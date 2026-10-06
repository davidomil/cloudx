import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Header } from "tar";
import { maxEvidenceCollectionBytes } from "./ForgeEvidenceFiles.js";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ForgeWorker } from "@cloudx/shared";
import { readContainerEvidenceTar, type EvidenceSink } from "./ForgeContainerEvidence.js";
import { ForgeDisposableResources, type ContainerIdentity, type DisposableContainerHost, type DisposableContainerInput } from "./ForgeDisposableResources.js";

const chunkBytes = 64 * 1024;

function header(filePath: string, bytes: number): Buffer {
  const entry = new Header({ path: filePath, type: "File", size: bytes, mode: 0o600 });
  entry.encode();
  return entry.block!;
}

async function* reportTar(failure: "interrupted" | "input-limit" | undefined, firstReportChunk: Promise<void>): AsyncGenerator<Buffer> {
  const chunk = Buffer.alloc(chunkBytes, 0x61);
  if (failure === "input-limit") {
    const generatedBytes = maxEvidenceCollectionBytes * 2 + 7 * 1024 * 1024;
    yield header("evidence/node_modules/generated.bin", generatedBytes);
    for (let bytes = 0; bytes < generatedBytes; bytes += chunkBytes) yield chunk;
  }
  const reportBytes = failure === "input-limit" ? 2 * 1024 * 1024 : chunkBytes * 2;
  yield header("evidence/report.json", reportBytes);
  for (let bytes = 0; bytes < reportBytes; bytes += chunkBytes) {
    yield chunk;
    if (failure === "interrupted") { await firstReportChunk; throw new Error("Docker stdout interrupted during report copy"); }
  }
  yield Buffer.alloc(1024);
}

class StreamingContainerHost implements DisposableContainerHost {
  readonly containers = new Map<string, ContainerIdentity>();
  readonly removed: string[] = [];
  selectedFiles = 0;
  selectedBytes = 0;
  failure?: "interrupted" | "input-limit";
  engineId = async () => "streaming-test-engine";
  async create(_input: DisposableContainerInput, labels: Record<string, string>): Promise<string> {
    const id = randomUUID().replaceAll("-", "").repeat(2);
    this.containers.set(id, { id, labels, created: new Date().toISOString(), running: false, writableBytes: 1024 });
    return id;
  }
  find = async (resourceId: string) => [...this.containers.values()].filter(item => item.labels["cloudx.forge.resource"] === resourceId).map(item => item.id);
  inspect = async (id: string) => structuredClone(this.containers.get(id));
  async stop(id: string): Promise<void> { this.containers.get(id)!.running = false; }
  async remove(id: string): Promise<void> { this.containers.delete(id); this.removed.push(id); }
  async readEvidence(_id: string, paths: string[], write: EvidenceSink): Promise<void> {
    let reportStarted!: () => void;
    const firstReportChunk = new Promise<void>(resolve => { reportStarted = resolve; });
    for (const source of paths) await readContainerEvidenceTar(source, reportTar(this.failure, firstReportChunk), async (filePath, stream, bytes) => {
      this.selectedFiles++;
      const host = this;
      async function* selectedReport() {
        for await (const chunk of stream) { host.selectedBytes += chunk.byteLength; reportStarted(); yield chunk; }
      }
      await write(filePath, selectedReport(), bytes);
    });
  }
}

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("Evidence export or resource queue did not settle")), 2000); });
  try { return await Promise.race([operation, stalled]); }
  finally { clearTimeout(deadline); }
}

describe("container evidence failures release the production resource queue", () => {
  it.each(["interrupted", "input-limit"] as const)("preserves the source, removes staging and permits a later export after %s tar input", async failure => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-tar-cancellation-"));
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const worker: ForgeWorker = {
      id: randomUUID(), attemptId: randomUUID(), kind: "issue", number: 183, title: "Report retirement",
      repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "test/project" },
      baseBranch: "main", templateId: "test", status: "running", autoPost: false,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), headSha: "a".repeat(40),
    };
    const host = new StreamingContainerHost();
    const resources = new ForgeDisposableResources(directory, async () => [structuredClone(worker)], host);
    const resource = await resources.create(worker, { image: "fixture", name: "report-cancellation", command: ["true"], retentionReason: "Keep the validation report", evidencePaths: ["/work/evidence"] });
    worker.status = "completed";
    host.failure = failure;
    const retirement = resources.retire(worker);
    const nextPreview = resources.preview();
    await expect(promptly(retirement)).rejects.toThrow(failure === "interrupted" ? "Docker stdout interrupted during report copy" : "bounded input limit");
    expect(host.selectedFiles).toBe(1);
    expect(host.selectedBytes).toBeGreaterThan(0);
    expect(host.selectedBytes).toBeLessThan(failure === "interrupted" ? chunkBytes * 2 : 2 * 1024 * 1024);
    expect(host.removed).toEqual([]);
    expect(host.containers.has(resource.containerId!)).toBe(true);
    expect(await fs.readdir(path.join(directory, "forge-evidence"))).toEqual([]);
    expect((await promptly(nextPreview))[0]).toMatchObject({ id: resource.id, state: "failed" });
    expect((await resources.records())[0]?.evidence).toMatchObject({ state: "pending" });
    host.failure = undefined;
    await promptly(resources.decideEvidence(resource.id, { action: "export" }));
    expect(host.removed).toEqual([resource.containerId]);
    expect((await resources.records())[0]).toMatchObject({ state: "deleted", evidence: { state: "verified", bytes: chunkBytes * 2 } });
  });
});

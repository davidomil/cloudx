import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { Header } from "tar";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ForgeWorker } from "@cloudx/shared";
import { readContainerEvidenceTar, type EvidenceSink } from "./ForgeContainerEvidence.js";
import { ForgeDisposableResources, ForgeEvidenceCompletenessError, type ContainerIdentity, type DisposableContainerHost } from "./ForgeDisposableResources.js";

class EvidenceHost implements DisposableContainerHost {
  container?: ContainerIdentity;
  files = new Map<string, string>([["/work/evidence/result.log", "validation passed\n"]]);
  reads = 0;
  stop = vi.fn(async () => { this.container!.running = false; });
  remove = vi.fn(async () => { this.container = undefined; });
  engineId = async () => "completeness-engine";
  async create(_input: unknown, labels: Record<string, string>) {
    this.container = { id: "a".repeat(64), created: new Date().toISOString(), labels, running: true, writableBytes: 8192 };
    return this.container.id;
  }
  find = async () => this.container ? [this.container.id] : [];
  inspect = async () => structuredClone(this.container);
  async readEvidence(_id: string, paths: string[], write: EvidenceSink) {
    this.reads++;
    const missing: string[] = [];
    for (const source of paths) {
      const selected = [...this.files].filter(([file]) => file === source || file.startsWith(`${source}/`));
      if (!selected.length) { missing.push(source); continue; }
      const entries = selected.flatMap(([file, contents]) => {
        const data = Buffer.from(contents);
        const header = new Header({ path: path.posix.basename(source) + file.slice(source.length), type: "File", size: data.length, mode: 0o600 });
        header.encode();
        return [header.block!, data, Buffer.alloc((512 - data.length % 512) % 512)];
      });
      await readContainerEvidenceTar(source, Readable.from([...entries, Buffer.alloc(1024)]), write);
    }
    if (missing.length) throw new ForgeEvidenceCompletenessError(missing);
  }
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-completeness-"));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const worker: ForgeWorker = { id: randomUUID(), attemptId: randomUUID(), kind: "review", number: 211, title: "Missing evidence", status: "running", headSha: "a".repeat(40),
    repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "fixture/cloudx" }, baseBranch: "main", templateId: "fixture", autoPost: false,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const host = new EvidenceHost();
  const reopen = () => new ForgeDisposableResources(directory, async () => [worker], host);
  const resources = reopen();
  const resource = await resources.create(worker, { name: "missing-review-log", image: "fixture", command: ["true"], retentionReason: "Keep the measured result and focused test log",
    evidencePaths: ["/work/evidence/result.log", "/work/evidence/focused-tests.log"] });
  return { directory, worker, host, reopen, resources, resource };
}

describe("Required container evidence completeness", () => {
  it("blocks handoff before stopping the container, then accepts intentionally produced evidence and verifies the archive before removal", async () => {
    const f = await fixture();
    await expect(f.resources.validateEvidenceHandoff(f.worker)).rejects.toMatchObject({ missingPaths: ["/work/evidence/focused-tests.log"] });
    expect((await f.reopen().records())[0]).toMatchObject({ state: "blocked", evidence: { state: "incomplete", missingPaths: ["/work/evidence/focused-tests.log"] } });
    expect(f.host.stop).not.toHaveBeenCalled();
    expect(f.host.remove).not.toHaveBeenCalled();
    expect(f.host.files.get("/work/evidence/result.log")).toBe("validation passed\n");
    f.host.files.set("/work/evidence/focused-tests.log", "focused regressions passed\n");
    await f.reopen().validateEvidenceHandoff(f.worker);
    expect((await f.reopen().records())[0]).toMatchObject({ state: "owned", evidence: { state: "pending" } });
    expect((await f.reopen().records())[0]?.evidence?.missingPaths).toBeUndefined();
    f.worker.status = "completed";
    f.host.remove.mockImplementationOnce(async () => {
      expect((await f.reopen().readEvidence(f.resource.id)).files.map(file => file.path)).toEqual(["work/evidence/focused-tests.log", "work/evidence/result.log"]);
      expect(await text(await f.reopen().evidenceFile(f.resource.id, "work/evidence/result.log"))).toBe("validation passed\n");
      f.host.container = undefined;
    });
    await f.reopen().retire(f.worker);
    expect((await f.reopen().records())[0]).toMatchObject({ state: "deleted", evidence: { state: "verified" } });
    expect(f.host.remove).toHaveBeenCalledOnce();
  });

  it("keeps an unchanged missing selection durable across retirement and restart without repeating the export, then retires an explicitly corrected selection", async () => {
    const f = await fixture();
    f.worker.status = "completed";
    const first = await f.resources.retire(f.worker).catch(error => error);
    const reads = f.host.reads;
    expect(first.message).toContain("/work/evidence/focused-tests.log");
    expect(first.message).not.toContain("TAR_BAD_ARCHIVE");
    expect(f.host.container?.running).toBe(false);
    for (let index = 0; index < 3; index++) {
      const failure = await f.reopen().retire(f.worker).catch(error => error);
      expect(failure.blockerIdentity).toBe(first.blockerIdentity);
      expect((await f.reopen().preview())[0]).toMatchObject({ eligible: false, reason: expect.stringContaining("explicitly correct") });
    }
    expect(f.host.reads).toBe(reads);
    expect(f.host.remove).not.toHaveBeenCalled();
    expect(f.host.files.get("/work/evidence/result.log")).toBe("validation passed\n");
    f.host.remove.mockImplementationOnce(async () => {
      const manifest = await f.reopen().readEvidence(f.resource.id);
      expect(manifest.paths).toEqual(["/work/evidence/result.log"]);
      expect(manifest.files).toHaveLength(1);
      f.host.container = undefined;
    });
    await f.reopen().decideEvidence(f.resource.id, { action: "export", evidencePaths: ["/work/evidence/result.log"] });
    expect((await f.reopen().records())[0]).toMatchObject({ state: "deleted", evidence: { state: "verified" } });
    expect(await text(await f.reopen().evidenceFile(f.resource.id, "work/evidence/result.log"))).toBe("validation passed\n");
  });

  it("allows the active owner to correct an earlier attempt's selection while retaining its original ownership receipt", async () => {
    const f = await fixture();
    const originalOwner = f.resource.owner;
    f.worker.attemptId = randomUUID();
    await expect(f.reopen().validateEvidenceHandoff(f.worker)).rejects.toBeInstanceOf(ForgeEvidenceCompletenessError);
    const updated = await f.reopen().updateEvidenceSelection(f.worker, f.resource.id, { evidencePaths: ["/work/evidence/result.log"], commitSha: "b".repeat(40) });
    expect(updated).toMatchObject({ owner: originalOwner, state: "owned", evidence: { state: "pending", paths: ["/work/evidence/result.log"], commitSha: "b".repeat(40), commitSource: "declared" } });
    await f.reopen().validateEvidenceHandoff(f.worker);
    expect(f.host.stop).not.toHaveBeenCalled();
    expect(f.host.remove).not.toHaveBeenCalled();
  });

  it("rejects incomplete receipts naming undeclared paths before host mutation", async () => {
    const f = await fixture();
    await f.resources.validateEvidenceHandoff(f.worker).catch(() => {});
    const journalPath = path.join(f.directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    journal.resources[0].evidence.missingPaths = ["/outside/selection.log"];
    await fs.writeFile(journalPath, JSON.stringify(journal));
    await expect(f.reopen().records()).rejects.toThrow("ownership journal is invalid");
    expect(f.host.stop).not.toHaveBeenCalled();
    expect(f.host.remove).not.toHaveBeenCalled();
  });
});

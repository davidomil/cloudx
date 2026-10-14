import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Header, Pax, type types } from "tar";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ForgeWorker } from "@cloudx/shared";
import { DockerDisposableContainerHost, ForgeDisposableCleanupError, ForgeDisposableResources } from "./ForgeDisposableResources.js";

const execute = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }), spawn };
});

describe("production Docker export of native Codex plugin fixtures", () => {
  beforeEach(() => { execute.mockReset(); spawn.mockReset(); });

  it.each(["plugins", "plugins-clone-QkqfBY"])("verifies useful evidence before deleting an environment containing 4200 %s cache files", async cache => {
    const fixture = await ownedEnvironment();
    const home = "evidence/settings-profile/data/codex-launches/model-scope";
    const useful = [
      { path: "evidence/validation.log", data: "focused tests passed\n" },
      { path: `${home}/config.toml`, data: 'model = "fixture-model"\n' },
      { path: "evidence/reproduction/input.ts", data: "export const reproduction = true;\n" },
      { path: `${home}/.tmp/diagnostics.log`, data: "native startup passed\n" },
      { path: "evidence/reproduction/native-tool", type: "SymbolicLink" as const, linkpath: "/opt/codex/bin/codex" },
    ];
    spawn.mockImplementation((_command: string, args: string[], options: unknown) => {
      expect(args).toEqual(["container", "cp", `${fixture.id}:/work/evidence`, "-"]);
      expect(options).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
      return dockerCopy(evidenceTar([
        ...useful.slice(0, 2),
        ...Array.from({ length: 4200 }, (_, index) => ({ path: `${home}/.tmp/${cache}/plugins/example/cache-${index}.json`, data: "generated plugin clone" })),
        ...useful.slice(2),
      ]));
    });
    fixture.beforeRemove = async () => {
      const manifest = await fixture.resources().readEvidence(fixture.resourceId);
      expect(manifest).toMatchObject({ owner: { workerId: fixture.worker.id, attemptId: fixture.worker.attemptId }, commitSha: fixture.worker.headSha });
      expect(manifest.files.map(file => file.path).sort()).toEqual(useful.map(file => `work/${file.path}`).sort());
      for (const file of useful.filter(file => file.data))
        expect(await text(await fixture.resources().evidenceFile(fixture.resourceId, `work/${file.path}`))).toBe(file.data);
      expect(JSON.parse(await text(await fixture.resources().evidenceFile(fixture.resourceId, "work/evidence/reproduction/native-tool"))))
        .toEqual({ type: "SymbolicLink", target: "/opt/codex/bin/codex" });
    };
    fixture.worker.status = "completed";
    await fixture.resources().retire(fixture.worker);
    expect(fixture.removed).toBe(true);
    expect((await fixture.resources().records())[0]).toMatchObject({ state: "deleted", evidence: { state: "verified", files: expect.any(Array) } });
    expect((await fixture.resources().readEvidence(fixture.resourceId)).files).toHaveLength(5);
    expect(execute.mock.calls.some(([, args]) => args.includes("prune") || args.includes("--volumes") || args.includes("-v"))).toBe(false);
  }, 30_000);

  it("keeps the 4096 useful-file limit and its primary identity across secondary cancellation, truncated-copy diagnostics and repeated retirement", async () => {
    const fixture = await ownedEnvironment();
    fixture.worker.status = "completed";
    const collectionFailure = "Evidence exceeds the bounded collection limit (1 GiB / 4096 files); the environment was preserved.";
    const archive = evidenceTar([
      { path: "evidence/profile/data/codex-launches/model/.tmp/plugins/plugins/example/cache.json", data: "generated" },
      ...Array.from({ length: 4097 }, (_, index) => ({ path: `evidence/reproduction/schema-${index}.json`, data: "" })),
    ]);
    let blockerIdentity: string | undefined;
    for (const [diagnostic, afterCancellation] of [
      ["", false],
      ["write /dev/stdout: connection reset by peer", false],
      ["Docker archive copy cancelled; TAR_BAD_ARCHIVE: truncated stream", true],
    ] as const) {
      spawn.mockImplementation(() => {
        const child = dockerCopy(archive);
        if (afterCancellation) child.kill.mockImplementation(() => {
          child.stderr.end(diagnostic);
          child.stdout.destroy(new Error("TAR_BAD_ARCHIVE: Docker copy truncated after cancellation"));
          return true;
        });
        else child.stderr.end(diagnostic);
        return child;
      });
      const failure = await fixture.resources().retire(fixture.worker).catch(error => error);
      expect(failure).toBeInstanceOf(ForgeDisposableCleanupError);
      if (blockerIdentity) expect(failure.blockerIdentity).toBe(blockerIdentity);
      blockerIdentity = failure.blockerIdentity;
      const [record] = await fixture.resources().records();
      expect(record).toMatchObject({ state: "failed", cleanupFailure: collectionFailure, evidence: { state: "pending" } });
      expect(record!.evidence!.manifestSha256).toBeUndefined();
      if (diagnostic) expect(record!.reason).toContain(diagnostic);
      expect(await fs.readdir(path.join(fixture.directory, "forge-evidence"))).toEqual([]);
      expect(fixture.removed).toBe(false);
    }
  }, 30_000);
});

interface TarEntry { path: string; data?: string; type?: types.EntryTypeName; linkpath?: string }
function evidenceTar(entries: TarEntry[]): Buffer {
  return Buffer.concat([...entries.flatMap(entry => {
    const data = Buffer.from(entry.data ?? "");
    const header = new Header({ path: entry.path, type: entry.type ?? "File", size: data.length, linkpath: entry.linkpath, mode: 0o600 });
    header.encode();
    return [
      ...(header.needPax ? [new Pax({ path: entry.path, linkpath: entry.linkpath }).encode()] : []),
      header.block!, data, Buffer.alloc((512 - data.length % 512) % 512),
    ];
  }), Buffer.alloc(1024)]);
}

function dockerCopy(archive: Buffer) {
  const stdout = Readable.from([archive]);
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), kill: vi.fn(() => { stdout.destroy(new Error("Docker copy cancelled")); return true; }) });
  stdout.on("end", () => { setImmediate(() => child.emit("close", 0, null)); });
  stdout.on("error", () => { setImmediate(() => child.emit("close", 1, "SIGKILL")); });
  return child;
}

async function ownedEnvironment() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-plugin-evidence-"));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const worker: ForgeWorker = { id: randomUUID(), attemptId: randomUUID(), kind: "review", number: 212, title: "Plugin evidence retirement",
    repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "fixture/cloudx" }, baseBranch: "main", templateId: "fixture",
    status: "running", autoPost: false, headSha: "a".repeat(40), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const host = new DockerDisposableContainerHost();
  const fixture = { directory, worker, id: "a".repeat(64), resourceId: "", removed: false, beforeRemove: undefined as (() => Promise<void>) | undefined,
    resources: () => new ForgeDisposableResources(directory, async () => [worker], host) };
  const created = new Date().toISOString();
  let labels: Record<string, string> = {};
  let running = true;
  execute.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === "info") return { stdout: "same-engine\n" };
    if (args[0] === "create") {
      labels = Object.fromEntries(args.flatMap((arg, index) => arg === "--label" ? [args[index + 1]!.split("=")] : []));
      return { stdout: `${fixture.id}\n` };
    }
    if (args[1] === "inspect") {
      if (fixture.removed) throw Object.assign(new Error("absent"), { stderr: `Error: No such container: ${fixture.id}` });
      return { stdout: JSON.stringify([{ Id: fixture.id, Created: created, Config: { Labels: labels }, State: { Running: running }, SizeRw: 2048 }]) };
    }
    if (args[1] === "stop") { running = false; return { stdout: fixture.id }; }
    if (args[1] === "rm") {
      expect(running).toBe(false);
      expect(args).toEqual(["container", "rm", fixture.id]);
      await fixture.beforeRemove?.();
      fixture.removed = true;
      return { stdout: fixture.id };
    }
    throw new Error(`Unexpected Docker operation: ${args.join(" ")}`);
  });
  const resource = await fixture.resources().create(worker, { image: "fixture", name: "plugin-evidence", command: ["true"],
    retentionReason: "Keep useful validation fixtures", evidencePaths: ["/work/evidence"] });
  fixture.resourceId = resource.id;
  return fixture;
}

import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import type { EvidenceSink } from "./ForgeContainerEvidence.js";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeWorker } from "@cloudx/shared";
import { ContainerCreationRejectedError, ForgeDisposableResources, validateContainerInput, type ContainerIdentity, type DisposableContainerHost, type DisposableContainerInput } from "./ForgeDisposableResources.js";
import { registerForgeDisposableResourceRoutes } from "./ForgeDisposableResourceRoutes.js";
import type { ForgeWorkflowService } from "./ForgeWorkflowService.js";
import { PathPolicy } from "../pathPolicy.js";
import { WorkspaceCleanupService } from "../workspace/WorkspaceCleanupService.js";
import { registerWorkspaceCleanupRoutes } from "../workspace/WorkspaceCleanupRoutes.js";

class ContainerHost implements DisposableContainerHost {
  engine = "test-engine";
  containers = new Map<string, ContainerIdentity>();
  removed: string[] = [];
  stopped: string[] = [];
  failure?: string;
  afterCreate?: () => void;
  beforeRemove?: () => void;
  evidence = new Map<string, Buffer>();
  evidenceFailure?: string;
  exportCalls = 0;
  engineId = async () => this.engine;
  async create(_input: DisposableContainerInput, labels: Record<string, string>): Promise<string> {
    const id = randomUUID().replaceAll("-", "").repeat(2);
    this.containers.set(id, { id, created: new Date().toISOString(), labels, running: false, writableBytes: 1024 * 1024 });
    this.afterCreate?.();
    return id;
  }
  find = async (id: string) => [...this.containers.values()].filter(item => item.labels["cloudx.forge.resource"] === id).map(item => item.id);
  inspect = async (id: string) => { if (this.failure === "inspect") throw new Error("Docker scan unavailable"); return structuredClone(this.containers.get(id)); };
  async stop(id: string): Promise<void> { this.stopped.push(id); this.containers.get(id)!.running = false; }
  async remove(id: string): Promise<void> {
    this.beforeRemove?.();
    if (this.failure === "remove") throw new Error("Docker removal denied");
    this.containers.delete(id); this.removed.push(id);
  }
  async readEvidence(_id: string, paths: string[], write: EvidenceSink) {
    this.exportCalls++;
    if (this.evidenceFailure) throw new Error(this.evidenceFailure);
    for (const [file, data] of this.evidence) if (paths.some(source => file === source.slice(1) || file.startsWith(`${source.slice(1)}/`))) await write(file, Readable.from([data]), data.length);
  }
}

describe("Forge disposable resource ownership and lifecycle", () => {
  let directory: string;
  let workers: ForgeWorker[];
  let host: ContainerHost;
  let resources: ForgeDisposableResources;
  const worker = (): ForgeWorker => ({ id: randomUUID(), attemptId: randomUUID(), kind: "issue", number: 128, title: "test", repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "test/project" }, baseBranch: "main", templateId: "test", status: "running", autoPost: false, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const create = (name = "cloudx-128-feedback", extra: Partial<DisposableContainerInput> = {}) => resources.create(workers[0]!, { image: "ubuntu:24.04", name, command: ["true"], ...extra });
  const legacy = async (name: string, retentionReason: string) => {
    const resource = await create(name, { retentionReason, evidencePaths: ["/work/evidence"] });
    const journalPath = path.join(directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    delete journal.resources.find((item: { id: string }) => item.id === resource.id).evidence;
    await fs.writeFile(journalPath, JSON.stringify(journal));
    return { ...resource, evidence: undefined };
  };
  const service = () => new ForgeDisposableResources(directory, async () => structuredClone(workers), host);
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-resources-")); workers = [worker()]; host = new ContainerHost(); resources = service(); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  it.each([["null", null], ["object", {}], ["empty", ""], ["overlong", "x".repeat(4097)], ["control character", "target\u0000private"]])("rejects %s saved fixture-link metadata before any host mutation", async (_scenario, symbolicLink) => {
    await create("link-validation", { evidencePaths: ["/work/evidence"] });
    const journalPath = path.join(directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    journal.resources[0].evidence.files = [{ path: "work/evidence/link", bytes: 0, sha256: "a".repeat(64), symbolicLink }];
    await fs.writeFile(journalPath, JSON.stringify(journal));
    await expect(service().records()).rejects.toThrow("Disposable resource ownership journal is invalid");
    expect(host.removed).toEqual([]);
    expect(host.stopped).toEqual([]);
  });

  it("reclaims only exact receipt-owned stopped containers after closure and persists measured writable bytes", async () => {
    const first = await create(); const second = await create("cloudx-128-feedback-upgrade");
    const unrelated = "f".repeat(64); host.containers.set(unrelated, { id: unrelated, created: new Date().toISOString(), labels: {}, running: true, writableBytes: 10_000 });
    expect((await resources.preview()).every(item => !item.eligible)).toBe(true);
    workers[0]!.status = "completed"; await resources.retire(workers[0]!);
    expect(host.removed).toEqual([first.containerId, second.containerId]);
    expect(host.containers.has(unrelated)).toBe(true);
    expect((await service().records()).map(item => [item.state, item.reclaimedBytes])).toEqual([["deleted", 1024 * 1024], ["deleted", 1024 * 1024]]);
    await service().retire(workers[0]!); expect(host.removed).toHaveLength(2);
  });
  it("protects open batch members and unfinished shared consumers until both lifecycles are terminal", async () => {
    const shared = worker(); workers.push(shared);
    await create("shared", { consumers: [{ workerId: shared.id, attemptId: shared.attemptId! }] });
    workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("shared consumer");
    shared.status = "completed"; shared.batch = { issues: [{ number: 1, title: "open", url: "https://example.test/1", state: "open" }] };
    await expect(resources.retire(shared)).rejects.toThrow("shared consumer");
    shared.batch.issues[0]!.state = "closed"; await resources.retire(shared);
    expect(host.removed).toHaveLength(1);
  });
  it("a completed unmerged review grants no automatic or manual deletion authority", async () => {
    workers[0]!.kind = "review"; await create(); workers[0]!.status = "completed";
    expect((await resources.preview())[0]).toMatchObject({ eligible: false, reason: expect.stringContaining("unmerged review") });
    const record = (await resources.records())[0]!;
    expect((await resources.remove(record.id)).state).toBe("blocked");
    expect(host.removed).toEqual([]);
  });
  it("quiesces an exclusively owned running container and preserves its separate volumes", async () => {
    const resource = await create(); host.containers.get(resource.containerId!)!.running = true;
    workers[0]!.status = "completed"; await resources.retire(workers[0]!);
    expect(host.stopped).toEqual([resource.containerId]); expect(host.removed).toEqual([resource.containerId]);
  });
  it.each(["engine", "labels", "creation", "id"])("preserves resources when %s identity changes after creation", async change => {
    const record = await create(); const identity = host.containers.get(record.containerId!)!;
    if (change === "engine") host.engine = "other-engine";
    if (change === "labels") identity.labels["cloudx.forge.worker"] = randomUUID();
    if (change === "creation") identity.created = new Date(0).toISOString();
    if (change === "id") identity.id = "e".repeat(64);
    workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow(/identity|ownership/u);
    expect(host.removed).toEqual([]);
    expect((await service().records())[0]!.state).toBe("failed");
  });
  it("rechecks active consumers immediately before removal and preserves stale manual previews", async () => {
    await create(); workers[0]!.status = "completed";
    host.failure = "remove"; await expect(resources.retire(workers[0]!)).rejects.toThrow("denied"); host.failure = undefined;
    const candidate = (await resources.preview())[0]!; expect(candidate.eligible).toBe(true);
    workers[0]!.status = "running";
    expect((await resources.remove(candidate.id)).state).toBe("blocked"); expect(host.removed).toEqual([]);
  });
  it("checks consumers after the last Docker inspection immediately before removal", async () => {
    await create(); workers[0]!.status = "completed";
    let checks = 0; const inspect = host.inspect;
    host.inspect = async id => {
      const identity = await inspect(id);
      if (++checks === 2) workers[0]!.status = "running";
      return identity;
    };
    await expect(resources.retire({ ...workers[0]!, status: "completed" })).rejects.toThrow("shared consumer");
    expect(host.removed).toEqual([]);
  });
  it("makes retained evidence an explicit visible blocker", async () => {
    const resource = await legacy("evidence", "Retain the failing database until its owner reviews it."); workers[0]!.status = "completed";
    host.containers.get(resource.containerId!)!.running = true;
    await expect(resources.retire(workers[0]!)).rejects.toThrow("Explicit evidence retention");
    expect((await resources.preview())[0]!.reason).toContain("failing database"); expect(host.removed).toEqual([]);
    expect(host.stopped).toEqual([resource.containerId]);
  });
  it("preserves declared validation provenance when a resumed worker still names its earlier published commit", async () => {
    workers[0]!.headSha = "a".repeat(40);
    host.evidence.set("work/evidence/test.log", Buffer.from("test passed\n"));
    const resource = await create("evidence", { retentionReason: "Specific validation log", evidencePaths: ["/work/evidence/test.log"], commitSha: "b".repeat(40) });
    host.containers.get(resource.containerId!)!.running = true;
    workers[0]!.status = "completed";
    await resources.retire(workers[0]!);
    expect(host.stopped).toEqual([resource.containerId]); expect(host.removed).toEqual([resource.containerId]);
    const saved = (await service().records())[0]!;
    expect(saved).toMatchObject({ state: "deleted", reclaimedBytes: 1024 * 1024, evidence: { state: "verified", commitSha: "b".repeat(40), commitSource: "declared", bytes: 12 } });
    const manifest = await service().readEvidence(resource.id);
    expect(manifest).toMatchObject({ owner: resource.owner, consumers: resource.consumers, containerId: resource.containerId, paths: ["/work/evidence/test.log"], files: [{ path: "work/evidence/test.log", bytes: 12 }] });
    expect(await text(await service().evidenceFile(resource.id, manifest.files[0]!.path))).toBe("test passed\n");
    await expect(service().evidenceFile(resource.id, "../../etc/passwd")).rejects.toThrow("Unknown evidence file");
    await service().retire(workers[0]!); expect(host.exportCalls).toBe(1);
  });
  it("requires a deliberate legacy-hold decision, persists keep across restart and confirms discard", async () => {
    const resource = await legacy("legacy-evidence", "Unselected old failure reproduction");
    host.containers.get(resource.containerId!)!.running = true;
    workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("requires review");
    expect((await service().decideEvidence(resource.id, { action: "keep" })).evidence?.state).toBe("kept");
    await expect(service().retire(workers[0]!)).rejects.toThrow("explicitly kept");
    await expect(service().decideEvidence(resource.id, { action: "discard" })).rejects.toThrow("confirmed discard");
    expect(host.removed).toEqual([]);
    expect((await service().decideEvidence(resource.id, { action: "discard", confirmation: "Discard evidence" })).state).toBe("deleted");
    expect((await service().records())[0]!.evidence?.state).toBe("discarded");
  });
  it("exports a reviewed legacy hold and marks request commit provenance as declared", async () => {
    host.evidence.set("work/evidence/old.log", Buffer.from("old reproduction"));
    const resource = await legacy("legacy-evidence", "Old logs"); workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("requires review");
    expect((await service().decideEvidence(resource.id, { action: "export", evidencePaths: ["/work/evidence/old.log"], commitSha: "c".repeat(40) })).state).toBe("deleted");
    expect(await service().readEvidence(resource.id)).toMatchObject({ commitSha: "c".repeat(40), commitSource: "declared" });
  });
  it("captures the authoritative completed worker commit when the environment was created before its first commit", async () => {
    host.evidence.set("work/evidence/log", Buffer.from("test log"));
    const resource = await create("evidence", { evidencePaths: ["/work/evidence/log"] });
    expect(resource.evidence?.commitSha).toBeUndefined();
    workers[0]!.headSha = "e".repeat(40); workers[0]!.status = "completed";
    await resources.retire(workers[0]!);
    expect(await service().readEvidence(resource.id)).toMatchObject({ commitSha: "e".repeat(40), commitSource: "worker" });
  });
  it("captures available completed-worker commit provenance when exporting an old hold", async () => {
    host.evidence.set("work/evidence/log", Buffer.from("old test log"));
    const resource = await legacy("legacy-evidence", "old logs");
    workers[0]!.headSha = "f".repeat(40); workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("requires review");
    await service().decideEvidence(resource.id, { action: "export", evidencePaths: ["/work/evidence/log"] });
    expect(await service().readEvidence(resource.id)).toMatchObject({ commitSha: "f".repeat(40), commitSource: "worker" });
  });
  it("stops terminal evidence containers during export failure and resumes export after restart", async () => {
    host.evidence.set("work/evidence/failure.log", Buffer.from("failing test")); host.evidenceFailure = "Export interrupted";
    const resource = await create("evidence", { retentionReason: "Test failure", evidencePaths: ["/work/evidence"] });
    host.containers.get(resource.containerId!)!.running = true; workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("Export interrupted");
    expect(host.stopped).toEqual([resource.containerId]); expect(host.removed).toEqual([]);
    expect((await service().records())[0]).toMatchObject({ state: "failed", evidence: { state: "pending" } });
    host.evidenceFailure = undefined; await service().retire(workers[0]!);
    expect((await service().records())[0]).toMatchObject({ state: "deleted", evidence: { state: "verified" } });
  });
  it("protects the source when its durable export receipt cannot be synced and succeeds after restart", async () => {
    host.evidence.set("work/evidence/log", Buffer.from("must survive receipt failure"));
    const resource = await create("receipt-failure", { evidencePaths: ["/work/evidence/log"] }); workers[0]!.status = "completed";
    const open = fs.open.bind(fs);
    const syncFailures: ReturnType<typeof vi.spyOn>[] = [];
    const intercept = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith("forge-disposable-resources.json")) syncFailures.push(vi.spyOn(handle, "sync").mockRejectedValue(new Error("receipt sync denied")));
      return handle;
    });
    try { await expect(resources.retire(workers[0]!)).rejects.toThrow("receipt sync denied"); }
    finally { intercept.mockRestore(); for (const spy of syncFailures) spy.mockRestore(); }
    expect(host.removed).toEqual([]);
    expect(host.containers.has(resource.containerId!)).toBe(true);
    expect(await fs.readdir(path.join(directory, "forge-evidence"))).toEqual([]);
    expect((await service().records())[0]).toMatchObject({ state: "failed", evidence: { state: "exporting" } });
    await service().retire(workers[0]!);
    expect(host.removed).toEqual([resource.containerId]);
    expect(await text(await service().evidenceFile(resource.id, "work/evidence/log"))).toBe("must survive receipt failure");
  });
  it("recovers completed archive export interrupted before the receipt write without exporting again", async () => {
    host.evidence.set("work/evidence/log", Buffer.from("durable log")); host.failure = "remove";
    const resource = await create("evidence", { retentionReason: "Test log", evidencePaths: ["/work/evidence/log"] }); workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("removal denied");
    const journalPath = path.join(directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    journal.resources[0].evidence.state = "exporting";
    await fs.writeFile(journalPath, JSON.stringify(journal));
    host.failure = undefined; await service().retire(workers[0]!);
    expect(host.exportCalls).toBe(1); expect(host.removed).toEqual([resource.containerId]);
    expect(await text(await service().evidenceFile(resource.id, "work/evidence/log"))).toBe("durable log");
  });
  it("verifies the saved archive again before retrying removal and preserves a corrupted archive", async () => {
    host.evidence.set("work/evidence/log", Buffer.from("valuable")); host.failure = "remove";
    const resource = await create("evidence", { retentionReason: "valuable log", evidencePaths: ["/work/evidence/log"] }); workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("removal denied");
    const archivePath = path.join(directory, (await service().records())[0]!.evidence!.archivePath!);
    const blob = createHash("sha256").update("work/evidence/log").digest("hex") + ".data";
    await fs.writeFile(path.join(path.dirname(archivePath), "batch-0", blob), "corrupted"); host.failure = undefined;
    await expect(service().retire(workers[0]!)).rejects.toThrow("verification failed"); expect(host.removed).toEqual([]);
  });
  it("preserves downloads from existing verified compact archives while finishing their reviewed retirement", async () => {
    host.evidence.set("work/evidence/log", Buffer.from("existing report")); host.failure = "remove";
    const resource = await create("existing-evidence", { evidencePaths: ["/work/evidence/log"] }); workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("removal denied");
    const saved = (await service().records())[0]!;
    const manifest = await service().readEvidence(resource.id);
    const legacyPath = `forge-evidence/${resource.id}.json`;
    await fs.writeFile(path.join(directory, legacyPath), JSON.stringify({ manifest, contents: { "work/evidence/log": Buffer.from("existing report").toString("base64") } }));
    const journalPath = path.join(directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    journal.resources[0].evidence.archivePath = legacyPath;
    await fs.writeFile(journalPath, JSON.stringify(journal));
    host.failure = undefined;
    await service().retire(workers[0]!);
    expect((await service().records())[0]?.evidence?.manifestSha256).toBe(saved.evidence?.manifestSha256);
    expect(await text(await service().evidenceFile(resource.id, "work/evidence/log"))).toBe("existing report");
    expect(host.exportCalls).toBe(1);
    expect(host.removed).toEqual([resource.containerId]);
  });
  it("protects a shared active attempt from stop, export and hold release", async () => {
    const shared = worker(); workers.push(shared);
    const resource = await create("evidence", { retentionReason: "shared log", evidencePaths: ["/work/evidence"], consumers: [{ workerId: shared.id, attemptId: shared.attemptId! }] });
    host.containers.get(resource.containerId!)!.running = true; workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("shared consumer");
    await expect(resources.decideEvidence(resource.id, { action: "discard", confirmation: "Discard evidence" })).rejects.toThrow("shared consumer");
    expect(host.stopped).toEqual([]); expect(host.exportCalls).toBe(0); expect(host.removed).toEqual([]);
  });
  it("preserves a container reactivated during evidence export and refuses to archive moving data", async () => {
    host.evidence.set("work/evidence/log", Buffer.from("test log"));
    const resource = await create("evidence", { evidencePaths: ["/work/evidence/log"] }); workers[0]!.status = "completed";
    const readEvidence = host.readEvidence.bind(host);
    host.readEvidence = async (...args) => { const result = await readEvidence(...args); host.containers.get(resource.containerId!)!.running = true; return result; };
    await expect(resources.retire(workers[0]!)).rejects.toThrow("became active during evidence export");
    expect(host.removed).toEqual([]);
    expect((await service().records())[0]).toMatchObject({ state: "failed", evidence: { state: "pending" } });
  });
  it("keeps successfully read evidence if the stopped container disappears before the durable archive write", async () => {
    host.evidence.set("work/evidence/log", Buffer.from("test log"));
    const resource = await create("evidence", { evidencePaths: ["/work/evidence/log"] }); workers[0]!.status = "completed";
    const readEvidence = host.readEvidence.bind(host);
    host.readEvidence = async (...args) => { const result = await readEvidence(...args); host.containers.delete(resource.containerId!); return result; };
    await resources.retire(workers[0]!);
    expect((await service().records())[0]).toMatchObject({ state: "deleted", evidence: { state: "verified" } });
    expect(await text(await service().evidenceFile(resource.id, "work/evidence/log"))).toBe("test log");
  });
  it("reports unavailable evidence and converges after export failed and the environment is already absent", async () => {
    host.evidenceFailure = "Interrupted copy";
    const resource = await create("evidence", { evidencePaths: ["/work/evidence/log"] }); workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("Interrupted copy");
    host.containers.delete(resource.containerId!);
    await service().retire(workers[0]!);
    expect((await service().records())[0]).toMatchObject({ state: "deleted", evidence: { state: "missing" } });
    expect(await service().preview()).toEqual([]);
  });
  it("preserves owned identity changes after export and reconciles absent environments with their evidence", async () => {
    host.evidence.set("work/evidence/log", Buffer.from("log"));
    const resource = await create("evidence", { retentionReason: "log", evidencePaths: ["/work/evidence/log"] }); workers[0]!.status = "completed";
    const readEvidence = host.readEvidence.bind(host);
    host.readEvidence = async (...args) => { const contents = await readEvidence(...args); host.engine = "replacement"; return contents; };
    await expect(resources.retire(workers[0]!)).rejects.toThrow("engine identity changed"); expect(host.removed).toEqual([]);
    host.engine = "test-engine"; host.readEvidence = readEvidence; host.failure = "remove";
    await expect(service().retire(workers[0]!)).rejects.toThrow("removal denied");
    host.containers.delete(resource.containerId!); host.failure = undefined;
    await service().retire(workers[0]!);
    expect((await service().records())[0]).toMatchObject({ state: "deleted", reclaimedBytes: 1024 * 1024, evidence: { state: "verified" } });
    expect(await text(await service().evidenceFile(resource.id, "work/evidence/log"))).toBe("log");
  });
  it("records already-absent legacy evidence truthfully without stale pending cleanup", async () => {
    const resource = await legacy("legacy", "old unknown files"); workers[0]!.status = "completed";
    host.containers.delete(resource.containerId!); await resources.retire(workers[0]!);
    expect((await service().records())[0]).toMatchObject({ state: "deleted", evidence: { state: "missing" }, reason: expect.stringContaining("without claiming an export") });
    expect(await service().preview()).toEqual([]);
  });
  it.each(["/", "/work/node_modules", "/work/evidence/../secret", "/work/evidence/", "/work/.git", "/work/cache.tsbuildinfo"])("rejects non-specific or generated evidence path %s", source => {
    expect(() => validateContainerInput({ image: "node:22", name: "evidence", command: [], evidencePaths: [source] })).toThrow("arbitrary Docker options");
  });
  it("requires specific evidence declarations on new creation instead of accepting a text-only indefinite hold", () => {
    expect(() => validateContainerInput({ image: "node:22", name: "evidence", command: [], retentionReason: "Keep everything indefinitely" })).toThrow("Evidence retention requires specific evidencePaths");
  });
  it("does not convert a failed storage scan into zero usage", async () => {
    await create(); host.failure = "inspect";
    expect((await resources.preview())[0]).toMatchObject({ sizeUnavailable: true, eligible: false, reason: "Docker scan unavailable" });
  });
  it("continues other cleanup items after partial failure and reconciles removal interrupted by restart", async () => {
    const first = await create(); await create("second"); workers[0]!.status = "completed";
    let calls = 0; const remove = host.remove.bind(host);
    host.remove = async id => { if (calls++ === 0) throw new Error("first denied"); await remove(id); };
    await expect(resources.retire(workers[0]!)).rejects.toThrow("first denied");
    expect((await service().records()).map(item => item.state)).toEqual(["failed", "deleted"]);
    const journalPath = path.join(directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")); journal.resources[0].state = "deleting";
    await fs.writeFile(journalPath, JSON.stringify(journal)); host.containers.delete(first.containerId!);
    resources = service(); await resources.retire(workers[0]!);
    expect((await resources.records()).every(item => item.state === "deleted")).toBe(true);
  });
  it("recovers a container created before the durable ID write from its unique recorded intent", async () => {
    host.afterCreate = () => { host.failure = "inspect"; };
    await expect(create()).rejects.toThrow("scan unavailable"); host.failure = undefined;
    const journalPath = path.join(directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")); delete journal.resources[0].containerId;
    await fs.writeFile(journalPath, JSON.stringify(journal)); workers[0]!.status = "completed";
    await service().retire(workers[0]!); expect(host.removed).toHaveLength(1);
  });
  it("reconciles a rejected creation as absent across restart without adopting its name-conflicting container", async () => {
    const conflict = "f".repeat(64);
    host.containers.set(conflict, { id: conflict, created: new Date().toISOString(), labels: {}, running: true, writableBytes: 4096 });
    vi.spyOn(host, "create").mockRejectedValue(new ContainerCreationRejectedError("The container name is already in use."));
    await expect(create("conflicting-name")).rejects.toThrow("already in use");
    expect(await service().preview()).toEqual([]);
    expect((await service().records())[0]).toMatchObject({ state: "deleted", allocatedBytes: 0, reclaimedBytes: 0, reason: expect.stringContaining("confirmed absent") });
    workers[0]!.status = "completed";
    await service().retire(workers[0]!);
    await service().retire(workers[0]!);
    expect(host.containers.has(conflict)).toBe(true);
    expect(host.stopped).toEqual([]); expect(host.removed).toEqual([]);
  });
  it("keeps an interrupted creation without a receipt blocked even when its scan finds nothing", async () => {
    vi.spyOn(host, "create").mockRejectedValue(new Error("Creation response interrupted"));
    await expect(create()).rejects.toThrow("interrupted");
    workers[0]!.status = "completed";
    await expect(service().retire(workers[0]!)).rejects.toThrow("0 matching resources");
    expect((await service().preview())[0]).toMatchObject({ eligible: false, sizeUnavailable: true });
    expect(host.removed).toEqual([]);
  });
  it("preserves a rejected creation when the absence scan fails, then reconciles its confirmed absence", async () => {
    vi.spyOn(host, "create").mockRejectedValue(new ContainerCreationRejectedError("Docker rejected creation"));
    await expect(create()).rejects.toThrow("rejected");
    const scan = vi.spyOn(host, "find").mockRejectedValue(new Error("Docker scan unavailable"));
    workers[0]!.status = "completed";
    await expect(service().retire(workers[0]!)).rejects.toThrow("scan unavailable");
    expect((await service().preview())[0]).toMatchObject({ eligible: false, sizeUnavailable: true });
    scan.mockRestore();
    await service().retire(workers[0]!);
    expect((await service().records())[0]).toMatchObject({ state: "deleted", allocatedBytes: 0, reclaimedBytes: 0 });
    expect(host.removed).toEqual([]);
  });
  it("keeps ambiguous rejected creation matches and engine changes blocked", async () => {
    vi.spyOn(host, "create").mockRejectedValue(new ContainerCreationRejectedError("Docker rejected creation"));
    await expect(create()).rejects.toThrow("rejected");
    vi.spyOn(host, "find").mockResolvedValue(["a".repeat(64), "b".repeat(64)]);
    workers[0]!.status = "completed";
    await expect(service().retire(workers[0]!)).rejects.toThrow("2 matching resources");
    host.engine = "replacement-engine";
    await expect(service().retire(workers[0]!)).rejects.toThrow("engine identity changed");
    expect(host.removed).toEqual([]);
  });
  it("preserves a rejected intent when the Docker engine changes during its absence scan", async () => {
    vi.spyOn(host, "create").mockRejectedValue(new ContainerCreationRejectedError("Docker rejected creation"));
    await expect(create()).rejects.toThrow("rejected");
    vi.spyOn(host, "find").mockImplementation(async () => { host.engine = "replacement-engine"; return []; });
    workers[0]!.status = "completed";
    await expect(service().retire(workers[0]!)).rejects.toThrow("engine identity changed during the absence scan");
    expect((await service().records())[0]).toMatchObject({ state: "failed", reclaimedBytes: 0 });
    expect((await service().preview())[0]).toMatchObject({ eligible: false, sizeUnavailable: true });
    expect(host.removed).toEqual([]);
  });
  it("reconciles a matching creation receipt instead of absence and protects its active consumer", async () => {
    const actualCreate = host.create.bind(host);
    vi.spyOn(host, "create").mockImplementation(async (input, labels) => {
      await actualCreate(input, labels);
      throw new ContainerCreationRejectedError("Docker rejected the response");
    });
    await expect(create()).rejects.toThrow("rejected");
    expect((await service().preview())[0]).toMatchObject({ eligible: false, allocatedBytes: 1024 * 1024, reason: expect.stringContaining("Active or unfinished") });
    expect(host.removed).toEqual([]);
    workers[0]!.status = "completed";
    await service().retire(workers[0]!);
    expect(host.removed).toHaveLength(1);
    expect((await service().records())[0]).toMatchObject({ state: "deleted", reclaimedBytes: 1024 * 1024 });
  });
  it("requires explicit ownership review for ambiguous creation and never adopts legacy name matches", async () => {
    await create(); const journalPath = path.join(directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")); delete journal.resources[0].containerId; delete journal.resources[0].created;
    await fs.writeFile(journalPath, JSON.stringify(journal));
    const original = [...host.containers.values()][0]!; const duplicate = { ...original, id: "d".repeat(64) }; host.containers.set(duplicate.id, duplicate);
    workers[0]!.status = "completed"; await expect(service().retire(workers[0]!)).rejects.toThrow("explicit ownership review"); expect(host.removed).toEqual([]);
  });
  it("validates creation input and preserves resources for malformed durable ownership", async () => {
    expect(() => validateContainerInput({ image: "ubuntu:24.04", name: "test", command: [], flags: ["--privileged"] })).toThrow("arbitrary Docker options");
    await fs.writeFile(path.join(directory, "forge-disposable-resources.json"), JSON.stringify({ resources: [{ id: randomUUID() }], terminalWorkers: [] }));
    await expect(resources.preview()).rejects.toThrow("journal is invalid"); expect(host.removed).toEqual([]);
  });
  it("reuses reviewed manual cleanup for resource outcomes, stale activity and partial failures", async () => {
    const first = await create(); await create("second"); workers[0]!.status = "completed";
    host.failure = "remove"; await expect(resources.retire(workers[0]!)).rejects.toThrow("denied"); host.failure = undefined;
    const forge = {
      dashboard: async () => ({ configured: true, workers: structuredClone(workers) }),
      withCompletedWorkerResources: async (_ids: string[], operation: () => Promise<void>) => {
        if (workers.some(item => item.status !== "completed")) throw new Error("Active worker protected by lifecycle owner");
        await operation();
      },
    } as unknown as ForgeWorkflowService;
    const cleanup = new WorkspaceCleanupService({ dataDir: directory, pathPolicy: new PathPolicy([directory]), resources, forge,
      openDirectories: () => [], withInactiveDirectory: async (_path, operation) => operation(), processDirectories: async () => [], protectedDirectories: [], trashDirectory: path.join(directory, "trash") });
    const app = Fastify(); registerWorkspaceCleanupRoutes(app, cleanup, ["http://cloudx.test"]);
    try {
      const preview = await cleanup.preview();
      expect(preview.candidates.map(item => item.kind)).toEqual(["resource", "resource"]);
      expect(preview.reclaimableBytes).toBe(2 * 1024 * 1024);
      expect(preview.resourceOutcomes?.every(item => item.state === "failed" && item.remainingBytes === 1024 * 1024)).toBe(true);
      const request = { previewId: preview.id, candidateIds: preview.candidates.map(item => item.id), discardCandidateIds: [], emptyTrash: false, confirmation: "Delete permanently" as const };
      expect((await app.inject({ method: "POST", url: "/api/system/workspace-cleanup", headers: { origin: "http://cloudx.test" }, payload: { ...request, confirmation: "cancel" } })).statusCode).toBe(400);
      expect(host.removed).toEqual([]);
      const remove = host.remove.bind(host); host.remove = async id => { if (id === first.containerId) throw new Error("fixture denied"); await remove(id); };
      expect((await app.inject({ method: "POST", url: "/api/system/workspace-cleanup", headers: { origin: "http://cloudx.test" }, payload: request })).statusCode).toBe(202);
      await cleanup.settled();
      expect((await cleanup.status())?.results.map(item => item.status)).toEqual(["failed", "deleted"]);
      expect((await cleanup.status())?.results[1]).toMatchObject({ remainingBytes: 0, reclaimedBytes: 1024 * 1024 });
      host.remove = remove;
      const next = await cleanup.preview(); workers[0]!.status = "running";
      await cleanup.start({ ...request, previewId: next.id, candidateIds: next.candidates.map(item => item.id) }); await cleanup.settled();
      expect((await cleanup.status())?.results[0]!.status).toBe("failed");
      expect(host.containers.has(first.containerId!)).toBe(true);
    } finally { await cleanup.settled(); await app.close(); }
  });
  it("an unpublished checkout blocker does not indefinitely retain a disposable shared environment", async () => {
    const shared = worker(); workers.push(shared);
    await create("shared-source-blocker", { consumers: [{ workerId: shared.id, attemptId: shared.attemptId! }] });
    workers[0]!.status = "completed"; await expect(resources.retire(workers[0]!)).rejects.toThrow("shared consumer");
    workers[0]!.status = "cleanup_failed"; workers[0]!.error = "Unpublished source checkout retained";
    shared.status = "completed"; await resources.retire(shared);
    expect(host.removed).toHaveLength(1);
    expect(workers[0]!.error).toBe("Unpublished source checkout retained");
  });
  it("the HTTP creation boundary checks origin, exact attempt and specification before host creation", async () => {
    const workflow = { withRunningWorkerResources: vi.fn(async (id: string, attempt: string, operation: (worker: ForgeWorker) => Promise<unknown>) => {
      if (id !== workers[0]!.id || attempt !== workers[0]!.attemptId) throw new Error("current attempt required");
      return operation(workers[0]!);
    }) } as unknown as ForgeWorkflowService;
    const app = Fastify(); registerForgeDisposableResourceRoutes(app, resources, workflow, ["http://cloudx.test"]);
    const url = `/api/forge/workers/${workers[0]!.id}/resources`; const payload = { attemptId: workers[0]!.attemptId, image: "ubuntu:24.04", name: "owned", command: ["true"] };
    try {
      expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, payload: { ...payload, flags: ["--privileged"] }, headers: { origin: "http://cloudx.test" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url, payload: { ...payload, attemptId: randomUUID() }, headers: { origin: "http://cloudx.test" } })).statusCode).toBe(409);
      expect(host.containers.size).toBe(0);
      expect((await app.inject({ method: "POST", url, payload, headers: { origin: "http://cloudx.test" } })).statusCode).toBe(201);
      expect((await app.inject("/api/forge/resources")).json().resources).toHaveLength(1);
    } finally { await app.close(); }
  });
});

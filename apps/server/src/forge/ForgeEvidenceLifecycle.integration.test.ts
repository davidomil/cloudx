import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { EvidenceSink } from "./ForgeContainerEvidence.js";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { DisposableResource, ForgeWorker } from "@cloudx/shared";
import { JsonStateFile } from "../jsonStateFile.js";
import { PluginDataStore } from "../plugins/PluginDataStore.js";
import { NotificationsPlugin } from "../plugins/NotificationsPlugin.js";
import { ForgeDisposableResources, type ContainerIdentity, type DisposableContainerHost } from "./ForgeDisposableResources.js";
import { ForgeWorkflowService, type ForgeWorkflowDependencies } from "./ForgeWorkflowService.js";
import { ForgeWorkerReports, ForgeWorkflowStore } from "./ForgeWorkflowStore.js";

const repository = { provider: "github" as const, apiUrl: "https://api.github.com", projectPath: "fixture/cloudx" };
const committedHead = "a".repeat(40);
const evidencePath = "/work/evidence/test.log";
const evidenceBytes = Buffer.from("validation passed\n");
const writableBytes = 4 * 1024 * 1024;

describe("Completed Forge evidence lifecycle", () => {
  it.each(["issue", "review"] as const)("announces an unchanged %s cleanup hold once across forced checks, dismissal, timed checks and restart", async kind => {
    const owner = completedWorker(kind);
    const resource = savedEnvironment(owner);
    const fixture = await EvidenceLifecycleFixture.create([owner], [resource], true);
    onTestFinished(() => { vi.useRealTimers(); });
    await fixture.workflow.poll();

    const [notification] = fixture.notifications.list();
    expect(notification).toMatchObject({ title: "Forge disposable cleanup needs attention", body: expect.stringContaining("requires review") });
    expect(fixture.notifications.list()).toHaveLength(1);
    const announced = (await fixture.store.read())[0]!.resourceCleanupNotificationDigest;
    expect(announced).toMatch(/^[a-f0-9]{64}$/u);
    fixture.notifications.dismiss(notification!.id);

    await fixture.workflow.reconcileResourceCleanup();
    vi.setSystemTime(Date.now() + 31_000);
    await fixture.workflow.poll();
    await fixture.restart();
    await fixture.workflow.poll();
    expect(fixture.cleanupResources).toHaveBeenCalledTimes(4);
    expect(fixture.notifications.list()).toEqual([]);
    expect((await fixture.workflow.dashboard()).workers[0]).toMatchObject({ status: "completed", error: expect.stringContaining("requires review"),
      resourceCleanupNotificationDigest: announced });
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "blocked" });
    expect(fixture.host.containers.get(resource.containerId!)?.running).toBe(false);
    expect(fixture.host.removed).toEqual([]);
  });

  it("announces a materially changed cleanup blocker once and still converges after evidence release", async () => {
    const owner = completedWorker();
    const resource = savedEnvironment(owner);
    const fixture = await EvidenceLifecycleFixture.create([owner], [resource], true);
    await fixture.workflow.poll();
    const originalDigest = (await fixture.store.read())[0]!.resourceCleanupNotificationDigest;
    fixture.notifications.dismissAll();

    fixture.host.engine = "changed-engine";
    await fixture.workflow.reconcileResourceCleanup();
    expect(fixture.notifications.list()).toHaveLength(1);
    expect(fixture.notifications.list()[0]?.body).toContain("engine identity changed");
    const changedDigest = (await fixture.store.read())[0]!.resourceCleanupNotificationDigest;
    expect(changedDigest).not.toBe(originalDigest);
    fixture.notifications.dismissAll();
    await fixture.workflow.reconcileResourceCleanup();
    await fixture.restart();
    await fixture.workflow.poll();
    expect(fixture.notifications.list()).toEqual([]);
    expect((await fixture.store.read())[0]?.resourceCleanupNotificationDigest).toBe(changedDigest);
    expect(fixture.host.removed).toEqual([]);

    fixture.host.engine = "fixture-engine";
    await fixture.workflow.withCompletedWorkerResources([owner.id], () => fixture.resources.decideEvidence(resource.id,
      { action: "export", evidencePaths: [evidencePath], commitSha: committedHead }));
    await fixture.workflow.reconcileResourceCleanup();
    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.host.removed).toEqual([resource.containerId]);
    expect(await buffer(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1)))).toEqual(evidenceBytes);
    expect(fixture.notifications.list()).toEqual([]);
  });

  it("clears the announced blocker after resource release even when working files retain the completed worker", async () => {
    const owner = { ...completedWorker(), retainedWorkspace: { worktreePath: "/owned/checkout", retainedPaths: ["notes.txt"] } };
    const resource = savedEnvironment(owner);
    const fixture = await EvidenceLifecycleFixture.create([owner], [resource], true);
    await fixture.workflow.poll();
    expect((await fixture.store.read())[0]?.resourceCleanupNotificationDigest).toMatch(/^[a-f0-9]{64}$/u);
    fixture.notifications.dismissAll();

    await fixture.workflow.withCompletedWorkerResources([owner.id], () => fixture.resources.decideEvidence(resource.id,
      { action: "export", evidencePaths: [evidencePath], commitSha: committedHead }));
    await fixture.workflow.reconcileResourceCleanup();
    const [retained] = await fixture.store.read();
    expect(retained).toMatchObject({ status: "completed", retainedWorkspace: owner.retainedWorkspace });
    expect(retained?.error).toBeUndefined();
    expect(retained?.resourceCleanupNotificationDigest).toBeUndefined();
    expect(fixture.host.removed).toEqual([resource.containerId]);
    await fixture.restart();
    await fixture.workflow.poll();
    expect((await fixture.store.read())[0]?.resourceCleanupNotificationDigest).toBeUndefined();
    expect(fixture.notifications.list()).toEqual([]);
  });

  it.each(["issue", "review"] as const)("reconciles a saved completed %s worker's earlier attempts and preserves durable evidence after removal", async kind => {
    const owner = completedWorker(kind);
    const first = savedEnvironment(owner, true);
    const second = savedEnvironment(owner, true);
    const fixture = await EvidenceLifecycleFixture.create([owner], [first, second], true);
    await fixture.workflow.poll();

    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.host.removed).toEqual([first.containerId, second.containerId]);
    expect(fixture.host.stopped).toEqual([first.containerId, second.containerId]);
    expect((await fixture.resources.records()).map(resource => [resource.state, resource.reclaimedBytes, resource.evidence?.state]))
      .toEqual([["deleted", writableBytes, "verified"], ["deleted", writableBytes, "verified"]]);
    const manifest = await fixture.resources.readEvidence(first.id);
    expect(manifest).toMatchObject({ owner: first.owner, consumers: first.consumers, engineId: first.engineId,
      containerId: first.containerId, created: first.created, commitSha: committedHead, commitSource: "worker",
      paths: [evidencePath], bytes: evidenceBytes.length, files: [{ path: evidencePath.slice(1), bytes: evidenceBytes.length }] });
    expect(await buffer(await fixture.resources.evidenceFile(first.id, evidencePath.slice(1)))).toEqual(evidenceBytes);
    expect(await fixture.reports.read(owner.attemptId!)).toMatchObject({ title: owner.title, body: "Saved validation report" });
    expect(fixture.provider.getIssue).toHaveBeenCalledTimes(kind === "issue" ? 1 : 0);

    await fixture.restart();
    await fixture.workflow.reconcileResourceCleanup();
    expect((await fixture.workflow.dashboard()).workers).toEqual([]);
    expect(await buffer(await fixture.resources.evidenceFile(first.id, evidencePath.slice(1)))).toEqual(evidenceBytes);
    expect(fixture.host.exports).toHaveLength(2);
    expect(fixture.host.removed).toHaveLength(2);
  });

  it.each(["export", "discard"] as const)("stops a saved legacy hold, persists keep, then reconciles a reviewed %s decision after restart", async action => {
    const owner = completedWorker();
    const resource = savedEnvironment(owner);
    const fixture = await EvidenceLifecycleFixture.create([owner], [resource], true);
    await fixture.workflow.poll();
    expect((await fixture.store.read())[0]).toMatchObject({ status: "completed", error: expect.stringContaining("Disposable resource cleanup pending:") });
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "blocked", reason: expect.stringContaining("requires review") });
    expect(fixture.host.containers.get(resource.containerId!)?.running).toBe(false);
    expect(fixture.host.removed).toEqual([]);
    expect(fixture.notifications.list()).toHaveLength(1);
    const announced = (await fixture.store.read())[0]!.resourceCleanupNotificationDigest;
    fixture.notifications.dismissAll();

    await fixture.workflow.withCompletedWorkerResources([owner.id], () => fixture.resources.decideEvidence(resource.id, { action: "keep" }));
    await fixture.restart();
    await fixture.workflow.reconcileResourceCleanup();
    expect((await fixture.resources.records())[0]).toMatchObject({ evidence: { state: "kept" }, reason: expect.stringContaining("explicitly kept") });
    expect((await fixture.store.read())[0]?.error).toContain("explicitly kept");
    expect((await fixture.store.read())[0]?.resourceCleanupNotificationDigest).toBe(announced);
    await fixture.workflow.reconcileResourceCleanup();
    expect(fixture.notifications.list()).toEqual([]);
    await fixture.workflow.withCompletedWorkerResources([owner.id], () => fixture.resources.decideEvidence(resource.id,
      action === "export" ? { action, evidencePaths: [evidencePath], commitSha: committedHead } : { action, confirmation: "Discard evidence" }));

    await fixture.restart();
    await fixture.workflow.reconcileResourceCleanup();
    expect(await fixture.store.read()).toEqual([]);
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "deleted", reclaimedBytes: writableBytes,
      evidence: { state: action === "export" ? "verified" : "discarded" } });
    expect(fixture.host.removed).toEqual([resource.containerId]);
    expect(fixture.notifications.list()).toEqual([]);
    if (action === "export") {
      expect(await fixture.resources.readEvidence(resource.id)).toMatchObject({ commitSha: committedHead, commitSource: "declared" });
      expect(await buffer(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1)))).toEqual(evidenceBytes);
    } else {
      await expect(fixture.resources.readEvidence(resource.id)).rejects.toThrow("No verified durable evidence");
      expect(fixture.host.exports).toEqual([]);
    }
  });

  it.each(["export", "remove"] as const)("recovers a completed worker after %s interruption without losing its evidence", async failure => {
    const owner = completedWorker();
    const resource = savedEnvironment(owner, true);
    const fixture = await EvidenceLifecycleFixture.create([owner], [resource]);
    fixture.host.failure = failure;
    await fixture.workflow.poll();

    expect((await fixture.store.read())[0]).toMatchObject({ status: "completed", error: expect.stringContaining(`${failure} interrupted`) });
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "failed", evidence: { state: failure === "export" ? "pending" : "verified" } });
    expect(fixture.host.containers.get(resource.containerId!)?.running).toBe(false);
    expect(fixture.host.removed).toEqual([]);
    if (failure === "remove") expect(await buffer(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1)))).toEqual(evidenceBytes);

    fixture.host.failure = undefined;
    await fixture.restart();
    await fixture.workflow.reconcileResourceCleanup();
    expect(await fixture.store.read()).toEqual([]);
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "deleted", reclaimedBytes: writableBytes, evidence: { state: "verified" } });
    expect(await buffer(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1)))).toEqual(evidenceBytes);
    expect(fixture.host.exports).toHaveLength(failure === "export" ? 2 : 1);
    expect(fixture.host.removed).toEqual([resource.containerId]);
  });

  it("keeps the container and worker across restart until the renamed evidence archive directory is durable", async () => {
    const owner = completedWorker();
    const resource = savedEnvironment(owner, true);
    const fixture = await EvidenceLifecycleFixture.create([owner], [resource]);
    const namespace = path.join(fixture.directory, "forge-evidence");
    const originalOpen = fs.open.bind(fs);
    const failures: ReturnType<typeof vi.spyOn>[] = [];
    let syncAttempts = 0;
    let deviceAvailable = false;
    const intercept = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === namespace) {
        const sync = handle.sync.bind(handle);
        failures.push(vi.spyOn(handle, "sync").mockImplementation(async () => {
          syncAttempts++;
          if (!deviceAvailable) throw new Error("Container archive directory sync failed");
          await sync();
        }));
      }
      return handle;
    });
    try {
      await fixture.workflow.poll();
      expect((await fixture.resources.records())[0]).toMatchObject({ state: "failed", evidence: { state: "exporting" }, reason: "Container archive directory sync failed" });
      expect(await fs.readFile(path.join(namespace, resource.id, "manifest.json"), "utf8")).toContain(resource.id);
      expect(fixture.host.removed).toEqual([]);
      const failedAttempts = syncAttempts;
      await fixture.restart();
      await fixture.workflow.poll();
      expect((await fixture.store.read())[0]?.id).toBe(owner.id);
      expect((await fixture.resources.records())[0]?.state).toBe("failed");
      expect(fixture.host.removed).toEqual([]);
      expect(syncAttempts).toBeGreaterThan(failedAttempts);
      expect(fixture.host.exports).toHaveLength(1);

      deviceAvailable = true;
      await fixture.workflow.reconcileResourceCleanup();
      expect(await fixture.store.read()).toEqual([]);
      expect(fixture.host.removed).toEqual([resource.containerId]);
      expect(fixture.host.exports).toHaveLength(1);
      await fixture.restart();
      expect(await buffer(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1)))).toEqual(evidenceBytes);
    } finally { intercept.mockRestore(); for (const failure of failures) failure.mockRestore(); }
  });

  it.each([16 * 1024 * 1024 + 1, 23_754_142, 32 * 1024 * 1024 + 1, 34_048_143])("streams a %i-byte report through completion and keeps its verified provenance after restart", async bytes => {
    const owner = completedWorker();
    const resource = savedEnvironment(owner, true);
    const fixture = await EvidenceLifecycleFixture.create([owner], [resource]);
    fixture.host.reportBytes = bytes;
    await fixture.workflow.poll();
    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.host.removed).toEqual([resource.containerId]);
    const manifest = await fixture.resources.readEvidence(resource.id);
    expect(manifest).toMatchObject({ owner: resource.owner, consumers: resource.consumers, commitSha: committedHead, bytes,
      files: [{ path: evidencePath.slice(1), bytes }] });
    await fixture.restart();
    let downloaded = 0;
    const hash = createHash("sha256");
    for await (const chunk of await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1))) { downloaded += chunk.length; hash.update(chunk); }
    expect(downloaded).toBe(bytes);
    expect(hash.digest("hex")).toBe(manifest.files[0]!.sha256);
    await fixture.workflow.poll();
    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.host.exports).toHaveLength(1);
  });

  it("protects partial reports without recording a false export intent and retries successfully after restart", async () => {
    const owner = completedWorker();
    const resource = savedEnvironment(owner, true);
    const fixture = await EvidenceLifecycleFixture.create([owner], [resource]);
    fixture.host.reportBytes = 34_048_143;
    fixture.host.partialExport = true;
    await fixture.workflow.poll();
    expect((await fixture.store.read())[0]?.error).toContain("report stream interrupted");
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "failed", evidence: { state: "pending" } });
    expect((await fixture.resources.records())[0]?.evidence?.manifestSha256).toBeUndefined();
    expect(fixture.host.removed).toEqual([]);
    expect(await fs.readdir(path.join(fixture.directory, "forge-evidence"))).toEqual([]);
    fixture.host.partialExport = false;
    await fixture.restart();
    await fixture.workflow.poll();
    expect(await fixture.store.read()).toEqual([]);
    expect(await fixture.resources.readEvidence(resource.id)).toMatchObject({ bytes: 34_048_143 });
    expect(fixture.host.removed).toEqual([resource.containerId]);
  });

  it("rejects an unexportable selection before its export intent is accepted", async () => {
    const owner = completedWorker();
    const resource = savedEnvironment(owner, true);
    const fixture = await EvidenceLifecycleFixture.create([owner], [resource]);
    fixture.host.reportBytes = 256 * 1024 * 1024 + 1;
    await fixture.workflow.poll();
    expect((await fixture.store.read())[0]?.error).toContain("bounded storage limit");
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "failed", evidence: { state: "pending" } });
    expect((await fixture.resources.records())[0]?.evidence?.manifestSha256).toBeUndefined();
    expect(fixture.host.removed).toEqual([]);
    expect(await fs.readdir(path.join(fixture.directory, "forge-evidence"))).toEqual([]);
  });

  it("preserves a shared environment until every batch issue closes and its active tab quiesces", async () => {
    const owner = completedWorker();
    const batch = { ...completedWorker(), number: 2, status: "paused" as const, tabId: "batch-tab", batch: { issues: [
      { number: 2, title: "First member", url: "https://example.test/2", state: "closed" as const },
      { number: 3, title: "Second member", url: "https://example.test/3", state: "open" as const },
    ] } };
    const resource = savedEnvironment(owner, true);
    resource.consumers.push({ workerId: batch.id, attemptId: batch.attemptId! });
    const fixture = await EvidenceLifecycleFixture.create([owner, batch], [resource]);
    fixture.issueStates.set(3, "open");
    fixture.activeTabs.add(batch.tabId);
    await fixture.workflow.poll();

    expect((await fixture.resources.records())[0]).toMatchObject({ state: "blocked", reason: expect.stringContaining("shared consumer") });
    expect(fixture.host.containers.get(resource.containerId!)?.running).toBe(true);
    expect(fixture.host.stopped).toEqual([]);
    expect(fixture.host.exports).toEqual([]);
    await expect(fixture.workflow.withCompletedWorkerResources([owner.id, batch.id], () => fixture.resources.decideEvidence(resource.id,
      { action: "discard", confirmation: "Discard evidence" }))).rejects.toThrow("active or unfinished consumer");
    expect(fixture.host.removed).toEqual([]);

    fixture.issueStates.set(3, "closed");
    await fixture.workflow.reconcileResourceCleanup();
    await fixture.workflow.reconcileResourceCleanup();
    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.activeTabs.size).toBe(0);
    expect(fixture.host.events.indexOf("close:batch-tab")).toBeLessThan(fixture.host.events.indexOf(`stop:${resource.containerId}`));
    expect(fixture.host.removed).toEqual([resource.containerId]);
    expect(await buffer(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1)))).toEqual(evidenceBytes);
  });
});

function completedWorker(kind: ForgeWorker["kind"] = "issue"): ForgeWorker {
  const timestamp = new Date().toISOString();
  return { id: randomUUID(), attemptId: randomUUID(), repository, kind, number: kind === "review" ? 7 : 1,
    title: `Saved ${kind} worker`, status: "completed", baseBranch: "main", templateId: "worker", autoPost: false,
    headSha: committedHead, startedAt: timestamp, updatedAt: timestamp };
}

function savedEnvironment(worker: ForgeWorker, selectedEvidence = false): DisposableResource {
  const owner = { workerId: worker.id, attemptId: randomUUID() };
  return { id: randomUUID(), kind: "container", engineId: "fixture-engine", containerId: randomUUID().replaceAll("-", "").repeat(2),
    created: new Date().toISOString(), name: "saved-validation-environment", owner, consumers: [owner],
    retentionReason: "Preserve the specific validation log; dependencies and build outputs are disposable.",
    ...(selectedEvidence ? { evidence: { state: "pending" as const, paths: [evidencePath], commitSha: committedHead, commitSource: "worker" as const } } : {}),
    state: "blocked", reason: "Explicit evidence retention", allocatedBytes: writableBytes, reclaimedBytes: 0, updatedAt: new Date().toISOString() };
}

class SavedContainerHost implements DisposableContainerHost {
  readonly containers = new Map<string, ContainerIdentity>();
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
  readonly exports: string[] = [];
  readonly events: string[] = [];
  failure?: "export" | "remove";
  reportBytes?: number;
  partialExport = false;
  async *reportStream() {
    let remaining = this.reportBytes!;
    while (remaining) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining), 0x61);
      remaining -= chunk.length;
      yield chunk;
      if (this.partialExport) throw new Error("report stream interrupted");
    }
  }
  engine = "fixture-engine";
  engineId = async () => this.engine;
  create = async (): Promise<string> => { throw new Error("This fixture loads existing containers; creation is forbidden."); };
  find = async (resourceId: string) => [...this.containers.values()].filter(item => item.labels["cloudx.forge.resource"] === resourceId).map(item => item.id);
  inspect = async (id: string) => structuredClone(this.containers.get(id));
  async stop(id: string): Promise<void> { this.events.push(`stop:${id}`); this.stopped.push(id); this.containers.get(id)!.running = false; }
  async remove(id: string): Promise<void> {
    this.events.push(`remove:${id}`);
    if (this.failure === "remove") throw new Error("remove interrupted");
    this.containers.delete(id); this.removed.push(id);
  }
  async readEvidence(id: string, paths: string[], write: EvidenceSink) {
    this.events.push(`export:${id}`); this.exports.push(id);
    if (this.failure === "export") throw new Error("export interrupted");
    if (this.reportBytes !== undefined) await write(paths[0]!.slice(1), this.reportStream(), this.reportBytes);
    else if (paths.includes(evidencePath)) await write(evidencePath.slice(1), Readable.from([evidenceBytes]), evidenceBytes.length);
  }
}

class EvidenceLifecycleFixture {
  readonly host = new SavedContainerHost();
  readonly notifications = new NotificationsPlugin();
  readonly cleanupResources = vi.fn((worker: ForgeWorker) => this.resources.retire(worker));
  readonly reports: ForgeWorkerReports;
  readonly issueStates = new Map<number, "open" | "closed">();
  readonly activeTabs = new Set<string>();
  readonly provider = {
    getIssue: vi.fn(async (number: number) => ({ number, title: `Issue ${number}`, body: "", state: this.issueStates.get(number) ?? "closed", comments: [] })),
    getChangeRequestStatus: vi.fn(async (number: number) => ({ number, merged: true, state: "merged", headSha: committedHead, headBranch: "worker-branch", baseBranch: "main" })),
  };
  store!: ForgeWorkflowStore;
  resources!: ForgeDisposableResources;
  workflow!: ForgeWorkflowService;
  private constructor(readonly directory: string) { this.reports = new ForgeWorkerReports(directory); }

  static async create(workers: ForgeWorker[], resources: DisposableResource[], terminalReceipts = false): Promise<EvidenceLifecycleFixture> {
    const fixture = new EvidenceLifecycleFixture(await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-forge-evidence-lifecycle-")));
    onTestFinished(async () => { await fixture.workflow?.dispose(); await fs.rm(fixture.directory, { recursive: true, force: true }); });
    await new ForgeWorkflowStore(new PluginDataStore(fixture.directory)).write(workers);
    await new JsonStateFile(fixture.directory, "forge-disposable-resources.json", "Fixture resource journal").write({ resources,
      terminalWorkers: terminalReceipts ? resources.flatMap(resource => resource.consumers) : [] });
    for (const worker of workers) {
      const report = await fixture.reports.prepare(worker.attemptId!, { item: { number: worker.number } });
      await fs.writeFile(report.reportPath, JSON.stringify({ kind: worker.kind, title: worker.title, body: "Saved validation report" }));
    }
    for (const resource of resources) fixture.host.containers.set(resource.containerId!, { id: resource.containerId!, created: resource.created!, running: true,
      writableBytes, labels: { "cloudx.forge.resource": resource.id, "cloudx.forge.worker": resource.owner.workerId, "cloudx.forge.attempt": resource.owner.attemptId } });
    await fixture.restart();
    return fixture;
  }

  async restart(): Promise<void> {
    await this.workflow?.dispose();
    this.store = new ForgeWorkflowStore(new PluginDataStore(this.directory));
    this.resources = new ForgeDisposableResources(this.directory, async () => (await this.workflow.dashboard()).workers, this.host);
    this.workflow = new ForgeWorkflowService({
      store: this.store, reports: this.reports, provider: () => this.provider,
      settings: () => ({ repository, baseBranch: "main", workerTemplateId: "worker", reviewTemplateId: "review", maxRunMinutes: 60 }),
      runtime: { recover: async () => ({ tabIds: [] }), isActive: (tabId: string) => this.activeTabs.has(tabId),
        close: async (tabId: string) => { this.host.events.push(`close:${tabId}`); this.activeTabs.delete(tabId); } },
      cleanupDisposableResources: this.cleanupResources,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      notify: (title: string, body: string) => this.notifications.send({ title, body }),
    } as unknown as ForgeWorkflowDependencies);
  }
}

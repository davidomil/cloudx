import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { DisposableResource, ForgeWorker } from "@cloudx/shared";
import { JsonStateFile } from "../jsonStateFile.js";
import { PluginDataStore } from "../plugins/PluginDataStore.js";
import { ForgeDisposableResources, type ContainerIdentity, type DisposableContainerHost } from "./ForgeDisposableResources.js";
import { ForgeWorkflowService, type ForgeWorkflowDependencies } from "./ForgeWorkflowService.js";
import { ForgeWorkerReports, ForgeWorkflowStore } from "./ForgeWorkflowStore.js";

const repository = { provider: "github" as const, apiUrl: "https://api.github.com", projectPath: "fixture/cloudx" };
const committedHead = "a".repeat(40);
const evidencePath = "/work/evidence/test.log";
const evidenceBytes = Buffer.from("validation passed\n");
const writableBytes = 4 * 1024 * 1024;

describe("Completed Forge evidence lifecycle", () => {
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
    expect(await fixture.resources.evidenceFile(first.id, evidencePath.slice(1))).toEqual(evidenceBytes);
    expect(await fixture.reports.read(owner.attemptId!)).toMatchObject({ title: owner.title, body: "Saved validation report" });
    expect(fixture.provider.getIssue).toHaveBeenCalledTimes(kind === "issue" ? 1 : 0);

    await fixture.restart();
    await fixture.workflow.reconcileResourceCleanup();
    expect((await fixture.workflow.dashboard()).workers).toEqual([]);
    expect(await fixture.resources.evidenceFile(first.id, evidencePath.slice(1))).toEqual(evidenceBytes);
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

    await fixture.workflow.withCompletedWorkerResources([owner.id], () => fixture.resources.decideEvidence(resource.id, { action: "keep" }));
    await fixture.restart();
    await fixture.workflow.reconcileResourceCleanup();
    expect((await fixture.resources.records())[0]).toMatchObject({ evidence: { state: "kept" }, reason: expect.stringContaining("explicitly kept") });
    expect((await fixture.store.read())[0]?.error).toContain("explicitly kept");
    await fixture.workflow.withCompletedWorkerResources([owner.id], () => fixture.resources.decideEvidence(resource.id,
      action === "export" ? { action, evidencePaths: [evidencePath], commitSha: committedHead } : { action, confirmation: "Discard evidence" }));

    await fixture.restart();
    await fixture.workflow.reconcileResourceCleanup();
    expect(await fixture.store.read()).toEqual([]);
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "deleted", reclaimedBytes: writableBytes,
      evidence: { state: action === "export" ? "verified" : "discarded" } });
    expect(fixture.host.removed).toEqual([resource.containerId]);
    if (action === "export") {
      expect(await fixture.resources.readEvidence(resource.id)).toMatchObject({ commitSha: committedHead, commitSource: "declared" });
      expect(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1))).toEqual(evidenceBytes);
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
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "failed", evidence: { state: failure === "export" ? "exporting" : "verified" } });
    expect(fixture.host.containers.get(resource.containerId!)?.running).toBe(false);
    expect(fixture.host.removed).toEqual([]);
    if (failure === "remove") expect(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1))).toEqual(evidenceBytes);

    fixture.host.failure = undefined;
    await fixture.restart();
    await fixture.workflow.reconcileResourceCleanup();
    expect(await fixture.store.read()).toEqual([]);
    expect((await fixture.resources.records())[0]).toMatchObject({ state: "deleted", reclaimedBytes: writableBytes, evidence: { state: "verified" } });
    expect(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1))).toEqual(evidenceBytes);
    expect(fixture.host.exports).toHaveLength(failure === "export" ? 2 : 1);
    expect(fixture.host.removed).toEqual([resource.containerId]);
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
    expect(await fixture.resources.evidenceFile(resource.id, evidencePath.slice(1))).toEqual(evidenceBytes);
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
  engineId = async () => "fixture-engine";
  create = async (): Promise<string> => { throw new Error("This fixture loads existing containers; creation is forbidden."); };
  find = async (resourceId: string) => [...this.containers.values()].filter(item => item.labels["cloudx.forge.resource"] === resourceId).map(item => item.id);
  inspect = async (id: string) => structuredClone(this.containers.get(id));
  async stop(id: string): Promise<void> { this.events.push(`stop:${id}`); this.stopped.push(id); this.containers.get(id)!.running = false; }
  async remove(id: string): Promise<void> {
    this.events.push(`remove:${id}`);
    if (this.failure === "remove") throw new Error("remove interrupted");
    this.containers.delete(id); this.removed.push(id);
  }
  async readEvidence(id: string, paths: string[]) {
    this.events.push(`export:${id}`); this.exports.push(id);
    if (this.failure === "export") throw new Error("export interrupted");
    return paths.includes(evidencePath) ? [{ path: evidencePath.slice(1), data: evidenceBytes }] : [];
  }
}

class EvidenceLifecycleFixture {
  readonly host = new SavedContainerHost();
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
      cleanupDisposableResources: (worker: ForgeWorker) => this.resources.retire(worker),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, notify: vi.fn(),
    } as unknown as ForgeWorkflowDependencies);
  }
}

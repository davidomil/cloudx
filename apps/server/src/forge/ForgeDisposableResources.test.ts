import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeWorker } from "@cloudx/shared";
import { ForgeDisposableResources, validateContainerInput, type ContainerIdentity, type DisposableContainerHost, type DisposableContainerInput } from "./ForgeDisposableResources.js";
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
}

describe("Forge disposable resource ownership and lifecycle", () => {
  let directory: string;
  let workers: ForgeWorker[];
  let host: ContainerHost;
  let resources: ForgeDisposableResources;
  const worker = (): ForgeWorker => ({ id: randomUUID(), attemptId: randomUUID(), kind: "issue", number: 128, title: "test", repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "test/project" }, baseBranch: "main", templateId: "test", status: "running", autoPost: false, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const create = (name = "cloudx-128-feedback", extra: Partial<DisposableContainerInput> = {}) => resources.create(workers[0]!, { image: "ubuntu:24.04", name, command: ["true"], ...extra });
  const service = () => new ForgeDisposableResources(directory, async () => structuredClone(workers), host);
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-resources-")); workers = [worker()]; host = new ContainerHost(); resources = service(); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

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
    await create("evidence", { retentionReason: "Retain the failing database until its owner reviews it." }); workers[0]!.status = "completed";
    await expect(resources.retire(workers[0]!)).rejects.toThrow("Explicit evidence retention");
    expect((await resources.preview())[0]!.reason).toContain("failing database"); expect(host.removed).toEqual([]);
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

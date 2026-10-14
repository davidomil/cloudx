import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeWorker } from "@cloudx/shared";
import { ForgeDisposableResources, ForgeEvidenceCompletenessError, type ContainerIdentity, type DisposableContainerHost } from "./ForgeDisposableResources.js";
import { registerForgeDisposableResourceRoutes } from "./ForgeDisposableResourceRoutes.js";
import type { ForgeWorkflowService } from "./ForgeWorkflowService.js";

describe("Forge evidence review routes", () => {
  let root: string;
  let app: ReturnType<typeof Fastify>;
  let resources: ForgeDisposableResources;
  let worker: ForgeWorker;
  let workers: ForgeWorker[];
  let host: DisposableContainerHost;
  let container: ContainerIdentity | undefined;
  let guard: ReturnType<typeof vi.fn>;
  let runningGuard: ReturnType<typeof vi.fn>;
  let reconcile: ReturnType<typeof vi.fn>;
  const origin = "http://localhost:3000";
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-route-"));
    worker = { id: randomUUID(), attemptId: randomUUID(), kind: "issue", number: 177, title: "Evidence", status: "running", headSha: "a".repeat(40), repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "fixture/repository" }, baseBranch: "main", templateId: "fixture", autoPost: false, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    workers = [worker];
    host = {
      engineId: async () => "fixture-engine",
      create: async (_input, labels) => {
        container = { id: "a".repeat(64), created: new Date().toISOString(), labels, running: true, writableBytes: 8192 };
        return container.id;
      },
      find: async () => container ? [container.id] : [],
      inspect: async () => structuredClone(container),
      stop: async () => { container!.running = false; },
      remove: async () => { container = undefined; },
      readEvidence: async (_id, _paths, write) => { const data = Buffer.from("regression passes\n"); await write("work/evidence/test.log", Readable.from([data]), data.length); },
    };
    resources = new ForgeDisposableResources(root, async () => workers, host);
    guard = vi.fn(async (_ids: string[], operation: () => Promise<unknown>) => operation());
    runningGuard = vi.fn(async (id: string, attemptId: string, operation: (current: ForgeWorker) => Promise<unknown>) => {
      const current = workers.find(item => item.id === id);
      if (!current || current.attemptId !== attemptId || !["running", "starting"].includes(current.status))
        throw new Error("Only the current active worker attempt can manage disposable environments.");
      return operation(structuredClone(current));
    });
    reconcile = vi.fn(async () => {});
    app = Fastify();
    registerForgeDisposableResourceRoutes(app, resources, { withCompletedWorkerResources: guard, withRunningWorkerResources: runningGuard, reconcileResourceCleanup: reconcile } as unknown as ForgeWorkflowService, [origin]);
  });
  afterEach(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function held() {
    const resource = await resources.create(worker, { name: "evidence", image: "fixture:latest", command: ["true"], retentionReason: "Keep the regression log", evidencePaths: ["/work/evidence/test.log"] });
    const journalPath = path.join(root, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    delete journal.resources[0].evidence;
    await fs.writeFile(journalPath, JSON.stringify(journal));
    worker.status = "completed";
    await expect(resources.retire(worker)).rejects.toThrow("evidence");
    return resource;
  }
  function decision(id: string, payload: unknown, requestOrigin: string | undefined = origin) {
    return app.inject({ method: "POST", url: `/api/forge/resources/${id}/evidence-decision`, headers: requestOrigin ? { origin: requestOrigin } : {}, payload });
  }
  function selection(resourceId: string, payload: unknown, ownerId = worker.id, requestOrigin: string | undefined = origin) {
    return app.inject({ method: "POST", url: `/api/forge/workers/${ownerId}/resources/${resourceId}/evidence-selection`, headers: requestOrigin ? { origin: requestOrigin } : {}, payload });
  }
  it("lets the active owner correct missing evidence before handoff, then verifies the corrected archive before retirement", async () => {
    const missingPath = "/work/evidence/focused-tests.log";
    vi.spyOn(host, "readEvidence").mockImplementation(async (_id, paths, write) => {
      if (paths.includes(missingPath)) throw new ForgeEvidenceCompletenessError([missingPath]);
      const data = Buffer.from("regression passes\n");
      await write("work/evidence/test.log", Readable.from([data]), data.length);
    });
    const resource = await resources.create(worker, { name: "incomplete-evidence", image: "fixture:latest", command: ["true"], retentionReason: "Keep the actual regression result", evidencePaths: ["/work/evidence/test.log", missingPath] });
    await expect(resources.validateEvidenceHandoff(worker)).rejects.toThrow(missingPath);
    expect((await resources.records())[0]).toMatchObject({ state: "blocked", evidence: { state: "incomplete", missingPaths: [missingPath] } });
    const originalContainer = structuredClone(container);
    const commitSha = "b".repeat(40);
    const response = await selection(resource.id, { attemptId: worker.attemptId, evidencePaths: ["/work/evidence/test.log"], commitSha });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "owned", evidence: { state: "pending", paths: ["/work/evidence/test.log"], commitSha, commitSource: "declared" } });
    expect(response.json().evidence.missingPaths).toBeUndefined();
    expect(response.json().cleanupFailure).toBeUndefined();
    expect(runningGuard).toHaveBeenCalledWith(worker.id, worker.attemptId, expect.any(Function));
    expect(guard).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(container).toEqual(originalContainer);
    await resources.validateEvidenceHandoff(worker);
    worker.status = "completed";
    await resources.retire(worker);
    expect((await resources.records())[0]).toMatchObject({ state: "deleted", evidence: { state: "verified", commitSha, files: [{ path: "work/evidence/test.log" }] } });
    expect(await text(await resources.evidenceFile(resource.id, "work/evidence/test.log"))).toBe("regression passes\n");
    expect(container).toBeUndefined();
  });
  it.each(["stale attempt", "inactive owner"])("rejects an evidence correction from a %s before changing its selection or environment", async scenario => {
    const resource = await resources.create(worker, { name: "evidence", image: "fixture:latest", command: ["true"], evidencePaths: ["/work/evidence/test.log"] });
    const originalRecords = await resources.records();
    const originalContainer = structuredClone(container);
    const attemptId = scenario === "stale attempt" ? randomUUID() : worker.attemptId;
    if (scenario === "inactive owner") worker.status = "completed";
    const response = await selection(resource.id, { attemptId, evidencePaths: ["/work/evidence/corrected.log"] });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("current active worker attempt");
    expect(runningGuard).toHaveBeenCalledWith(worker.id, attemptId, expect.any(Function));
    expect(await resources.records()).toEqual(originalRecords);
    expect(container).toEqual(originalContainer);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it.each(["another owner", "shared consumer"])("rejects selection changes by %s while preserving the owner's evidence", async scenario => {
    const other = { ...worker, id: randomUUID(), attemptId: randomUUID() };
    workers.push(other);
    const resource = await resources.create(worker, { name: "evidence", image: "fixture:latest", command: ["true"], evidencePaths: ["/work/evidence/test.log"],
      ...(scenario === "shared consumer" ? { consumers: [{ workerId: other.id, attemptId: other.attemptId! }] } : {}) });
    const originalRecords = await resources.records();
    const originalContainer = structuredClone(container);
    const response = await selection(resource.id, { attemptId: other.attemptId, evidencePaths: ["/work/evidence/corrected.log"] }, other.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Only the current active owner attempt");
    expect(runningGuard).toHaveBeenCalledWith(other.id, other.attemptId, expect.any(Function));
    expect(await resources.records()).toEqual(originalRecords);
    expect(container).toEqual(originalContainer);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("rejects untrusted origins and malformed evidence selections before invoking the active-owner guard", async () => {
    const resource = await resources.create(worker, { name: "evidence", image: "fixture:latest", command: ["true"], evidencePaths: ["/work/evidence/test.log"] });
    const originalRecords = await resources.records();
    const originalContainer = structuredClone(container);
    const valid = { attemptId: worker.attemptId, evidencePaths: ["/work/evidence/test.log"] };
    expect((await selection(resource.id, valid, worker.id, "https://untrusted.test")).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/forge/workers/${worker.id}/resources/${resource.id}/evidence-selection`, payload: valid })).statusCode).toBe(403);
    for (const payload of [[], { evidencePaths: valid.evidencePaths }, { ...valid, attemptId: "invalid" }, { ...valid, evidencePaths: [] },
      { ...valid, evidencePaths: ["/work/node_modules"] }, { ...valid, evidencePaths: ["/work/evidence/../secret"] },
      { ...valid, commitSha: "short" }, { ...valid, arbitrary: true }, { ...valid, action: "discard" }, { ...valid, confirmation: "Discard evidence" }])
      expect((await selection(resource.id, payload)).statusCode).toBe(400);
    expect(runningGuard).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(await resources.records()).toEqual(originalRecords);
    expect(container).toEqual(originalContainer);
  });
  it("exports legacy selected evidence, reclaims its environment, and keeps downloads available after service restart", async () => {
    const resource = await held();
    const response = await decision(resource.id, { action: "export", evidencePaths: ["/work/evidence/test.log"] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "deleted", reclaimedBytes: 8192, evidence: { state: "verified" } });
    expect(guard).toHaveBeenCalledWith([worker.id], expect.any(Function));
    expect(reconcile).toHaveBeenCalledTimes(1);
    const manifest = await app.inject(`/api/forge/resources/${resource.id}/evidence`);
    expect(manifest.headers["cache-control"]).toBe("no-store");
    expect(manifest.json()).toMatchObject({ owner: { workerId: worker.id, attemptId: worker.attemptId }, files: [{ path: "work/evidence/test.log" }] });
    const file = await app.inject(`/api/forge/resources/${resource.id}/evidence-file?path=work%2Fevidence%2Ftest.log`);
    expect(file.body).toBe("regression passes\n");
    expect(file.headers["content-type"]).toBe("application/octet-stream");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    const restarted = new ForgeDisposableResources(root, async () => []);
    expect(await text(await restarted.evidenceFile(resource.id, "work/evidence/test.log"))).toBe(file.body);
    expect(container).toBeUndefined();
  });
  it("keeps an explicit stopped hold and requires confirmation to discard", async () => {
    const resource = await held();
    expect((await decision(resource.id, { action: "keep" })).json()).toMatchObject({ state: "blocked", evidence: { state: "kept" } });
    expect(container?.running).toBe(false);
    expect((await decision(resource.id, { action: "discard" })).statusCode).toBe(400);
    expect(container).toBeDefined();
    expect((await decision(resource.id, { action: "discard", confirmation: "Discard evidence" })).json()).toMatchObject({ state: "deleted", evidence: { state: "discarded" } });
  });
  it("rejects untrusted origins and invalid decisions before the lifecycle guard", async () => {
    const resource = await held();
    expect((await decision(resource.id, { action: "discard", confirmation: "Discard evidence" }, "https://untrusted.test")).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/forge/resources/${resource.id}/evidence-decision`, payload: { action: "keep" } })).statusCode).toBe(403);
    for (const payload of [{ action: "delete" }, { action: "export", evidencePaths: ["/work/node_modules"] }, { action: "keep", arbitrary: true }])
      expect((await decision(resource.id, payload)).statusCode).toBe(400);
    expect(guard).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(container).toBeDefined();
  });
  it("preserves active shared consumers and surfaces lifecycle errors without repeating the decision", async () => {
    const resource = await held();
    guard.mockRejectedValueOnce(new Error("An active or unfinished consumer still needs this environment."));
    const response = await decision(resource.id, { action: "discard", confirmation: "Discard evidence" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("active or unfinished");
    expect(container).toBeDefined();
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("only serves exact verified archive keys and detects damaged durable evidence", async () => {
    const resource = await held();
    await decision(resource.id, { action: "export", evidencePaths: ["/work/evidence/test.log"] });
    expect((await app.inject(`/api/forge/resources/${resource.id}/evidence-file`)).statusCode).toBe(400);
    expect((await app.inject(`/api/forge/resources/${resource.id}/evidence-file?path=..%2F..%2Fsecret`)).statusCode).toBe(409);
    await fs.writeFile(path.join(root, "forge-evidence", resource.id, "manifest.json"), "damaged");
    expect((await app.inject(`/api/forge/resources/${resource.id}/evidence`)).statusCode).toBe(409);
    expect((await decision(randomUUID(), { action: "keep" })).statusCode).toBe(404);
  });
  it("rejects an unexportable reviewed selection without accepting an export receipt", async () => {
    const resource = await held();
    const response = await decision(resource.id, { action: "export", evidencePaths: ["/work/missing.log"] });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("outside its declared selection");
    expect((await resources.records())[0]).toMatchObject({ state: "failed", evidence: { state: "pending", paths: ["/work/missing.log"] } });
    expect((await resources.records())[0]?.evidence?.manifestSha256).toBeUndefined();
    expect(container?.running).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

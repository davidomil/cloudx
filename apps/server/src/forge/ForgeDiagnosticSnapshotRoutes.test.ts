import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerForgeDiagnosticSnapshotRoutes } from "./ForgeDiagnosticSnapshotRoutes.js";
import type { ForgeWorkflowService } from "./ForgeWorkflowService.js";
import { readDirectoryIdentity } from "../directoryIdentity.js";

describe("Forge diagnostic snapshot creation routes", () => {
  let app: ReturnType<typeof Fastify>;
  const create = vi.fn();
  const recover = vi.fn(), inventory = vi.fn(), archive = vi.fn();
  const origin = "http://localhost:3000";
  const workerId = randomUUID(), attemptId = randomUUID();
  const input = { kind: "source-only", commitSha: "a".repeat(40), attemptId };
  beforeEach(() => {
    create.mockReset();
    recover.mockReset(); inventory.mockReset(); archive.mockReset();
    app = Fastify();
    registerForgeDiagnosticSnapshotRoutes(app, { createDiagnosticSnapshot: create, recoverDiagnosticSnapshot: recover,
      diagnosticSnapshots: inventory, diagnosticSnapshotArchive: archive } as unknown as ForgeWorkflowService, [origin]);
  });
  afterEach(async () => { await app.close(); });

  function request(payload: unknown, requestOrigin: string | null = origin, id: string = workerId) {
    return app.inject({ method: "POST", url: `/api/forge/workers/${id}/snapshots`, headers: { "content-type": "application/json", ...(requestOrigin ? { origin: requestOrigin } : {}) }, payload: JSON.stringify(payload) });
  }

  it.each(["source-only", "repository"])("delegates a %s snapshot to the current worker lifecycle owner", async kind => {
    const result = { path: ".cloudx/forge-snapshots/owned/source", kind, retentionPolicy: kind === "source-only" ? "disposable" : "recover" };
    create.mockResolvedValue(result);
    const response = await request({ ...input, kind });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(result);
    expect(create).toHaveBeenCalledExactlyOnceWith(workerId, attemptId, { kind, commitSha: input.commitSha });
  });

  it("rejects untrusted or missing origins before creating any snapshot", async () => {
    for (const requestOrigin of [null, "https://untrusted.test"])
      expect((await request(input, requestOrigin)).statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    null, [], "invalid", {},
    { ...input, attemptId: "old" }, { ...input, attemptId: "a".repeat(36) },
    { ...input, kind: "objects" }, { ...input, commitSha: "short" },
    { ...input, commitSha: null }, { ...input, path: "existing/source" },
    { ...input, retentionPolicy: "disposable" },
  ])("rejects invalid declarations %j without adopting source paths", async payload => {
    expect((await request(payload)).statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts full SHA-256 commits and rejects malformed worker identity", async () => {
    create.mockResolvedValue({ path: "allocated" });
    expect((await request({ ...input, commitSha: "a".repeat(64) })).statusCode).toBe(201);
    expect(create).toHaveBeenCalledExactlyOnceWith(workerId, attemptId, { kind: "source-only", commitSha: "a".repeat(64) });
    expect((await request(input, origin, "not-a-worker")).statusCode).toBe(400);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("surfaces ownership or provenance failures without repeating snapshot creation", async () => {
    create.mockRejectedValueOnce(new Error("Only the current active worker attempt can create a snapshot."));
    const response = await request(input);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("current active worker attempt");
    expect(create).toHaveBeenCalledTimes(1);
  });

  const snapshotPath = `.cloudx/forge-snapshots/${randomUUID()}/source`;
  function recoverRequest(payload: unknown, requestOrigin: string | undefined = origin) {
    return app.inject({ method: "POST", url: `/api/forge/workers/${workerId}/snapshots/recover`,
      headers: { "content-type": "application/json", ...(requestOrigin ? { origin: requestOrigin } : {}) }, payload: JSON.stringify(payload) });
  }

  it("recovers only the exact registered copy through completed-worker authorization", async () => {
    recover.mockResolvedValue(undefined);
    const response = await recoverRequest({ path: snapshotPath });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ recovered: true });
    expect(recover).toHaveBeenCalledExactlyOnceWith(workerId, snapshotPath);
  });

  it("rejects missing and untrusted recovery origins before accessing the snapshot", async () => {
    for (const requestOrigin of ["", "https://untrusted.test"])
      expect((await recoverRequest({ path: snapshotPath }, requestOrigin)).statusCode).toBe(403);
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { path: "../outside" }, { path: snapshotPath, force: true }, { path: 23 }])("rejects malformed recovery selections %j", async input => {
    expect((await recoverRequest(input)).statusCode).toBe(400);
    expect(recover).not.toHaveBeenCalled();
  });

  it("keeps archive and ownership failures visible without repeating recovery", async () => {
    recover.mockRejectedValue(new Error("Snapshot ownership changed; original preserved."));
    const response = await recoverRequest({ path: snapshotPath });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("ownership changed");
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("returns the complete saved hold inventory across attempts", async () => {
    const snapshots = [{ path: snapshotPath, attemptId, hold: "Changed source preserved" },
      { path: `.cloudx/forge-snapshots/${randomUUID()}/source`, attemptId: randomUUID(), hold: "Replaced copy preserved" }];
    inventory.mockResolvedValue(snapshots);
    const response = await app.inject(`/api/forge/workers/${workerId}/snapshots`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ snapshots });
  });

  it("downloads a verified full archive after the worker card has retired", async () => {
    archive.mockResolvedValue(Readable.from([Buffer.from("verified full snapshot bytes")]));
    const response = await app.inject(`/api/forge/workers/${workerId}/snapshots/archive?${new URLSearchParams({ path: snapshotPath })}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-tar");
    expect(response.headers["content-disposition"]).toContain("diagnostic-snapshot.tar");
    expect(response.body).toBe("verified full snapshot bytes");
    expect(archive).toHaveBeenCalledExactlyOnceWith(workerId, snapshotPath);
  });

  it("rejects missing download paths and surfaces failed archive verification", async () => {
    expect((await app.inject(`/api/forge/workers/${workerId}/snapshots/archive`)).statusCode).toBe(400);
    expect(archive).not.toHaveBeenCalled();
    archive.mockRejectedValue(new Error("Archive checksum verification failed"));
    expect((await app.inject(`/api/forge/workers/${workerId}/snapshots/archive?${new URLSearchParams({ path: snapshotPath })}`)).statusCode).toBe(409);
  });
});

describe("Durable diagnostic snapshot inventory routes", () => {
  let directory: string, app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-snapshot-inventory-"));
    app = Fastify();
    registerForgeDiagnosticSnapshotRoutes(app, {} as ForgeWorkflowService, [], directory);
  });
  afterEach(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });

  it("shows every held and retired owned snapshot while reporting invalid peer receipts", async () => {
    const workerId = randomUUID(), attemptId = randomUUID();
    const worktreePath = path.join(directory, "checkout");
    await fs.mkdir(worktreePath);
    const worktree = await readDirectoryIdentity(worktreePath);
    const snapshot = (state: string, hold?: string) => {
      const relative = `.cloudx/forge-snapshots/${randomUUID()}/source`;
      return { path: relative, workerId, attemptId, kind: "repository", retentionPolicy: "recover", state, hold,
        identity: { path: path.join(worktreePath, relative), dev: "1", ino: "2" },
        parentIdentity: { path: path.dirname(path.join(worktreePath, relative)), dev: "1", ino: "3" },
        origin: { checkout: worktree, gitDirectory: { path: path.join(worktreePath, ".git"), dev: "1", ino: "4" }, commitSha: "a".repeat(40), url: "https://example.test/repo" }, contents: [] };
    };
    const snapshots = [snapshot("ready", "Source changed"), { ...snapshot("ready", "Identity changed"), attemptId: randomUUID() }, snapshot("removed")];
    const receipts = path.join(directory, "forge-workers/workspaces");
    await fs.mkdir(receipts, { recursive: true });
    await fs.writeFile(path.join(receipts, `${workerId}.json`), JSON.stringify({ id: workerId, worktree, diagnosticSnapshots: snapshots }));
    const invalidId = randomUUID();
    await fs.writeFile(path.join(receipts, `${invalidId}.json`), JSON.stringify({ id: invalidId, worktree, diagnosticSnapshots: [snapshots[0]] }));
    const response = await app.inject("/api/forge/diagnostic-snapshots");
    expect(response.statusCode).toBe(200);
    expect(response.json().snapshots).toHaveLength(3);
    expect(response.json().snapshots.map((item: { hold?: string }) => item.hold)).toEqual(["Source changed", "Identity changed", undefined]);
    expect(response.json().errors).toEqual([`${invalidId}: invalid snapshot ownership; the copy remains protected.`]);
    expect(JSON.stringify(response.json())).not.toContain("https://example.test");
  });

  it("returns an empty inventory before any workspace ownership receipts exist", async () => {
    expect((await app.inject("/api/forge/diagnostic-snapshots")).json()).toEqual({ snapshots: [], errors: [] });
  });
});

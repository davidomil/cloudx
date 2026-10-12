import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerForgeDiagnosticSnapshotRoutes } from "./ForgeDiagnosticSnapshotRoutes.js";
import type { ForgeWorkflowService } from "./ForgeWorkflowService.js";

describe("Forge diagnostic snapshot creation routes", () => {
  let app: ReturnType<typeof Fastify>;
  const create = vi.fn();
  const origin = "http://localhost:3000";
  const workerId = randomUUID(), attemptId = randomUUID();
  const input = { kind: "source-only", commitSha: "a".repeat(40), attemptId };
  beforeEach(() => {
    create.mockReset();
    app = Fastify();
    registerForgeDiagnosticSnapshotRoutes(app, { createDiagnosticSnapshot: create } as unknown as ForgeWorkflowService, [origin]);
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
});

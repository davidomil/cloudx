import type { FastifyInstance } from "fastify";
import { parseCloudxUpdateChannel, parseCloudxUpdateRequest, parseCloudxUpdateBackupCleanupRequest } from "@cloudx/shared";
import type { CloudxUpdateService } from "./CloudxUpdateService.js";
import { runtimeBuild } from "./RuntimeBuild.js";

export type CloudxUpdateApi = Pick<CloudxUpdateService, "status" | "start" | "preview" | "selectChannel" | "reassessCapacity"
  | "backups" | "previewBackupCleanup" | "backupCleanupStatus" | "cleanBackups">;

export function registerCloudxUpdateRoutes(app: FastifyInstance, updates: CloudxUpdateApi, trustedOrigins: string[]): void {
  // The maintained updater integration also attests historical server builds.
  if (!app.hasRoute({ method: "GET", url: "/api/runtime" })) {
    app.get("/api/runtime", async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return runtimeBuild.identity;
    });
  }
  app.get("/api/system/update", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return updates.status();
  });

  app.get("/api/system/update/preview", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return updates.preview();
  });

  app.get("/api/system/update/backups", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return updates.backups();
  });

  app.post("/api/system/update/backups/preview", { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: "Review update backups from a trusted CloudX browser origin." });
    }
    const body = request.body;
    if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)) {
      return reply.code(400).send({ error: "A backup preview request must contain no deletion options." });
    }
    return updates.previewBackupCleanup();
  });

  app.get("/api/system/update/backups/cleanup", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return updates.backupCleanupStatus();
  });

  app.post("/api/system/update/backups/cleanup", { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: "Delete update backups from a trusted CloudX browser origin." });
    }
    let selection;
    try { selection = parseCloudxUpdateBackupCleanupRequest(request.body); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const cleanup = await updates.cleanBackups(selection);
    reply.code(cleanup.state === "running" ? 202 : 200);
    return cleanup;
  });

  app.post("/api/system/update/capacity", { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: "Recheck capacity from a trusted CloudX browser origin." });
    }
    let selection;
    try { selection = parseCloudxUpdateRequest(request.body); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    return updates.reassessCapacity(selection);
  });

  app.put("/api/system/update/preview", { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: "Select update channels from a trusted CloudX browser origin." });
    }
    let channel;
    try {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) throw new Error("An update channel request must contain only a channel.");
      channel = parseCloudxUpdateChannel((body as Record<string, unknown>).channel);
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    return updates.selectChannel(channel);
  });

  app.post("/api/system/update", { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: "Start updates from a trusted CloudX browser origin." });
    }
    let selection;
    try { selection = parseCloudxUpdateRequest(request.body); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    let status;
    try { status = await updates.start(selection); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 409) throw error;
      return reply.code(409).send({ available: false, unavailableReason: (error as Error).message });
    }
    reply.code(status.run?.state === "running" ? 202 : status.available ? 200 : 409);
    return status;
  });
}

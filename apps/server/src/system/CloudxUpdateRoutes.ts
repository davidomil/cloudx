import type { FastifyInstance } from "fastify";
import { parseCloudxUpdateChannel, parseCloudxUpdateRequest } from "@cloudx/shared";
import type { CloudxUpdateService } from "./CloudxUpdateService.js";
import { runtimeBuild } from "./RuntimeBuild.js";

export function registerCloudxUpdateRoutes(app: FastifyInstance, updates: Pick<CloudxUpdateService, "status" | "start" | "preview" | "selectChannel">, trustedOrigins: string[]): void {
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

import type { FastifyInstance } from "fastify";
import type { CloudxUpdateService } from "./CloudxUpdateService.js";

export function registerCloudxUpdateRoutes(app: FastifyInstance, updates: Pick<CloudxUpdateService, "status" | "start">, trustedOrigins: string[]): void {
  app.get("/api/system/update", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return updates.status();
  });

  app.post("/api/system/update", { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: "Start updates from a trusted CloudX browser origin." });
    }
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length) {
      return reply.code(400).send({ error: "An update request must be an empty JSON object." });
    }
    const status = await updates.start();
    reply.code(status.run?.state === "running" ? 202 : status.available ? 200 : 409);
    return status;
  });
}

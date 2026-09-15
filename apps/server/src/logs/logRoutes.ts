import type { FastifyInstance } from "fastify";
import { CLOUDX_LOG_SOURCES, type CloudxLogSource } from "@cloudx/shared";
import { CloudxLogService } from "./CloudxLogService.js";

export function registerLogRoutes(app: FastifyInstance, logs: CloudxLogService): void {
  app.get<{ Querystring: { source?: CloudxLogSource } }>("/api/logs", {
    logLevel: "silent",
    schema: {
      querystring: {
        type: "object",
        properties: { source: { type: "string", enum: CLOUDX_LOG_SOURCES.map(source => source.id) } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.once("close", abort);
    try {
      return await logs.read(request.query.source ?? "current", controller.signal);
    } finally {
      reply.raw.removeListener("close", abort);
    }
  });
}

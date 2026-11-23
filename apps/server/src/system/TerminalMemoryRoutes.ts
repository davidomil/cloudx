import type { FastifyInstance } from "fastify";
import type { TerminalMemoryService } from "./TerminalMemoryService.js";

export function registerTerminalMemoryRoutes(app: FastifyInstance, service: Pick<TerminalMemoryService, "status" | "apply">, trustedOrigins: string[]): void {
  app.get("/api/terminal-memory", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return service.status();
  });
  app.put("/api/terminal-memory", { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin))
      return reply.code(403).send({ error: "Change terminal memory limits from a trusted CloudX browser origin." });
    return service.apply(request.body);
  });
}

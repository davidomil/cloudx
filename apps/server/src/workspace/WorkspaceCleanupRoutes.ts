import type { FastifyInstance } from "fastify";
import { parseWorkspaceCleanupRequest } from "@cloudx/shared";
import type { WorkspaceCleanupService } from "./WorkspaceCleanupService.js";

export function registerWorkspaceCleanupRoutes(app: FastifyInstance, cleanup: WorkspaceCleanupService, trustedOrigins: string[]): void {
  app.get("/api/system/workspace-cleanup", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return cleanup.status();
  });
  app.post("/api/system/workspace-cleanup/preview", async (request, reply) => {
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) return reply.code(403).send({ error: "Scan workspaces from a trusted CloudX browser origin." });
    reply.header("cache-control", "no-store");
    try { return await cleanup.preview(); }
    catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.post("/api/system/workspace-cleanup", { bodyLimit: 100_000 }, async (request, reply) => {
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) return reply.code(403).send({ error: "Delete workspaces from a trusted CloudX browser origin." });
    let selection;
    try { selection = parseWorkspaceCleanupRequest(request.body); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    try { return reply.code(202).send(await cleanup.start(selection)); }
    catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
}

import type { FastifyInstance } from "fastify";
import { ForgeGitHistory } from "./ForgeGitHistory.js";

export function registerForgeGitHistoryRoutes(app: FastifyInstance, dataDir: string): void {
  const history = new ForgeGitHistory(dataDir);
  app.get("/api/forge/git-history", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    try { return { archives: await history.list() }; }
    catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.get<{ Params: { archiveId: string } }>("/api/forge/git-history/:archiveId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try { return await history.read(request.params.archiveId); }
    catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.get<{ Params: { archiveId: string } }>("/api/forge/git-history/:archiveId/file", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const stream = await history.fileStream(request.params.archiveId);
      return reply.type("application/octet-stream").header("content-disposition", 'attachment; filename="history.bundle"')
        .header("x-content-type-options", "nosniff").send(stream);
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
}

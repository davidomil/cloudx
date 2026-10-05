import type { FastifyInstance } from "fastify";
import { ForgeCheckoutEvidence } from "./ForgeCheckoutEvidence.js";

export function registerForgeCheckoutEvidenceRoutes(app: FastifyInstance, dataDir: string): void {
  const evidence = new ForgeCheckoutEvidence(dataDir);
  app.get("/api/forge/checkout-evidence", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { archives: await evidence.list() };
  });
  app.get<{ Params: { archiveId: string } }>("/api/forge/checkout-evidence/:archiveId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try { return await evidence.read(request.params.archiveId); }
    catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.get<{ Params: { archiveId: string }; Querystring: { path?: string } }>("/api/forge/checkout-evidence/:archiveId/file", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const filePath = request.query.path;
    if (typeof filePath !== "string" || !filePath || filePath.length > 4096) return reply.code(400).send({ error: "An exact archived checkout evidence path is required." });
    try {
      const stream = await evidence.fileStream(request.params.archiveId, filePath);
      return reply.type("application/octet-stream").header("content-disposition", "attachment")
        .header("x-content-type-options", "nosniff").send(stream);
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
}

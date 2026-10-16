import type { FastifyInstance } from "fastify";
import { validateForgeDiagnosticSnapshotInput } from "@cloudx/shared";
import type { ForgeWorkflowService } from "./ForgeWorkflowService.js";
import { ForgeDiagnosticSnapshotInventory } from "./ForgeDiagnosticSnapshotInventory.js";

export function registerForgeDiagnosticSnapshotRoutes(app: FastifyInstance, workflow: ForgeWorkflowService, trustedOrigins: string[], dataDir?: string): void {
  if (dataDir) app.get("/api/forge/diagnostic-snapshots", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return new ForgeDiagnosticSnapshotInventory(dataDir).list();
  });
  app.get<{ Params: { workerId: string } }>("/api/forge/workers/:workerId/snapshots", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try { return { snapshots: await workflow.diagnosticSnapshots(request.params.workerId) }; }
    catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.get<{ Params: { workerId: string }; Querystring: { path?: string } }>("/api/forge/workers/:workerId/snapshots/archive", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (typeof request.query.path !== "string" || request.query.path.length > 4096)
      return reply.code(400).send({ error: "An exact registered snapshot path is required." });
    try {
      const stream = await workflow.diagnosticSnapshotArchive(request.params.workerId, request.query.path);
      return reply.type("application/x-tar").header("content-disposition", 'attachment; filename="diagnostic-snapshot.tar"')
        .header("x-content-type-options", "nosniff").send(stream);
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { workerId: string } }>("/api/forge/workers/:workerId/snapshots/recover", { bodyLimit: 100_000 }, async (request, reply) => {
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) return reply.code(403).send({ error: "Recover diagnostic snapshots from a trusted CloudX origin." });
    const input = request.body as { path?: unknown } | null;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 ||
      typeof input.path !== "string" || !/^\.cloudx\/forge-snapshots\/[a-f0-9-]{36}\/source$/u.test(input.path))
      return reply.code(400).send({ error: "An exact registered snapshot path is required." });
    try {
      await workflow.recoverDiagnosticSnapshot(request.params.workerId, input.path);
      return { recovered: true };
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { workerId: string } }>("/api/forge/workers/:workerId/snapshots", { bodyLimit: 100_000 }, async (request, reply) => {
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) return reply.code(403).send({ error: "Create diagnostic snapshots from a trusted CloudX origin." });
    const value = request.body;
    if (!value || typeof value !== "object" || Array.isArray(value)) return reply.code(400).send({ error: "A current attempt and diagnostic snapshot specification are required." });
    const { attemptId, ...input } = value as Record<string, unknown>;
    try {
      if (![request.params.workerId, attemptId].every(id => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)))
        throw new Error("Current Forge worker and attempt IDs are required.");
      validateForgeDiagnosticSnapshotInput(input);
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    try {
      return reply.code(201).send(await workflow.createDiagnosticSnapshot(request.params.workerId, attemptId as string, input));
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
}

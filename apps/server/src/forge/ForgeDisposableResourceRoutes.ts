import type { FastifyInstance } from "fastify";
import { validateContainerInput, validateEvidenceDecision, type ForgeDisposableResources } from "./ForgeDisposableResources.js";
import type { ForgeWorkflowService } from "./ForgeWorkflowService.js";

export function registerForgeDisposableResourceRoutes(app: FastifyInstance, resources: ForgeDisposableResources, workflow: ForgeWorkflowService, trustedOrigins: string[]): void {
  app.get("/api/forge/resources", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { resources: await resources.records() };
  });
  app.get<{ Params: { resourceId: string } }>("/api/forge/resources/:resourceId/evidence", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try { return await resources.readEvidence(request.params.resourceId); }
    catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.get<{ Params: { resourceId: string }; Querystring: { path?: string } }>("/api/forge/resources/:resourceId/evidence-file", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const path = request.query.path;
    if (typeof path !== "string" || !path || path.length > 4096) return reply.code(400).send({ error: "An exact archived evidence path is required." });
    try {
      const file = await resources.evidenceFile(request.params.resourceId, path);
      return reply.type("application/octet-stream").header("content-disposition", "attachment").header("x-content-type-options", "nosniff").send(file);
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { resourceId: string } }>("/api/forge/resources/:resourceId/evidence-decision", { bodyLimit: 100_000 }, async (request, reply) => {
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) return reply.code(403).send({ error: "Review evidence from a trusted CloudX origin." });
    const decision = request.body;
    try { validateEvidenceDecision(decision); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    try {
      const resource = (await resources.records()).find(item => item.id === request.params.resourceId);
      if (!resource) return reply.code(404).send({ error: "Unknown disposable resource." });
      const result = await workflow.withCompletedWorkerResources(resource.consumers.map(consumer => consumer.workerId), () => resources.decideEvidence(resource.id, decision));
      await workflow.reconcileResourceCleanup();
      return result;
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { workerId: string } }>("/api/forge/workers/:workerId/resources", { bodyLimit: 100_000 }, async (request, reply) => {
    if (!request.headers.origin || !trustedOrigins.includes(request.headers.origin)) return reply.code(403).send({ error: "Create owned environments from a trusted CloudX origin." });
    const value = request.body;
    if (!value || typeof value !== "object" || Array.isArray(value)) return reply.code(400).send({ error: "A current attempt and disposable container specification are required." });
    const { attemptId, ...input } = value as Record<string, unknown>;
    try {
      if (typeof attemptId !== "string" || !/^[a-f0-9-]{36}$/u.test(attemptId)) throw new Error("A current Forge attempt ID is required.");
      validateContainerInput(input);
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    try {
      const result = await workflow.withRunningWorkerResources(request.params.workerId, attemptId as string, worker => resources.create(worker, input));
      return reply.code(201).send(result);
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
}

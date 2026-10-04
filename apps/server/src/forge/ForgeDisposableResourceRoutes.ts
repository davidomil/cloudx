import type { FastifyInstance } from "fastify";
import { validateContainerInput, type ForgeDisposableResources } from "./ForgeDisposableResources.js";
import type { ForgeWorkflowService } from "./ForgeWorkflowService.js";

export function registerForgeDisposableResourceRoutes(app: FastifyInstance, resources: ForgeDisposableResources, workflow: ForgeWorkflowService, trustedOrigins: string[]): void {
  app.get("/api/forge/resources", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { resources: await resources.records() };
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

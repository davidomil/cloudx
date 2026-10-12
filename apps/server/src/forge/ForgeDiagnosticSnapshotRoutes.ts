import type { FastifyInstance } from "fastify";
import { validateForgeDiagnosticSnapshotInput } from "@cloudx/shared";
import type { ForgeWorkflowService } from "./ForgeWorkflowService.js";

export function registerForgeDiagnosticSnapshotRoutes(app: FastifyInstance, workflow: ForgeWorkflowService, trustedOrigins: string[]): void {
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

import type { FastifyInstance } from "fastify";
import { isRecord, type HardwareAgentReadiness, type HardwareOwner } from "@cloudx/shared";
import type { AgentHardwareContext } from "./AgentHardwareContext.js";
import { HardwareError, requireHardware } from "./HardwareError.js";
import type { HardwareService } from "./HardwareService.js";
import type { HardwareSshPasswords } from "./HardwareSshPasswords.js";

const operator: HardwareOwner = { kind: "user", userId: "local" };

/** Management inherits exact Origin/Host admission; agent ownership comes only from a private capability. */
export async function registerHardwareRoutes(app: FastifyInstance, hardware: HardwareService, contexts: AgentHardwareContext,
  options: { agentReadiness?: () => Promise<HardwareAgentReadiness[]>; sshPasswords?: HardwareSshPasswords } = {}): Promise<void> {
  await app.register(async scope => {
    scope.addHook("onSend", async (_request, reply) => { reply.header("cache-control", "no-store"); });
    scope.setErrorHandler((error, request, reply) => {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "REQUEST_FAILED";
      if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        const message = "The Hardware request exceeds its size limit.";
        return reply.code(413).send({ code: "INVALID_INPUT", error: message, message });
      }
      const known = error instanceof HardwareError || ["FORBIDDEN", "PROVIDER_UNAVAILABLE", "INVALID_INPUT"].includes(code);
      const status = code === "FORBIDDEN" || code === "OWNER_CHANGED" ? 403 : code === "NOT_FOUND" ? 404 :
        ["INVALID_INPUT", "INVALID_REQUEST", "INVALID_FILTER", "INVALID_CONFIG"].includes(code) ? 400 :
        ["INTEGRITY_ERROR", "WRITER_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "SERVICE_UNAVAILABLE", "STORE_UNAVAILABLE"].includes(code) ? 503 : known ? 409 : 500;
      if (!known) request.log.error({ err: error }, "Hardware request failed.");
      const message = known && error instanceof Error ? error.message : "The Hardware request failed.";
      return reply.code(status).send({ code, error: message, message, ...(error instanceof HardwareError && error.details ? { details: error.details } : {}) });
    });
    scope.get("/api/hardware/state", async () => ({ ...await hardware.snapshot(operator),
      ...(options.agentReadiness ? { agentReadiness: await options.agentReadiness() } : {}) }));
    scope.put<{ Params: { credentialRefId: string } }>("/api/hardware/ssh-passwords/:credentialRefId", { bodyLimit: 8192 }, async request => {
      const body = fields(request.body, ["password"]);
      requireHardware(options.sshPasswords, "SERVICE_UNAVAILABLE", "The SSH password store is unavailable.");
      return options.sshPasswords.save(request.params.credentialRefId, body.password);
    });
    scope.post("/api/hardware/actions", { bodyLimit: 2 * 1024 * 1024 }, async request => {
      const body = fields(request.body, ["action", "input"]);
      requireHardware(typeof body.action === "string" && body.action.startsWith("hardware.") && isRecord(body.input), "INVALID_REQUEST", "Choose a Hardware action and structured input.");
      return { result: await hardware.execute(body.action, body.input, operator) };
    });
    scope.post("/api/hardware/agent", { bodyLimit: 2 * 1024 * 1024 }, async request => {
      const body = fields(request.body, ["tabId", "executionId", "action", "input"]);
      requireHardware(typeof body.tabId === "string" && typeof body.executionId === "string" && typeof body.action === "string" && isRecord(body.input), "INVALID_REQUEST", "Read the private Hardware context for this exact execution.");
      const owner = await contexts.authenticate({ tabId: body.tabId, executionId: body.executionId, capability: request.headers.authorization?.replace(/^Bearer /, "") ?? "" });
      if (body.action === "hardware.context") return { owner, readiness: (await hardware.snapshot(owner)).readiness };
      return { result: await hardware.execute(body.action, body.input, owner) };
    });
  });
}

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  requireHardware(isRecord(value) && Object.keys(value).every(key => allowed.includes(key)), "INVALID_REQUEST", "Hardware request contains invalid or unknown fields.");
  return value;
}

import {
  isRecord,
  parseHardwareItem,
  parseHardwareOwner,
  type HardwareMutationResult,
  type HardwareStateView,
  type OperationReceipt,
} from "@cloudx/shared";

export class HardwareApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function request(
  path: string,
  options: RequestInit,
  requestId?: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/hardware${path}`, options);
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new HardwareApiError(
      requestId
        ? "The response was lost. Inspect the original receipt before starting new work."
        : "Hardware service disconnected. Reconnect to read current state.",
      requestId ? "OUTCOME_UNKNOWN" : "DISCONNECTED",
      requestId,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HardwareApiError(
      "Hardware service returned an unreadable response.",
      requestId ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE",
      requestId,
    );
  }
  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : body;
    throw new HardwareApiError(
      isRecord(error) && typeof error.message === "string"
        ? error.message
        : isRecord(body) && typeof body.error === "string"
          ? body.error
          : `Hardware request failed (${response.status}).`,
      isRecord(error) && typeof error.code === "string"
        ? error.code
        : "REQUEST_FAILED",
      requestId,
    );
  }
  return body;
}

export async function getHardwareState(
  signal?: AbortSignal,
): Promise<HardwareStateView> {
  const value = await request("/state", { signal, cache: "no-store" });
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    ![
      "items",
      "tags",
      "groups",
      "types",
      "statusDefinitions",
      "reservations",
      "checkHolds",
      "receipts",
      "history",
    ].every((key) => Array.isArray(value[key])) ||
    !isRecord(value.currentOwner) ||
    !isRecord(value.readiness)
  )
    throw new HardwareApiError(
      "Hardware state is invalid. No empty inventory was substituted.",
      "INVALID_RESPONSE",
    );
  try {
    parseHardwareOwner(value.currentOwner);
    if (
      value.agentReadiness !== undefined &&
      (!Array.isArray(value.agentReadiness) ||
        !value.agentReadiness.every(
          (execution) =>
            isRecord(execution) &&
            typeof execution.tabId === "string" &&
            ["codex", "claude"].includes(String(execution.providerId)) &&
            ["ready", "relaunch_required", "unavailable"].includes(
              String(execution.state),
            ),
        ))
    )
      throw new Error("Invalid execution readiness");
    if (!["ready", "unavailable"].includes(String(value.readiness.state)))
      throw new Error("Invalid readiness");
    for (const summary of value.items as unknown[]) {
      if (
        !isRecord(summary) ||
        !Array.isArray(summary.observations) ||
        !Array.isArray(summary.blockers) ||
        !["available", "held", "ineligible"].includes(
          String(summary.availability),
        )
      )
        throw new Error("Invalid item summary");
      parseHardwareItem(summary.item);
    }
  } catch {
    throw new HardwareApiError(
      "Hardware state is invalid. No empty inventory was substituted.",
      "INVALID_RESPONSE",
    );
  }
  return value as unknown as HardwareStateView;
}

export async function callHardwareAction<T = HardwareMutationResult>(
  action: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const body = await request(
    "/actions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, input }),
      signal,
    },
    typeof input.requestId === "string" && action !== "hardware.receipt.get"
      ? input.requestId
      : undefined,
  );
  if (
    !isRecord(body) ||
    !isRecord(body.result) ||
    !(
      (body.result.receipt === null && action === "hardware.receipt.get") ||
      (validReceipt(body.result.receipt) &&
        body.result.receipt.requestId === input.requestId)
    )
  )
    throw new HardwareApiError(
      "Hardware action response is invalid. Inspect its receipt before continuing.",
      action === "hardware.receipt.get"
        ? "INVALID_RESPONSE"
        : "OUTCOME_UNKNOWN",
      typeof input.requestId === "string" ? input.requestId : undefined,
    );
  return body.result as T;
}

export async function saveHardwareSshPassword(
  credentialRefId: string,
  password: string,
  signal?: AbortSignal,
): Promise<{ credentialRefId: string }> {
  let body: unknown;
  try {
    body = await request(
      `/ssh-passwords/${encodeURIComponent(credentialRefId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
        signal,
      },
      credentialRefId,
    );
  } catch (cause) {
    if (cause instanceof HardwareApiError && cause.code === "OUTCOME_UNKNOWN")
      throw new HardwareApiError(
        "The password save response was lost. Explicitly retry this same password before continuing.",
        "OUTCOME_UNKNOWN",
        credentialRefId,
      );
    throw cause;
  }
  if (!isRecord(body) || body.credentialRefId !== credentialRefId)
    throw new HardwareApiError(
      "The password save response is invalid. Explicitly retry this same password before continuing.",
      "OUTCOME_UNKNOWN",
      credentialRefId,
    );
  return { credentialRefId };
}

function validReceipt(value: unknown): value is OperationReceipt {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.runId === "string" &&
    typeof value.startedAt === "string" &&
    ["running", "succeeded", "failed", "unknown"].includes(
      String(value.state),
    ) &&
    (value.result === undefined || isRecord(value.result)) &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string"))
  );
}

export function getHardwareReceipt(
  requestId: string,
): Promise<{ receipt: OperationReceipt | null }> {
  return callHardwareAction("hardware.receipt.get", { requestId });
}

export function hardwareRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

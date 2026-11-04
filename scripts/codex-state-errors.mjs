const preparationReasons = {
  "database-identity": "A retained Codex conversation identity must be a string.",
  "database-file": "A retained Codex database must be an owned regular file.",
  "database-home": "A retained Codex database home must be an owned real directory.",
  "directory-list": "Codex snapshot directory list is invalid.",
  "transcript-path": "A retained conversation path is outside the shared session store.",
  "transcript-file": "A retained conversation must be an owned regular file.",
  "sqlite-override": "CODEX_SQLITE_HOME must be absolute to verify a Codex version selection safely.",
  "sqlite-home": "Codex sqlite_home must be a string.",
  "configuration": "Codex configuration could not be read for snapshot preparation.",
  "unavailable": "The isolated snapshot could not be prepared. Inspect database ownership, health, available disk space and permissions.",
  "disk-full": "Snapshot preparation ran out of disk space or exceeded the storage quota.",
  "permission": "Snapshot preparation could not access the retained state or isolated copy. Check CloudX's filesystem permissions.",
};

/** Only fixed diagnostic codes and numeric capacity counts cross the public error boundary. */
export function parseCodexStateDiagnostic(value) {
  if (!value || typeof value !== "object" || typeof value.code !== "string" || !["snapshot", "verify"].includes(value.stage)) return undefined;
  if (value.stage === "verify") return value.code === "candidate-state" ? { stage: value.stage, code: value.code } : undefined;
  if (value.code === "disk-space") {
    if (!Number.isSafeInteger(value.observedBytes) || !Number.isSafeInteger(value.limitBytes) || value.limitBytes < 0 || value.observedBytes <= value.limitBytes) return undefined;
    return { stage: value.stage, code: value.code, observedBytes: value.observedBytes, limitBytes: value.limitBytes };
  }
  if (value.code === "disk-inodes") {
    if (!Number.isSafeInteger(value.requiredInodes) || !Number.isSafeInteger(value.availableInodes) || value.availableInodes < 0 || value.requiredInodes <= value.availableInodes) return undefined;
    return { stage: value.stage, code: value.code, requiredInodes: value.requiredInodes, availableInodes: value.availableInodes };
  }
  return Object.hasOwn(preparationReasons, value.code) ? { stage: value.stage, code: value.code } : undefined;
}

export class CodexStateVerificationError extends Error {
  constructor(diagnostic) {
    const safe = parseCodexStateDiagnostic(diagnostic);
    if (!safe) throw new Error("Invalid Codex state diagnostic.");
    const reason = safe.code === "disk-space" ? `Required destination capacity for retained Codex state is ${safe.observedBytes} bytes; available disk space is ${safe.limitBytes} bytes.`
      : safe.code === "disk-inodes" ? `Retained Codex state requires ${safe.requiredInodes} destination inodes; ${safe.availableInodes} inodes are available.`
      : preparationReasons[safe.code];
    const message = safe.stage === "snapshot"
      ? `Codex shared-state snapshot preparation failed: ${reason} Compatibility verification could not complete. The active selection is unchanged.`
      : "Codex shared-state compatibility verification failed. The active selection is unchanged. Inspect retained conversation identities, database health and schema compatibility before selecting this release again.";
    super(message);
    this.name = "CodexStateVerificationError";
    this.diagnostic = safe;
  }
}

export const CODEX_STATE_ERROR_PREFIX = "CLOUDX_CODEX_STATE_ERROR=";

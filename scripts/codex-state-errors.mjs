const preparationReasons = {
  "database-file": "A retained Codex database must be an owned regular file.",
  "database-home": "A retained Codex database home must be an owned real directory.",
  "database-count": "Too many Codex databases or distinct retained schemas to snapshot safely.",
  "directory-list": "Codex snapshot directory list exceeds the 16 MiB limit or is invalid.",
  "transcript-path": "A retained conversation path is outside the shared session store.",
  "transcript-file": "A retained conversation must be an owned regular file.",
  "time-limit": "Snapshot preparation exceeded its 60 second time limit.",
  "sqlite-override": "CODEX_SQLITE_HOME must be absolute to verify a Codex version selection safely.",
  "sqlite-home": "Codex sqlite_home must be a string.",
  "configuration": "Codex configuration could not be read for snapshot preparation.",
  "launch-count": "Too many retained Codex launches to verify.",
  "unavailable": "The isolated snapshot could not be prepared. Inspect database ownership, health, available disk space and permissions.",
  "disk-full": "Snapshot preparation ran out of disk space or exceeded the storage quota.",
  "permission": "Snapshot preparation could not access the retained state or isolated copy. Check CloudX's filesystem permissions.",
};
const sizeReasons = {
  "database-size": "Retained Codex database size",
  "snapshot-budget": "Aggregate Codex snapshot size",
  "transcript-budget": "Aggregate Codex snapshot size including retained conversations",
  "disk-space": "Required free space for the next Codex snapshot file",
};

/** Only fixed diagnostic codes and numeric limits cross the public error boundary. */
export function parseCodexStateDiagnostic(value) {
  if (!value || typeof value !== "object" || typeof value.code !== "string" || !["snapshot", "verify"].includes(value.stage)) return undefined;
  if (value.stage === "verify") return value.code === "candidate-state" ? { stage: value.stage, code: value.code } : undefined;
  if (Object.hasOwn(sizeReasons, value.code)) {
    const minimumLimit = value.code === "disk-space" ? 0 : 1;
    if (!Number.isSafeInteger(value.observedBytes) || !Number.isSafeInteger(value.limitBytes) || value.limitBytes < minimumLimit || value.observedBytes <= value.limitBytes) return undefined;
    return { stage: value.stage, code: value.code, observedBytes: value.observedBytes, limitBytes: value.limitBytes };
  }
  return Object.hasOwn(preparationReasons, value.code) ? { stage: value.stage, code: value.code } : undefined;
}

export class CodexStateVerificationError extends Error {
  constructor(diagnostic) {
    const safe = parseCodexStateDiagnostic(diagnostic);
    if (!safe) throw new Error("Invalid Codex state diagnostic.");
    const reason = safe.code === "disk-space" ? `${sizeReasons[safe.code]} is ${safe.observedBytes} bytes; available disk space is ${safe.limitBytes} bytes.`
      : safe.observedBytes === undefined ? preparationReasons[safe.code] : `${sizeReasons[safe.code]} is ${safe.observedBytes} bytes; the limit is ${safe.limitBytes} bytes.`;
    const message = safe.stage === "snapshot"
      ? `Codex shared-state snapshot preparation failed: ${reason} Compatibility verification could not complete. The active selection is unchanged.`
      : "Codex shared-state compatibility verification failed. The active selection is unchanged. Inspect retained conversation identities, database health and schema compatibility before selecting this release again.";
    super(message);
    this.name = "CodexStateVerificationError";
    this.diagnostic = safe;
  }
}

export const CODEX_STATE_ERROR_PREFIX = "CLOUDX_CODEX_STATE_ERROR=";

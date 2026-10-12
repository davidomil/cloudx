export interface CodexStateDiagnostic {
  stage: "snapshot" | "verify";
  code: string;
  observedBytes?: number;
  limitBytes?: number;
}
export function parseCodexStateDiagnostic(value: unknown): CodexStateDiagnostic | undefined;
export class CodexStateVerificationError extends Error {
  readonly diagnostic: CodexStateDiagnostic;
  constructor(diagnostic: CodexStateDiagnostic);
}
export const CODEX_STATE_ERROR_PREFIX: string;

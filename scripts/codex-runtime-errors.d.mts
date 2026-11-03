export type CodexRuntimeVerificationStage = "load" | "launch" | "interactive-readiness" | "interactive-turn" | "interactive-evidence" | "forge-resume" | "forge-turn" | "forge-evidence" | "forge-finish";
export interface CodexRuntimeDiagnostic {
  stage: CodexRuntimeVerificationStage;
  code: "failed" | "transcript" | "conversation" | "cwd" | "approval-policy" | "sandbox-policy" | "workspace-roots";
}
export function parseCodexRuntimeDiagnostic(value: unknown): CodexRuntimeDiagnostic | undefined;
export class CodexRuntimeVerificationError extends Error {
  readonly diagnostic: CodexRuntimeDiagnostic;
  constructor(diagnostic: CodexRuntimeDiagnostic, options?: ErrorOptions);
}
export const CODEX_RUNTIME_ERROR_PREFIX: string;

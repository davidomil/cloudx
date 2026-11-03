const stages = {
  load: ["verifier loading", "Build the CloudX server with npm run build -w @cloudx/server before verifying this release."],
  launch: ["native tab launch and conversation selection", "Check the Codex executable, native terminal prerequisites and conversation selection support for this release."],
  "interactive-readiness": ["interactive readiness", "The selected native tab did not become ready. Check native startup and terminal support for this release."],
  "interactive-turn": ["interactive turn", "The synthetic local-provider turn did not complete correctly. Check native turn support for this release."],
  "interactive-evidence": ["interactive turn evidence", "The completed interactive turn did not preserve the required native launch evidence. Check CloudX support for this release's transcript format."],
  "forge-resume": ["Forge conversation resume", "The native tab did not confirm the selected conversation on resume. Check native resume support for this release."],
  "forge-turn": ["Forge turn completion", "The resumed synthetic turn or its native completion receipt did not complete correctly. Check native Forge turn support for this release."],
  "forge-evidence": ["Forge turn evidence", "The completed resumed turn did not preserve the required native launch evidence. Check CloudX support for this release's transcript format."],
  "forge-finish": ["Forge turn shutdown", "The completed native Forge turn did not shut down correctly. Check native completion and shutdown support for this release."],
};

const evidenceReasons = {
  transcript: "The completed turn's native transcript evidence is missing, malformed, stale or mismatched. Check CloudX support for this release's transcript format before selecting it again.",
  conversation: "The native conversation identity does not match the selected conversation. Check native conversation selection and resume support for this release.",
  cwd: "The completed turn reports a different working directory. Check the native launch configuration before selecting this release again.",
  "approval-policy": "The completed turn did not preserve CloudX's approval policy. Check native launch policy support for this release.",
  "sandbox-policy": "The completed turn did not preserve CloudX's launch sandbox policy. Check native launch policy support for this release.",
  "workspace-roots": "The completed turn's native evidence does not prove both the workspace and CloudX skills roots. Check CloudX support for this release's workspace evidence before selecting it again.",
};

/** Public runtime failures contain only known stages and fixed diagnostic codes. */
export function parseCodexRuntimeDiagnostic(value) {
  if (!value || typeof value !== "object" || typeof value.stage !== "string" || typeof value.code !== "string" || !Object.hasOwn(stages, value.stage)) return undefined;
  const evidenceStage = ["interactive-evidence", "forge-evidence"].includes(value.stage);
  const turnStage = ["interactive-turn", "forge-turn"].includes(value.stage);
  if (value.code !== "failed" && !(evidenceStage && Object.hasOwn(evidenceReasons, value.code)) && !(turnStage && ["transcript", "conversation"].includes(value.code))) return undefined;
  return { stage: value.stage, code: value.code };
}

export class CodexRuntimeVerificationError extends Error {
  constructor(diagnostic, options) {
    const safe = parseCodexRuntimeDiagnostic(diagnostic);
    if (!safe) throw new Error("Invalid Codex runtime diagnostic.");
    const [stage, advice] = stages[safe.stage];
    super(`Codex native verification failed at ${stage}: ${safe.code === "failed" ? advice : evidenceReasons[safe.code]} The active selection is unchanged. Check the private update log for native details.`, options);
    this.name = "CodexRuntimeVerificationError";
    this.diagnostic = safe;
  }
}

export const CODEX_RUNTIME_ERROR_PREFIX = "CLOUDX_CODEX_RUNTIME_ERROR=";

import { isRecord, type CodexTerminalInitialInput } from "@cloudx/shared";

// Parses the resume selection shared by Codex and Claude agent tabs.
export function codexResumeInput(initialInput: Record<string, unknown> | undefined): Required<CodexTerminalInitialInput>["resume"] | undefined {
  if (!isRecord(initialInput) || !isRecord(initialInput.resume)) {
    return undefined;
  }
  if ("sourceId" in initialInput.resume) throw new Error("Codex session source selection is no longer supported; resume uses shared sessions.");
  const mode = initialInput.resume.mode;
  if (mode !== "picker" && mode !== "last" && mode !== "session") {
    return undefined;
  }
  const sessionId = typeof initialInput.resume.sessionId === "string" ? initialInput.resume.sessionId.trim() : "";
  if (mode === "session" && !sessionId) {
    throw new Error("Codex resume session id is required.");
  }
  return {
    mode,
    sessionId: mode === "session" ? sessionId : undefined,
    all: optionalResumeBoolean(initialInput.resume.all, "all") ?? false,
    includeNonInteractive: optionalResumeBoolean(initialInput.resume.includeNonInteractive, "includeNonInteractive") ?? false
  };
}

function optionalResumeBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Codex resume ${name} must be a boolean.`);
  }
  return value;
}

// The exact conversation a tab resumes, or undefined when it has none or the
// saved selection is invalid.
export function resumeSessionId(initialInput: Record<string, unknown> | undefined): string | undefined {
  try {
    const resume = codexResumeInput(initialInput);
    return resume?.mode === "session" ? resume.sessionId : undefined;
  } catch {
    return undefined;
  }
}

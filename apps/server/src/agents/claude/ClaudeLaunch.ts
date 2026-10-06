import fs from "node:fs/promises";
import path from "node:path";

import { CLAUDE_MODEL_ID_PATTERN as CLAUDE_MODEL_PATTERN } from "@cloudx/shared";

import { codexResumeInput } from "../resumeInput.js";
import type { ClaudeLaunchPreferences } from "./ClaudeSettingsService.js";

const SESSION_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
// Values accepted by --effort for one session.
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type ClaudeEffort = typeof CLAUDE_EFFORTS[number];

export function isClaudeModel(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_MODEL_PATTERN.test(value);
}

// Codex effort names map onto the closest Claude level. Unknown values fall
// back to Claude Code's own setting rather than failing a switch.
function claudeEffortFor(value: unknown): ClaudeEffort | undefined {
  if (value === "ultra") return "max";
  if (value === "none" || value === "minimal") return "low";
  return CLAUDE_EFFORTS.find(entry => entry === value);
}

export interface ClaudeLaunchArgsOptions {
  settings: Pick<ClaudeLaunchPreferences, "permissionMode" | "autoTrustWorkspace">;
  settingsPath: string;
  addDirs: string[];
  // Starts a new conversation under this id.
  newSessionId?: string;
}

export function buildClaudeLaunchArgs(initialInput: Record<string, unknown> | undefined, options: ClaudeLaunchArgsOptions): string[] {
  const resume = codexResumeInput(initialInput);
  const prompt = initialInput?.prompt;
  if (prompt !== undefined && (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0"))) throw new Error("Claude initial prompt must be a non-empty string without null bytes.");
  if (resume?.mode === "session" && !SESSION_ID_PATTERN.test(resume.sessionId ?? "")) throw new Error("Claude resume requires an exact session id.");
  const args = ["--settings", options.settingsPath];
  for (const directory of options.addDirs) args.push("--add-dir", directory);
  if (options.settings.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", options.settings.permissionMode);
  // A model chosen for another provider, such as a GPT model carried over from
  // a Codex run, is ignored in favor of the Claude default.
  if (isClaudeModel(initialInput?.model)) args.push("--model", initialInput.model);
  const effort = claudeEffortFor(initialInput?.reasoningEffort);
  if (effort) args.push("--effort", effort);
  if (options.newSessionId !== undefined) {
    if (resume || !SESSION_ID_PATTERN.test(options.newSessionId)) throw new Error("A new Claude session needs an exact id and no resume selection.");
    args.push("--session-id", options.newSessionId);
  } else if (resume?.mode === "session") args.push("--resume", resume.sessionId!);
  else if (resume?.mode === "last") args.push("--continue");
  else if (resume?.mode === "picker") args.push("--resume");
  if (prompt !== undefined) args.push("--", prompt as string);
  return args;
}

// Claude stores each conversation as projects/<cwd slug>/<session id>.jsonl.
export async function findClaudeTranscript(projectsDir: string, sessionId: string): Promise<string> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("An exact Claude conversation ID is required. Select a saved session.");
  let projects;
  try { projects = await fs.readdir(projectsDir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`The transcript for Claude conversation ${sessionId} is unavailable. Select a saved session.`);
    throw error;
  }
  if (projects.length > 100_000) throw new Error("Claude session lookup exceeded the directory limit.");
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(projectsDir, project.name, `${sessionId}.jsonl`);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`The transcript for Claude conversation ${sessionId} is unavailable. Select a saved session.`);
}


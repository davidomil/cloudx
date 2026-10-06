import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isRecord } from "@cloudx/shared";

import type { AgentAccountStore } from "./AgentAccountStore.js";
import { agentCommand, runAgentCli } from "./agentCli.js";
import { isClaudeModel } from "./claude/ClaudeLaunch.js";

const CLAUDE_EXEC_TIMEOUT_MS = 120_000;
const CLAUDE_EXEC_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface AgentExecOptions {
  schemaPath?: string;
  timeoutMs?: number;
  imagePaths?: string[];
  signal?: AbortSignal;
  taskLabel?: string;
  outputPrefix?: string;
  maxOutputBytes?: number;
}

// Runs one structured, read-only request and returns the final message text.
export type AgentExecFn = (model: string, prompt: string, options?: AgentExecOptions) => Promise<string>;

// The model decides the provider: Claude model ids run on Claude Code with the
// default Claude account, all other ids run on Codex as before.
export function createAgentExec(accounts: AgentAccountStore | undefined, codexExec: AgentExecFn, env: NodeJS.ProcessEnv = process.env): AgentExecFn {
  return (model, prompt, options = {}) => isClaudeModel(model)
    ? runClaudeExec(accounts, model, prompt, options, env)
    : codexExec(model, prompt, options);
}

async function runClaudeExec(
  accounts: AgentAccountStore | undefined,
  model: string,
  prompt: string,
  options: AgentExecOptions,
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (!accounts) throw new Error("Claude requests need the agent account store.");
  const env = await accounts.defaultClaudeEnv(baseEnv);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), options.outputPrefix ?? "cloudx-claude-exec-"));
  try {
    const imagePaths = options.imagePaths ?? [];
    const args = [
      "-p", "--output-format", "json", "--no-session-persistence",
      "--model", model,
      "--setting-sources", "", "--strict-mcp-config",
      // Images are read with the Read tool; nothing else is allowed.
      "--tools", imagePaths.length ? "Read" : "",
      "--permission-mode", "dontAsk",
      ...imagePaths.flatMap(imagePath => ["--add-dir", path.dirname(imagePath)])
    ];
    if (options.schemaPath) args.push("--json-schema", await fs.readFile(options.schemaPath, "utf8"));
    const stdin = imagePaths.length
      ? `${prompt}\n\nImages to inspect with the Read tool:\n${imagePaths.map(imagePath => `- ${imagePath}`).join("\n")}\n`
      : prompt;
    const result = await runAgentCli(agentCommand("claude", env), args, {
      env, cwd: workDir, stdin, signal: options.signal,
      timeoutMs: options.timeoutMs ?? CLAUDE_EXEC_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? CLAUDE_EXEC_MAX_OUTPUT_BYTES
    });
    return readClaudeExecResult(result.stdout, result.code, options.taskLabel ?? "Claude request");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

export function readClaudeExecResult(stdout: string, code: number | null, taskLabel: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); }
  catch { throw new Error(`The ${taskLabel} did not return Claude Code JSON output${code === 0 ? "" : ` (exit ${code})`}.`); }
  if (!isRecord(parsed)) throw new Error(`The ${taskLabel} returned an unexpected Claude Code result.`);
  if (parsed.is_error === true || code !== 0) {
    const detail = typeof parsed.result === "string" ? parsed.result.slice(0, 300) : String(parsed.subtype ?? "error");
    throw new Error(`The ${taskLabel} failed in Claude Code: ${detail}`);
  }
  if (parsed.structured_output !== undefined) return JSON.stringify(parsed.structured_output);
  if (typeof parsed.result === "string") return parsed.result;
  throw new Error(`The ${taskLabel} returned no Claude Code result.`);
}

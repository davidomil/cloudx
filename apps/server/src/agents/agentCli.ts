import { spawn } from "node:child_process";

import type { AgentProviderId, AgentProviderStatus } from "@cloudx/shared";
import { agentProviderLabel } from "@cloudx/shared";

import { buildToolEnv, resolveAssistantCommand, resolveClaudeCommand, type EnforcedEnv } from "../terminal/ShellLaunch.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface AgentCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface AgentCliOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export function agentCommand(providerId: AgentProviderId, env: NodeJS.ProcessEnv = process.env): string {
  return providerId === "claude" ? resolveClaudeCommand(env) : resolveAssistantCommand(env);
}

// Runs a provider CLI without a shell. Output is capped and the process is
// killed on timeout or abort, so a hung CLI cannot hold a request open.
export function runAgentCli(command: string, args: string[], options: AgentCliOptions = {}): Promise<AgentCliResult> {
  const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("The provider command was cancelled."));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildToolEnv(options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const kill = () => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const finish = (error: Error | undefined, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const onAbort = () => { kill(); finish(new Error("The provider command was cancelled.")); };
    const timer = setTimeout(() => { kill(); finish(new Error(`${command} did not finish within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} seconds.`)); },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > maxOutput) { kill(); finish(new Error(`${command} produced more than ${maxOutput} bytes of output.`)); return; }
      stdoutBytes += chunk.length;
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.length > maxOutput) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });
    child.on("error", (error) => finish((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${command} is not installed or not on PATH.`) : error));
    child.on("close", (code) => finish(undefined, code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}

export async function readAgentProviderStatus(providerId: AgentProviderId, env: NodeJS.ProcessEnv = process.env): Promise<AgentProviderStatus> {
  const command = agentCommand(providerId, env);
  const status: AgentProviderStatus = { providerId, label: agentProviderLabel(providerId), installed: false, command };
  try {
    const result = await runAgentCli(command, ["--version"], { env, timeoutMs: 5_000 });
    if (result.code !== 0) return status;
    const version = result.stdout.trim().split(/\r?\n/u)[0]?.slice(0, 120);
    return { ...status, installed: true, ...(version ? { version } : {}) };
  } catch {
    return status;
  }
}

// Inherited credentials, and markers a parent Claude Code session sets for its
// own children. A CloudX server started from inside Claude Code would
// otherwise launch tabs that act as child sessions and skip their transcripts.
const CLAUDE_INHERITED_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME",
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"
];

// Environment for a Claude launch. Credentials come only from the selected account.
export function claudeLaunchEnv(baseEnv: NodeJS.ProcessEnv, configDir: string, accountEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const name of CLAUDE_INHERITED_ENV) delete env[name];
  return { ...env, ...accountEnv, CLAUDE_CONFIG_DIR: configDir };
}

// The same selection, re-applied after a login shell's profile has run.
export function claudeEnforcedEnv(configDir: string, accountEnv: Record<string, string>): EnforcedEnv {
  return { set: { ...accountEnv, CLAUDE_CONFIG_DIR: configDir }, unset: CLAUDE_INHERITED_ENV };
}

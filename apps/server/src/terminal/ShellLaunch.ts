import path from "node:path";
import { resolveSelectedCodexCommand } from "../../../../scripts/codex-selection.mjs";

export interface ProcessLaunch {
  command: string;
  args: string[];
}

const LOGIN_SHELLS = new Set(["bash", "zsh"]);

export function resolveUserShell(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHELL?.trim() || "/bin/bash";
}

export function resolveAssistantCommand(env: NodeJS.ProcessEnv = process.env, defaultCommand = "codex"): string {
  return resolveSelectedCodexCommand(env.CLOUDX_ASSISTANT_BIN?.trim() || defaultCommand);
}

export function resolveClaudeCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLOUDX_CLAUDE_BIN?.trim() || "claude";
}

export function buildToolEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pathEntries = [
    ...splitPath(env.CLOUDX_TOOL_PATH),
    commandDirectory(env.CLOUDX_ASSISTANT_BIN?.trim() || ""),
    commandDirectory(env.CLOUDX_CLAUDE_BIN?.trim() || ""),
    ...splitPath(env.PATH)
  ].filter((entry): entry is string => Boolean(entry));
  return {
    ...env,
    PATH: dedupe(pathEntries).join(path.delimiter)
  };
}

export function buildInteractiveShellLaunch(env: NodeJS.ProcessEnv = process.env): ProcessLaunch {
  const shell = resolveUserShell(env);
  return {
    command: shell,
    args: supportsLoginShell(shell) ? ["-l"] : []
  };
}

export function buildLoginShellCommandLaunch(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ProcessLaunch {
  const shell = resolveUserShell(env);
  if (!supportsLoginShell(shell)) {
    return { command, args };
  }
  return {
    command: shell,
    args: ["-lc", `exec ${[command, ...args].map(shellQuote).join(" ")}`]
  };
}

// Variables a launched command must see as CloudX set them, even when the
// user's login profile exports its own values.
export interface EnforcedEnv {
  set: Record<string, string>;
  unset: readonly string[];
}

const ENFORCED_ENV_PREFIX = "CLOUDX_ENFORCED_";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// Like buildLoginShellCommandLaunch, then re-applies the enforced variables
// after the profile has run. Values travel in the environment under reserved
// names, never on a command line, and shell builtins move them into place
// right before exec. Spawn the command with the returned env.
export function buildEnforcedLoginShellLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  enforced: EnforcedEnv
): ProcessLaunch & { env: NodeJS.ProcessEnv } {
  const names = Object.keys(enforced.set);
  if ([...names, ...enforced.unset].some(name => !ENV_NAME_PATTERN.test(name))) throw new Error("Enforced environment variable names must be shell identifiers.");
  const direct = { ...env };
  for (const name of enforced.unset) delete direct[name];
  Object.assign(direct, enforced.set);
  if (!supportsLoginShell(resolveUserShell(env))) return { command, args, env: direct };
  const unset = enforced.unset.filter(name => !names.includes(name));
  const steps = [
    ...(unset.length ? [`unset ${unset.join(" ")}`] : []),
    ...names.map(name => `export ${name}="$${ENFORCED_ENV_PREFIX}${name}"; unset ${ENFORCED_ENV_PREFIX}${name}`)
  ];
  return {
    command: resolveUserShell(env),
    args: ["-lc", `${steps.map(step => `${step}; `).join("")}exec ${[command, ...args].map(shellQuote).join(" ")}`],
    env: { ...direct, ...Object.fromEntries(names.map(name => [`${ENFORCED_ENV_PREFIX}${name}`, enforced.set[name]!])) }
  };
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function supportsLoginShell(shell: string): boolean {
  return LOGIN_SHELLS.has(shell.split("/").pop() ?? shell);
}

function commandDirectory(command: string): string | undefined {
  return path.isAbsolute(command) ? path.dirname(command) : undefined;
}

function splitPath(value: string | undefined): string[] {
  return value?.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean) ?? [];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

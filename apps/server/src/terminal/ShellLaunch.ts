import path from "node:path";

export interface ProcessLaunch {
  command: string;
  args: string[];
}

const LOGIN_SHELLS = new Set(["bash", "zsh"]);

export function resolveUserShell(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHELL?.trim() || "/bin/bash";
}

export function resolveAssistantCommand(env: NodeJS.ProcessEnv = process.env, defaultCommand = "codex"): string {
  return env.CLOUDX_ASSISTANT_BIN?.trim() || defaultCommand;
}

export function buildToolEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pathEntries = [
    ...splitPath(env.CLOUDX_TOOL_PATH),
    commandDirectory(resolveAssistantCommand(env, "")),
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

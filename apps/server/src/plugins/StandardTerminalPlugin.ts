import type { CreatePluginSessionInput, WorkspacePlugin } from "@cloudx/plugin-api";

import { CodexTerminalSession, DEFAULT_TERMINAL_REPLAY_BYTES, TERMINAL_ACTIONS } from "./CodexTerminalPlugin.js";
import type { TerminalProcessFactory } from "../terminal/TerminalProcess.js";

export class StandardTerminalPlugin implements WorkspacePlugin {
  readonly id = "standard-terminal";
  readonly acronym = "TTY";
  readonly displayName = "Terminal";
  readonly description = "Runs the user's shell in a PTY-backed web terminal.";
  readonly panelKind = "terminal" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;
  readonly actions = TERMINAL_ACTIONS;

  constructor(
    private readonly factory: TerminalProcessFactory,
    private readonly replayBytes = DEFAULT_TERMINAL_REPLAY_BYTES
  ) {}

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
      configFields: [],
      actions: this.actions
    };
  }

  async createSession(input: CreatePluginSessionInput) {
    const shell = process.env.SHELL ?? "/bin/bash";
    const terminalProcess = await this.factory.spawn(shell, [], {
      cwd: input.cwd,
      env: buildShellIntegrationEnv(process.env, shell),
      cols: 100,
      rows: 30
    });
    return new CodexTerminalSession(input.tab, terminalProcess, input.controls, {
      closeOnExit: false,
      replayBytes: this.replayBytes,
      voiceKind: "standard-terminal",
      voiceSummary: "Interactive shell terminal. Translate natural-language shell requests into concise shell commands before typing."
    });
  }
}

export function buildShellIntegrationEnv(env: NodeJS.ProcessEnv, shell: string): NodeJS.ProcessEnv {
  if (!/bash$/.test(shell)) {
    return env;
  }
  const marker = `__cloudx_status=$?; if [ "\${__CLOUDX_PROMPT_SEEN:-0}" = "1" ]; then printf '\\033]633;D;%s\\007' "$__cloudx_status"; fi; __CLOUDX_PROMPT_SEEN=1`;
  const existingPromptCommand = env.PROMPT_COMMAND?.trim();
  return {
    ...env,
    PROMPT_COMMAND: existingPromptCommand ? `${marker}; ${existingPromptCommand}` : marker
  };
}

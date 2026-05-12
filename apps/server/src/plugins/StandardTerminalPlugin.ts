import type { CreatePluginSessionInput, WorkspacePlugin } from "@cloudx/plugin-api";

import { CodexTerminalSession, TERMINAL_ACTIONS } from "./CodexTerminalPlugin.js";
import type { TerminalProcessFactory } from "../terminal/TerminalProcess.js";

export class StandardTerminalPlugin implements WorkspacePlugin {
  readonly id = "standard-terminal";
  readonly displayName = "Terminal";
  readonly description = "Runs the user's shell in a PTY-backed web terminal.";
  readonly panelKind = "terminal" as const;
  readonly creatable = true;
  readonly actions = TERMINAL_ACTIONS;

  constructor(private readonly factory: TerminalProcessFactory) {}

  descriptor() {
    return {
      id: this.id,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      actions: this.actions
    };
  }

  async createSession(input: CreatePluginSessionInput) {
    const shell = process.env.SHELL ?? "/bin/bash";
    const terminalProcess = await this.factory.spawn(shell, [], {
      cwd: input.cwd,
      env: process.env,
      cols: 100,
      rows: 30
    });
    return new CodexTerminalSession(input.tab, terminalProcess);
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";
import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";
import { buildShellIntegrationEnv, StandardTerminalPlugin } from "./StandardTerminalPlugin.js";

class CapturingFactory implements TerminalProcessFactory {
  command: string | undefined;
  args: string[] | undefined;
  env: NodeJS.ProcessEnv | undefined;

  async spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }): Promise<TerminalProcess> {
    this.command = command;
    this.args = args;
    this.env = options.env;
    return {
      onData: () => () => undefined,
      onExit: () => () => undefined,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    };
  }
}

describe("StandardTerminalPlugin shell integration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("injects bash PROMPT_COMMAND markers for command exit codes", () => {
    const env = buildShellIntegrationEnv({ PROMPT_COMMAND: "history -a" } as NodeJS.ProcessEnv, "/bin/bash");

    expect(env.PROMPT_COMMAND).toContain("]633;D;%s");
    expect(env.PROMPT_COMMAND).toContain("history -a");
  });

  it("leaves non-bash shells unchanged", () => {
    const env = { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv;

    expect(buildShellIntegrationEnv(env, "/bin/zsh")).toBe(env);
  });

  it("uses the shell integration env when creating standard terminal sessions", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    const factory = new CapturingFactory();
    const plugin = new StandardTerminalPlugin(factory);

    const session = await plugin.createSession({ tab, cwd: "/tmp", controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });

    expect(factory.command).toBe("/bin/bash");
    expect(factory.args).toEqual(["-l"]);
    expect(factory.env?.PROMPT_COMMAND).toContain("]633;D;%s");
    await expect(Promise.resolve(session.voiceContext()).then((context) => context.kind)).resolves.toBe("standard-terminal");
  });
});

const tab: WorkspaceTab = {
  id: "tab-1",
  pluginId: "standard-terminal",
  title: "Shell",
  cwd: "/tmp",
  status: "running",
  indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

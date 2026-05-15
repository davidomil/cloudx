import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TabIndicatorUpdate, WorkspaceTab } from "@cloudx/shared";

import { CodexTerminalPlugin, CodexTerminalSession, TerminalShellIntegrationParser, materializeCodexProfile } from "./CodexTerminalPlugin.js";
import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";

class FakeTerminalProcess implements TerminalProcess {
  written = "";
  killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void {
    this.exitListener = listener;
    return () => {
      this.exitListener = undefined;
    };
  }

  write(data: string): void {
    this.written += data;
  }

  resize(): void {
    return undefined;
  }

  kill(): void {
    this.killed = true;
    this.exitListener?.({ exitCode: 130 });
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  exit(exitCode: number): void {
    this.exitListener?.({ exitCode });
  }
}

class CapturingFactory implements TerminalProcessFactory {
  command: string | undefined;
  args: string[] | undefined;
  env: NodeJS.ProcessEnv | undefined;

  async spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }): Promise<TerminalProcess> {
    this.command = command;
    this.args = args;
    this.env = options.env;
    return new FakeTerminalProcess();
  }
}

const tab: WorkspaceTab = {
  id: "tab-1",
  pluginId: "codex-terminal",
  title: "Test",
  cwd: "/tmp",
  status: "running",
  indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};
const tempCodexHomes: string[] = [];

describe("CodexTerminalPlugin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const codexHome of tempCodexHomes.splice(0)) {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("launches Codex through the user's login shell", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory);

    await plugin.createSession({ tab, cwd: "/tmp", controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });

    expect(factory.command).toBe("/bin/bash");
    expect(factory.args).toEqual(["-lc", "exec /usr/bin/codex"]);
  });

  it("uses assistant command and environment from the resolved personality profile", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CODEX_HOME", createCodexHome({ "code-review": "Code review skill instructions." }));
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory);

    await plugin.createSession({
      tab,
      cwd: "/tmp",
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined },
      runtimeContext: {
        pluginRuntime: {
          "rules-skills": {
            personalityProfile: {
              source: "tab",
              profile: {
                id: "claude",
                name: "Claude",
                color: "yellow",
                assistantCommand: "/usr/bin/claude",
                rulesText: "Review carefully.",
                enabledSkillIds: ["code-review"],
                enabledPluginIds: ["file-browser"],
                env: { CLOUDX_PROFILE: "claude" }
              }
            }
          }
        }
      }
    });

    expect(factory.args?.[0]).toBe("-lc");
    expect(factory.args?.[1]).toContain("exec /usr/bin/claude");
    expect(factory.args?.[1]).toContain("Review carefully.");
    expect(factory.args?.[1]).toContain("Code review skill instructions.");
    expect(factory.env?.CLOUDX_PROFILE).toBe("claude");
    expect(factory.env).toMatchObject({
      CLOUDX_PERSONALITY_PROFILE_ID: "claude",
      CLOUDX_PERSONALITY_PROFILE_NAME: "Claude",
      CLOUDX_PERSONALITY_INJECTION: "prompt-argument",
      CLOUDX_PERSONALITY_RULES: "Review carefully.",
      CLOUDX_ENABLED_SKILL_IDS: "code-review",
      CLOUDX_ENABLED_PLUGIN_IDS: "file-browser"
    });
  });

  it("materializes stored profile fields into launch environment for wrapper commands", () => {
    const codexHome = createCodexHome({
      reviewer: "Reviewer skill instructions.",
      testing: "Testing skill instructions."
    });
    const launch = materializeCodexProfile(
      {
        id: "review",
        name: "Review",
        color: "red",
        rulesText: "Find correctness issues.",
        enabledSkillIds: ["reviewer", "testing"],
        enabledPluginIds: ["file-browser"],
        env: { CUSTOM_ENV: "1" }
      },
      { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", CODEX_HOME: codexHome }
    );

    expect(launch.command).toBe("/usr/bin/codex");
    expect(launch.args).toHaveLength(1);
    expect(launch.injectionPrompt).toContain("Find correctness issues.");
    expect(launch.injectionPrompt).toContain("Reviewer skill instructions.");
    expect(launch.injectionPrompt).toContain("Testing skill instructions.");
    expect(launch.env).toMatchObject({
      CUSTOM_ENV: "1",
      CLOUDX_PERSONALITY_PROFILE_ID: "review",
      CLOUDX_PERSONALITY_PROFILE_NAME: "Review",
      CLOUDX_PERSONALITY_INJECTION: "prompt-argument",
      CLOUDX_PERSONALITY_RULES: "Find correctness issues.",
      CLOUDX_ENABLED_SKILL_IDS: "reviewer,testing",
      CLOUDX_ENABLED_PLUGIN_IDS: "file-browser"
    });
    expect(launch.voiceSummary).toContain("Review");
  });

  it("fails clearly when a selected skill cannot be materialized", () => {
    const codexHome = createCodexHome({});

    expect(() =>
      materializeCodexProfile(
        {
          id: "review",
          name: "Review",
          color: "red",
          enabledSkillIds: ["missing-skill"],
          enabledPluginIds: []
        },
        { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", CODEX_HOME: codexHome }
      )
    ).toThrow(/missing-skill.*SKILL\.md/);
  });

  it("loads system and plugin-qualified skill instructions", () => {
    const codexHome = createCodexHome({});
    writeSkillFile(codexHome, ["skills", ".system", "plugin-creator"], "System plugin creator instructions.");
    writeSkillFile(
      codexHome,
      ["plugins", "cache", "openai-curated", "build-web-apps", "b8edb371", "skills", "react-best-practices"],
      "React best practices instructions."
    );

    const launch = materializeCodexProfile(
      {
        id: "frontend",
        name: "Frontend",
        color: "green",
        enabledSkillIds: ["plugin-creator", "build-web-apps:react-best-practices"],
        enabledPluginIds: []
      },
      { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", CODEX_HOME: codexHome }
    );

    expect(launch.injectionPrompt).toContain("System plugin creator instructions.");
    expect(launch.injectionPrompt).toContain("React best practices instructions.");
  });
});

function createCodexHome(skills: Record<string, string>): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-codex-home-"));
  tempCodexHomes.push(codexHome);
  for (const [skillId, content] of Object.entries(skills)) {
    writeSkillFile(codexHome, ["skills", skillId], content);
  }
  return codexHome;
}

function writeSkillFile(codexHome: string, segments: string[], content: string): void {
  const skillDir = path.join(codexHome, ...segments);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
}

describe("CodexTerminalSession", () => {
  it("types text and submits when requested", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);

    session.handleAction("enter_text", { text: "run tests", submit: true });

    expect(process.written).toBe("run tests\r");
  });

  it("keeps the submit key separate for Codex TUI input", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, submitDelayMs: 25 });

      session.handleAction("enter_text", { text: "run tests", submit: true });

      expect(process.written).toBe("run tests");
      await vi.advanceTimersByTimeAsync(25);
      expect(process.written).toBe("run tests\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes trailing line breaks before adding the submit key", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);

    const result = session.handleAction("enter_text", { text: "run tests\n\n", submit: true });

    expect(process.written).toBe("run tests\r");
    expect(result).toEqual({ typed: 9, submitted: true });
  });

  it("maps supported keys to terminal sequences", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);

    session.handleAction("send_key", { key: "ctrl-c" });

    expect(process.written).toBe("\u0003");
  });

  it("keeps recent output within the configured replay buffer", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, replayBytes: 6 });

    process.emitData("alpha");
    process.emitData("beta");

    expect(session.snapshot().recentOutput).toBe("habeta");
  });

  it("exposes terminal output through standardized voice context", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process, undefined, {
      closeOnExit: false,
      voiceKind: "codex-terminal",
      voiceSummary: "Codex terminal"
    });

    process.emitData("running tests\nall green");

    expect(session.voiceContext()).toMatchObject({
      kind: "codex-terminal",
      cwd: "/tmp",
      status: "running",
      summary: "Codex terminal",
      visibleText: "running tests\nall green",
      recentOutput: "running tests\nall green"
    });
  });

  it("marks successful and failed shell-integrated commands", () => {
    const process = new FakeTerminalProcess();
    const indicators: TabIndicatorUpdate[] = [];
    new CodexTerminalSession(tab, process, {
      setTabIndicator: (indicator) => indicators.push(indicator),
      closeTab: () => undefined
    });

    process.emitData("\u001b]633;D;0\u0007");
    process.emitData("\u001b]133;D;2\u001b\\");

    expect(indicators).toMatchObject([
      { color: "green", label: "Command completed" },
      { color: "red", label: "Command failed" }
    ]);
  });

  it("closes Codex tabs when the Codex process exits", () => {
    const process = new FakeTerminalProcess();
    const closed: string[] = [];
    new CodexTerminalSession(
      tab,
      process,
      {
        setTabIndicator: () => undefined,
        closeTab: (reason) => closed.push(reason ?? "")
      },
      { closeOnExit: true }
    );

    process.exit(1);

    expect(closed).toEqual(["Codex exited with code 1."]);
  });

  it("keeps immediately failed Codex tabs open long enough to show the failure", () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const closed: string[] = [];
      const statuses: Array<{ status: WorkspaceTab["status"]; message?: string }> = [];
      const session = new CodexTerminalSession(
        tab,
        process,
        {
          setTabIndicator: () => undefined,
          closeTab: (reason) => closed.push(reason ?? "")
        },
        { closeOnExit: true, closeOnExitAfterMs: 2000 }
      );
      session.onStatusChange((status, message) => statuses.push({ status, message }));

      process.exit(1);

      expect(closed).toEqual([]);
      expect(statuses).toEqual([{ status: "failed", message: "Codex exited with code 1." }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still closes Codex tabs after the startup grace period", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const closed: string[] = [];
      new CodexTerminalSession(
        tab,
        process,
        {
          setTabIndicator: () => undefined,
          closeTab: (reason) => closed.push(reason ?? "")
        },
        { closeOnExit: true, closeOnExitAfterMs: 2000 }
      );

      await vi.advanceTimersByTimeAsync(2000);
      process.exit(0);

      expect(closed).toEqual(["Codex exited cleanly."]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TerminalShellIntegrationParser", () => {
  it("parses chunked OSC command-finished events", () => {
    const parser = new TerminalShellIntegrationParser();

    expect(parser.push("before \u001b]133;D;")).toEqual([]);
    expect(parser.push("1\u0007 after")).toEqual([{ sequence: 133, exitCode: 1 }]);
  });

  it("accepts VS Code OSC 633 command-finished events without exit code", () => {
    const parser = new TerminalShellIntegrationParser();

    expect(parser.push("\u001b]633;D\u001b\\")).toEqual([{ sequence: 633 }]);
  });
});

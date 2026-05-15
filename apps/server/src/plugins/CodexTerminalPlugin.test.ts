import { afterEach, describe, expect, it, vi } from "vitest";

import type { TabIndicatorUpdate, WorkspaceTab } from "@cloudx/shared";

import { CodexTerminalPlugin, CodexTerminalSession, TerminalShellIntegrationParser } from "./CodexTerminalPlugin.js";
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

  async spawn(command: string, args: string[]): Promise<TerminalProcess> {
    this.command = command;
    this.args = args;
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

describe("CodexTerminalPlugin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
});

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

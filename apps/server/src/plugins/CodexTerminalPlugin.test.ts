import { describe, expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { CodexTerminalSession } from "./CodexTerminalPlugin.js";
import type { TerminalProcess } from "../terminal/TerminalProcess.js";

class FakeTerminalProcess implements TerminalProcess {
  written = "";
  killed = false;
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  onData(): () => void {
    return () => undefined;
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
}

const tab: WorkspaceTab = {
  id: "tab-1",
  pluginId: "codex-terminal",
  title: "Test",
  cwd: "/tmp",
  status: "running",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

describe("CodexTerminalSession", () => {
  it("types text and submits when requested", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);

    session.handleAction("enter_text", { text: "run tests", submit: true });

    expect(process.written).toBe("run tests\r");
  });

  it("maps supported keys to terminal sequences", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);

    session.handleAction("send_key", { key: "ctrl-c" });

    expect(process.written).toBe("\u0003");
  });
});

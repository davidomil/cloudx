import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@cloudx/shared";

import { CodexTerminalPlugin, CodexTerminalSession } from "./CodexTerminalPlugin.js";
import { DurableTerminalProcessFactory } from "../terminal/DurableTerminalProcess.js";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import type { TerminalProducer } from "../terminal/TerminalProcess.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

const tab: WorkspaceTab = {
  id: "owned-output", pluginId: "codex-terminal", ownerPluginId: "forge", title: "Owned terminal",
  cwd: "/tmp", status: "running", indicator: { color: "green", label: "Running", updatedAt: new Date(0).toISOString() },
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
};

describe("directly owned terminal output", () => {
  it("pauses pending UTF-8 bytes and resumes parsing without a browser attachment", async () => {
    const { terminal, session } = fixture();
    const original = await session.attachTerminal(() => {});
    original.dispose();
    const chunk = "😀".repeat(16 * 1024);
    for (let index = 0; index < 3; index++) terminal.data(chunk);
    expect(terminal.pauseOutput).not.toHaveBeenCalled();
    terminal.data(chunk);
    expect(terminal.pauseOutput).toHaveBeenCalledOnce();
    expect(terminal.resumeOutput).not.toHaveBeenCalled();

    const restored = await session.attachTerminal(() => {});
    expect(terminal.resumeOutput).toHaveBeenCalledOnce();
    expect(restored.screen.data).toContain("😀");
    terminal.data("x".repeat(256 * 1024));
    expect(terminal.pauseOutput).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(terminal.resumeOutput).toHaveBeenCalledTimes(2));
    expect(Buffer.byteLength(session.snapshot().recentOutput!)).toBeLessThanOrEqual(1024);
  });

  it("accounts for output delivered synchronously when the native consumer subscribes", async () => {
    const { terminal, session } = fixture("x".repeat(256 * 1024));
    expect(terminal.pauseOutput).toHaveBeenCalledOnce();
    const restored = await session.attachTerminal(() => {});
    expect(terminal.resumeOutput).toHaveBeenCalledOnce();
    expect(restored.screen.data).toContain("x".repeat(100));
  });

  it.each(["terminate", "stop action"] as const)("keeps paused output recoverable when %s is rejected", async (close) => {
    const { terminal, session } = fixture();
    terminal.terminate.mockRejectedValueOnce(new Error("Descendants are still running."));
    terminal.data("x".repeat(256 * 1024));
    expect(terminal.pauseOutput).toHaveBeenCalledOnce();
    await expect(close === "terminate" ? session.terminate() : session.handleAction("stop", {}))
      .rejects.toThrow("Descendants are still running.");
    const restored = await session.attachTerminal(() => {});
    expect(terminal.resumeOutput).toHaveBeenCalledOnce();
    expect(session.snapshot().status).toBe("running");
    expect(restored.screen.data).toContain("x".repeat(100));
    session.write("NEXT_COMMAND\n");
    expect(terminal.write).toHaveBeenCalledWith("NEXT_COMMAND\n");
    terminal.data("\r\nAFTER_REJECTED_STOP");
    expect((await session.attachTerminal(() => {})).screen.data).toContain("AFTER_REJECTED_STOP");
  });

  it.each(["terminate", "stop action", "stop", "exit"] as const)("does not resume an exited producer during %s", async (close) => {
    const { terminal, session } = fixture();
    const received: string[] = [];
    await session.attachTerminal(data => { received.push(data); });
    const data = "x".repeat(256 * 1024);
    terminal.data(data);
    expect(terminal.pauseOutput).toHaveBeenCalledOnce();
    if (close === "terminate") await session.terminate();
    else if (close === "stop action") await session.handleAction("stop", {});
    else if (close === "stop") session.stop();
    else terminal.exit();
    await vi.waitFor(() => expect(received.join("")).toBe(data));
    expect(terminal.resumeOutput).not.toHaveBeenCalled();
    expect(session.snapshot().status).toBe(close === "exit" ? "completed" : "stopped");
    if (close === "stop action") {
      expect((await session.attachTerminal(() => {})).screen.data).toContain("x".repeat(100));
    } else if (close === "terminate") {
      await expect(session.attachTerminal(() => {})).rejects.toThrow("disposed");
    }
  });

  it("reports a producer resume failure and still confirms explicit termination", async () => {
    const { terminal, session } = fixture();
    terminal.resumeOutput.mockImplementationOnce(() => { throw new Error("Native output resume failed."); });
    terminal.data("x".repeat(256 * 1024));
    await vi.waitFor(() => expect(session.snapshot()).toMatchObject({ status: "failed", statusMessage: "Native output resume failed." }));
    await expect(session.handleAction("stop", {})).resolves.toEqual({ stopped: true });
    expect(terminal.terminate).toHaveBeenCalledOnce();
    expect(session.snapshot().status).toBe("stopped");
  });
});

describe.skipIf(process.platform !== "linux")("native Forge-owned terminal output", () => {
  it("delivers a 64 MiB burst with 1024 replay bytes, snapshots, subsequent input, and confirmed termination", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-owned-output-"));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const shell = path.join(directory, "codex-fixture");
    await fs.writeFile(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o700 });
    vi.stubEnv("SHELL", "/bin/sh");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", shell);
    const native = new NodePtyTerminalProcessFactory();
    const spawn = vi.spyOn(native, "spawn");
    const factory = new DurableTerminalProcessFactory(path.join(directory, "absent-broker.sock"), native);
    const plugin = new CodexTerminalPlugin(factory, 1024);
    const closeTab = vi.fn();
    const session = await plugin.createSession({
      tab: { ...tab, cwd: directory }, cwd: directory, controls: { closeTab, setTabIndicator: vi.fn() }
    });
    cleanups.push(() => session.terminate!());
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][2]).not.toHaveProperty("sessionId");
    const producer = await spawn.mock.results[0].value;
    const pause = vi.spyOn(producer, "pauseOutput");
    let output = "";
    let printableBytes = 0;
    await session.attachTerminal!((data) => {
      printableBytes += data.length - data.replaceAll("@", "").length;
      output = (output + data).slice(-4096);
    });
    session.write!("stty -echo; PS1=''; printf '\\nREADY_PID=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(output).toMatch(/READY_PID=\d+/u));
    const pid = Number(/READY_PID=(\d+)/u.exec(output)![1]);
    session.write!("python3 -c \"import os; [os.write(1, b'@' * 65536) for _ in range(1024)]\"; printf '\\nBURST_DONE=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(session.snapshot().recentOutput).toContain(`BURST_DONE=${pid}`), { timeout: 75_000 });
    const restored = await session.attachTerminal!(() => {});
    expect(printableBytes).toBe(64 * 1024 * 1024);
    expect(restored.screen.data).toContain(`BURST_DONE=${pid}`);
    expect(pause).toHaveBeenCalled();
    expect(session.snapshot().status).toBe("running");
    expect(Buffer.byteLength(session.snapshot().recentOutput!)).toBeLessThanOrEqual(1024);
    await session.handleAction("enter_text", { text: "printf '\\nAFTER_BURST=%s\\n' \"$$\"", submit: true });
    await vi.waitFor(() => expect(output).toContain(`AFTER_BURST=${pid}`));
    expect((await session.attachTerminal!(() => {})).screen.data).toContain(`AFTER_BURST=${pid}`);
    await expect(session.handleAction("stop", {})).resolves.toEqual({ stopped: true });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(session.snapshot().status).toBe("stopped");
    expect((await session.attachTerminal!(() => {})).screen.data).toContain(`AFTER_BURST=${pid}`);
    expect(closeTab).not.toHaveBeenCalled();
  }, 90_000);
});

function fixture(initialOutput = "") {
  const terminal = new TestProducer(initialOutput);
  const session = new CodexTerminalSession(tab, terminal, undefined, { closeOnExit: false, replayBytes: 1024 });
  cleanups.push(() => session.terminate());
  return { terminal, session };
}

class TestProducer implements TerminalProducer {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();
  readonly pauseOutput = vi.fn();
  readonly resumeOutput = vi.fn();
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly kill = vi.fn(() => this.exit());
  readonly terminate = vi.fn(async () => this.exit());

  constructor(private readonly initialOutput: string) {}

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    if (this.initialOutput) listener(this.initialOutput);
    return () => { this.dataListeners.delete(listener); };
  }

  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  data(data: string) { for (const listener of this.dataListeners) listener(data); }
  exit() { for (const listener of this.exitListeners) listener({ exitCode: 0 }); }
}

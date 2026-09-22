import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalProcess, TerminalSpawnOptions } from "./TerminalProcess.js";
import { TerminalReadiness } from "./TerminalReadiness.js";
import type { TerminalExit } from "./TerminalSupervisor.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("TerminalReadiness", () => {
  it("coalesces concurrent checks and retires both launch paths before becoming ready", async () => {
    const directory = await temporaryDirectory();
    const terminals: TerminalProcess[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spawn = vi.fn(async (_command: string, _args: string[], options: TerminalSpawnOptions) => {
      await gate;
      const terminal = probeTerminal(options);
      terminals.push(terminal);
      return terminal;
    });
    const readiness = new TerminalReadiness(directory, { spawn });

    const first = readiness.check();
    expect(readiness.check()).toBe(first);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    release();
    await first;

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]![2].sessionId).toMatch(/^terminal-readiness-/u);
    expect(spawn.mock.calls[1]![2].sessionId).toBeUndefined();
    for (const terminal of terminals) {
      expect(terminal.terminate).toHaveBeenCalledOnce();
      expect(terminal.detach).toHaveBeenCalledOnce();
    }
    expect(await fs.readdir(directory)).toEqual([]);
    await readiness.check();
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["missing marker", { output: "unrelated output" }, "expected marker"],
    ["failed exit", { event: { exitCode: 23 } }, "exit 23"],
    ["signal exit", { event: { exitCode: 0, signal: 9 } }, "signal 9"],
    ["excessive output", { output: "x".repeat(4097) }, "output limit"],
    ["command timeout", { event: null }, "did not exit before the deadline"],
    ["unconfirmed cleanup", { cleanupError: new Error("descendants remain unconfirmed") }, "descendants remain unconfirmed"]
  ] as const)("rejects %s, requests cleanup, and retains probe evidence", async (_reason, behavior, message) => {
    const directory = await temporaryDirectory();
    let terminal!: TerminalProcess;
    const spawn = vi.fn(async (_command: string, _args: string[], options: TerminalSpawnOptions) => {
      terminal = probeTerminal(options, behavior);
      return terminal;
    });

    await expect(new TerminalReadiness(directory, { spawn }, 50).check()).rejects.toThrow(message);

    expect(spawn).toHaveBeenCalledOnce();
    expect(terminal.terminate).toHaveBeenCalledOnce();
    expect(terminal.detach).toHaveBeenCalledOnce();
    expect(await fs.readdir(directory)).toHaveLength(1);
  });
});

function probeTerminal(options: TerminalSpawnOptions, behavior: { output?: string; event?: TerminalExit | null; cleanupError?: Error } = {}): TerminalProcess {
  const event = behavior.event === undefined ? { exitCode: 0 } : behavior.event;
  return {
    onData(listener) {
      listener(behavior.output ?? `CLOUDX_TERMINAL_READY:${options.execution!.executionId}`);
      return () => {};
    },
    onExit(listener) {
      if (event) queueMicrotask(() => listener(event));
      return () => {};
    },
    write() {}, resize() {}, kill() {},
    terminate: vi.fn(async () => { if (behavior.cleanupError) throw behavior.cleanupError; }),
    detach: vi.fn()
  };
}

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-readiness-test-"));
  directories.push(directory);
  return directory;
}

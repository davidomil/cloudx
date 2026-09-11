import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableTerminalProcessFactory } from "./DurableTerminalProcess.js";
import { TerminalBroker } from "./TerminalBroker.js";
import { isTerminalRequest, MAX_TERMINAL_MESSAGE_BYTES, terminalReplay, terminalSocketPath } from "./TerminalBrokerProtocol.js";
import type { TerminalProcess } from "./TerminalProcess.js";
import type { TerminalExit } from "./TerminalSupervisor.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("durable terminal broker", () => {
  it("keeps the terminal alive when detached, replays bounded output, and forwards input and explicit shutdown", async () => {
    const { factory, process, spawn } = await fixture(8);
    const first = await factory.spawn("shell", [], options("tab-1"));
    first.detach?.();
    process.data("discarded-prefix");
    process.data("restored");
    expect(process.terminate).not.toHaveBeenCalled();

    const restored = await factory.attach("tab-1");
    let output = "";
    restored.onData((data) => { output += data; });
    await vi.waitFor(() => expect(output).toBe("restored"));
    restored.write("continue\n");
    restored.resize(80, 24);
    await vi.waitFor(() => expect(process.write).toHaveBeenCalledWith("continue\n"));
    expect(process.resize).toHaveBeenCalledWith(80, 24);
    expect(spawn).toHaveBeenCalledTimes(1);

    await restored.terminate();
    expect(process.terminate).toHaveBeenCalledTimes(1);
    await expect(factory.attach("tab-1")).rejects.toThrow("not restarted");
  });

  it("preserves exit status and output produced while no web client was connected", async () => {
    const { factory, process } = await fixture();
    const original = await factory.spawn("shell", [], options("tab-exit"));
    original.detach?.();
    process.data("finished\n");
    process.exit({ exitCode: 23 });

    const restored = await factory.attach("tab-exit");
    const output: string[] = [];
    restored.onData((data) => output.push(data));
    const exited = new Promise((resolve) => restored.onExit(resolve));
    expect(await exited).toEqual({ exitCode: 23 });
    expect(output.join("")).toBe("finished\n");
    await restored.terminate();
  });

  it("rejects duplicate identities and unknown restores without launching another terminal", async () => {
    const { factory, spawn } = await fixture();
    await factory.spawn("shell", [], options("known"));
    await expect(factory.spawn("shell", [], options("known"))).rejects.toThrow("already exists");
    await expect(factory.attach("missing")).rejects.toThrow("not restarted");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["kill", "terminate"] as const)("releases an explicitly closed identity via %s and confirms shutdown to all attachments", async (close) => {
    const { factory, spawn } = await fixture();
    const first = await factory.spawn("shell", [], options("restarted"));
    const second = await factory.attach("restarted");
    const disconnected = vi.fn();
    second.onDisconnect!(disconnected);
    const exited = new Promise((resolve) => second.onExit(resolve));
    await first[close]();
    await exited;
    await second.terminate();
    const restarted = await factory.spawn("new-shell", [], options("restarted"));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(disconnected).not.toHaveBeenCalled();
    await restarted.terminate();
  });

  it("keeps embedded terminals under the caller's existing process owner", async () => {
    const process = new FakeTerminal();
    const spawn = vi.fn(async () => process);
    const factory = new DurableTerminalProcessFactory("/nonexistent/broker.sock", { spawn });
    const { sessionId: _sessionId, ...embedded } = options("unused");
    expect(await factory.spawn("embedded", [], embedded)).toBe(process);
    expect(spawn).toHaveBeenCalledWith("embedded", [], embedded);
    await expect(factory.attach("missing")).rejects.toThrow("broker is unavailable");
  });

  it("reports launch failure and retains identity when descendant shutdown cannot be confirmed", async () => {
    const { factory, process, spawn } = await fixture();
    spawn.mockRejectedValueOnce(new Error("The executable is unavailable."));
    await expect(factory.spawn("missing", [], options("failed-start"))).rejects.toThrow("executable is unavailable");
    const terminal = await factory.spawn("shell", [], options("failed-start"));
    process.terminate.mockRejectedValueOnce(new Error("Descendants are still running."));
    await expect(terminal.terminate()).rejects.toThrow("Descendants are still running");
    await expect(factory.spawn("duplicate", [], options("failed-start"))).rejects.toThrow("already exists");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not replace a socket already owned by a running broker", async () => {
    const { factory, socketPath } = await fixture();
    const other = new TerminalBroker(socketPath, { spawn: vi.fn() });
    await expect(other.start()).rejects.toThrow("already running");
    const terminal = await factory.spawn("shell", [], options("still-reachable"));
    await terminal.terminate();
  });

  it("refuses an insecure directory or a symlink to a private directory", async () => {
    const directory = await temporaryDirectory();
    await fs.chmod(directory, 0o755);
    await expect(new TerminalBroker(path.join(directory, "broker.sock"), { spawn: vi.fn() }).start()).rejects.toThrow("mode 0700");
    await fs.chmod(directory, 0o700);
    const link = `${directory}-link`;
    await fs.symlink(directory, link);
    cleanups.push(() => fs.unlink(link));
    await expect(new TerminalBroker(path.join(link, "broker.sock"), { spawn: vi.fn() }).start()).rejects.toThrow("mode 0700");
  });

  it.each(["invalid request", "oversized request"])("disconnects an %s without creating a terminal", async (mode) => {
    const { socketPath, spawn } = await fixture();
    const socket = net.createConnection(socketPath);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(mode === "invalid request" ? '{"type":"spawn","sessionId":"bad"}\n' : "x".repeat(MAX_TERMINAL_MESSAGE_BYTES + 1));
    await closed;
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports transport loss without claiming that the terminal exited", async () => {
    const directory = await temporaryDirectory();
    const socketPath = path.join(directory, "broker.sock");
    const server = net.createServer((socket) => socket.once("data", () => socket.end('{"type":"ready"}\n')));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await fs.chmod(socketPath, 0o600);
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const factory = new DurableTerminalProcessFactory(socketPath, { spawn: vi.fn() });
    const terminal = await factory.attach("retained");
    const exit = vi.fn();
    terminal.onExit(exit);
    const disconnected = new Promise<Error>((resolve) => terminal.onDisconnect!(resolve));
    expect((await disconnected).message).toContain("not confirmed stopped");
    expect(exit).not.toHaveBeenCalled();
    await expect(terminal.terminate()).rejects.toThrow("connection is closed");
  });

  it("uses a short stable socket path and retains complete Unicode characters in replay", () => {
    expect(Buffer.byteLength(terminalSocketPath(`/a/${"long-path/".repeat(40)}`))).toBeLessThan(104);
    expect(terminalSocketPath("/a/../b")).toBe(terminalSocketPath("/b"));
    expect(terminalSocketPath("/a")).not.toBe(terminalSocketPath("/b"));
    expect(terminalReplay("old😀new", 6)).toBe("new");
    expect(terminalReplay("old😀new", 7)).toBe("😀new");
  });

  it.each([
    { ...options("id"), cols: 0 },
    { ...options("id"), rows: 1.5 },
    { ...options("id"), cwd: "relative" },
    { ...options("id"), env: { TOKEN: { secret: true } } }
  ])("validates serialized spawn options before host execution", (invalid) => {
    expect(isTerminalRequest({ type: "spawn", sessionId: "id", command: "sh", args: [], options: invalid })).toBe(false);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-broker-test-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(replayBytes?: number) {
  const directory = await temporaryDirectory();
  const socketPath = path.join(directory, "broker.sock");
  const process = new FakeTerminal();
  const spawn = vi.fn(async () => process);
  const broker = new TerminalBroker(socketPath, { spawn }, replayBytes);
  await broker.start();
  cleanups.push(() => broker.stop());
  return { socketPath, factory: new DurableTerminalProcessFactory(socketPath, { spawn }), process, spawn };
}

function options(sessionId: string) { return { cwd: os.tmpdir(), env: { PATH: "/usr/bin" }, cols: 100, rows: 30, sessionId }; }

class FakeTerminal implements TerminalProcess {
  data = (_data: string) => {};
  exit = (_event: TerminalExit) => {};
  onData(listener: (data: string) => void) { this.data = listener; return () => {}; }
  onExit(listener: (event: TerminalExit) => void) { this.exit = listener; return () => {}; }
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();
  terminate = vi.fn(async () => { this.exit({ exitCode: 0 }); });
}

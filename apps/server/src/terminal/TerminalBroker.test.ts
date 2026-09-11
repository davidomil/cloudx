import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableTerminalProcessFactory } from "./DurableTerminalProcess.js";
import { TerminalBroker } from "./TerminalBroker.js";
import { isTerminalRequest, MAX_TERMINAL_INPUT_BYTES, MAX_TERMINAL_MESSAGE_BYTES, readTerminalMessages, terminalReplay, terminalSocketPath } from "./TerminalBrokerProtocol.js";
import type { TerminalProcess } from "./TerminalProcess.js";
import type { TerminalExit } from "./TerminalSupervisor.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("durable terminal broker", () => {
  it.each([
    "a".repeat(MAX_TERMINAL_INPUT_BYTES),
    "b".repeat(300 * 1024),
    "界😀".repeat(60 * 1024)
  ])("delivers large input intact and accepts subsequent input (%#)", async (input) => {
    const { factory, process } = await fixture();
    const terminal = await factory.spawn("shell", [], options("large-input"));
    const disconnected = vi.fn();
    terminal.onDisconnect!(disconnected);
    terminal.write(input);
    terminal.write("\nNEXT_COMMAND\n");
    await vi.waitFor(() => expect(process.write.mock.calls.map(([data]) => data).join("")).toBe(input + "\nNEXT_COMMAND\n"));
    for (const [chunk] of process.write.mock.calls) {
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(MAX_TERMINAL_INPUT_BYTES);
    }
    expect(disconnected).not.toHaveBeenCalled();
    await terminal.terminate();
  });

  it("rejects input exceeding available send capacity without sending a prefix or disconnecting", async () => {
    const { factory, process } = await fixture();
    const terminal = await factory.spawn("shell", [], options("input-capacity"));
    expect(() => terminal.write("\u0000".repeat(2 * 1024 * 1024))).toThrow("No input was sent");
    terminal.write("still usable\n");
    await vi.waitFor(() => expect(process.write).toHaveBeenCalledExactlyOnceWith("still usable\n"));
    await terminal.terminate();
  });

  it.each([
    ["large ASCII", "r".repeat(16 * 1024 * 1024)],
    ["escaped controls", "\u0000\u001b\u0007".repeat(1024 * 1024)]
  ])("streams complete %s replay before live output and exit while respecting backpressure", async (_name, replay) => {
    const { factory, process, socketPath } = await fixture(Buffer.byteLength(replay));
    const original = await factory.spawn("shell", [], options("large-replay"));
    original.detach!();
    process.data(replay);

    const socket = net.createConnection(socketPath);
    cleanups.push(async () => { socket.destroy(); });
    socket.on("error", () => {});
    let received = "";
    let sentLive = false;
    let exited = false;
    readTerminalMessages(socket, (value) => {
      const message = value as { type: string; data?: string };
      if (message.type === "data") {
        received += message.data!;
        if (!sentLive) {
          sentLive = true;
          process.data("LIVE_AFTER_REPLAY");
          process.exit({ exitCode: 0 });
        }
      }
      if (message.type === "exit") exited = true;
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.pause();
    socket.write(JSON.stringify({ type: "attach", sessionId: "large-replay" }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.destroyed).toBe(false);
    socket.resume();
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 10_000 });
    expect(received).toBe(replay + "LIVE_AFTER_REPLAY");
    expect(socket.destroyed).toBe(false);
    socket.write(JSON.stringify({ type: "write", data: "AFTER_REPLAY\n" }) + "\n");
    await vi.waitFor(() => expect(process.write).toHaveBeenCalledWith("AFTER_REPLAY\n"));
  }, 15_000);

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
    const recovered = await factory.attach("failed-start");
    await recovered.terminate();
    await expect(factory.attach("failed-start")).rejects.toThrow("not restarted");
  });

  it("delivers output produced during termination before acknowledging shutdown", async () => {
    const { factory, process } = await fixture();
    const terminal = await factory.spawn("shell", [], options("final-output"));
    let output = "";
    terminal.onData((data) => { output += data; });
    process.terminate.mockImplementationOnce(async () => {
      process.data("FINAL_OUTPUT");
      process.exit({ exitCode: 0 });
    });
    await terminal.terminate();
    expect(output).toBe("FINAL_OUTPUT");
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

  it("restores complete screen chunks and output received before the first subscription", async () => {
    const factory = await respondingBroker([
      { type: "data", data: "raw tail" },
      { type: "screen", data: "screen", cols: 80, rows: 24, complete: false },
      { type: "screen", data: " snapshot", cols: 80, rows: 24, complete: true },
      { type: "ready" },
      { type: "data", data: " then live" }
    ]);
    const terminal = await factory.attach("screen-cutoff");
    let output = "";
    terminal.onData((data) => { output += data; });
    const screen = vi.fn();
    terminal.onScreen!(screen);
    expect(screen).toHaveBeenCalledExactlyOnceWith({ data: "screen snapshot then live", cols: 80, rows: 24 });
    expect(output).toBe("raw tail then live");
    terminal.detach!();
  });

  it.each([
    [{ type: "screen", data: "partial", cols: 80, rows: 24, complete: false }, { type: "ready" }],
    [{ type: "screen", data: "partial", cols: 80, rows: 24, complete: false }, { type: "screen", data: "rest", cols: 90, rows: 24, complete: true }]
  ].map((messages) => ({ messages })))("rejects incomplete or inconsistent screen assembly (%#)", async ({ messages }) => {
    const factory = await respondingBroker(messages);
    await expect(factory.attach("invalid-screen")).rejects.toThrow("incomplete or inconsistent");
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

async function respondingBroker(messages: unknown[]) {
  const directory = await temporaryDirectory();
  const socketPath = path.join(directory, "broker.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => socket.write(messages.map((message) => JSON.stringify(message) + "\n").join("")));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await fs.chmod(socketPath, 0o600);
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return new DurableTerminalProcessFactory(socketPath, { spawn: vi.fn() });
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

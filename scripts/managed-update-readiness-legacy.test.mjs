import { expect, it, vi } from "vitest";
import { TerminalReadiness } from "./managed-update-readiness-legacy.ts";

it("confirms broker and direct supervised commands without execution bindings", async () => {
  const fixture = terminalFixture();
  const readiness = new TerminalReadiness("/profile", fixture.factory);
  const check = readiness.check();
  expect(readiness.check()).toBe(check);
  await check;
  expect(fixture.factory.spawn).toHaveBeenCalledTimes(2);
  const options = fixture.factory.spawn.mock.calls.map(call => call[2]);
  expect(options[0]).toMatchObject({ cwd: "/profile", sessionId: expect.stringMatching(/^terminal-readiness-/) });
  expect(options[1]).not.toHaveProperty("sessionId");
  for (const option of options) expect(option).not.toHaveProperty("execution");
  for (const terminal of fixture.terminals) {
    expect(terminal.terminate).toHaveBeenCalledOnce();
    expect(terminal.detach).toHaveBeenCalledOnce();
    expect(terminal.unsubscribe).toHaveBeenCalledTimes(3);
  }
});

it("waits for confirmed broker cleanup before probing the direct supervisor", async () => {
  let confirmCleanup;
  const cleanup = new Promise(resolve => { confirmCleanup = resolve; });
  const fixture = terminalFixture({ cleanup });
  const check = new TerminalReadiness("/profile", fixture.factory).check();
  await vi.waitFor(() => expect(fixture.terminals[0].terminate).toHaveBeenCalledOnce());
  expect(fixture.factory.spawn).toHaveBeenCalledOnce();
  expect(fixture.terminals[0].detach).not.toHaveBeenCalled();
  confirmCleanup();
  await check;
  expect(fixture.factory.spawn).toHaveBeenCalledTimes(2);
});

it.each([
  ["missing marker", { output: "unexpected" }, "expected marker"],
  ["nonzero exit", { exit: { exitCode: 1 } }, "exit 1"],
  ["signal exit", { exit: { exitCode: 0, signal: 15 } }, "signal 15"],
  ["excess output", { output: "x".repeat(4097) }, "output limit"],
  ["no exit", { exit: null }, "deadline"],
  ["disconnect", { exit: null, disconnect: new Error("Broker disconnected") }, "Broker disconnected"],
  ["unconfirmed cleanup", { cleanup: () => { throw new Error("Ownership not confirmed"); } }, "Ownership not confirmed"],
])("rejects %s and retires only the probe terminal", async (_name, behavior, message) => {
  const fixture = terminalFixture(behavior);
  await expect(new TerminalReadiness("/profile", fixture.factory, 10).check()).rejects.toThrow(message);
  expect(fixture.factory.spawn).toHaveBeenCalledOnce();
  expect(fixture.terminals[0].terminate).toHaveBeenCalledOnce();
  expect(fixture.terminals[0].detach).toHaveBeenCalledOnce();
  expect(fixture.terminals[0].unsubscribe).toHaveBeenCalledTimes(3);
});

it("attributes spawn failure to its owner and allows a later explicit readiness check", async () => {
  const fixture = terminalFixture();
  fixture.factory.spawn.mockRejectedValueOnce(new Error("Supervisor startup failed"));
  const readiness = new TerminalReadiness("/profile", fixture.factory);
  await expect(readiness.check()).rejects.toThrow("Broker terminal readiness failed: Supervisor startup failed");
  await expect(readiness.check()).resolves.toBeUndefined();
});

it("attributes a direct supervisor startup failure after confirmed broker shutdown", async () => {
  const fixture = terminalFixture();
  const spawn = fixture.factory.spawn.getMockImplementation();
  fixture.factory.spawn.mockImplementationOnce(spawn).mockRejectedValueOnce(new Error("Supervisor startup failed"));
  await expect(new TerminalReadiness("/profile", fixture.factory).check())
    .rejects.toThrow("Direct worker terminal readiness failed: Supervisor startup failed");
  expect(fixture.terminals[0].terminate).toHaveBeenCalledOnce();
  expect(fixture.terminals[0].detach).toHaveBeenCalledOnce();
});

function terminalFixture(behavior = {}) {
  const terminals = [];
  const factory = { spawn: vi.fn(async (_command, args) => {
    const marker = JSON.parse(args[1].slice("process.stdout.write(".length, -1));
    const unsubscribe = vi.fn();
    const terminal = {
      onData: listener => { listener(behavior.output ?? marker); return unsubscribe; },
      onExit: listener => { if (behavior.exit !== null) queueMicrotask(() => listener(behavior.exit ?? { exitCode: 0 })); return unsubscribe; },
      onDisconnect: listener => { if (behavior.disconnect) queueMicrotask(() => listener(behavior.disconnect)); return unsubscribe; },
      terminate: vi.fn(async () => typeof behavior.cleanup === "function" ? behavior.cleanup() : behavior.cleanup),
      detach: vi.fn(), unsubscribe
    };
    terminals.push(terminal);
    return terminal;
  }) };
  return { terminals, factory };
}

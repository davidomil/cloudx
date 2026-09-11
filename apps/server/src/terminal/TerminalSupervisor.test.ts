import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalSupervisor } from "./TerminalSupervisor.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("TerminalSupervisor ownership receipts", () => {
  it("accepts completed ownership when the command exits before startup is observed", async () => {
    const fixture = await supervisorFixture();
    await fixture.receipt("complete", { pid: process.pid, exitCode: 23 });
    fixture.exit();

    await expect(fixture.supervisor.ready()).resolves.toBeUndefined();
    await expect(fixture.supervisor.terminate()).resolves.toBeUndefined();
    expect(await fixture.supervisor.completion).toEqual({ event: { exitCode: 23 } });
    await expect(fs.access(fixture.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    undefined,
    { pid: 2_147_483_647, exitCode: 0 },
    { pid: process.pid, exitCode: "0" },
    { pid: process.pid, exitCode: -1 },
    { pid: process.pid, exitCode: 256 },
    { pid: process.pid, exitCode: 0, signal: 0 },
    { pid: process.pid, exitCode: 0, signal: 65 },
    { pid: process.pid, exitCode: 17, signal: 9 },
    []
  ])("refuses missing or invalid completion evidence: %j", async (receipt) => {
    const fixture = await supervisorFixture();
    if (receipt !== undefined) await fixture.receipt("complete", receipt);
    fixture.exit();

    await expect(fixture.supervisor.terminate()).rejects.toThrow();
    expect(await fixture.supervisor.completion).toMatchObject({ event: { exitCode: 125 }, error: expect.any(Error) });
  });

  it("resolves a failed ownership result if receipt cleanup fails", async () => {
    const fixture = await supervisorFixture();
    await fixture.receipt("complete", { pid: process.pid, exitCode: 0 });
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("Receipt directory cannot be removed"));
    fixture.exit();

    await expect(fixture.supervisor.terminate()).rejects.toThrow("Receipt directory cannot be removed");
    expect(await fixture.supervisor.completion).toMatchObject({ event: { exitCode: 125 }, error: expect.any(Error) });
  });

  it("refuses startup evidence from a different process", async () => {
    const fixture = await supervisorFixture();
    await fixture.receipt("ready", { pid: 2_147_483_647 });

    await expect(fixture.supervisor.ready()).rejects.toThrow("invalid ownership receipt");
    fixture.exit();
    await fixture.supervisor.completion;
  });

  it("fails the stop deadline without declaring a living supervisor quiescent", async () => {
    const fixture = await supervisorFixture();
    vi.useFakeTimers();
    const stopped = expect(fixture.supervisor.terminate()).rejects.toThrow("shutdown deadline");
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(fixture.native.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    fixture.exit();
    await fixture.supervisor.completion;
  });

  it("allows an explicit completion recheck after an earlier stop deadline without signaling again", async () => {
    const fixture = await supervisorFixture();
    vi.useFakeTimers();
    const stopped = expect(fixture.supervisor.terminate()).rejects.toThrow("shutdown deadline");
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    await fixture.receipt("complete", { pid: process.pid, exitCode: 0 });
    fixture.exit();

    await expect(fixture.supervisor.terminate()).resolves.toBeUndefined();
    expect(fixture.native.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  it("allows a later explicit shutdown request after a deadline while the supervisor remains alive", async () => {
    const fixture = await supervisorFixture();
    vi.useFakeTimers();
    const first = expect(fixture.supervisor.terminate()).rejects.toThrow("shutdown deadline");
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.native.kill).toHaveBeenCalledTimes(1);

    const second = fixture.supervisor.terminate();
    expect(fixture.supervisor.terminate()).toBe(second);
    expect(fixture.native.kill).toHaveBeenCalledTimes(2);
    await fixture.receipt("complete", { pid: process.pid, exitCode: 0 });
    fixture.exit();
    await expect(second).resolves.toBeUndefined();
  });
});

async function supervisorFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-receipt-test-"));
  directories.push(directory);
  let exit!: () => void;
  const native = {
    pid: process.pid,
    onExit: (listener: () => void) => { exit = listener; return { dispose() {} }; },
    kill: vi.fn()
  };
  const supervisor = new TerminalSupervisor(native as unknown as IPty, directory);
  return {
    directory, native, supervisor, exit: () => exit(),
    receipt: (name: string, value: unknown) => fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(value))
  };
}

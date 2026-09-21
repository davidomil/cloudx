import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi, type TestContext } from "vitest";

import type { TerminalExit } from "../TerminalSupervisor.js";
import { retainTerminalDiagnostics, TerminalDiagnostics } from "./TerminalDiagnostics.js";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("bounds Unicode output and recent events while retaining every byte and lifecycle count", async () => {
  const { diagnostics, producer, source } = fixture();
  const received = vi.fn();
  const exited = vi.fn();
  const disposeData = producer.onData(received);
  const disposeExit = producer.onExit(exited);
  const output = "discarded".repeat(1024) + "界😀".repeat(4096);
  source.data(output);
  for (let i = 0; i < 100; i++) { producer.pauseOutput(); producer.resumeOutput(); }
  await producer.terminate();
  const snapshot = diagnostics.snapshot();
  expect(snapshot.bytesReceived).toBe(Buffer.byteLength(output));
  expect(Buffer.byteLength(snapshot.lastOutput)).toBeLessThanOrEqual(4096);
  expect(snapshot.lastOutput).not.toContain("�");
  expect(output.endsWith(snapshot.lastOutput)).toBe(true);
  expect(snapshot.omittedOutputBytes + Buffer.byteLength(snapshot.lastOutput)).toBe(snapshot.bytesReceived);
  expect(snapshot.events).toHaveLength(64);
  expect(snapshot.eventCounts).toEqual({ pause: 100, resume: 100, exit: 1, terminate: 1 });
  expect(snapshot.events.slice(-2).map(event => event.kind)).toEqual(["terminate", "exit"]);
  expect(snapshot.events.at(-1)?.exit).toEqual({ exitCode: 7 });
  expect(received).toHaveBeenCalledExactlyOnceWith(output);
  expect(exited).toHaveBeenCalledExactlyOnceWith({ exitCode: 7 });
  expect(source.pauseOutput).toHaveBeenCalledTimes(100);
  expect(source.resumeOutput).toHaveBeenCalledTimes(100);
  producer.write("input");
  producer.resize(80, 24);
  producer.kill();
  disposeData();
  disposeExit();
  expect(source.write).toHaveBeenCalledExactlyOnceWith("input");
  expect(source.resize).toHaveBeenCalledExactlyOnceWith(80, 24);
  expect(source.kill).toHaveBeenCalledOnce();
  expect(source.unsubscribe).toHaveBeenCalledTimes(2);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(32 * 1024);
});

it("retains the first failure phase and output even after cleanup exits and later saves", () => {
  const { diagnostics, producer, source, read } = fixture();
  producer.onData(() => {});
  producer.onExit(() => {});
  diagnostics.enterPhase("waiting for screen marker");
  source.data("output before timeout");
  diagnostics.fail(new Error("marker timeout"));
  const failure = read();
  diagnostics.enterPhase("cleanup");
  source.data("cleanup output");
  source.exit({ exitCode: 0 });
  diagnostics.fail(new Error("cleanup error"));
  diagnostics.save("passed");
  expect(read()).toEqual(failure);
  expect(failure).toMatchObject({ status: "failed", phase: "waiting for screen marker", lastOutput: "output before timeout" });
  expect(failure.error).toContain("marker timeout");
  expect(failure.runtime.node).toBe(process.version);
  expect(failure.runtime.cpuMax).toEqual(expect.any(String));
  expect(failure.runtime.memoryMax).toEqual(expect.any(String));
  expect(failure.runtime.processLimits).toEqual(expect.any(String));
});

it("checkpoints in-flight output and records cancellation without a final test callback", () => {
  vi.useFakeTimers();
  const directory = temporaryDirectory();
  const controller = new AbortController();
  const onTestFinished = vi.fn<TestContext["onTestFinished"]>();
  const diagnostics = retainTerminalDiagnostics({ signal: controller.signal, onTestFinished, onTestFailed: vi.fn() }, "probe", directory);
  const read = () => JSON.parse(readFileSync(path.join(directory, "probe.json"), "utf8"));
  diagnostics.enterPhase("waiting for replay");
  vi.advanceTimersByTime(1000);
  expect(read()).toMatchObject({ status: "running", phase: "waiting for replay" });
  controller.abort(new Error("test deadline"));
  expect(read()).toMatchObject({ status: "failed", phase: "waiting for replay" });
  expect(read().error).toContain("test deadline");
  onTestFinished.mock.calls[0]![0]({ task: { result: { state: "fail" } } } as Parameters<Parameters<TestContext["onTestFinished"]>[0]>[0]);
  expect(vi.getTimerCount()).toBe(0);
  expect(readdirSync(directory)).toEqual(["probe.json"]);
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cloudx-terminal-diagnostics-"));
  directories.push(directory);
  return directory;
}

function fixture() {
  const directory = temporaryDirectory();
  const diagnostics = new TerminalDiagnostics("probe", directory);
  const source = {
    data: (_data: string) => {},
    exit: (_exit: TerminalExit) => {},
    unsubscribe: vi.fn(),
    onData(listener: (data: string) => void) { this.data = listener; return this.unsubscribe; },
    onExit(listener: (exit: TerminalExit) => void) { this.exit = listener; return this.unsubscribe; },
    pauseOutput: vi.fn(), resumeOutput: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    terminate: async () => { source.exit({ exitCode: 7 }); },
  };
  return { diagnostics, source, producer: diagnostics.observe(source), read: () => JSON.parse(readFileSync(path.join(directory, "probe.json"), "utf8")) };
}

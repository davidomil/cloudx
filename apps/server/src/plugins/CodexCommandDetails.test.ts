import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCodexCommandDetailsSnapshot, type CodexCommandDetailsSnapshot } from "@cloudx/shared";
import { codexCommandDetailsPath, readCodexCommandDetails } from "./CodexCommandDetails.js";

const { CodexCommandDetailsCapture, saveCommandDetails, MAX_COMMAND_BYTES, MAX_OUTPUT_BYTES, MAX_TOTAL_BYTES, MAX_COMMANDS } = await import(new URL("../../helpers/codex-command-details.mjs", import.meta.url).href);
const binding = { tabId: "tab", executionId: "execution" };
const command = "python - <<'PY'\nprint(\"quotes, literal \\\\n, and é\")\nPY";
const item = { type: "commandExecution", id: "item", command, cwd: "/tmp", status: "inProgress", aggregatedOutput: null, exitCode: null };
const event = (method: string, patch: Record<string, unknown> = {}) => ({ method, params: { threadId: "thread", turnId: "turn", item, ...patch } });
const folders: string[] = [];
const captures: Array<{ close(): Promise<void> }> = [];
async function folder() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-command-details-")); folders.push(root); return root; }
function capture(save = vi.fn(), options = {}) {
  const observer = new CodexCommandDetailsCapture(binding, save, options);
  captures.push(observer);
  return observer;
}
afterEach(async () => {
  for (const observer of captures.splice(0)) await observer.close();
  for (const root of folders.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("native command capture", () => {
  it("preserves exact commands and streaming output, then uses the authoritative final aggregate", async () => {
    const save = vi.fn();
    const observer = capture(save);
    observer.fromServer(event("item/started"));
    observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: "first\n" }));
    observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: "second\n" }));
    await observer.flush();
    expect(parseCodexCommandDetailsSnapshot(save.mock.lastCall![0]).commands[0]).toMatchObject({ command, output: "first\nsecond\n", status: "inProgress" });
    observer.fromServer(event("item/completed", { item: { ...item, status: "completed", aggregatedOutput: "complete\n", exitCode: 0 } }));
    observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: "late\n" }));
    await observer.close();
    expect(save.mock.lastCall![0]).toMatchObject({ ...binding, commands: [{ threadId: "thread", turnId: "turn", id: "item", command, output: "complete\n", status: "completed", exitCode: 0, outputTruncated: false }] });
  });

  it("associates deltas by thread, turn, and item and never synthesizes commands from terminal text", () => {
    const observer = capture();
    observer.fromServer(event("item/started"));
    for (const patch of [{ threadId: "other" }, { turnId: "other" }, { itemId: "other" }])
      observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: "wrong\n", ...patch }));
    observer.fromServer(event("item/agentMessage/delta", { itemId: "item", delta: "terminal rows" }));
    observer.fromServer(event("item/started", { threadId: "other", item: { ...item, command: "other thread" } }));
    expect(observer.snapshot().commands).toHaveLength(2);
    expect(observer.snapshot().commands[0]).toMatchObject({ output: "", command });
  });

  it("hydrates only successful correlated native resume and fork responses without sending requests", () => {
    const observer = capture();
    const response = { id: 7, result: { thread: { id: "old-thread", turns: [{ id: "old-turn", items: [{ ...item, status: "completed", aggregatedOutput: "restored output" }] }] } } };
    observer.fromServer(response);
    observer.fromClient({ id: 7, method: "thread/resume" });
    observer.fromServer({ ...response, id: "7" });
    expect(observer.snapshot().commands).toEqual([]);
    observer.fromServer(response);
    expect(observer.snapshot().commands[0]).toMatchObject({ threadId: "old-thread", turnId: "old-turn", output: "restored output" });
    observer.fromClient({ id: 8, method: "thread/fork" });
    observer.fromServer({ id: 8, error: { message: "failed" } });
    expect(observer.resumeRequests.size).toBe(0);
  });

  it("keeps streamed middle output when native completion retains only a head and tail", () => {
    const observer = capture();
    const output = "a".repeat(768 * 1024) + "MIDDLE_SENTINEL" + "b".repeat(768 * 1024);
    const aggregatedOutput = `${output.slice(0, 512 * 1024)}\n... ${Buffer.byteLength(output) - 1024 * 1024} bytes omitted ...\n${output.slice(-512 * 1024)}`;
    observer.fromServer(event("item/started"));
    for (let offset = 0; offset < output.length; offset += 8192)
      observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: output.slice(offset, offset + 8192) }));
    observer.fromServer(event("item/completed", { item: { ...item, status: "completed", aggregatedOutput, exitCode: 0 } }));
    expect(observer.snapshot().commands[0].output === output).toBe(true);
    expect(observer.snapshot().commands[0]).toMatchObject({ outputTruncated: false, status: "completed", exitCode: 0 });
    const historyOnly = capture();
    historyOnly.fromServer(event("item/completed", { item: { ...item, status: "completed", aggregatedOutput } }));
    expect(historyOnly.snapshot().commands[0].output === aggregatedOutput).toBe(true);
    expect(historyOnly.snapshot().commands[0].outputTruncated).toBe(true);
  });

  it("does not confuse a command's literal omission text with native aggregate truncation", () => {
    const observer = capture();
    const output = "literal\n... 12 bytes omitted ...\ntext";
    observer.fromServer(event("item/completed", { item: { ...item, status: "completed", aggregatedOutput: output } }));
    expect(observer.snapshot().commands[0]).toMatchObject({ output, outputTruncated: false });
  });

  it("keeps the streaming retention warning when native completion is also capped", () => {
    const observer = capture();
    observer.fromServer(event("item/started"));
    observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: "x".repeat(MAX_OUTPUT_BYTES + 1) }));
    const aggregate = `${"x".repeat(512 * 1024)}\n... ${MAX_OUTPUT_BYTES + 1 - 1024 * 1024} bytes omitted ...\n${"x".repeat(512 * 1024)}`;
    observer.fromServer(event("item/completed", { item: { ...item, status: "completed", aggregatedOutput: aggregate } }));
    expect(Buffer.byteLength(observer.snapshot().commands[0].output)).toBe(MAX_OUTPUT_BYTES);
    expect(observer.snapshot().commands[0]).toMatchObject({ outputTruncated: true, status: "completed" });
  });

  it("hydrates exact correlated paginated history and retains its newest commands in chronological order", () => {
    const observer = capture();
    observer.fromClient({ id: 1, method: "thread/resume", params: { threadId: "old-thread", excludeTurns: true } });
    observer.fromServer({ id: 1, result: { thread: { id: "old-thread", turns: [] } } });
    const request = { id: 2, method: "thread/items/list", params: { threadId: "old-thread", sortDirection: "desc" } };
    const response = { id: 2, result: { data: Array.from({ length: MAX_COMMANDS + 3 }, (_, index) => ({ turnId: "old-turn", item: { ...item, id: String(MAX_COMMANDS + 2 - index), status: "completed", aggregatedOutput: "restored output" } })), nextCursor: "older", backwardsCursor: null } };
    const originalRequest = structuredClone(request);
    const originalResponse = structuredClone(response);
    observer.fromServer(response);
    observer.fromClient(request);
    observer.fromServer({ ...response, id: "2" });
    expect(observer.snapshot().commands).toEqual([]);
    observer.fromServer(response);
    expect(observer.snapshot().commands.map((entry: { id: string }) => entry.id)).toEqual(Array.from({ length: MAX_COMMANDS }, (_, index) => String(index + 3)));
    expect(observer.snapshot().commands.at(-1)).toMatchObject({ threadId: "old-thread", turnId: "old-turn", output: "restored output" });
    observer.fromClient({ id: 3, method: "thread/items/list", params: { ...request.params, cursor: "older" } });
    observer.fromServer({ id: 3, result: { ...response.result, data: [{ turnId: "older-turn", item: { ...item, id: "older", status: "completed", aggregatedOutput: "older output" } }] } });
    expect(observer.snapshot().commands.at(-1)?.id).toBe(String(MAX_COMMANDS + 2));
    expect(observer.snapshot().commands).toHaveLength(MAX_COMMANDS);
    expect(request).toEqual(originalRequest);
    expect(response).toEqual(originalResponse);
  });

  it("bounds paginated command bytes and handles failed pages without retaining request bindings", () => {
    const observer = capture();
    observer.fromClient({ id: 1, method: "thread/items/list", params: { threadId: "thread", turnId: "turn" } });
    observer.fromServer({ id: 1, error: { message: "failed" } });
    expect(observer.historyRequests.size).toBe(0);
    observer.fromClient({ id: 2, method: "thread/items/list", params: { threadId: "thread", turnId: "turn" } });
    observer.fromServer({ id: 2, result: { data: [{ turnId: "turn", item: { ...item, command: "é".repeat(MAX_COMMAND_BYTES), status: "completed", aggregatedOutput: "x".repeat(MAX_OUTPUT_BYTES + 1) } }] } });
    const snapshot = parseCodexCommandDetailsSnapshot(observer.snapshot());
    expect(snapshot.commands[0]).toMatchObject({ commandTruncated: true, outputTruncated: true });
    expect(Buffer.byteLength(snapshot.commands[0].command)).toBe(MAX_COMMAND_BYTES);
    expect(Buffer.byteLength(snapshot.commands[0].output)).toBe(MAX_OUTPUT_BYTES);
    expect(observer.historyRequests.size).toBe(0);
  });

  it.each([
    { data: {} },
    { data: [{ turnId: "different-turn", item }] },
    { data: [{ turnId: "turn", item: { ...item, cwd: undefined } }] }
  ])("contains malformed or misbound paginated history without interrupting the native session %j", result => {
    const observer = capture();
    observer.fromClient({ id: 1, method: "thread/items/list", params: { threadId: "thread", turnId: "turn" } });
    expect(() => observer.fromServer({ id: 1, result })).not.toThrow();
    expect(observer.snapshot()).toMatchObject({ status: "unavailable", commands: [] });
    expect(observer.historyRequests.size).toBe(0);
  });

  it("bounds pending resume and paginated history requests together", () => {
    const observer = capture();
    for (let id = 0; id < 32; id++) observer.fromClient({ id, method: "thread/items/list", params: { threadId: "thread" } });
    observer.fromClient({ id: 32, method: "thread/resume" });
    expect(observer.snapshot()).toMatchObject({ status: "unavailable", commands: [] });
    expect(observer.historyRequests.size).toBe(0);
  });

  it("retains UTF-8 prefixes with explicit truncation and limits count and total text", () => {
    const observer = capture();
    observer.fromServer(event("item/started", { item: { ...item, command: "é".repeat(MAX_COMMAND_BYTES) } }));
    observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: "🙂".repeat(MAX_OUTPUT_BYTES) }));
    const first = observer.snapshot().commands[0];
    expect(Buffer.byteLength(first.command)).toBe(MAX_COMMAND_BYTES);
    expect(Buffer.byteLength(first.output)).toBe(MAX_OUTPUT_BYTES);
    expect(first.commandTruncated && first.outputTruncated).toBe(true);
    expect(first.output).not.toContain("�");
    observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: "more output" }));
    expect(observer.snapshot().commands[0].output).toBe(first.output);
    for (let id = 0; id < MAX_COMMANDS + 2; id++) observer.fromServer(event("item/completed", { item: { ...item, id: String(id), status: "completed", aggregatedOutput: "x".repeat(MAX_OUTPUT_BYTES) } }));
    const snapshot = parseCodexCommandDetailsSnapshot(observer.snapshot());
    expect(snapshot.commands.length).toBeLessThanOrEqual(MAX_COMMANDS);
    expect(snapshot.commands.reduce((sum, entry) => sum + Buffer.byteLength(entry.command) + Buffer.byteLength(entry.output), 0)).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(snapshot.commands.at(-1)?.id).toBe(String(MAX_COMMANDS + 1));
    const small = capture();
    for (let id = 0; id < MAX_COMMANDS + 3; id++) small.fromServer(event("item/started", { item: { ...item, id: String(id) } }));
    expect(small.snapshot().commands.map((entry: { id: string }) => entry.id)).toEqual(Array.from({ length: MAX_COMMANDS }, (_, id) => String(id + 3)));
  });

  it("coalesces output writes and continues observing while storage is pending", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const observer = capture(save);
    observer.fromServer(event("item/started"));
    for (let id = 0; id < 100; id++) observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: `${id}\n` }));
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: "continued\n" }));
    expect(observer.snapshot().commands[0].output.endsWith("continued\n")).toBe(true);
    release();
    await observer.close();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.lastCall![0].commands[0].output.endsWith("continued\n")).toBe(true);
  });

  it("contains malformed observer events and persistence failures without throwing into the native session", async () => {
    const diagnostic = vi.fn(() => { throw new Error("diagnostic failure"); });
    const observer = capture(vi.fn().mockRejectedValue(new Error("disk full")), { onError: diagnostic });
    observer.fromServer(event("item/started"));
    await expect(observer.flush()).resolves.toBeUndefined();
    expect(() => observer.fromServer(event("item/commandExecution/outputDelta", { itemId: "item", delta: "still running" }))).not.toThrow();
    expect(observer.snapshot().commands[0].output).toBe("still running");
    const invalid = capture();
    expect(() => invalid.fromServer(event("item/started", { turnId: undefined }))).not.toThrow();
    expect(invalid.snapshot()).toMatchObject({ status: "unavailable", commands: [] });
    expect(diagnostic).toHaveBeenCalledTimes(1);
  });
});

describe("persisted native command details", () => {
  it("atomically restores an exact execution and rejects another tab, another execution, and absent binding", async () => {
    const home = await folder();
    const observer = capture();
    observer.fromServer(event("item/started"));
    const snapshot = observer.snapshot() as CodexCommandDetailsSnapshot;
    await saveCommandDetails(codexCommandDetailsPath(home), snapshot);
    await expect(readCodexCommandDetails(home, "tab", "execution")).resolves.toEqual(snapshot);
    await expect(readCodexCommandDetails(home, "other-tab", "execution")).resolves.toMatchObject({ status: "unavailable", commands: [] });
    await expect(readCodexCommandDetails(home, "tab", "old-execution")).resolves.toMatchObject({ status: "unavailable", commands: [] });
    await expect(readCodexCommandDetails(home, "tab", undefined)).resolves.toMatchObject({ status: "unavailable", executionId: "", commands: [] });
    expect((await fs.stat(codexCommandDetailsPath(home))).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(home)).toEqual([".cloudx-command-details.json"]);
  });

  it("reports missing, malformed, oversized, and symlink snapshots without exposing file contents", async () => {
    const home = await folder();
    const receipt = codexCommandDetailsPath(home);
    await expect(readCodexCommandDetails(home, "tab", "execution")).resolves.toMatchObject({ status: "unavailable", reason: "Native command details are not available yet." });
    for (const text of ["not JSON", JSON.stringify({ ...binding, version: 1, status: "available", commands: [{}] })]) {
      await fs.writeFile(receipt, text);
      await expect(readCodexCommandDetails(home, "tab", "execution")).resolves.toMatchObject({ status: "unavailable", reason: "Command details could not be read." });
    }
    await fs.truncate(receipt, 64 * 1024 * 1024);
    await expect(readCodexCommandDetails(home, "tab", "execution")).resolves.toMatchObject({ status: "unavailable" });
    await fs.rm(receipt);
    await fs.symlink("/etc/passwd", receipt);
    await expect(readCodexCommandDetails(home, "tab", "execution")).resolves.toMatchObject({ status: "unavailable", commands: [] });
  });

  it("rejects failed writes and leaves no partial snapshot or temporary file", async () => {
    const home = await folder();
    await expect(saveCommandDetails(path.join(home, "missing", "receipt"), {})).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(home)).toEqual([]);
  });
});

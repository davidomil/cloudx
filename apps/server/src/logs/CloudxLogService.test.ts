import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { CloudxLogService, LOG_MAX_BYTES, LOG_MAX_ENTRIES, readServiceJournal } from "./CloudxLogService.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const signal = () => new AbortController().signal;

describe("recent server logs", () => {
  it("starts empty and preserves diagnostic text and ordering", async () => {
    const logs = new CloudxLogService();
    expect(await logs.read("current", signal())).toMatchObject({ source: "current", content: "", truncated: false });
    logs.recordServerLog('first\n');
    logs.recordServerLog('second 日本語\n');
    const snapshot = await logs.read("current", signal());
    expect(snapshot.content).toBe('first\nsecond 日本語\n');
    expect(Number.isNaN(Date.parse(snapshot.capturedAt))).toBe(false);
  });

  it("retains the newest 1000 entries and reports discarded history", async () => {
    const logs = new CloudxLogService();
    for (let index = 0; index <= LOG_MAX_ENTRIES; index++) logs.recordServerLog(`entry ${index}\n`);
    expect(await logs.read("current", signal())).toMatchObject({
      truncated: true,
      content: Array.from({ length: LOG_MAX_ENTRIES }, (_, index) => `entry ${index + 1}\n`).join("")
    });
  });

  it("bounds UTF-8 bytes while preserving whole entries", async () => {
    const logs = new CloudxLogService();
    logs.recordServerLog("old\n");
    const text = "é".repeat(LOG_MAX_BYTES / 2);
    logs.recordServerLog(text);
    expect(await logs.read("current", signal())).toMatchObject({ content: text, truncated: true });
    logs.recordServerLog("latest\n");
    expect(await logs.read("current", signal())).toMatchObject({ content: "latest\n", truncated: true });
  });

  it("marks oversized records explicitly and still captures subsequent logs", async () => {
    const logs = new CloudxLogService();
    logs.recordServerLog("x".repeat(LOG_MAX_BYTES + 1));
    logs.recordServerLog("next\n");
    expect(await logs.read("current", signal())).toMatchObject({
      truncated: true, content: "[Log entry omitted: exceeds the 1 MiB viewer limit.]\nnext\n"
    });
  });
});

describe("installed service logs", () => {
  it.each([
    ["services", ["cloudx.service", "cloudx-terminal.service", "cloudx-asr.service", "cloudx-documentation.service"]],
    ["server", ["cloudx.service"]], ["terminals", ["cloudx-terminal.service"]],
    ["asr", ["cloudx-asr.service"]], ["documentation", ["cloudx-documentation.service"]]
  ] as const)("reads only the fixed units for %s", async (source, units) => {
    const readJournal = vi.fn(async () => "2026-09-15 service: ready\n");
    const logs = new CloudxLogService(readJournal);
    const abort = signal();
    expect(await logs.read(source, abort)).toMatchObject({ source, content: "2026-09-15 service: ready", truncated: false });
    expect(readJournal).toHaveBeenCalledExactlyOnceWith(units, abort);
  });

  it("reports empty and truncated journal snapshots", async () => {
    const readJournal = vi.fn(async () => "");
    const logs = new CloudxLogService(readJournal);
    expect(await logs.read("services", signal())).toMatchObject({ content: "", truncated: false });
    readJournal.mockResolvedValue(Array.from({ length: LOG_MAX_ENTRIES + 1 }, (_, index) => `line ${index}\n`).join(""));
    expect(await logs.read("services", signal())).toMatchObject({
      content: Array.from({ length: LOG_MAX_ENTRIES }, (_, index) => `line ${index + 1}`).join("\n"), truncated: true
    });
  });

  it("waits for the active read before starting a replacement and bounds waiting requests", async () => {
    let finishRead!: (output: string) => void;
    const readJournal = vi.fn(() => new Promise<string>(resolve => { finishRead = resolve; }));
    const logs = new CloudxLogService(readJournal);
    const reading = logs.read("services", signal());
    const replacement = logs.read("asr", signal());
    expect(readJournal).toHaveBeenCalledTimes(1);
    await expect(logs.read("terminals", signal())).rejects.toMatchObject({ statusCode: 429 });
    await expect(logs.read("current", signal())).resolves.toMatchObject({ content: "" });
    readJournal.mockResolvedValue("replacement");
    finishRead("first");
    await expect(reading).resolves.toMatchObject({ content: "first" });
    await expect(replacement).resolves.toMatchObject({ source: "asr", content: "replacement" });
  });

  it("starts a waiting replacement after the active read fails", async () => {
    let rejectRead!: (error: Error) => void;
    const readJournal = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectRead = reject; }));
    const logs = new CloudxLogService(readJournal);
    const reading = logs.read("services", signal());
    const replacement = logs.read("asr", signal());
    readJournal.mockResolvedValue("recovered");
    rejectRead(new Error("journal failed"));
    await expect(reading).rejects.toThrow("journal failed");
    await expect(replacement).resolves.toMatchObject({ source: "asr", content: "recovered" });
    await expect(logs.read("services", signal())).resolves.toMatchObject({ content: "recovered" });
  });

  it("removes canceled waiting reads without starting them or releasing the active reader", async () => {
    let finishRead!: (output: string) => void;
    const readJournal = vi.fn(() => new Promise<string>(resolve => { finishRead = resolve; }));
    const logs = new CloudxLogService(readJournal);
    const reading = logs.read("services", signal());
    const waiting = new AbortController();
    const canceled = logs.read("asr", waiting.signal);
    waiting.abort();
    await expect(canceled).rejects.toThrow("cancelled");
    const replacement = logs.read("terminals", signal());
    expect(readJournal).toHaveBeenCalledTimes(1);
    readJournal.mockResolvedValue("terminal logs");
    finishRead("first");
    await reading;
    await expect(replacement).resolves.toMatchObject({ source: "terminals", content: "terminal logs" });
    expect(readJournal).toHaveBeenCalledTimes(2);
    expect(readJournal).not.toHaveBeenCalledWith(["cloudx-asr.service"], waiting.signal);
  });

  it("does not start an already canceled read and releases admission after a synchronous failure", async () => {
    const readJournal = vi.fn<() => Promise<string>>().mockImplementationOnce(() => { throw new Error("reader unavailable"); }).mockResolvedValue("ready");
    const logs = new CloudxLogService(readJournal);
    const aborted = new AbortController();
    aborted.abort();
    await expect(logs.read("asr", aborted.signal)).rejects.toThrow("cancelled");
    expect(readJournal).not.toHaveBeenCalled();
    await expect(logs.read("asr", signal())).rejects.toThrow("reader unavailable");
    await expect(logs.read("asr", signal())).resolves.toMatchObject({ content: "ready" });
  });
});

describe("journal process boundary", () => {
  it("uses a shell-free, time-bounded, byte-bounded command with cancellation", async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        (args[3] as (error: null, stdout: string, stderr: string) => void)(null, "journal text", "");
        child.emit("close");
      });
      return child as ReturnType<typeof execFile>;
    });
    const abort = signal();
    expect(await readServiceJournal(["cloudx.service"], abort)).toBe("journal text");
    expect(execFile).toHaveBeenCalledExactlyOnceWith("journalctl", [
      "--user", "--no-pager", "--quiet", "--output=short-iso-precise", "--lines=1001", "--unit=cloudx.service"
    ], { encoding: "utf8", timeout: 5000, maxBuffer: LOG_MAX_BYTES, killSignal: "SIGKILL", signal: abort }, expect.any(Function));
  });

  it.each(["ENOENT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ABORT_ERR", "ETIMEDOUT"])("reports %s without exposing subprocess output", async code => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        (args[3] as (error: Error) => void)(Object.assign(new Error("private process diagnostic"), { code }));
        child.emit("close");
      });
      return child as ReturnType<typeof execFile>;
    });
    await expect(readServiceJournal(["cloudx.service"], signal())).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("Could not read the service journal") });
    await expect(readServiceJournal(["cloudx.service"], signal())).rejects.not.toThrow("private process diagnostic");
  });

  it("keeps admission until an aborted child closes, even when its callback has already failed", async () => {
    const child = new EventEmitter();
    let fail!: () => void;
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      fail = () => (args[3] as (error: Error, stdout: string) => void)(new Error("aborted"), "");
      return child as ReturnType<typeof execFile>;
    });
    const settled = vi.fn();
    const reading = readServiceJournal(["cloudx.service"], signal()).catch(settled);
    fail();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit("close");
    await reading;
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ statusCode: 503 }));
  });
});

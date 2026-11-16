import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonlCache, type JsonlCacheOptions } from "./JsonlCache.js";
import { UsageScanScheduler } from "./UsageScanScheduler.js";

const roots: string[] = [];
const disposables: { dispose(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(disposables.splice(0).map(value => value.dispose()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(content: string | Buffer) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jsonl-"));
  roots.push(root);
  const file = path.join(root, "rollout.jsonl");
  const directory = path.join(root, "index");
  await fs.writeFile(file, content);
  return { root, file, directory };
}

function scheduler(sliceBytes = 256 * 1024, intervalMs = 0) {
  const value = new UsageScanScheduler({ sliceBytes, intervalMs });
  disposables.push(value);
  return value;
}

// Attributes each usage line to the model of the latest context line.
function modelCache(options: JsonlCacheOptions<{ model: string }, string> = {}) {
  const cache = new JsonlCache<{ model: string }, string>(() => ({ model: "none" }), (line, state) => {
    const value = line as { model?: string; usage?: string };
    if (value.model) state.model = value.model;
    return value.usage ? `${value.usage}:${state.model}` : undefined;
  }, {
    scheduler: scheduler(),
    validateState: value => typeof value === "object" && value !== null && "model" in value && typeof value.model === "string",
    validateResult: value => typeof value === "string",
    ...options
  });
  disposables.push(cache);
  return cache;
}

async function indexed(cache: ReturnType<typeof modelCache>, file: string) {
  await cache.read(file);
  await cache.idle();
  return cache.read(file);
}

describe("JsonlCache", () => {
  it("keeps concurrent reads of one file in order across chunks", async () => {
    // Several 1 MiB chunks, each model change separated from its usage line.
    const filler = JSON.stringify({ text: "x".repeat(600_000) });
    const turns = Array.from({ length: 8 }, (_, index) => [JSON.stringify({ model: `m${index}` }), filler, JSON.stringify({ usage: `u${index}` })]);
    const { file } = await fixture(`${turns.flat().join("\n")}\n`);
    const reads: { offset: number; bytes: number }[] = [];
    const cache = modelCache({ onRead: (_, offset, bytes) => reads.push({ offset, bytes }) });
    const expected = turns.map((_, index) => `u${index}:m${index}`);
    expect(await Promise.all([cache.read(file), cache.read(file), cache.read(file), cache.read(file)])).toEqual([[], [], [], []]);
    expect(cache.status([file])).toBe("backfilling");
    await cache.idle();
    expect(await Promise.all([cache.read(file), cache.read(file), cache.read(file), cache.read(file)])).toEqual([expected, expected, expected, expected]);
    expect(cache.status([file])).toBeUndefined();
    expect(reads.reduce((sum, read) => sum + read.bytes, 0)).toBe((await fs.stat(file)).size);
    expect(reads.every(read => read.bytes <= 256 * 1024)).toBe(true);
    expect(reads.slice(1).every((read, index) => read.offset === reads[index].offset + reads[index].bytes)).toBe(true);
  });

  it("keeps multi-byte characters that a chunk boundary splits", async () => {
    // {"pad":" is 8 bytes and ","model":" 11, so "é" starts at the last byte of the first chunk.
    const padding = "x".repeat(1024 * 1024 - 20);
    const { file } = await fixture(`${JSON.stringify({ pad: padding, model: "é-model" })}\n${JSON.stringify({ usage: "r1" })}\n`);
    expect(await indexed(modelCache(), file)).toEqual(["r1:é-model"]);
  });

  it("reuses a durable snapshot without source reads and processes each appended byte once", async () => {
    const content = '{"model":"m1"}\n{"usage":"u1"}\n';
    const { file, directory } = await fixture(content);
    const first = modelCache({ directory });
    expect(await indexed(first, file)).toEqual(["u1:m1"]);
    const checkpointName = (await fs.readdir(directory)).find(name => name.endsWith(".jsonl"))!;
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(directory, checkpointName))).mode & 0o777).toBe(0o600);
    await first.dispose();
    const reads: { offset: number; bytes: number }[] = [];
    const resumed = modelCache({ directory, onRead: (_, offset, bytes) => reads.push({ offset, bytes }) });
    expect(await resumed.readWithStatus(file)).toEqual({ results: ["u1:m1"], indexing: undefined });
    await resumed.idle();
    expect(reads).toEqual([]);
    const append = '{"usage":"u2"}\n';
    await fs.appendFile(file, append);
    expect(await indexed(resumed, file)).toEqual(["u1:m1", "u2:m1"]);
    expect(reads).toEqual([{ offset: Buffer.byteLength(content), bytes: Buffer.byteLength(append) }]);
    expect(await resumed.read(file)).toEqual(["u1:m1", "u2:m1"]);
    expect(reads).toHaveLength(1);
  });

  it("persists parser context and an incomplete UTF-8 record across restart", async () => {
    const prefix = Buffer.from('{"model":"é-model"}\n{"usage":"é-usage"}');
    const split = prefix.lastIndexOf(Buffer.from("é")) + 1;
    const { file, directory } = await fixture(prefix.subarray(0, split));
    const first = modelCache({ directory, scheduler: scheduler(7) });
    expect(await indexed(first, file)).toEqual([]);
    await first.dispose();
    await fs.appendFile(file, Buffer.concat([prefix.subarray(split), Buffer.from("\n")]));
    const reads: number[] = [];
    const resumed = modelCache({ directory, scheduler: scheduler(7), onRead: (_, offset) => reads.push(offset) });
    expect(await indexed(resumed, file)).toEqual(["é-usage:é-model"]);
    expect(reads[0]).toBe(split);
  });

  it("checkpoints completed records during an interrupted slice and resumes without duplicate usage", async () => {
    const content = Array.from({ length: 40 }, (_, index) => JSON.stringify(index % 2 ? { usage: `u${index}` } : { model: `m${index}` })).join("\n") + "\n";
    const { file, directory } = await fixture(content);
    let signalRead!: () => void;
    const firstRead = new Promise<void>(resolve => { signalRead = resolve; });
    let bytesRead = 0;
    const first = modelCache({ directory, scheduler: scheduler(37, 1000), onRead: (_, __, bytes) => { bytesRead += bytes; signalRead(); } });
    expect(await first.read(file)).toEqual([]);
    await firstRead;
    await first.dispose();
    expect(bytesRead).toBe(37);
    const offsets: number[] = [];
    const resumed = modelCache({ directory, scheduler: scheduler(37), onRead: (_, offset) => offsets.push(offset) });
    expect(await indexed(resumed, file)).toEqual(Array.from({ length: 20 }, (_, index) => `u${2 * index + 1}:m${2 * index}`));
    expect(offsets[0]).toBe(Buffer.from(content).lastIndexOf(10, 36) + 1);
    expect((await fs.readdir(directory)).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("cancels queued indexing immediately when disposed", async () => {
    const { file } = await fixture('{"usage":"u1"}\n'.repeat(100));
    let reads = 0;
    const cache = modelCache({ onRead: () => { reads++; } });
    await cache.read(file);
    await cache.dispose();
    expect(reads).toBe(0);
    await expect(cache.read(file)).rejects.toThrow("disposed");
  });

  it("rebuilds a replaced, truncated or same-size rewritten file", async () => {
    const { file, root, directory } = await fixture('{"usage":"old"}\n');
    const cache = modelCache({ directory });
    expect(await indexed(cache, file)).toEqual(["old:none"]);
    const replacement = path.join(root, "replacement.jsonl");
    await fs.writeFile(replacement, '{"usage":"new"}\n');
    await fs.rename(replacement, file);
    expect(await indexed(cache, file)).toEqual(["new:none"]);
    await fs.writeFile(file, '{"usage":"x"}\n');
    expect(await indexed(cache, file)).toEqual(["x:none"]);
    await fs.writeFile(file, '{"usage":"y"}\n');
    await fs.utimes(file, new Date(), new Date(Date.now() + 10_000));
    expect(await indexed(cache, file)).toEqual(["y:none"]);
  });

  it("ignores orphan temporary files and rejects corrupt committed checkpoints without rescanning", async () => {
    const { file, directory } = await fixture('{"usage":"u1"}\n');
    const first = modelCache({ directory });
    await indexed(first, file);
    await first.dispose();
    const checkpoint = path.join(directory, `${createHash("sha256").update(file).digest("hex")}.jsonl`);
    await fs.writeFile(`${checkpoint}.orphan.tmp`, "{unfinished");
    let reads = 0;
    const warm = modelCache({ directory, onRead: () => { reads++; } });
    expect(await warm.read(file)).toEqual(["u1:none"]);
    await warm.dispose();
    const stored = JSON.parse(await fs.readFile(checkpoint, "utf8"));
    stored.state = { model: 42 };
    await fs.writeFile(checkpoint, JSON.stringify(stored));
    const corrupt = modelCache({ directory, onRead: () => { reads++; } });
    expect(await corrupt.readWithStatus(file)).toEqual({ results: [], indexing: "error" });
    await corrupt.idle();
    expect(reads).toBe(0);
  });

  it("drops an oversized record through its newline instead of parsing its tail", async () => {
    const { file } = await fixture('x'.repeat(16 * 1024 * 1024 + 1) + '{"usage":"tail"}\n{"usage":"next"}\n');
    const cache = modelCache({ scheduler: scheduler(1024 * 1024) });
    expect(await indexed(cache, file)).toEqual(["next:none"]);
  });

  it("keeps mid-record checkpoints small instead of rewriting a growing partial record", async () => {
    const { file, directory } = await fixture('{"text":"' + "x".repeat(4 * 1024 * 1024) + '"}\n{"usage":"next"}\n');
    const checkpoint = path.join(directory, `${createHash("sha256").update(file).digest("hex")}.jsonl`);
    let slices = 0;
    let signalRead!: () => void;
    const fourthRead = new Promise<void>(resolve => { signalRead = resolve; });
    const first = modelCache({ directory, scheduler: scheduler(256 * 1024), onRead: () => { if (++slices === 4) signalRead(); } });
    await first.read(file);
    await fourthRead;
    await first.dispose();
    const stored = JSON.parse(await fs.readFile(checkpoint, "utf8"));
    expect(stored.offset).toBe(0);
    expect(stored.pending).toBe("");
    expect((await fs.stat(checkpoint)).size).toBeLessThan(1024);
    const resumed = modelCache({ directory, scheduler: scheduler(1024 * 1024) });
    expect(await indexed(resumed, file)).toEqual(["next:none"]);
  });

  it("journals each usage result once instead of rewriting accumulated results per slice", async () => {
    const rows = Array.from({ length: 36_000 }, (_, index) => JSON.stringify({ usage: `u${index}`, pad: "x".repeat(96) }));
    const content = rows.join("\n") + "\n";
    expect(Buffer.byteLength(content)).toBeGreaterThan(4 * 1024 * 1024);
    const { file, directory } = await fixture(content);
    const cache = modelCache({ directory });
    expect(await indexed(cache, file)).toHaveLength(rows.length);
    const journalPath = path.join(directory, `${createHash("sha256").update(file).digest("hex")}.jsonl`);
    const journal = await fs.readFile(journalPath, "utf8");
    const frames = journal.trimEnd().split("\n").map(line => JSON.parse(line));
    expect(frames.length).toBeGreaterThan(16);
    expect(frames.reduce((sum, frame) => sum + frame.results.length, 0)).toBe(rows.length);
    expect(Buffer.byteLength(journal)).toBeLessThan(Buffer.byteLength(content) / 4);
    await cache.dispose();
    const warmReads: number[] = [];
    const warm = modelCache({ directory, onRead: (_, offset) => warmReads.push(offset) });
    const result = await warm.readWithStatus(file);
    expect(result.results).toHaveLength(rows.length);
    expect(result.indexing).toBeUndefined();
    expect(result.results.at(-1)).toBe("u35999:none");
    expect(warmReads).toEqual([]);
  });

  it("replays complete journal transactions and replaces an interrupted final append", async () => {
    const initial = '{"model":"m1"}\n{"usage":"u1"}\n';
    const { file, directory } = await fixture(initial);
    const first = modelCache({ directory, scheduler: scheduler(16) });
    expect(await indexed(first, file)).toEqual(["u1:m1"]);
    await first.dispose();
    const journalPath = path.join(directory, `${createHash("sha256").update(file).digest("hex")}.jsonl`);
    const complete = await fs.readFile(journalPath);
    // The torn UTF-8 suffix must be discarded by byte position, not decoded
    // character length, before the next durable transaction is appended.
    await fs.appendFile(journalPath, Buffer.from([123, 34, 0xc3]));
    const reads: number[] = [];
    const resumed = modelCache({ directory, onRead: (_, offset) => reads.push(offset) });
    expect(await resumed.readWithStatus(file)).toEqual({ results: ["u1:m1"], indexing: undefined });
    expect(reads).toEqual([]);
    await fs.appendFile(file, '{"usage":"u2"}\n');
    expect(await indexed(resumed, file)).toEqual(["u1:m1", "u2:m1"]);
    const repaired = await fs.readFile(journalPath);
    expect(repaired.subarray(0, complete.length)).toEqual(complete);
    const frames = repaired.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    expect(frames.at(-1).results).toEqual(["u2:m1"]);
    expect(frames.at(-1).totalResults).toBe(2);
    expect(reads).toEqual([Buffer.byteLength(initial)]);
    await resumed.dispose();
    expect(await modelCache({ directory }).read(file)).toEqual(["u1:m1", "u2:m1"]);
  });

  it("extends a checkpointed partial record across several new slices without regressing progress", async () => {
    const { file, directory } = await fixture('{"model":"m1"}\n{"usage":"' + "u".repeat(100));
    const first = modelCache({ directory, scheduler: scheduler(17) });
    expect(await indexed(first, file)).toEqual([]);
    await first.dispose();
    await fs.appendFile(file, "v".repeat(100) + '"}\n{"usage":"next"}\n');
    const resumed = modelCache({ directory, scheduler: scheduler(17) });
    expect(await indexed(resumed, file)).toEqual([`${"u".repeat(100)}${"v".repeat(100)}:m1`, "next:m1"]);
    await resumed.dispose();
    const journalPath = path.join(directory, `${createHash("sha256").update(file).digest("hex")}.jsonl`);
    const frames = (await fs.readFile(journalPath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    expect(frames.every((frame, index) => !index || frame.offset >= frames[index - 1].offset)).toBe(true);
    expect(await modelCache({ directory }).read(file)).toEqual([`${"u".repeat(100)}${"v".repeat(100)}:m1`, "next:m1"]);
  });

  it("keeps dropping an oversized record after a restart until the record ends", async () => {
    const { file, directory } = await fixture("x".repeat(16 * 1024 * 1024 + 1));
    const first = modelCache({ directory, scheduler: scheduler(1024 * 1024) });
    expect(await indexed(first, file)).toEqual([]);
    await first.dispose();
    await fs.appendFile(file, '{"usage":"tail"}\n{"usage":"next"}\n');
    const resumed = modelCache({ directory });
    expect(await indexed(resumed, file)).toEqual(["next:none"]);
  });

  it.each(["sequence", "totalResults", "state", "results", "offset", "syntax"])("rejects a corrupt complete journal frame: %s", async field => {
    const { file, directory } = await fixture('{"usage":"u1"}\n');
    const first = modelCache({ directory });
    await indexed(first, file);
    await first.dispose();
    await fs.appendFile(file, '{"usage":"u2"}\n');
    const second = modelCache({ directory });
    await indexed(second, file);
    await second.dispose();
    const journalPath = path.join(directory, `${createHash("sha256").update(file).digest("hex")}.jsonl`);
    const frames = (await fs.readFile(journalPath, "utf8")).trimEnd().split("\n");
    const frame = JSON.parse(frames[1]);
    if (field === "state") frame.state = { model: 42 };
    else if (field === "results") frame.results = [42];
    else if (field === "offset") frame.offset = frame.size + 1;
    else frame[field] = 10_000;
    frames[1] = field === "syntax" ? "{bad" : JSON.stringify(frame);
    await fs.writeFile(journalPath, frames.join("\n") + "\n");
    let reads = 0;
    const corrupt = modelCache({ directory, onRead: () => { reads++; } });
    expect((await corrupt.readWithStatus(file)).indexing).toBe("error");
    await corrupt.idle();
    expect(reads).toBe(0);
  });

  it("discards a slice when its source is rewritten while it is being read", async () => {
    const { file, directory } = await fixture('{"usage":"old"}\n');
    let slices = 0;
    const cache = modelCache({ directory, onRead: () => {
      if (++slices !== 1) return;
      writeFileSync(file, '{"usage":"new"}\n');
      utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    } });
    expect(await indexed(cache, file)).toEqual(["new:none"]);
    expect(slices).toBe(2);
  });

  it("retains indexed totals and reports an error when a known source disappears", async () => {
    const { file, directory } = await fixture('{"usage":"u1"}\n');
    const errors: unknown[] = [];
    const cache = modelCache({ directory, onError: (_, error) => errors.push(error) });
    await indexed(cache, file);
    await fs.unlink(file);
    expect(await cache.readWithStatus(file)).toEqual({ results: ["u1:none"], indexing: "error" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("reports parser failures while retaining only previously checkpointed results", async () => {
    const { file, directory } = await fixture('{"usage":"u1"}\n');
    const first = modelCache({ directory });
    await indexed(first, file);
    await first.dispose();
    await fs.appendFile(file, '{"usage":"u2"}\n');
    const failing = new JsonlCache<{ model: string }, string>(() => ({ model: "none" }), () => { throw new Error("parser failed"); }, { directory, scheduler: scheduler() });
    disposables.push(failing);
    expect(await failing.read(file)).toEqual(["u1:none"]);
    await failing.idle();
    expect(await failing.readWithStatus(file)).toEqual({ results: ["u1:none"], indexing: "error" });
  });

  it("treats a missing source as empty without creating a checkpoint", async () => {
    const { file, directory } = await fixture("");
    await fs.unlink(file);
    expect(await modelCache({ directory }).readWithStatus(file)).toEqual({ results: [], indexing: undefined });
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

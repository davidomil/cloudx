import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { ForgeEvidenceFiles } from "./ForgeEvidenceFiles.js";
import { Readable } from "node:stream";
import { Header, type types } from "tar";
import { describe, expect, it, onTestFinished } from "vitest";
import { readContainerEvidenceTar as streamEvidenceTar, validEvidencePaths } from "./ForgeContainerEvidence.js";

function evidenceTar(entries: { path: string; data?: string; type?: types.EntryTypeName; linkpath?: string; size?: number }[]): Buffer {
  return Buffer.concat([...entries.flatMap(entry => {
    const data = Buffer.from(entry.data ?? "");
    const header = new Header({ path: entry.path, type: entry.type ?? "File", size: entry.size ?? data.length, mode: 0o600, linkpath: entry.linkpath });
    header.encode();
    return [header.block!, data, Buffer.alloc((512 - data.length % 512) % 512)];
  }), Buffer.alloc(1024)]);
}

async function readContainerEvidenceTar(source: string, tar: Buffer) {
  const files: { path: string; data: Buffer }[] = [];
  await streamEvidenceTar(source, Readable.from([tar]), async (filePath, stream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    files.push({ path: filePath, data: Buffer.concat(chunks) });
  });
  return files;
}

describe("specific bounded Docker evidence archive parsing", () => {
  it("reads regular reports while excluding generated siblings and repository history", async () => {
    const archive = evidenceTar([
      { path: "evidence", type: "Directory" },
      { path: "evidence/tests.log", data: "tests passed" },
      { path: "evidence/reproduction/input.json", data: "{}" },
      { path: "evidence/node_modules/generated", data: "disposable" },
      { path: "evidence/dist/build.js", data: "disposable" },
      { path: "evidence/build.tsbuildinfo", data: "disposable" },
      { path: "evidence/.git/config", data: "history" },
    ]);
    const files = await readContainerEvidenceTar("/work/evidence", archive);
    expect(files.map(item => [item.path, item.data.toString()])).toEqual([["work/evidence/tests.log", "tests passed"], ["work/evidence/reproduction/input.json", "{}"]]);
  });
  it.each(["../outside", "/outside", "evidence/../outside", "other/log", "evidence\\outside"])("rejects archive path %s without extracting it", async file => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: file, data: "private" }]))).rejects.toThrow("unsafe or unexpected path");
  });
  it.each(["SymbolicLink", "Link", "FIFO", "CharacterDevice"] as const)("rejects %s evidence entries", async type => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", type, ...(["SymbolicLink", "Link"].includes(type) ? { linkpath: "/etc/passwd" } : {}) }]))).rejects.toThrow("links, special files");
  });
  it("rejects duplicate entries and truncated or corrupted archives", async () => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", data: "first" }, { path: "evidence/log", data: "second" }]))).rejects.toThrow("duplicate paths");
    const archive = evidenceTar([{ path: "evidence/log", data: "normal log" }]);
    archive[0] = 0;
    await expect(readContainerEvidenceTar("/work/evidence", archive)).rejects.toThrow();
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", data: "missing body", size: 9999 }]))).rejects.toThrow();
  });
  it("rejects oversized evidence before buffering its entry body", async () => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/large", size: 256 * 1024 * 1024 + 1 }]))).rejects.toThrow("bounded storage limit");
  });
  it.each([false, true])("rejects interrupted input with the original error when delayed sink startup is %s", async delayedSink => {
    const failure = new Error("Docker stdout interrupted during report copy");
    const header = new Header({ path: "evidence/report.json", type: "File", size: 128 * 1024, mode: 0o600 }); header.encode();
    let sinkStarted = false;
    async function* interruptedTar() {
      yield header.block!;
      yield Buffer.alloc(64 * 1024, 0x61);
      if (!delayedSink) await setImmediate();
      throw failure;
    }
    const operation = streamEvidenceTar("/work/evidence", interruptedTar(), async (_filePath, stream) => {
      sinkStarted = true;
      if (delayedSink) await setImmediate();
      for await (const _chunk of stream) { /* Consume the selected report without buffering it. */ }
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("Interrupted export did not settle")), 2000); });
    try { await expect(Promise.race([operation, stalled])).rejects.toBe(failure); }
    finally { clearTimeout(deadline); }
    expect(sinkStarted).toBe(true);
  });
  it.each([16 * 1024 * 1024 + 1, 23_754_142, 32 * 1024 * 1024 + 1, 34_048_143])("streams a %i-byte Docker tar report to disk under backpressure", async bytes => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-tar-stream-"));
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const storage = new ForgeEvidenceFiles(directory);
    const writer = await storage.begin("forge-evidence", "container-183");
    const header = new Header({ path: "evidence/report.json", type: "File", size: bytes, mode: 0o600 }); header.encode();
    let produced = 0;
    let consumed = 0;
    let ahead = 0;
    async function* tar() {
      yield header.block!;
      while (produced < bytes) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, bytes - produced), 0x61);
        produced += chunk.length;
        ahead = Math.max(ahead, produced - consumed);
        yield chunk;
      }
      yield Buffer.alloc((512 - bytes % 512) % 512 + 1024);
    }
    await streamEvidenceTar("/work/evidence", tar(), async (filePath, stream, size) => {
      async function* slowDiskInput() {
        for await (const chunk of stream) { consumed += chunk.length; yield chunk; await setImmediate(); }
      }
      await writer.add(filePath, slowDiskInput(), size);
    });
    expect(consumed).toBe(bytes);
    expect(ahead).toBeLessThanOrEqual(256 * 1024);
    await writer.commit({ files: writer.files, bytes: writer.bytes }, async () => {});
    await storage.verify("forge-evidence", "container-183", writer.files);
    const hash = createHash("sha256");
    for await (const chunk of await storage.fileStream("forge-evidence", "container-183", "work/evidence/report.json")) hash.update(chunk);
    expect(hash.digest("hex")).toBe(writer.files[0]?.sha256);
  });
  it("accepts concrete absolute paths and rejects overlapping or generated selections", () => {
    expect(validEvidencePaths(["/work/evidence/log", "/work/reproduction.json"])).toBe(true);
    expect(validEvidencePaths(["/work/evidence", "/work/evidence/log"])).toBe(false);
    expect(validEvidencePaths(["/work/node_modules/pkg/log"])).toBe(false);
    expect(validEvidencePaths(["/work/evidence/.git/log"])).toBe(false);
  });
});

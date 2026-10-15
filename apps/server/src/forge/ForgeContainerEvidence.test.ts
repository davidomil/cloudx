import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { ForgeEvidenceFiles } from "./ForgeEvidenceFiles.js";
import { Readable } from "node:stream";
import { Header, type types } from "tar";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
  it.each(["Link", "FIFO", "CharacterDevice"] as const)("rejects %s evidence entries", async type => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", type, ...(["SymbolicLink", "Link"].includes(type) ? { linkpath: "/etc/passwd" } : {}) }]))).rejects.toThrow("links, special files");
  });
  it.each(["/opt/codex/bin/codex", "../../provider/projects", "/etc/passwd"])("preserves fixture link %s as inert metadata", async target => {
    const files = await readContainerEvidenceTar("/review/repro", evidenceTar([
      { path: "repro/fixture/apply_patch", type: "SymbolicLink", linkpath: target },
      { path: "repro/result.log", data: "test passed" },
    ]));
    expect(files.map(file => [file.path, file.data.toString()])).toEqual([
      ["review/repro/fixture/apply_patch", JSON.stringify({ type: "SymbolicLink", target })],
      ["review/repro/result.log", "test passed"],
    ]);
  });
  it("streams more than one batch of selected schema files without omitting any", async () => {
    const files = await readContainerEvidenceTar("/review/repro", evidenceTar(Array.from({ length: 600 }, (_, index) =>
      ({ path: `repro/schema/${index}.json`, data: `${index}` }))));
    expect(files).toHaveLength(600);
    expect(files[599]?.data.toString()).toBe("599");
  });
  it.each(["plugins/plugins/example", "plugins-clone-example"])("discards more than 8192 %s cache entries before preserving useful evidence", async layout => {
    const archive = evidenceTar([
      ...Array.from({ length: 9000 }, (_, index) => ({ path: `evidence/codex-launches/example/.tmp/${layout}/${index}`, data: "" })),
      { path: "evidence/validation.log", data: "validation passed\n" },
      { path: "evidence/config/settings.json", data: "{}" },
      { path: "evidence/fixture/tool", type: "SymbolicLink", linkpath: "/opt/codex/bin/codex" },
    ]);
    const files = await readContainerEvidenceTar("/work/evidence", archive);
    expect(files.map(file => [file.path, file.data.toString()])).toEqual([
      ["work/evidence/validation.log", "validation passed\n"],
      ["work/evidence/config/settings.json", "{}"],
      ["work/evidence/fixture/tool", JSON.stringify({ type: "SymbolicLink", target: "/opt/codex/bin/codex" })],
    ]);
  });
  it("bounds discarded generated bodies before consuming them", async () => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([
      { path: "evidence/codex-launches/example/.tmp/plugins/large", size: 64 * 1024 * 1024 },
    ]))).rejects.toThrow("generated archive traversal limit");
  });
  it("charges extended path headers to generated traversal instead of the useful entry inventory", async () => {
    const archive = evidenceTar([
      ...Array.from({ length: 9000 }, (_, index) => [
        { path: "././@LongLink", type: "NextFileHasLongPath" as const, data: `evidence/codex-launches/example/.tmp/plugins/${"x".repeat(100)}/${index}\0` },
        { path: "placeholder", data: "" },
      ]).flat(),
      { path: "evidence/log", data: "passed" },
    ]);
    expect((await readContainerEvidenceTar("/work/evidence", archive)).map(file => file.data.toString())).toEqual(["passed"]);
  });
  it("bounds the number of empty discarded entries through their serialized header bytes", async () => {
    const header = new Header({ path: "evidence/node_modules/empty", type: "File", size: 0, mode: 0o600 }); header.encode();
    async function* generated() { for (let index = 0; index <= 64 * 1024 * 1024 / 512; index++) yield header.block!; }
    await expect(streamEvidenceTar("/work/evidence", generated(), async () => {})).rejects.toThrow("generated archive traversal limit");
  });
  it("retains the 8192-entry ceiling for non-generated directory inventories", async () => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar(Array.from({ length: 8193 }, (_, index) =>
      ({ path: `evidence/fixture/${index}`, type: "Directory" }))))).rejects.toThrow("too many entries");
  });
  it("bounds metadata accumulated before any regular entry", async () => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([
      ...Array.from({ length: 9 }, () => ({ path: "pax", type: "GlobalExtendedHeader" as const, data: "x".repeat(1024 * 1024) })),
      { path: "evidence/log", data: "must stay protected" },
    ]))).rejects.toThrow("metadata traversal limit");
  });
  it("bounds synchronous archive traversal time even when the event loop cannot run its Docker timeout", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(60_001);
    try {
      await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", data: "log" }]))).rejects.toThrow("traversal timed out");
    } finally { clock.mockRestore(); }
  });
  it("checks the traversal deadline for input chunks that contain no entries", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    async function* padding() {
      yield Buffer.alloc(512);
      clock.mockReturnValue(60_001);
      yield Buffer.alloc(512);
    }
    try {
      await expect(streamEvidenceTar("/work/evidence", padding(), async () => {})).rejects.toThrow("traversal timed out");
    } finally { clock.mockRestore(); }
  });
  it("rejects archive entries beneath a fixture link and duplicate directory paths", async () => {
    await expect(readContainerEvidenceTar("/review/repro", evidenceTar([
      { path: "repro/projects", type: "SymbolicLink", linkpath: "/private" },
      { path: "repro/projects/secret", data: "must not be copied" },
    ]))).rejects.toThrow("link parent");
    await expect(readContainerEvidenceTar("/review/repro", evidenceTar([
      { path: "repro", type: "Directory" }, { path: "repro", type: "Directory" },
    ]))).rejects.toThrow("duplicate");
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([
      { path: "evidence/fixture", type: "SymbolicLink", linkpath: "/private" },
      { path: "evidence/fixture/node_modules/generated", data: "must not be copied" },
    ]))).rejects.toThrow("link parent");
  });
  it("keeps an aggregate file-count ceiling even when individual storage batches fit", async () => {
    await expect(readContainerEvidenceTar("/review/repro", evidenceTar(Array.from({ length: 4097 }, (_, index) =>
      ({ path: `repro/schema/${index}.json`, data: "" }))))).rejects.toThrow("bounded collection limit");
  });
  it("rejects duplicate entries and truncated or corrupted archives", async () => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", data: "first" }, { path: "evidence/log", data: "second" }]))).rejects.toThrow("duplicate paths");
    const archive = evidenceTar([{ path: "evidence/log", data: "normal log" }]);
    archive[0] = 0;
    await expect(readContainerEvidenceTar("/work/evidence", archive)).rejects.toThrow();
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", data: "missing body", size: 9999 }]))).rejects.toThrow();
  });
  it("rejects oversized extended metadata instead of silently changing the following evidence path", async () => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([
      { path: "pax", type: "ExtendedHeader", data: "x".repeat(1024 * 1024 + 1) },
      { path: "evidence/log", data: "must stay protected" },
    ]))).rejects.toThrow("oversized metadata");
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

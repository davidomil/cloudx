import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonStateFile } from "../jsonStateFile.js";
import { evidenceLinkContents, ForgeEvidenceFiles, maxEvidenceBytes, syncEvidenceReceipt, writeEvidenceReceipt } from "./ForgeEvidenceFiles.js";

const namespace = "forge-checkout-evidence";
const id = "worker-183";
const filePath = "reports/check.log";
const blob = createHash("sha256").update(filePath).digest("hex") + ".data";

describe("bounded durable Forge evidence files", () => {
  let directory: string;
  let storage: ForgeEvidenceFiles;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-files-")); storage = new ForgeEvidenceFiles(directory); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  async function publish() {
    const writer = await storage.begin(namespace, id);
    await writer.add(filePath, Readable.from([Buffer.from("passed\n")]), 7);
    await writer.commit({ files: writer.files, bytes: writer.bytes, attemptId: "attempt-183", commitSha: "a".repeat(40) }, async () => {});
    return writer.files;
  }

  it("syncs an exact receipt with directory ancestors and refuses symlink replacements", async () => {
    const file = new JsonStateFile(directory, "nested/receipts/worker.json", "Evidence receipt", 0o600);
    await file.write({ commitSha: "a".repeat(40), manifestSha256: "b".repeat(64) });
    await syncEvidenceReceipt(file);
    await fs.unlink(file.filePath);
    await fs.symlink("/etc/passwd", file.filePath);
    await expect(syncEvidenceReceipt(file)).rejects.toThrow();
  });

  it("preserves the previous durable receipt when syncing its replacement fails before rename", async () => {
    const file = new JsonStateFile(directory, "receipt.json", "Evidence receipt", 0o600);
    await writeEvidenceReceipt(file, { manifestSha256: "a".repeat(64) });
    const open = fs.open.bind(fs);
    const syncFailures: ReturnType<typeof vi.spyOn>[] = [];
    const intercept = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".evidence.tmp")) syncFailures.push(vi.spyOn(handle, "sync").mockRejectedValue(new Error("receipt device sync failed")));
      return handle;
    });
    try { await expect(writeEvidenceReceipt(file, { manifestSha256: "b".repeat(64) })).rejects.toThrow("receipt device sync failed"); }
    finally { intercept.mockRestore(); for (const spy of syncFailures) spy.mockRestore(); }
    expect(await file.read()).toEqual({ manifestSha256: "a".repeat(64) });
    expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
  });

  it("records intent only after content is synced and publishes verified flat files with provenance", async () => {
    const writer = await storage.begin(namespace, id);
    await writer.add(filePath, Readable.from([Buffer.from("passed\n")]), 7);
    let recorded = false;
    await writer.commit({ files: writer.files, attemptId: "attempt-183" }, async () => {
      expect(await storage.readManifest(namespace, id)).toBeUndefined();
      expect(writer.files).toEqual([{ path: filePath, bytes: 7, sha256: createHash("sha256").update("passed\n").digest("hex") }]);
      recorded = true;
    });
    expect(recorded).toBe(true);
    await storage.verify(namespace, id, writer.files);
    expect(await text(await storage.fileStream(namespace, id, filePath))).toBe("passed\n");
    await writer.abort();
    expect(await storage.readManifest(namespace, id)).toMatchObject({ attemptId: "attempt-183" });
    await expect(storage.begin(namespace, id)).rejects.toThrow("already exists");
  });

  it("protects unpublished partial content when either source or durable intent fails", async () => {
    const writer = await storage.begin(namespace, id);
    async function* interrupted() { yield Buffer.from("partial"); throw new Error("source interrupted"); }
    await expect(writer.add(filePath, interrupted(), 50)).rejects.toThrow("source interrupted");
    expect(writer.files).toEqual([]);
    expect(await storage.readManifest(namespace, id)).toBeUndefined();
    await writer.abort();
    const retry = await storage.begin(namespace, id);
    await retry.add(filePath, Readable.from([Buffer.from("passed\n")]), 7);
    await expect(retry.commit({ files: retry.files }, async () => { throw new Error("journal unavailable"); })).rejects.toThrow("journal unavailable");
    expect(await storage.readManifest(namespace, id)).toBeUndefined();
    await retry.abort();
    expect(await fs.readdir(path.join(directory, namespace))).toEqual([]);
  });

  it("rejects oversized headers before consuming file data and detects truncated streams", async () => {
    const writer = await storage.begin(namespace, id);
    let consumed = false;
    async function* source() { consumed = true; yield Buffer.from("small"); }
    await expect(writer.add(filePath, source(), maxEvidenceBytes + 1)).rejects.toThrow("bounded storage limit");
    expect(consumed).toBe(false);
    await expect(writer.add(filePath, source(), 10)).rejects.toThrow("truncated");
    await writer.abort();
  });

  it("bounds file count and refuses duplicate selections without accepting a manifest", async () => {
    const writer = await storage.begin(namespace, id);
    for (let index = 0; index < 512; index++) await writer.add(`reports/${index}`, Readable.from([]), 0);
    await expect(writer.add("reports/last", Readable.from([]), 0)).rejects.toThrow("512 files");
    await expect(writer.add("reports/0", Readable.from([]), 0)).rejects.toThrow("duplicate");
    await writer.abort();
  }, 20_000);

  it("publishes a complete bounded collection once and reads files from every batch", async () => {
    const writer = await storage.beginCollection("forge-evidence", id);
    for (let index = 0; index < 600; index++) await writer.add(`reports/${index}`, Readable.from([Buffer.from(`${index}`)]), String(index).length);
    const files = writer.files;
    const batches = writer.batches;
    expect(batches.map(batch => batch.files.length)).toEqual([512, 88]);
    await expect(writer.add("reports/0", Readable.from([]), 0)).rejects.toThrow("duplicate");
    await writer.commit({ files, batches, bytes: writer.bytes }, async () => {
      expect(await storage.readManifest("forge-evidence", id)).toBeUndefined();
    });
    await writer.abort();
    await storage.verifyCollection("forge-evidence", id, batches, files);
    expect(await text(await storage.fileStream("forge-evidence", id, "reports/599", 1))).toBe("599");
  });

  it("rotates storage batches by bytes while retaining the 256 MiB per-file bound", async () => {
    const writer = await storage.beginCollection("forge-evidence", id);
    const size = maxEvidenceBytes / 2 + 1;
    async function* report() {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      for (let remaining = size; remaining > 0; remaining -= chunk.length) yield chunk.subarray(0, Math.min(remaining, chunk.length));
    }
    try {
      await expect(writer.add("reports/oversized", report(), maxEvidenceBytes + 1)).rejects.toThrow("256 MiB per file");
      await writer.add("reports/first", report(), size);
      await writer.add("reports/second", report(), size);
      expect(writer.batches.map(batch => batch.bytes)).toEqual([size, size]);
      await writer.commit({ files: writer.files, batches: writer.batches, bytes: writer.bytes }, async () => {});
      await storage.verifyCollection("forge-evidence", id, writer.batches, writer.files);
    } finally { await writer.abort(); }
  }, 20_000);

  it("rotates batches by bounded metadata size for long fixture-link targets", async () => {
    const writer = await storage.beginCollection("forge-evidence", id);
    const target = "/provider/" + "x".repeat(4000);
    const data = evidenceLinkContents(target);
    for (let index = 0; index < 300; index++) await writer.add(`fixtures/${index}`, Readable.from([data]), data.length, target);
    expect(writer.batches).toHaveLength(2);
    expect(writer.batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 1024 * 1024)).toBe(true);
    await writer.commit({ files: writer.files, batches: writer.batches, bytes: writer.bytes }, async () => {});
    await storage.verifyCollection("forge-evidence", id, writer.batches, writer.files);
  });

  it.each(["manifest", "extra-batch", "symlink-parent", "link-content"] as const)("protects the source when collection %s is changed", async change => {
    const writer = await storage.beginCollection("forge-evidence", id);
    const target = "../../provider/projects";
    const data = evidenceLinkContents(target);
    await writer.add(filePath, Readable.from([data]), data.length, target);
    const files = writer.files;
    const batches = writer.batches;
    await writer.commit({ files, batches, bytes: writer.bytes }, async () => {});
    const archive = path.join(directory, "forge-evidence", id);
    const batch = path.join(archive, "batch-0");
    if (change === "manifest") await fs.writeFile(path.join(batch, "manifest.json"), JSON.stringify({ files, bytes: 0 }));
    if (change === "extra-batch") await fs.mkdir(path.join(archive, "batch-1"));
    if (change === "symlink-parent") {
      await fs.rename(batch, path.join(directory, "outside-batch"));
      await fs.symlink(path.join(directory, "outside-batch"), batch);
    }
    if (change === "link-content") await fs.writeFile(path.join(batch, blob), evidenceLinkContents("/etc/private"));
    await expect(storage.verifyCollection("forge-evidence", id, batches, files)).rejects.toThrow();
  });

  it("rejects false link metadata and cleans all batches if the complete export intent fails", async () => {
    const writer = await storage.beginCollection("forge-evidence", id);
    await expect(writer.add(filePath, Readable.from([Buffer.from("ordinary content")]), 16, "/etc/private")).rejects.toThrow("bounded storage policy");
    await writer.abort();
    const retry = await storage.beginCollection("forge-evidence", id);
    for (let index = 0; index < 513; index++) await retry.add(`reports/${index}`, Readable.from([]), 0);
    await expect(retry.commit({ files: retry.files, batches: retry.batches }, async () => { throw new Error("receipt unavailable"); })).rejects.toThrow("receipt unavailable");
    expect(await storage.readManifest("forge-evidence", id)).toBeUndefined();
    await retry.abort();
    expect(await fs.readdir(path.join(directory, "forge-evidence"))).toEqual([]);
  });

  it("rejects malformed batch inventories with the bounded-policy error", async () => {
    const malformed = [{ files: [null], bytes: 0 }] as unknown as import("@cloudx/shared").ForgeEvidenceBatch[];
    await expect(storage.verifyCollection("forge-evidence", id, malformed, [])).rejects.toThrow("bounded storage policy");
  });

  it.each(["../outside", ".", "..", "reports/../outside", "reports//log", "reports/.git/log"])("rejects unsafe evidence manifest path %s", async value => {
    const writer = await storage.begin(namespace, id);
    await expect(writer.add(value, Readable.from([]), 0)).rejects.toThrow("unsafe");
    await writer.abort();
  });

  it.each(["checksum", "inventory", "symlink"])("blocks retirement if durable %s verification changes", async change => {
    const files = await publish();
    const archive = path.join(directory, namespace, id);
    if (change === "checksum") await fs.writeFile(path.join(archive, blob), "failed\n");
    if (change === "inventory") await fs.writeFile(path.join(archive, "extra.data"), "unexpected");
    if (change === "symlink") { await fs.unlink(path.join(archive, blob)); await fs.symlink("/etc/passwd", path.join(archive, blob)); }
    await expect(storage.verify(namespace, id, files)).rejects.toThrow();
  });

  it("rejects a replaced archive directory and bounded metadata failures", async () => {
    await publish();
    const archive = path.join(directory, namespace, id);
    await fs.writeFile(path.join(archive, "manifest.json"), " ".repeat(1024 * 1024 + 1));
    await expect(storage.readManifest(namespace, id)).rejects.toThrow("bounded regular file");
    await fs.rename(archive, `${archive}-preserved`);
    await fs.symlink(`${archive}-preserved`, archive);
    await expect(storage.readManifest(namespace, id)).rejects.toThrow("symbolic link");
  });
});

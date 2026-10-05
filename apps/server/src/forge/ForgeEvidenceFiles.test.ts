import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonStateFile } from "../jsonStateFile.js";
import { ForgeEvidenceFiles, maxEvidenceBytes, syncEvidenceReceipt, writeEvidenceReceipt } from "./ForgeEvidenceFiles.js";

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

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ForgeEvidenceFile } from "@cloudx/shared";
import { requireRegularFile, requireSafeDirectory, stringifyJsonDocument, type JsonStateFile } from "../jsonStateFile.js";

export const maxEvidenceBytes = 256 * 1024 * 1024;
export const maxEvidenceFiles = 512;
const maxManifestBytes = 1024 * 1024;

export async function writeEvidenceReceipt(file: JsonStateFile, value: unknown): Promise<void> {
  const parent = path.dirname(file.filePath);
  await requireSafeDirectory(file.rootPath, parent, { create: true, label: "Forge evidence receipt" });
  if (await fs.realpath(parent) !== parent) throw new Error("Evidence receipt must have safe directory parents.");
  await requireRegularFile(file.filePath, "Forge evidence receipt");
  const temporary = path.join(parent, `.${path.basename(file.filePath)}.${randomUUID()}.evidence.tmp`);
  try {
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(stringifyJsonDocument(value, "Forge evidence receipt")); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file.filePath);
    await syncEvidenceReceipt(file);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Persist the receipt and all directory names before publishing or retiring its source. */
export async function syncEvidenceReceipt(file: JsonStateFile): Promise<void> {
  const parent = path.dirname(file.filePath);
  if (!await requireSafeDirectory(file.rootPath, parent, { create: false, label: "Forge evidence receipt" }) || await fs.realpath(parent) !== parent) throw new Error("Evidence receipt must have safe directory parents.");
  const handle = await fs.open(file.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Evidence receipt must be a regular file.");
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectoryAndParents(parent);
}

/** Private flat storage keeps source paths in the manifest, never in host paths. */
export class ForgeEvidenceFiles {
  constructor(private readonly dataDir: string) {}

  async begin(namespace: string, id: string): Promise<ForgeEvidenceWriter> {
    const parent = await this.directory(namespace, true);
    const destination = path.join(parent!, safeId(id));
    if (await optionalStat(destination)) throw new Error("Durable evidence already exists; verify its receipt before retrying.");
    const stage = path.join(parent!, `.${id}.${randomUUID()}.partial`);
    await fs.mkdir(stage, { mode: 0o700 });
    return new ForgeEvidenceWriter(stage, destination, parent!);
  }

  async readManifest<T>(namespace: string, id: string): Promise<T | undefined> {
    const directory = await this.archiveDirectory(namespace, id);
    if (!directory) return undefined;
    const handle = await fs.open(path.join(directory, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxManifestBytes) throw new Error("Evidence manifest must be a bounded regular file.");
      return JSON.parse(await handle.readFile("utf8")) as T;
    } finally { await handle.close(); }
  }

  async verify(namespace: string, id: string, files: ForgeEvidenceFile[]): Promise<void> {
    validateFiles(files);
    const directory = await this.archiveDirectory(namespace, id);
    if (!directory) throw new Error("Durable evidence archive is missing.");
    const entries = await fs.readdir(directory);
    if (entries.length !== files.length + 1 || !entries.includes("manifest.json") || files.some(file => !entries.includes(blobName(file.path)))) throw new Error("Durable evidence file inventory changed.");
    for (const file of files) {
      const handle = await this.openFile(namespace, id, file.path);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== file.bytes) throw new Error("Durable evidence size verification failed.");
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
          bytes += chunk.length;
          if (bytes > file.bytes) throw new Error("Durable evidence grew during verification.");
          hash.update(chunk);
        }
        if (bytes !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error("Durable evidence checksum verification failed.");
      } finally { await handle.close(); }
    }
    // Recovery must establish durability even when a previous rename was visible but its directory sync failed.
    await syncDirectoryAndParents(directory);
  }

  async fileStream(namespace: string, id: string, filePath: string) {
    const handle = await this.openFile(namespace, id, filePath);
    return handle.createReadStream({ highWaterMark: 64 * 1024 });
  }

  private async openFile(namespace: string, id: string, filePath: string) {
    const directory = await this.archiveDirectory(namespace, id);
    if (!directory) throw new Error("Durable evidence archive is missing.");
    const handle = await fs.open(path.join(directory, blobName(filePath)), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) { await handle.close(); throw new Error("Durable evidence content must be a regular file."); }
    return handle;
  }

  private async archiveDirectory(namespace: string, id: string): Promise<string | undefined> {
    const parent = await this.directory(namespace, false);
    if (!parent) return undefined;
    const directory = path.join(parent, safeId(id));
    if (!await requireSafeDirectory(this.dataDir, directory, { create: false, label: "Durable Forge evidence" })) return undefined;
    if (await fs.realpath(directory) !== directory) throw new Error("Evidence archive must not have symbolic-link parents.");
    return directory;
  }

  private async directory(namespace: string, create: boolean): Promise<string | undefined> {
    if (!/^forge-(?:(?:checkout-)?evidence|git-history)$/u.test(namespace)) throw new Error("Unknown Forge evidence storage namespace.");
    const directory = path.resolve(this.dataDir, namespace);
    if (!await requireSafeDirectory(this.dataDir, directory, { create, label: "Forge evidence storage" })) return undefined;
    if (await fs.realpath(directory) !== directory) throw new Error("Evidence storage must not have symbolic-link parents.");
    return directory;
  }
}

export class ForgeEvidenceWriter {
  readonly files: ForgeEvidenceFile[] = [];
  bytes = 0;
  private published = false;
  constructor(private readonly stage: string, private readonly destination: string, private readonly parent: string) {}

  async add(filePath: string, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, expectedBytes?: number): Promise<void> {
    if (!safeKey(filePath) || this.files.some(file => file.path === filePath)) throw new Error("Evidence contains an unsafe or duplicate path.");
    if (this.files.length >= maxEvidenceFiles || expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || this.bytes + expectedBytes > maxEvidenceBytes)) throw new Error("Evidence exceeds the bounded storage limit (256 MiB / 512 files); select narrower paths.");
    const handle = await fs.open(path.join(this.stage, blobName(filePath)), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (this.bytes + bytes > maxEvidenceBytes || expectedBytes !== undefined && bytes > expectedBytes) throw new Error("Evidence exceeds its bounded storage or declared file size.");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
      }
      if (expectedBytes !== undefined && bytes !== expectedBytes) throw new Error("Evidence stream was truncated before its declared file size.");
      await handle.sync();
    } finally { await handle.close(); }
    this.bytes += bytes;
    this.files.push({ path: filePath, bytes, sha256: hash.digest("hex") });
  }

  async commit(manifest: unknown, recordIntent: () => Promise<void>): Promise<void> {
    validateFiles(this.files);
    const content = JSON.stringify(manifest);
    if (content === undefined || Buffer.byteLength(content) > maxManifestBytes) throw new Error("Evidence manifest exceeds the metadata limit.");
    const handle = await fs.open(path.join(this.stage, "manifest.json"), "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(this.stage);
    await recordIntent();
    await fs.rename(this.stage, this.destination);
    this.published = true;
    await syncDirectory(this.parent);
  }

  async abort(): Promise<void> { if (!this.published) await fs.rm(this.stage, { recursive: true, force: true }); }
}

function validateFiles(files: ForgeEvidenceFile[]): void {
  if (!Array.isArray(files) || !files.length || files.length > maxEvidenceFiles || new Set(files.map(file => file.path)).size !== files.length ||
    files.some(file => !safeKey(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) ||
    files.reduce((sum, file) => sum + file.bytes, 0) > maxEvidenceBytes) throw new Error("Evidence file manifest violates the bounded storage policy.");
}
function safeKey(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\\") && !/[\u0000-\u001f]/u.test(value) && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value.split("/").every(part => !["", ".", "..", ".git"].includes(part)); }
function safeId(value: string): string { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(value)) throw new Error("Invalid Forge evidence identity."); return value; }
function blobName(value: string): string { if (!safeKey(value)) throw new Error("Invalid evidence file path."); return `${createHash("sha256").update(value).digest("hex")}.data`; }
async function optionalStat(value: string) { return fs.lstat(value).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }); }
async function syncDirectory(value: string): Promise<void> { const handle = await fs.open(value, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function syncDirectoryAndParents(directory: string): Promise<void> {
  for (;;) {
    await syncDirectory(directory);
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

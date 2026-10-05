import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Parser } from "tar";
import type { DisposableResource, ForgeEvidenceManifest, ForgeResourceEvidence } from "@cloudx/shared";
import { JsonStateFile, requireSafeDirectory } from "../jsonStateFile.js";
import { isGeneratedForgePath } from "./ForgeGeneratedArtifacts.js";
import { ForgeEvidenceFiles, maxEvidenceBytes, maxEvidenceFiles } from "./ForgeEvidenceFiles.js";

export type EvidenceSink = (filePath: string, data: AsyncIterable<Uint8Array>, expectedBytes: number) => Promise<void>;
export type ContainerEvidenceSource = (write: EvidenceSink) => Promise<void>;
interface EvidenceArchive { manifest: ForgeEvidenceManifest; contents?: Record<string, string> }
const namespace = "forge-evidence";
const legacyMaxEvidenceBytes = 16 * 1024 * 1024;

export function validEvidencePaths(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= 32 && value.every(item =>
    typeof item === "string" && item.length <= 1024 && item.startsWith("/") && item !== "/" &&
    !item.includes("\\") && !/[\u0000-\u001f]/u.test(item) && path.posix.normalize(item) === item &&
    !item.endsWith("/") && !generatedEvidencePath(item) && !item.split("/").includes(".git")) &&
    value.every((item, index) => value.every((other, otherIndex) => index === otherIndex || item !== other && !item.startsWith(`${other}/`)));
}

/** Parse Docker stdout as data and stream regular files to a bounded disk sink. */
export async function readContainerEvidenceTar(source: string, tar: AsyncIterable<Uint8Array>, write: EvidenceSink): Promise<void> {
  if (!validEvidencePaths([source])) throw new Error("Evidence requires specific absolute container paths outside generated environments.");
  const keys = new Set<string>();
  let bytes = 0;
  let archiveBytes = 0;
  let entries = 0;
  const root = path.posix.basename(source);
  const parser = new Parser({ strict: true });
  let tail = Promise.resolve();
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      archiveBytes += chunk.length;
      if (archiveBytes > maxEvidenceBytes * 2 + 8 * 1024 * 1024) { callback(new Error("Container evidence tar exceeds its bounded input limit; select narrower paths.")); return; }
      if (parser.write(chunk)) callback();
      else parser.once("drain", callback);
    },
    final(callback) { parser.end(); completion.then(() => callback(), callback); },
  });
  const completion = new Promise<void>((resolve, reject) => {
    parser.on("error", reject);
    parser.on("end", () => { tail.then(resolve, reject); });
  });
  // Consume rejection immediately even if source input fails before finalization.
  completion.catch(error => { destination.destroy(error as Error); });
  parser.on("entry", entry => {
    const fail = (reason: string) => parser.abort(new Error(reason));
    if (++entries > 8192) { fail("Container evidence tar has too many entries; select narrower paths."); return; }
    const name = entry.path.replace(/^\.\//u, "").replace(/\/$/u, "");
    if (!name || name.includes("\\") || /[\u0000-\u001f]/u.test(name) || path.posix.isAbsolute(name) || path.posix.normalize(name) !== name || name.split("/")[0] !== root) {
      fail("Container evidence archive contains an unsafe or unexpected path."); return;
    }
    const filePath = source.slice(1) + name.slice(root.length);
    if (generatedEvidencePath(filePath) || filePath.split("/").includes(".git") || entry.type === "Directory") { entry.resume(); return; }
    if (!["File", "OldFile"].includes(entry.type) || entry.linkpath || keys.has(filePath)) {
      fail("Container evidence archive contains links, special files or duplicate paths."); return;
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || bytes + entry.size > maxEvidenceBytes || keys.size >= maxEvidenceFiles) {
      fail("Evidence exceeds the bounded storage limit (256 MiB / 512 files); select narrower paths."); return;
    }
    keys.add(filePath); bytes += entry.size;
    tail = tail.then(() => write(filePath, entry, entry.size));
    tail.catch(error => parser.abort(error instanceof Error ? error : new Error(String(error))));
  });
  try { await pipeline(Readable.from(tar), destination); await completion; }
  catch (error) { parser.abort(error instanceof Error ? error : new Error(String(error))); await tail.catch(() => undefined); throw error; }
  if (!keys.size) throw new Error(`Evidence source ${source} has no exportable regular files; select specific valuable data.`);
}

export class ForgeContainerEvidence {
  private readonly storage: ForgeEvidenceFiles;
  constructor(private readonly dataDir: string) { this.storage = new ForgeEvidenceFiles(dataDir); }

  async export(resource: DisposableResource, source: ContainerEvidenceSource, recordIntent: (receipt: ForgeResourceEvidence) => Promise<void>): Promise<ForgeResourceEvidence> {
    const evidence = resource.evidence;
    if (!evidence || !validEvidencePaths(evidence.paths) || !resource.containerId || !resource.created) throw new Error("Evidence export requires exact source and container provenance.");
    const writer = await this.storage.begin(namespace, resource.id);
    try {
      await source(async (filePath, data, expectedBytes) => {
        if (!selectedEvidenceKey(filePath, evidence.paths)) throw new Error("Evidence source returned a path outside its declared selection.");
        await writer.add(filePath, data, expectedBytes);
      });
      const files = writer.files.sort((left, right) => left.path.localeCompare(right.path));
      const manifest: ForgeEvidenceManifest = {
        resourceId: resource.id, owner: resource.owner, consumers: resource.consumers, engineId: resource.engineId,
        containerId: resource.containerId, created: resource.created, reason: resource.retentionReason, paths: evidence.paths,
        commitSha: evidence.commitSha, commitSource: evidence.commitSource, exportedAt: new Date().toISOString(), files, bytes: writer.bytes,
      };
      const receipt: ForgeResourceEvidence = { ...evidence, state: "verified", archivePath: archivePath(resource.id), manifestSha256: sha256(JSON.stringify(manifest)), files, bytes: writer.bytes, exportedAt: manifest.exportedAt };
      // The full selection must stream successfully before its durable export intent is accepted.
      await writer.commit(manifest, () => recordIntent({ ...receipt, state: "exporting" }));
      await this.read({ ...resource, evidence: receipt });
      return receipt;
    } finally { await writer.abort(); }
  }

  async recover(resource: DisposableResource): Promise<ForgeResourceEvidence | undefined> {
    const archive = await this.readArchive(resource);
    if (!archive) return undefined;
    if (!resource.evidence?.manifestSha256 || sha256(JSON.stringify(archive.manifest)) !== resource.evidence.manifestSha256) throw new Error("Evidence archive does not match its durable export intent; review is required before releasing the environment.");
    const evidence: ForgeResourceEvidence = { ...resource.evidence, state: "verified", files: archive.manifest.files, bytes: archive.manifest.bytes, exportedAt: archive.manifest.exportedAt };
    await this.read({ ...resource, evidence });
    return evidence;
  }

  async read(resource: DisposableResource): Promise<EvidenceArchive> {
    const evidence = resource.evidence;
    if (evidence?.state !== "verified" || ![archivePath(resource.id), legacyArchivePath(resource.id)].includes(evidence.archivePath ?? "") || !evidence.manifestSha256) throw new Error("No verified durable evidence archive is available.");
    const archive = await this.readArchive(resource);
    if (!archive) throw new Error("The verified evidence archive is missing. The environment remains protected.");
    const manifest = archive.manifest;
    if (!manifest || sha256(JSON.stringify(manifest)) !== evidence.manifestSha256 || manifest.resourceId !== resource.id || manifest.engineId !== resource.engineId ||
      manifest.containerId !== resource.containerId || manifest.created !== resource.created || manifest.reason !== resource.retentionReason || JSON.stringify(manifest.owner) !== JSON.stringify(resource.owner) ||
      JSON.stringify(manifest.consumers) !== JSON.stringify(resource.consumers) || JSON.stringify(manifest.paths) !== JSON.stringify(evidence.paths) ||
      manifest.commitSha !== evidence.commitSha || manifest.commitSource !== evidence.commitSource || !Number.isFinite(Date.parse(manifest.exportedAt)) ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > maxEvidenceFiles || manifest.files.some(file => !selectedEvidenceKey(file.path, evidence.paths)))
      throw new Error("Evidence manifest does not match its ownership and export receipt.");
    if (JSON.stringify(manifest.files) !== JSON.stringify(evidence.files) || manifest.bytes !== evidence.bytes || manifest.exportedAt !== evidence.exportedAt ||
      manifest.bytes !== manifest.files.reduce((sum, file) => sum + file.bytes, 0)) throw new Error("Evidence archive size or file inventory changed.");
    if (archive.contents) verifyLegacyContents(archive);
    else await this.storage.verify(namespace, resource.id, manifest.files);
    return archive;
  }

  async fileStream(resource: DisposableResource, filePath: string) {
    const archive = await this.read(resource);
    if (!archive.manifest.files.some(file => file.path === filePath)) throw new Error("Unknown evidence file.");
    if (archive.contents) return Readable.from([Buffer.from(archive.contents[filePath]!, "base64")]);
    return this.storage.fileStream(namespace, resource.id, filePath);
  }

  private async readArchive(resource: DisposableResource): Promise<EvidenceArchive | undefined> {
    if (resource.evidence?.archivePath === legacyArchivePath(resource.id)) {
      const directory = path.resolve(this.dataDir, namespace);
      if (!await requireSafeDirectory(this.dataDir, directory, { create: false, label: "Forge evidence archive directory" })) return undefined;
      if (await fs.realpath(directory) !== directory) throw new Error("Forge evidence archive must not have symbolic-link parents.");
      const location = path.join(this.dataDir, legacyArchivePath(resource.id));
      const stat = await fs.lstat(location).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (!stat) return undefined;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > legacyMaxEvidenceBytes * 2 + 1_000_000) throw new Error("Legacy evidence archive must be a bounded regular file.");
      return new JsonStateFile(this.dataDir, legacyArchivePath(resource.id), "Forge container evidence").read<EvidenceArchive>();
    }
    const manifest = await this.storage.readManifest<ForgeEvidenceManifest>(namespace, resource.id);
    return manifest ? { manifest } : undefined;
  }
}

function verifyLegacyContents(archive: EvidenceArchive): void {
  let bytes = 0;
  const keys = new Set<string>();
  for (const file of archive.manifest.files) {
    if (keys.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof archive.contents![file.path] !== "string") throw new Error("Evidence file manifest is invalid.");
    keys.add(file.path);
    const data = Buffer.from(archive.contents![file.path]!, "base64");
    bytes += data.length;
    if (data.length !== file.bytes || sha256(data) !== file.sha256 || bytes > legacyMaxEvidenceBytes) throw new Error("Durable evidence verification failed; the environment remains protected.");
  }
  if (bytes !== archive.manifest.bytes || keys.size !== Object.keys(archive.contents!).length) throw new Error("Evidence archive size or file inventory changed.");
}
function generatedEvidencePath(value: string): boolean { return isGeneratedForgePath(value) || /(?:^|\/)[^/]+\.tsbuildinfo$/u.test(value); }
function selectedEvidenceKey(value: unknown, selections: string[]): value is string { return typeof value === "string" && value.length <= 4096 && validEvidencePaths([`/${value}`]) && selections.some(source => value === source.slice(1) || value.startsWith(`${source.slice(1)}/`)); }
function archivePath(id: string): string { validId(id); return `${namespace}/${id}/manifest.json`; }
function legacyArchivePath(id: string): string { validId(id); return `${namespace}/${id}.json`; }
function validId(id: string): void { if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error("Evidence resource identity is invalid."); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

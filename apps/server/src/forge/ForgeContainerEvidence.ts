import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Parser } from "tar";
import type { DisposableResource, ForgeEvidenceManifest, ForgeResourceEvidence } from "@cloudx/shared";
import { JsonStateFile, requireSafeDirectory } from "../jsonStateFile.js";
import { isGeneratedForgePath } from "./ForgeGeneratedArtifacts.js";

export interface ContainerEvidenceContent { path: string; data: Buffer }
const maxEvidenceBytes = 16 * 1024 * 1024;
const maxEvidenceFiles = 512;
interface EvidenceArchive { manifest: ForgeEvidenceManifest; contents: Record<string, string> }

export function validEvidencePaths(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= 32 && value.every(item =>
    typeof item === "string" && item.length <= 1024 && item.startsWith("/") && item !== "/" &&
    !item.includes("\\") && !/[\u0000-\u001f]/u.test(item) && path.posix.normalize(item) === item &&
    !item.endsWith("/") && !generatedEvidencePath(item) && !item.split("/").includes(".git")) &&
    value.every((item, index) => value.every((other, otherIndex) => index === otherIndex || item !== other && !item.startsWith(`${other}/`)));
}

/** The Docker archive is parsed as data; container paths never become host paths. */
export async function readContainerEvidenceTar(source: string, tar: Buffer): Promise<ContainerEvidenceContent[]> {
  if (!validEvidencePaths([source])) throw new Error("Evidence requires specific absolute container paths outside generated environments.");
  const result: ContainerEvidenceContent[] = [];
  const keys = new Set<string>();
  let bytes = 0;
  const root = path.posix.basename(source);
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true });
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.on("entry", entry => {
      const name = entry.path.replace(/^\.\//u, "").replace(/\/$/u, "");
      if (!name || name.includes("\\") || /[\u0000-\u001f]/u.test(name) || path.posix.isAbsolute(name) || path.posix.normalize(name) !== name || name.split("/")[0] !== root) {
        parser.abort(new Error("Container evidence archive contains an unsafe or unexpected path.")); return;
      }
      const filePath = source.slice(1) + name.slice(root.length);
      if (generatedEvidencePath(filePath) || filePath.split("/").includes(".git")) { entry.resume(); return; }
      if (entry.type === "Directory") { entry.resume(); return; }
      if (!["File", "OldFile"].includes(entry.type) || entry.linkpath || keys.has(filePath)) {
        parser.abort(new Error("Container evidence archive contains links, special files or duplicate paths.")); return;
      }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || bytes + entry.size > maxEvidenceBytes || keys.size >= maxEvidenceFiles) {
        parser.abort(new Error("Evidence exceeds the compact archive limit (16 MiB / 512 files); select narrower paths.")); return;
      }
      keys.add(filePath); bytes += entry.size;
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => { chunks.push(Buffer.from(chunk)); });
      entry.on("end", () => { result.push({ path: filePath, data: Buffer.concat(chunks) }); });
      entry.resume();
    });
    parser.end(tar);
  });
  return result;
}

export class ForgeContainerEvidence {
  constructor(private readonly dataDir: string) {}

  async export(resource: DisposableResource, contents: ContainerEvidenceContent[], recordIntent: (receipt: ForgeResourceEvidence) => Promise<void>): Promise<ForgeResourceEvidence> {
    const evidence = resource.evidence;
    if (!evidence || !validEvidencePaths(evidence.paths) || !resource.containerId || !resource.created) throw new Error("Evidence export requires exact source and container provenance.");
    const files = contents.sort((left, right) => left.path.localeCompare(right.path)).map(item => ({ path: item.path, bytes: item.data.length, sha256: sha256(item.data) }));
    const bytes = files.reduce((sum, item) => sum + item.bytes, 0);
    if (!files.length || files.length > maxEvidenceFiles || bytes > maxEvidenceBytes || new Set(files.map(item => item.path)).size !== files.length ||
      files.some(item => !safeEvidenceKey(item.path) || !evidence.paths.some(source => item.path === source.slice(1) || item.path.startsWith(`${source.slice(1)}/`))))
      throw new Error("Evidence export is empty, unsafe or exceeds the compact archive limit; select specific valuable files.");
    const manifest: ForgeEvidenceManifest = {
      resourceId: resource.id, owner: resource.owner, consumers: resource.consumers, engineId: resource.engineId,
      containerId: resource.containerId, created: resource.created, reason: resource.retentionReason, paths: evidence.paths,
      commitSha: evidence.commitSha, commitSource: evidence.commitSource, exportedAt: new Date().toISOString(), files, bytes,
    };
    const receipt: ForgeResourceEvidence = { ...evidence, state: "verified", archivePath: archivePath(resource.id), manifestSha256: sha256(JSON.stringify(manifest)), files, bytes, exportedAt: manifest.exportedAt };
    await recordIntent({ ...receipt, state: "exporting" });
    await this.file(resource.id, true);
    await new JsonStateFile(this.dataDir, archivePath(resource.id), "Forge container evidence", 0o600).write({ manifest, contents: Object.fromEntries(contents.map(item => [item.path, item.data.toString("base64")])) } satisfies EvidenceArchive);
    await this.read({ ...resource, evidence: receipt });
    return receipt;
  }

  async recover(resource: DisposableResource): Promise<ForgeResourceEvidence | undefined> {
    const archive = await this.readArchive(resource.id);
    if (!archive) return undefined;
    if (!resource.evidence?.manifestSha256 || sha256(JSON.stringify(archive.manifest)) !== resource.evidence.manifestSha256) throw new Error("Evidence archive does not match its durable export intent; review is required before releasing the environment.");
    const evidence: ForgeResourceEvidence = { ...resource.evidence!, state: "verified", archivePath: archivePath(resource.id), manifestSha256: sha256(JSON.stringify(archive.manifest)), files: archive.manifest.files, bytes: archive.manifest.bytes, exportedAt: archive.manifest.exportedAt };
    await this.read({ ...resource, evidence });
    return evidence;
  }

  async read(resource: DisposableResource): Promise<EvidenceArchive> {
    const evidence = resource.evidence;
    if (evidence?.state !== "verified" || evidence.archivePath !== archivePath(resource.id) || !evidence.manifestSha256) throw new Error("No verified durable evidence archive is available.");
    const archive = await this.readArchive(resource.id);
    if (!archive) throw new Error("The verified evidence archive is missing. The environment remains protected.");
    const manifest = archive.manifest;
    if (!manifest || sha256(JSON.stringify(manifest)) !== evidence.manifestSha256 || manifest.resourceId !== resource.id || manifest.engineId !== resource.engineId ||
      manifest.containerId !== resource.containerId || manifest.created !== resource.created || JSON.stringify(manifest.owner) !== JSON.stringify(resource.owner) ||
      JSON.stringify(manifest.consumers) !== JSON.stringify(resource.consumers) || JSON.stringify(manifest.paths) !== JSON.stringify(evidence.paths) ||
      manifest.commitSha !== evidence.commitSha || manifest.commitSource !== evidence.commitSource || !Number.isFinite(Date.parse(manifest.exportedAt)) ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > maxEvidenceFiles || typeof archive.contents !== "object" || !archive.contents)
      throw new Error("Evidence manifest does not match its ownership and export receipt.");
    let bytes = 0;
    const keys = new Set<string>();
    for (const file of manifest.files) {
      if (!safeEvidenceKey(file.path) || !evidence.paths.some(source => file.path === source.slice(1) || file.path.startsWith(`${source.slice(1)}/`)) ||
        keys.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof archive.contents[file.path] !== "string") throw new Error("Evidence file manifest is invalid.");
      keys.add(file.path);
      const data = Buffer.from(archive.contents[file.path]!, "base64");
      bytes += data.length;
      if (data.length !== file.bytes || sha256(data) !== file.sha256 || bytes > maxEvidenceBytes) throw new Error("Durable evidence verification failed; the environment remains protected.");
    }
    if (bytes !== manifest.bytes || keys.size !== Object.keys(archive.contents).length || JSON.stringify(manifest.files) !== JSON.stringify(evidence.files) ||
      manifest.bytes !== evidence.bytes || manifest.exportedAt !== evidence.exportedAt) throw new Error("Evidence archive size or file inventory changed.");
    return archive;
  }

  private async readArchive(resourceId: string): Promise<EvidenceArchive | undefined> {
    const location = await this.file(resourceId, false);
    if (!location) return undefined;
    const stat = await fs.lstat(location).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxEvidenceBytes * 2 + 1_000_000) throw new Error("Evidence archive must be a bounded regular file.");
    return new JsonStateFile(this.dataDir, archivePath(resourceId), "Forge container evidence").read<EvidenceArchive>();
  }

  private async file(resourceId: string, create: boolean): Promise<string | undefined> {
    const directory = path.resolve(this.dataDir, "forge-evidence");
    if (!await requireSafeDirectory(this.dataDir, directory, { create, label: "Forge evidence archive directory" })) return undefined;
    if (await fs.realpath(directory) !== directory) throw new Error("Forge evidence archive must not have symbolic-link parents.");
    return path.join(this.dataDir, archivePath(resourceId));
  }
}

function generatedEvidencePath(value: string): boolean { return isGeneratedForgePath(value) || /(?:^|\/)[^/]+\.tsbuildinfo$/u.test(value); }
function safeEvidenceKey(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && validEvidencePaths([`/${value}`]); }
function archivePath(id: string): string { if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error("Evidence resource identity is invalid."); return `forge-evidence/${id}.json`; }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

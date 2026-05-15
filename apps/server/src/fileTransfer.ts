import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

import type { WorkspaceTab } from "@cloudx/shared";

import type { PathPolicy } from "./pathPolicy.js";

export interface FileDownloadResult {
  filename: string;
  contentType: string;
  stream: NodeJS.ReadableStream;
  archive: boolean;
}

export interface FileUploadResult {
  path: string;
  relativePath: string;
  bytes: number;
  uploaded: true;
}

interface ResolvedTransferPath {
  resolvedPath: string;
  relativePath: string;
  stat: fs.Stats;
}

interface TarEntry {
  sourcePath: string;
  archivePath: string;
  stat: fs.Stats;
}

const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCKS = 2;
const FILE_BROWSER_PLUGIN_ID = "file-browser";

export class FileTransferService {
  constructor(private readonly pathPolicy: PathPolicy) {}

  async createDownload(tab: WorkspaceTab, relativePaths: unknown): Promise<FileDownloadResult> {
    this.requireFileBrowserTab(tab);
    const requestedPaths = parseRelativePaths(relativePaths);
    const entries = await Promise.all(requestedPaths.map((relativePath) => this.resolveExistingPath(tab, relativePath)));

    if (entries.length === 1 && entries[0]!.stat.isFile()) {
      const entry = entries[0]!;
      await this.requireRealPathUnderCwd(tab, entry.resolvedPath);
      return {
        filename: sanitizeDownloadFilename(path.basename(entry.resolvedPath) || "download"),
        contentType: "application/octet-stream",
        stream: fs.createReadStream(entry.resolvedPath),
        archive: false
      };
    }

    return {
      filename: archiveFilenameFor(tab, entries),
      contentType: "application/gzip",
      stream: Readable.from(this.createTar(entries.map((entry) => this.archiveEntryFor(tab, entry)))).pipe(createGzip()),
      archive: true
    };
  }

  async upload(tab: WorkspaceTab, relativePath: unknown, body: unknown): Promise<FileUploadResult> {
    this.requireFileBrowserTab(tab);
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error("relativePath is required.");
    }
    if (!Buffer.isBuffer(body)) {
      throw new Error("Upload body must be a binary buffer.");
    }
    const targetPath = this.resolvePathUnderCwd(tab, relativePath);
    if (relativeFor(tab, targetPath) === ".") {
      throw new Error("Upload target must be a file path.");
    }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await this.requireRealPathUnderCwd(tab, path.dirname(targetPath));
    const existing = await fsp.lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (existing?.isDirectory()) {
      throw new Error(`Upload target is a directory: ${targetPath}`);
    }
    if (existing?.isSymbolicLink()) {
      throw new Error(`Upload target is a symbolic link: ${targetPath}`);
    }
    await fsp.writeFile(targetPath, body);
    return {
      path: targetPath,
      relativePath: relativeFor(tab, targetPath),
      bytes: body.byteLength,
      uploaded: true
    };
  }

  private async resolveExistingPath(tab: WorkspaceTab, relativePath: string): Promise<ResolvedTransferPath> {
    const resolvedPath = this.resolvePathUnderCwd(tab, relativePath);
    const stat = await fsp.lstat(resolvedPath);
    if (stat.isFile() || stat.isDirectory()) {
      await this.requireRealPathUnderCwd(tab, resolvedPath);
    }
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error(`Unsupported file type: ${resolvedPath}`);
    }
    return {
      resolvedPath,
      relativePath: relativeFor(tab, resolvedPath),
      stat
    };
  }

  private resolvePathUnderCwd(tab: WorkspaceTab, requestedPath: string): string {
    const trimmed = requestedPath.trim();
    const resolvedPath = path.isAbsolute(trimmed) ? this.pathPolicy.resolve(trimmed) : this.pathPolicy.resolve(path.resolve(tab.cwd, trimmed || "."));
    const relativePath = path.relative(tab.cwd, resolvedPath);
    if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
      return resolvedPath;
    }
    throw new Error("File transfer path is outside the tab working directory.");
  }

  private async requireRealPathUnderCwd(tab: WorkspaceTab, candidate: string): Promise<void> {
    const [cwdRealPath, candidateRealPath] = await Promise.all([fsp.realpath(tab.cwd), fsp.realpath(candidate)]);
    const relativePath = path.relative(cwdRealPath, candidateRealPath);
    if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
      return;
    }
    throw new Error("File transfer path resolves outside the tab working directory.");
  }

  private archiveEntryFor(tab: WorkspaceTab, entry: ResolvedTransferPath): TarEntry {
    const archivePath = entry.relativePath === "." ? sanitizeArchivePath(path.basename(tab.cwd) || "files") : sanitizeArchivePath(entry.relativePath);
    return {
      sourcePath: entry.resolvedPath,
      archivePath,
      stat: entry.stat
    };
  }

  private async *createTar(entries: TarEntry[]): AsyncGenerator<Buffer> {
    for (const entry of entries) {
      yield* this.appendTarEntry(entry.sourcePath, entry.archivePath, entry.stat);
    }
    yield Buffer.alloc(TAR_BLOCK_SIZE * TAR_END_BLOCKS);
  }

  private async *appendTarEntry(sourcePath: string, archivePath: string, stat: fs.Stats): AsyncGenerator<Buffer> {
    if (stat.isDirectory()) {
      const directoryArchivePath = archivePath.endsWith("/") ? archivePath : `${archivePath}/`;
      yield createTarHeader(directoryArchivePath, stat, "5");
      const children = await fsp.readdir(sourcePath, { withFileTypes: true });
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        const childPath = path.join(sourcePath, child.name);
        const childStat = await fsp.lstat(childPath);
        yield* this.appendTarEntry(childPath, `${archivePath}/${child.name}`, childStat);
      }
      return;
    }

    if (stat.isSymbolicLink()) {
      const linkName = await fsp.readlink(sourcePath);
      yield createTarHeader(archivePath, stat, "2", linkName);
      return;
    }

    if (!stat.isFile()) {
      throw new Error(`Unsupported file type: ${sourcePath}`);
    }

    yield createTarHeader(archivePath, stat, "0");
    for await (const chunk of fs.createReadStream(sourcePath)) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    const padding = tarPadding(stat.size);
    if (padding > 0) {
      yield Buffer.alloc(padding);
    }
  }

  private requireFileBrowserTab(tab: WorkspaceTab): void {
    if (tab.pluginId !== FILE_BROWSER_PLUGIN_ID) {
      throw new Error(`File transfers are only available for ${FILE_BROWSER_PLUGIN_ID} tabs.`);
    }
  }
}

export function contentDispositionAttachment(filename: string): string {
  const fallback = sanitizeDownloadFilename(filename).replace(/"/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function parseRelativePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("relativePaths must be a non-empty array.");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`relativePaths[${index}] must be a string.`);
    }
    return entry.trim() || ".";
  });
}

function relativeFor(tab: WorkspaceTab, resolvedPath: string): string {
  const relativePath = path.relative(tab.cwd, resolvedPath).split(path.sep).filter(Boolean).join("/");
  return relativePath || ".";
}

function archiveFilenameFor(tab: WorkspaceTab, entries: ResolvedTransferPath[]): string {
  if (entries.length === 1) {
    const entry = entries[0]!;
    const basename = entry.relativePath === "." ? path.basename(tab.cwd) : path.basename(entry.resolvedPath);
    return `${sanitizeDownloadFilename(basename || "files")}.tar.gz`;
  }
  return "cloudx-files.tar.gz";
}

function sanitizeDownloadFilename(value: string): string {
  const cleaned = value.trim().replace(/[\\/:*?"<>|\r\n]+/g, "_");
  if (!cleaned || /^\.+$/.test(cleaned)) {
    return "files";
  }
  return cleaned;
}

function sanitizeArchivePath(value: string): string {
  const normalized = value
    .split(/[\\/]+/)
    .filter((part) => part && part !== ".")
    .join("/");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid archive path: ${value}`);
  }
  return normalized;
}

function createTarHeader(name: string, stat: fs.Stats, typeflag: "0" | "2" | "5", linkName = ""): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const pathFields = splitUstarPath(name);
  writeString(header, 0, 100, pathFields.name);
  writeOctal(header, 100, 8, stat.mode & 0o7777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, typeflag === "0" ? stat.size : 0);
  writeOctal(header, 136, 12, Math.floor(stat.mtimeMs / 1000));
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, typeflag);
  if (linkName) {
    writeString(header, 157, 100, linkName);
  }
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "cloudx");
  writeString(header, 297, 32, "cloudx");
  writeString(header, 345, 155, pathFields.prefix);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeChecksum(header, checksum);
  return header;
}

function splitUstarPath(entryPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(entryPath) <= 100) {
    return { name: entryPath, prefix: "" };
  }
  const separators = [...entryPath.matchAll(/\//g)].map((match) => match.index).filter((index): index is number => index !== undefined);
  for (const separator of separators.reverse()) {
    const prefix = entryPath.slice(0, separator);
    const name = entryPath.slice(separator + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Archive path is too long for ustar: ${entryPath}`);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value);
  if (encoded.byteLength > length) {
    throw new Error(`Value is too long for tar header field: ${value}`);
  }
  encoded.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const octal = Math.trunc(value).toString(8);
  if (octal.length > length - 1) {
    throw new Error(`Value is too large for tar header field: ${value}`);
  }
  writeString(buffer, offset, length, octal.padStart(length - 1, "0"));
}

function writeChecksum(buffer: Buffer, checksum: number): void {
  const octal = checksum.toString(8);
  if (octal.length > 6) {
    throw new Error(`Checksum is too large for tar header field: ${checksum}`);
  }
  writeString(buffer, 148, 6, octal.padStart(6, "0"));
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function tarPadding(size: number): number {
  const remainder = size % TAR_BLOCK_SIZE;
  return remainder === 0 ? 0 : TAR_BLOCK_SIZE - remainder;
}

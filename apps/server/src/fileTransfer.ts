import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

import type { WorkspaceTab } from "@cloudx/shared";

import { isSameOrChildPath } from "./pathBoundary.js";
import type { PathPolicy } from "./pathPolicy.js";

export interface FileDownloadResult {
  filename: string;
  contentType: string;
  stream: NodeJS.ReadableStream;
  archive: boolean;
}

export interface RawFileResult {
  contentType: string;
  stream: NodeJS.ReadableStream;
}

export interface FileUploadResult {
  path: string;
  relativePath: string;
  bytes: number;
  uploaded: true;
}

export interface FileUploadOptions {
  maxBytes?: number;
}

interface OpenTransferFile {
  stat: fs.Stats;
  stream: fs.ReadStream;
}

export class FileUploadTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(readonly maxBytes: number) {
    super(`Upload exceeds the maximum size of ${formatBytes(maxBytes)}.`);
    this.name = "FileUploadTooLargeError";
  }
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
const SYMLINK_DOWNLOAD_ERROR = "Symbolic links are not supported for file downloads.";

export class FileTransferService {
  constructor(private readonly pathPolicy: PathPolicy) {}

  async createDownload(tab: WorkspaceTab, relativePaths: unknown): Promise<FileDownloadResult> {
    this.requireFileBrowserTab(tab);
    const requestedPaths = parseRelativePaths(relativePaths);
    const entries = await Promise.all(requestedPaths.map((relativePath) => this.resolveExistingPath(tab, relativePath)));

    if (entries.length === 1 && entries[0]!.stat.isFile()) {
      const entry = entries[0]!;
      await this.requireRealPathUnderCwd(tab, entry.resolvedPath);
      const file = await openTransferFileNoFollow(entry.resolvedPath, entry.stat);
      return {
        filename: sanitizeDownloadFilename(path.basename(entry.resolvedPath) || "download"),
        contentType: "application/octet-stream",
        stream: file.stream,
        archive: false
      };
    }

    const archiveEntries = (await Promise.all(entries.map((entry) => this.archiveEntriesFor(tab, entry)))).flat();
    return {
      filename: archiveFilenameFor(tab, entries),
      contentType: "application/gzip",
      stream: gzipTarStream(this.createTar(archiveEntries)),
      archive: true
    };
  }

  async createRawFile(tab: WorkspaceTab, relativePath: unknown): Promise<RawFileResult> {
    this.requireFileBrowserTab(tab);
    const entry = await this.resolveExistingPath(tab, parseRelativePath(relativePath, "relativePath"));
    if (!entry.stat.isFile()) {
      throw new Error(`Raw file target is not a file: ${entry.resolvedPath}`);
    }
    await this.requireRealPathUnderCwd(tab, entry.resolvedPath);
    const file = await openTransferFileNoFollow(entry.resolvedPath, entry.stat);
    return {
      contentType: inlineContentTypeForPath(entry.resolvedPath),
      stream: file.stream
    };
  }

  async upload(tab: WorkspaceTab, relativePath: unknown, body: unknown, options: FileUploadOptions = {}): Promise<FileUploadResult> {
    this.requireFileBrowserTab(tab);
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error("relativePath is required.");
    }
    const bodyStream = uploadBodyStream(body);
    if (Buffer.isBuffer(body) && options.maxBytes !== undefined && body.byteLength > options.maxBytes) {
      throw new FileUploadTooLargeError(options.maxBytes);
    }
    const targetPath = this.resolvePathUnderCwd(tab, relativePath);
    if (relativeFor(tab, targetPath) === ".") {
      throw new Error("Upload target must be a file path.");
    }
    const targetDir = path.dirname(targetPath);
    await this.requireUploadParentCanBeCreatedUnderCwd(tab, targetDir);
    await fsp.mkdir(targetDir, { recursive: true });
    await this.requireRealPathUnderCwd(tab, targetDir);
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
    const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.cloudx-upload-${randomUUID()}.tmp`);
    const bytes = await writeUploadStream(tempPath, bodyStream, options);
    try {
      await fsp.rename(tempPath, targetPath);
    } catch (error) {
      await removeFileIfPresent(tempPath);
      throw error;
    }
    return {
      path: targetPath,
      relativePath: relativeFor(tab, targetPath),
      bytes,
      uploaded: true
    };
  }

  private async resolveExistingPath(tab: WorkspaceTab, relativePath: string): Promise<ResolvedTransferPath> {
    const resolvedPath = this.resolvePathUnderCwd(tab, relativePath);
    const stat = await fsp.lstat(resolvedPath);
    await this.requireDownloadablePath(tab, resolvedPath, stat);
    return {
      resolvedPath,
      relativePath: relativeFor(tab, resolvedPath),
      stat
    };
  }

  private async requireDownloadablePath(tab: WorkspaceTab, sourcePath: string, stat: fs.Stats): Promise<void> {
    if (stat.isSymbolicLink()) {
      throw new Error(SYMLINK_DOWNLOAD_ERROR);
    }
    if (stat.isFile() || stat.isDirectory()) {
      await this.requireRealPathUnderCwd(tab, sourcePath);
    }
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error(`Unsupported file type: ${sourcePath}`);
    }
  }

  private resolvePathUnderCwd(tab: WorkspaceTab, requestedPath: string): string {
    const trimmed = requestedPath.trim();
    const resolvedPath = path.isAbsolute(trimmed) ? this.pathPolicy.resolve(trimmed) : this.pathPolicy.resolve(path.resolve(tab.cwd, trimmed || "."));
    if (isSameOrChildPath(tab.cwd, resolvedPath)) {
      return resolvedPath;
    }
    throw new Error("File transfer path is outside the tab working directory.");
  }

  private async requireRealPathUnderCwd(tab: WorkspaceTab, candidate: string): Promise<void> {
    const [cwdRealPath, candidateRealPath] = await Promise.all([fsp.realpath(tab.cwd), fsp.realpath(candidate)]);
    if (isSameOrChildPath(cwdRealPath, candidateRealPath)) {
      return;
    }
    throw new Error("File transfer path resolves outside the tab working directory.");
  }

  private async requireUploadParentCanBeCreatedUnderCwd(tab: WorkspaceTab, targetDir: string): Promise<void> {
    let current = targetDir;
    for (;;) {
      const stat = await fsp.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
      if (stat) {
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          throw new Error(`Upload parent path is not a directory: ${current}`);
        }
        await this.requireRealPathUnderCwd(tab, current);
        return;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Upload parent path does not exist: ${targetDir}`);
      }
      current = parent;
    }
  }

  private async archiveEntriesFor(tab: WorkspaceTab, entry: ResolvedTransferPath): Promise<TarEntry[]> {
    const archivePath = entry.relativePath === "." ? sanitizeArchivePath(path.basename(tab.cwd) || "files") : sanitizeArchivePath(entry.relativePath);
    return this.snapshotTarEntries(tab, entry.resolvedPath, archivePath);
  }

  private async snapshotTarEntries(tab: WorkspaceTab, sourcePath: string, archivePath: string): Promise<TarEntry[]> {
    const stat = await fsp.lstat(sourcePath);
    await this.requireDownloadablePath(tab, sourcePath, stat);
    const entry: TarEntry = {
      sourcePath,
      archivePath,
      stat
    };
    if (!stat.isDirectory()) {
      return [entry];
    }
    const children = await fsp.readdir(sourcePath, { withFileTypes: true });
    const childEntries: TarEntry[] = [];
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      childEntries.push(...await this.snapshotTarEntries(tab, path.join(sourcePath, child.name), `${archivePath}/${child.name}`));
    }
    return [entry, ...childEntries];
  }

  private async *createTar(entries: TarEntry[]): AsyncGenerator<Buffer> {
    for (const entry of entries) {
      yield* this.appendTarEntry(entry);
    }
    yield Buffer.alloc(TAR_BLOCK_SIZE * TAR_END_BLOCKS);
  }

  private async *appendTarEntry(entry: TarEntry): AsyncGenerator<Buffer> {
    if (entry.stat.isDirectory()) {
      const directoryArchivePath = entry.archivePath.endsWith("/") ? entry.archivePath : `${entry.archivePath}/`;
      yield createTarHeader(directoryArchivePath, entry.stat, "5");
      return;
    }

    if (entry.stat.isSymbolicLink()) {
      throw new Error(SYMLINK_DOWNLOAD_ERROR);
    }

    if (!entry.stat.isFile()) {
      throw new Error(`Unsupported file type: ${entry.sourcePath}`);
    }

    const file = await openTransferFileNoFollow(entry.sourcePath, entry.stat);
    try {
      yield createTarHeader(entry.archivePath, file.stat, "0");
      for await (const chunk of file.stream) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
      const padding = tarPadding(file.stat.size);
      if (padding > 0) {
        yield Buffer.alloc(padding);
      }
    } finally {
      file.stream.destroy();
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
  return value.map((entry, index) => parseRelativePath(entry, `relativePaths[${index}]`));
}

function parseRelativePath(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value.trim() || ".";
}

function uploadBodyStream(body: unknown): AsyncIterable<Buffer | Uint8Array | string> {
  if (Buffer.isBuffer(body)) {
    return Readable.from([body]);
  }
  if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    return body as AsyncIterable<Buffer | Uint8Array | string>;
  }
  throw new Error("Upload body must be a binary stream.");
}

async function openTransferFileNoFollow(filePath: string, expectedStat?: fs.Stats): Promise<OpenTransferFile> {
  const file = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch((error) => {
    if (isSymbolicLinkOpenError(error)) {
      throw new Error(SYMLINK_DOWNLOAD_ERROR);
    }
    throw error;
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error(`Transfer target is not a file: ${filePath}`);
    }
    if (expectedStat && !sameFilesystemObject(stat, expectedStat)) {
      throw new Error(`Transfer target changed during download: ${filePath}`);
    }
    return {
      stat,
      stream: file.createReadStream()
    };
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

function sameFilesystemObject(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function gzipTarStream(chunks: AsyncIterable<Buffer>): NodeJS.ReadableStream {
  const source = Readable.from(chunks);
  const gzip = createGzip();
  source.on("error", (error) => {
    gzip.destroy(error);
  });
  return source.pipe(gzip);
}

async function writeUploadStream(sourcePath: string, body: AsyncIterable<Buffer | Uint8Array | string>, options: FileUploadOptions): Promise<number> {
  const stream = fs.createWriteStream(sourcePath, { flags: "wx" });
  let bytes = 0;
  let writeError: Error | undefined;
  stream.on("error", (error) => {
    writeError = error;
  });
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (options.maxBytes !== undefined && bytes > options.maxBytes) {
        throw new FileUploadTooLargeError(options.maxBytes);
      }
      await writeStreamChunk(stream, buffer);
      if (writeError) {
        throw writeError;
      }
    }
    await closeWriteStream(stream);
    return bytes;
  } catch (error) {
    await destroyWriteStream(stream);
    await removeFileIfPresent(sourcePath);
    throw error;
  }
}

async function writeStreamChunk(stream: fs.WriteStream, buffer: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(buffer, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function closeWriteStream(stream: fs.WriteStream): Promise<void> {
  if (stream.closed) {
    return;
  }
  stream.end();
  await once(stream, "close");
}

async function destroyWriteStream(stream: fs.WriteStream): Promise<void> {
  if (stream.closed) {
    return;
  }
  stream.destroy();
  await once(stream, "close");
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  await fsp.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${bytes / 1024 ** 3} GiB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${bytes / 1024 ** 2} MiB`;
  }
  return `${bytes} bytes`;
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

function inlineContentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".gif":
      return "image/gif";
    case ".ico":
    case ".cur":
      return "image/x-icon";
    case ".jpg":
    case ".jpeg":
    case ".jfif":
    case ".pjpeg":
    case ".pjp":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".svg":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function createTarHeader(name: string, stat: fs.Stats, typeflag: "0" | "5"): Buffer {
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
    if (!name) {
      continue;
    }
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

function isSymbolicLinkOpenError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "EMLINK";
}

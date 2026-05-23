import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { extract as extractTar } from "tar";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import { isSameOrChildPath } from "../pathBoundary.js";

export type ArchiveExtractionDestination = "here" | "folder";
export type ArchiveKind = "zip" | "tar";

export interface ArchiveExtractionInput {
  cwd: string;
  archivePath: string;
  destination: ArchiveExtractionDestination;
}

export interface ArchiveExtractionLimits {
  maxEntryCount: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export interface ArchiveExtractionServiceOptions {
  limits?: Partial<ArchiveExtractionLimits>;
}

export interface ArchiveExtractionResult {
  archivePath: string;
  archiveRelativePath: string;
  destinationPath: string;
  destinationRelativePath: string;
  extracted: true;
}

const TEMP_EXTRACT_PREFIX = ".cloudx-extract-";
const DEFAULT_ARCHIVE_MAX_BYTES = 25 * 1024 * 1024 * 1024;
const DEFAULT_ARCHIVE_MAX_ENTRY_COUNT = 100_000;
export const DEFAULT_ARCHIVE_EXTRACTION_LIMITS: ArchiveExtractionLimits = {
  maxEntryCount: DEFAULT_ARCHIVE_MAX_ENTRY_COUNT,
  maxEntryBytes: DEFAULT_ARCHIVE_MAX_BYTES,
  maxTotalBytes: DEFAULT_ARCHIVE_MAX_BYTES
};
const SUPPORTED_TAR_ENTRY_TYPES = new Set(["File", "OldFile", "ContiguousFile", "Directory", "GNUDumpDir"]);
const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_REGULAR_FILE_TYPE = 0o100000;
const ZIP_UNIX_DIRECTORY_FILE_TYPE = 0o040000;
const SUPPORTED_ZIP_UNIX_FILE_TYPES = new Set([ZIP_UNIX_REGULAR_FILE_TYPE, ZIP_UNIX_DIRECTORY_FILE_TYPE]);

export class ArchiveExtractionService {
  private readonly limits: ArchiveExtractionLimits;

  constructor(options: ArchiveExtractionServiceOptions = {}) {
    this.limits = archiveExtractionLimits(options.limits);
  }

  async extract(input: ArchiveExtractionInput): Promise<ArchiveExtractionResult> {
    const kind = archiveKindForPath(input.archivePath);
    if (!kind) {
      throw new Error(`Unsupported archive type: ${input.archivePath}`);
    }
    const archiveLinkStat = await fs.lstat(input.archivePath);
    if (archiveLinkStat.isSymbolicLink()) {
      throw new Error(`Archive target is a symbolic link: ${input.archivePath}`);
    }
    const archiveStat = await fs.stat(input.archivePath);
    if (!archiveStat.isFile()) {
      throw new Error(`Archive target is not a file: ${input.archivePath}`);
    }

    const parentDirectory = path.dirname(input.archivePath);
    const cwdRealPath = await fs.realpath(input.cwd);
    const archiveRealPath = await fs.realpath(input.archivePath);
    requirePathUnder(cwdRealPath, archiveRealPath, "Archive path is outside the tab working directory.");
    const parentRealPath = await fs.realpath(parentDirectory);
    requirePathUnder(cwdRealPath, parentRealPath, "Archive parent directory is outside the tab working directory.");

    const destinationPath = input.destination === "folder" ? path.join(parentRealPath, archiveExtractionFolderName(input.archivePath)) : parentRealPath;
    requirePathUnder(cwdRealPath, destinationPath, "Extraction destination is outside the tab working directory.");
    if (input.destination === "folder" && (await pathExists(destinationPath))) {
      throw new Error(`Extraction destination already exists: ${destinationPath}`);
    }

    const tempDirectory = await fs.mkdtemp(path.join(parentRealPath, TEMP_EXTRACT_PREFIX));
    const limitTracker = new ArchiveExtractionLimitTracker(this.limits);
    try {
      if (kind === "zip") {
        await this.extractZip(input.archivePath, tempDirectory, limitTracker);
      } else {
        await this.extractTar(input.archivePath, tempDirectory, limitTracker);
      }

      if (input.destination === "folder") {
        await fs.rename(tempDirectory, destinationPath);
      } else {
        await mergeExtractedDirectory(tempDirectory, destinationPath);
        await removeDirectoryIfPresent(tempDirectory);
      }

      return {
        archivePath: input.archivePath,
        archiveRelativePath: relativeFor(cwdRealPath, input.archivePath),
        destinationPath,
        destinationRelativePath: relativeFor(cwdRealPath, destinationPath),
        extracted: true
      };
    } catch (error) {
      await removeDirectoryIfPresent(tempDirectory);
      throw error;
    }
  }

  private async extractZip(archivePath: string, destinationPath: string, limitTracker: ArchiveExtractionLimitTracker): Promise<void> {
    const zipFile = await openZipFile(archivePath);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        zipFile.close();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      zipFile.on("error", (error) => finish(error));
      zipFile.on("close", () => finish());
      zipFile.on("entry", (entry: Entry) => {
        void (async () => {
          try {
            if (!entry.fileName.startsWith("__MACOSX/")) {
              const safePath = trackZipEntry(entry, limitTracker);
              await extractZipEntry(zipFile, entry, safePath, destinationPath);
            }
            zipFile.readEntry();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
      zipFile.readEntry();
    });
  }

  private async extractTar(archivePath: string, destinationPath: string, limitTracker: ArchiveExtractionLimitTracker): Promise<void> {
    let policyError: Error | undefined;
    await extractTar({
      file: archivePath,
      cwd: destinationPath,
      preservePaths: false,
      strict: true,
      filter: (entryPath, entry) => {
        if (policyError) {
          return false;
        }
        policyError = tarEntryPolicyError(entryPath, entry, limitTracker);
        return !policyError;
      }
    });
    if (policyError) {
      throw policyError;
    }
  }
}

function tarEntryPolicyError(entryPath: string, entry: { type?: unknown; size?: unknown }, limitTracker: ArchiveExtractionLimitTracker): Error | undefined {
  try {
    const safePath = safeArchiveEntryPath(entryPath);
    if (typeof entry.type !== "string" || !SUPPORTED_TAR_ENTRY_TYPES.has(entry.type)) {
      return new Error(`Archive entry type is not supported: ${entryPath}`);
    }
    limitTracker.track(safePath, entry.size);
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    return new Error(String(error));
  }
}

export function archiveKindForPath(filePath: string): ArchiveKind | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  if (lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar";
  }
  return undefined;
}

export function archiveExtractionFolderName(filePath: string): string {
  const baseName = path.basename(filePath);
  return baseName.replace(/\.tar\.gz$/iu, "").replace(/\.tgz$/iu, "").replace(/\.(zip|tar)$/iu, "") || "archive";
}

function safeArchiveEntryPath(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) || normalized.split("/").includes("..") || parts.length === 0) {
    throw new Error(`Archive entry path is outside the extraction destination: ${entryPath}`);
  }
  return parts.join("/");
}

function zipEntryHasSupportedType(externalFileAttributes: number): boolean {
  const mode = (externalFileAttributes >>> 16) & 0xffff;
  const fileType = mode & ZIP_UNIX_FILE_TYPE_MASK;
  return fileType === 0 || SUPPORTED_ZIP_UNIX_FILE_TYPES.has(fileType);
}

function trackZipEntry(entry: Pick<Entry, "fileName" | "externalFileAttributes" | "uncompressedSize">, limitTracker: ArchiveExtractionLimitTracker): string {
  const safePath = safeArchiveEntryPath(entry.fileName);
  if (!zipEntryHasSupportedType(entry.externalFileAttributes)) {
    throw new Error(`Archive entry type is not supported: ${entry.fileName}`);
  }
  limitTracker.track(safePath, entry.uncompressedSize);
  return safePath;
}

async function extractZipEntry(zipFile: ZipFile, entry: Entry, safePath: string, destinationPath: string): Promise<void> {
  const targetPath = path.join(destinationPath, safePath);
  const directory = zipEntryIsDirectory(entry);
  if (directory) {
    await fs.mkdir(targetPath, { recursive: true, mode: zipEntryMode(entry, true) });
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const readStream = await openZipReadStream(zipFile, entry);
  await pipeline(readStream, fsSync.createWriteStream(targetPath, { flags: "wx", mode: zipEntryMode(entry, false) }));
}

function zipEntryIsDirectory(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = mode & ZIP_UNIX_FILE_TYPE_MASK;
  const platform = entry.versionMadeBy >>> 8;
  return fileType === ZIP_UNIX_DIRECTORY_FILE_TYPE || entry.fileName.endsWith("/") || (platform === 0 && entry.externalFileAttributes === 16);
}

function zipEntryMode(entry: Entry, directory: boolean): number {
  const mode = ((entry.externalFileAttributes >>> 16) & 0xffff) & 0o777;
  return mode || (directory ? 0o755 : 0o644);
}

function openZipReadStream(zipFile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, readStream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!readStream) {
        reject(new Error(`Unable to read zip archive entry: ${entry.fileName}`));
        return;
      }
      resolve(readStream);
    });
  });
}

function openZipFile(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      if (!zipFile) {
        reject(new Error(`Unable to open zip archive: ${archivePath}`));
        return;
      }
      resolve(zipFile);
    });
  });
}

class ArchiveExtractionLimitTracker {
  private entryCount = 0;
  private totalBytes = 0;
  private readonly seenPaths = new Set<string>();

  constructor(private readonly limits: ArchiveExtractionLimits) {}

  track(safeEntryPath: string, sizeValue: unknown): void {
    this.entryCount += 1;
    if (this.entryCount > this.limits.maxEntryCount) {
      throw new Error(`Archive contains more than ${this.limits.maxEntryCount} entries.`);
    }
    if (this.seenPaths.has(safeEntryPath)) {
      throw new Error(`Archive contains a duplicate entry path: ${safeEntryPath}`);
    }
    this.seenPaths.add(safeEntryPath);

    const entryBytes = requireArchiveEntrySize(safeEntryPath, sizeValue);
    if (entryBytes > this.limits.maxEntryBytes) {
      throw new Error(`Archive entry exceeds the maximum size of ${this.limits.maxEntryBytes} bytes: ${safeEntryPath}`);
    }

    this.totalBytes += entryBytes;
    if (this.totalBytes > this.limits.maxTotalBytes) {
      throw new Error(`Archive exceeds the maximum extracted size of ${this.limits.maxTotalBytes} bytes.`);
    }
  }
}

function archiveExtractionLimits(limits: Partial<ArchiveExtractionLimits> = {}): ArchiveExtractionLimits {
  return {
    maxEntryCount: requirePositiveSafeInteger(limits.maxEntryCount ?? DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxEntryCount, "maxEntryCount"),
    maxEntryBytes: requirePositiveSafeInteger(limits.maxEntryBytes ?? DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxEntryBytes, "maxEntryBytes"),
    maxTotalBytes: requirePositiveSafeInteger(limits.maxTotalBytes ?? DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxTotalBytes, "maxTotalBytes")
  };
}

function requireArchiveEntrySize(entryPath: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Archive entry has invalid size metadata: ${entryPath}`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Archive extraction limit ${field} must be a positive safe integer.`);
  }
  return value;
}

async function mergeExtractedDirectory(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  await fs.mkdir(destinationDirectory, { recursive: true });
  await assertNoMergeConflicts(sourceDirectory, destinationDirectory);
  for (const entry of await fs.readdir(sourceDirectory, { withFileTypes: true })) {
    await moveExtractedEntry(path.join(sourceDirectory, entry.name), path.join(destinationDirectory, entry.name));
  }
}

async function assertNoMergeConflicts(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceStat = await fs.lstat(sourcePath);
  const destinationStat = await fs.lstat(destinationPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Archive entry type is not supported: ${sourcePath}`);
  }
  if (!sourceStat.isDirectory()) {
    if (destinationStat) {
      throw new Error(`Extraction target already exists: ${destinationPath}`);
    }
    return;
  }
  if (destinationStat && !destinationStat.isDirectory()) {
    throw new Error(`Extraction target already exists: ${destinationPath}`);
  }
  for (const entry of await fs.readdir(sourcePath)) {
    await assertNoMergeConflicts(path.join(sourcePath, entry), path.join(destinationPath, entry));
  }
}

async function moveExtractedEntry(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceStat = await fs.lstat(sourcePath);
  if (!sourceStat.isDirectory()) {
    await fs.rename(sourcePath, destinationPath);
    return;
  }
  if (!(await pathExists(destinationPath))) {
    await fs.rename(sourcePath, destinationPath);
    return;
  }
  for (const entry of await fs.readdir(sourcePath)) {
    await moveExtractedEntry(path.join(sourcePath, entry), path.join(destinationPath, entry));
  }
  await fs.rmdir(sourcePath);
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs
    .lstat(filePath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}

async function removeDirectoryIfPresent(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

function requirePathUnder(root: string, candidate: string, message: string): void {
  if (isSameOrChildPath(root, candidate)) {
    return;
  }
  throw new Error(message);
}

function relativeFor(root: string, candidate: string): string {
  const relative = path.relative(root, fsSync.realpathSync.native(candidate));
  return relative ? relative.split(path.sep).join("/") : ".";
}

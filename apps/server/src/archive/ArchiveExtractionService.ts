import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import extractZip from "extract-zip";
import { extract as extractTar } from "tar";

export type ArchiveExtractionDestination = "here" | "folder";
export type ArchiveKind = "zip" | "tar";

export interface ArchiveExtractionInput {
  cwd: string;
  archivePath: string;
  destination: ArchiveExtractionDestination;
}

export interface ArchiveExtractionResult {
  archivePath: string;
  archiveRelativePath: string;
  destinationPath: string;
  destinationRelativePath: string;
  extracted: true;
}

const TEMP_EXTRACT_PREFIX = ".cloudx-extract-";
const UNSUPPORTED_TAR_ENTRY_TYPES = new Set(["Link", "SymbolicLink", "CharacterDevice", "BlockDevice", "FIFO"]);

export class ArchiveExtractionService {
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
    try {
      if (kind === "zip") {
        await this.extractZip(input.archivePath, tempDirectory);
      } else {
        await this.extractTar(input.archivePath, tempDirectory);
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

  private async extractZip(archivePath: string, destinationPath: string): Promise<void> {
    await extractZip(archivePath, {
      dir: destinationPath,
      onEntry: (entry) => {
        assertSafeArchiveEntryPath(entry.fileName);
        if (zipEntryIsSymlink(entry.externalFileAttributes)) {
          throw new Error(`Archive entry type is not supported: ${entry.fileName}`);
        }
      }
    });
  }

  private async extractTar(archivePath: string, destinationPath: string): Promise<void> {
    await extractTar({
      file: archivePath,
      cwd: destinationPath,
      preservePaths: false,
      strict: true,
      filter: (entryPath, entry) => {
        assertSafeArchiveEntryPath(entryPath);
        if ("type" in entry && typeof entry.type === "string" && UNSUPPORTED_TAR_ENTRY_TYPES.has(entry.type)) {
          throw new Error(`Archive entry type is not supported: ${entryPath}`);
        }
        return true;
      }
    });
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

function assertSafeArchiveEntryPath(entryPath: string): void {
  const normalized = entryPath.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Archive entry path is outside the extraction destination: ${entryPath}`);
  }
}

function zipEntryIsSymlink(externalFileAttributes: number): boolean {
  const mode = (externalFileAttributes >> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
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
    .access(filePath)
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
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(message);
}

function relativeFor(root: string, candidate: string): string {
  const relative = path.relative(root, fsSync.realpathSync.native(candidate));
  return relative ? relative.split(path.sep).join("/") : ".";
}

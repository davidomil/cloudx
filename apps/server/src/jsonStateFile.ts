import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { isSameOrChildPath } from "./pathBoundary.js";

interface DirectoryOptions {
  create: boolean;
  label: string;
}

export class JsonStateFile {
  readonly rootPath: string;
  readonly filePath: string;

  constructor(
    rootDir: string,
    fileName: string,
    private readonly label: string
  ) {
    this.rootPath = path.resolve(rootDir);
    this.filePath = path.join(this.rootPath, fileName);
  }

  async read<T>(): Promise<T | undefined> {
    if (!(await requireSafeDirectory(this.rootPath, path.dirname(this.filePath), { create: false, label: `${this.label} directory` }))) {
      return undefined;
    }
    if (!(await requireRegularFile(this.filePath, `${this.label} file`))) {
      return undefined;
    }
    return JSON.parse(await readTextFileNoFollow(this.filePath, `${this.label} file`)) as T;
  }

  readSync<T>(): T | undefined {
    if (!requireSafeDirectorySync(this.rootPath, path.dirname(this.filePath), { create: false, label: `${this.label} directory` })) {
      return undefined;
    }
    if (!requireRegularFileSync(this.filePath, `${this.label} file`)) {
      return undefined;
    }
    return JSON.parse(readTextFileNoFollowSync(this.filePath, `${this.label} file`)) as T;
  }

  async write(value: unknown): Promise<void> {
    await writeTextFileAtomic(this.rootPath, this.filePath, stringifyJsonDocument(value, `${this.label} file`), `${this.label} file`);
  }
}

export function stringifyJsonDocument(value: unknown, label: string): string {
  const content = JSON.stringify(value, null, 2);
  if (content === undefined) {
    throw new Error(`${label} must be JSON-serializable.`);
  }
  return `${content}\n`;
}

export async function writeTextFileAtomic(rootPath: string, filePath: string, content: string, label: string): Promise<void> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedFile = path.resolve(filePath);
  const directory = path.dirname(resolvedFile);
  await requireSafeDirectory(resolvedRoot, directory, { create: true, label: `${label} directory` });
  await requireRegularFile(resolvedFile, label);
  const tempPath = path.join(directory, `${path.basename(resolvedFile)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await fsp.rename(tempPath, resolvedFile);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeNewTextFileNoFollow(rootPath: string, filePath: string, content: string, label: string): Promise<void> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedFile = path.resolve(filePath);
  const directory = path.dirname(resolvedFile);
  await requireSafeDirectory(resolvedRoot, directory, { create: true, label: `${label} directory` });
  if (await requireRegularFile(resolvedFile, label)) {
    throw new Error(`${label} already exists: ${resolvedFile}`);
  }
  const file = await fsp.open(resolvedFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW).catch((error) => {
    if (isSymbolicLinkOpenError(error)) {
      throw new Error(`${label} must not be a symbolic link: ${resolvedFile}`);
    }
    throw error;
  });
  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}

export async function appendTextFileNoFollow(filePath: string, content: string, label: string): Promise<void> {
  const resolvedFile = path.resolve(filePath);
  const file = await fsp.open(resolvedFile, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW).catch((error) => {
    if (isSymbolicLinkOpenError(error)) {
      throw new Error(`${label} must not be a symbolic link: ${resolvedFile}`);
    }
    throw error;
  });
  try {
    await file.appendFile(content, "utf8");
  } finally {
    await file.close();
  }
}

export async function requireSafeDirectory(rootPath: string, directoryPath: string, options: DirectoryOptions): Promise<boolean> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedDirectory = path.resolve(directoryPath);
  let stat = await lstatOptional(resolvedDirectory);
  if (!stat && options.create) {
    await fsp.mkdir(resolvedDirectory, { recursive: true });
    stat = await lstatOptional(resolvedDirectory);
  }
  if (!stat) {
    return false;
  }
  assertDirectoryStat(stat, resolvedDirectory, options.label);
  const [rootRealPath, directoryRealPath] = await Promise.all([fsp.realpath(resolvedRoot), fsp.realpath(resolvedDirectory)]);
  if (!isSameOrChildPath(rootRealPath, directoryRealPath)) {
    throw new Error(`${options.label} resolves outside the configured data directory: ${resolvedDirectory}`);
  }
  return true;
}

export function requireSafeDirectorySync(rootPath: string, directoryPath: string, options: DirectoryOptions): boolean {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedDirectory = path.resolve(directoryPath);
  const stat = lstatOptionalSync(resolvedDirectory);
  if (!stat) {
    return false;
  }
  assertDirectoryStat(stat, resolvedDirectory, options.label);
  const rootRealPath = fs.realpathSync(resolvedRoot);
  const directoryRealPath = fs.realpathSync(resolvedDirectory);
  if (!isSameOrChildPath(rootRealPath, directoryRealPath)) {
    throw new Error(`${options.label} resolves outside the configured data directory: ${resolvedDirectory}`);
  }
  return true;
}

export async function requireRegularFile(filePath: string, label: string): Promise<boolean> {
  const stat = await lstatOptional(filePath);
  if (!stat) {
    return false;
  }
  assertFileStat(stat, filePath, label);
  return true;
}

export function requireRegularFileSync(filePath: string, label: string): boolean {
  const stat = lstatOptionalSync(filePath);
  if (!stat) {
    return false;
  }
  assertFileStat(stat, filePath, label);
  return true;
}

export async function readTextFileNoFollow(filePath: string, label: string): Promise<string> {
  const file = await fsp.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    if (isSymbolicLinkOpenError(error)) {
      throw new Error(`${label} must not be a symbolic link: ${filePath}`);
    }
    throw error;
  });
  try {
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export function readTextFileNoFollowSync(filePath: string, label: string): string {
  const fd = openReadNoFollowSync(filePath, label);
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function openReadNoFollowSync(filePath: string, label: string): number {
  try {
    return fs.openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isSymbolicLinkOpenError(error)) {
      throw new Error(`${label} must not be a symbolic link: ${filePath}`);
    }
    throw error;
  }
}

async function lstatOptional(filePath: string): Promise<fs.Stats | undefined> {
  return fsp.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

function lstatOptionalSync(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertDirectoryStat(stat: fs.Stats, directoryPath: string, label: string): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${directoryPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${directoryPath}`);
  }
}

function assertFileStat(stat: fs.Stats, filePath: string, label: string): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSymbolicLinkOpenError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
}

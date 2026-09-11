import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { isDirectChildPath, isSameOrChildPath } from "./pathBoundary.js";

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
    private readonly label: string,
    private readonly mode?: number
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
    await writeTextFileAtomic(this.rootPath, this.filePath, stringifyJsonDocument(value, `${this.label} file`), `${this.label} file`, this.mode);
  }
}

export interface OwnedTextFile {
  readonly path: string;
  write(content: string): Promise<void>;
  unlink(): Promise<void>;
  close(): Promise<void>;
}

export interface OwnedRegularFile {
  readonly path: string;
  unlink(): Promise<void>;
  close(): Promise<void>;
}

export interface OwnedDirectoryIdentity {
  path: string;
  dev: string;
  ino: string;
}

export interface OwnedDirectory {
  readonly identity: OwnedDirectoryIdentity;
  childPath(name: string): string;
  assertCurrent(): Promise<void>;
  remove(): Promise<void>;
  close(): Promise<void>;
}

export async function openOwnedDirectoryNoFollow(rootPath: string, directoryPath: string, label: string, expected?: OwnedDirectoryIdentity): Promise<OwnedDirectory> {
  if (process.platform !== "linux") throw new Error(`${label} descriptor-relative ownership requires Linux.`);
  const resolvedRoot = path.resolve(rootPath);
  const resolvedDirectory = path.resolve(directoryPath);
  if (!isDirectChildPath(resolvedRoot, resolvedDirectory) || (expected && expected.path !== resolvedDirectory)) throw new Error(`${label} must be a direct child of its owned parent.`);
  const parent = await openDirectoryNoFollow(resolvedRoot, `${label} parent`);
  const anchoredDirectory = descriptorChildPath(parent.fd, path.basename(resolvedDirectory));
  let directory: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    if (!expected) await fsp.mkdir(anchoredDirectory, { mode: 0o700 });
    directory = await openDirectoryNoFollow(anchoredDirectory, label);
    const stat = await directory.stat({ bigint: true });
    const identity = { path: resolvedDirectory, dev: stat.dev.toString(), ino: stat.ino.toString() };
    if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) throw new Error(`${label} ownership changed; the replacement was preserved.`);
    const handle = directory;
    let closed = false;
    const assertOpen = () => { if (closed) throw new Error(`${label} ownership handles are closed.`); };
    const assertCurrent = async () => {
      assertOpen();
      const current = await fsp.lstat(anchoredDirectory, { bigint: true });
      if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error(`${label} ownership changed; the replacement was preserved.`);
    };
    const childPath = (name: string) => {
      assertOpen();
      if (!name || name === "." || name === ".." || path.basename(name) !== name) throw new Error(`${label} child must be a direct file name.`);
      return descriptorChildPath(handle.fd, name);
    };
    await assertCurrent();
    return {
      identity,
      childPath,
      assertCurrent,
      async remove() {
        await assertCurrent();
        const entries = await fsp.readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
        if (entries.some(entry => entry.isDirectory())) throw new Error(`${label} contains an unexpected nested directory.`);
        for (const entry of entries) await fsp.unlink(childPath(entry.name));
        await assertCurrent();
        await fsp.rmdir(anchoredDirectory);
      },
      async close() {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled([handle.close(), parent.close()]);
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, `${label} ownership handles failed to close.`);
      }
    };
  } catch (error) {
    await Promise.allSettled([directory?.close(), parent.close()]);
    throw error;
  }
}

export function stringifyJsonDocument(value: unknown, label: string): string {
  const content = JSON.stringify(value, null, 2);
  if (content === undefined) {
    throw new Error(`${label} must be JSON-serializable.`);
  }
  return `${content}\n`;
}

export async function writeTextFileAtomic(rootPath: string, filePath: string, content: string, label: string, mode?: number): Promise<void> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedFile = path.resolve(filePath);
  const directory = path.dirname(resolvedFile);
  await requireSafeDirectory(resolvedRoot, directory, { create: true, label: `${label} directory` });
  await requireRegularFile(resolvedFile, label);
  const tempPath = path.join(directory, `${path.basename(resolvedFile)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode });
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

export async function openOwnedTextFileNoFollow(rootPath: string, directoryPath: string, fileName: string, label: string): Promise<OwnedTextFile> {
  if (process.platform !== "linux") {
    throw new Error(`${label} descriptor-relative creation requires Linux.`);
  }
  const resolvedRoot = path.resolve(rootPath);
  const resolvedDirectory = path.resolve(directoryPath);
  if (!isDirectChildPath(resolvedRoot, resolvedDirectory)) {
    throw new Error(`${label} directory must stay directly within the configured data directory: ${resolvedDirectory}`);
  }
  if (!fileName || path.basename(fileName) !== fileName) {
    throw new Error(`${label} name must be a direct child name.`);
  }

  await fsp.mkdir(resolvedRoot, { recursive: true });
  const root = await openDirectoryNoFollow(resolvedRoot, `${label} data directory`);
  let directory: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    const anchoredDirectory = descriptorChildPath(root.fd, path.basename(resolvedDirectory));
    await fsp.mkdir(anchoredDirectory, { recursive: true });
    directory = await openDirectoryNoFollow(anchoredDirectory, `${label} directory`);
  } finally {
    await root.close();
  }

  const anchoredFile = descriptorChildPath(directory.fd, fileName);
  let file: Awaited<ReturnType<typeof fsp.open>>;
  try {
    file = await fsp.open(anchoredFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW);
  } catch (error) {
    await directory.close();
    const stat = await lstatOptional(anchoredFile);
    if (stat?.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${path.join(resolvedDirectory, fileName)}`);
    }
    if (isAlreadyExists(error)) {
      throw new Error(`${label} already exists: ${path.join(resolvedDirectory, fileName)}`);
    }
    throw error;
  }

  let fileClosed = false;
  let directoryClosed = false;
  return {
    path: path.join(resolvedDirectory, fileName),
    write: (content) => file.writeFile(content, "utf8"),
    async unlink() {
      if (directoryClosed) {
        throw new Error(`${label} ownership directory is closed.`);
      }
      await fsp.unlink(anchoredFile).catch((error) => {
        if (!isNotFound(error)) {
          throw error;
        }
      });
    },
    async close() {
      const failures: unknown[] = [];
      if (!fileClosed) {
        fileClosed = true;
        try {
          await file.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (!directoryClosed) {
        directoryClosed = true;
        try {
          await directory.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, `Failed to close ${label} ownership handles.`);
      }
    }
  };
}

export async function openOwnedRegularFileNoFollow(rootPath: string, directoryPath: string, fileName: string, label: string): Promise<OwnedRegularFile> {
  if (process.platform !== "linux") {
    throw new Error(`${label} descriptor-relative deletion requires Linux.`);
  }
  const resolvedRoot = path.resolve(rootPath);
  const resolvedDirectory = path.resolve(directoryPath);
  if (!isDirectChildPath(resolvedRoot, resolvedDirectory)) {
    throw new Error(`${label} directory must stay directly within the configured data directory: ${resolvedDirectory}`);
  }
  if (!fileName || path.basename(fileName) !== fileName) {
    throw new Error(`${label} name must be a direct child name.`);
  }

  const root = await openDirectoryNoFollow(resolvedRoot, `${label} data directory`);
  let directory: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    directory = await openDirectoryNoFollow(descriptorChildPath(root.fd, path.basename(resolvedDirectory)), `${label} directory`);
  } finally {
    await root.close();
  }

  const anchoredFile = descriptorChildPath(directory.fd, fileName);
  let file: Awaited<ReturnType<typeof fsp.open>>;
  try {
    file = await fsp.open(anchoredFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    await directory.close();
    if (isSymbolicLinkOpenError(error)) {
      throw new Error(`${label} must not be a symbolic link: ${path.join(resolvedDirectory, fileName)}`);
    }
    throw error;
  }
  const ownedStat = await file.stat().catch(async (error) => {
    await Promise.allSettled([file.close(), directory.close()]);
    throw error;
  });
  if (!ownedStat.isFile()) {
    await Promise.allSettled([file.close(), directory.close()]);
    throw new Error(`${label} must be a regular file: ${path.join(resolvedDirectory, fileName)}`);
  }

  let closed = false;
  return {
    path: path.join(resolvedDirectory, fileName),
    async unlink() {
      if (closed) {
        throw new Error(`${label} ownership handles are closed.`);
      }
      const current = await fsp.lstat(anchoredFile);
      if (!current.isFile() || current.dev !== ownedStat.dev || current.ino !== ownedStat.ino) {
        throw new Error(`${label} changed before descriptor-relative deletion: ${path.join(resolvedDirectory, fileName)}`);
      }
      await fsp.unlink(anchoredFile);
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      const results = await Promise.allSettled([file.close(), directory.close()]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, `Failed to close ${label} ownership handles.`);
      }
    }
  };
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

async function openDirectoryNoFollow(directoryPath: string, label: string) {
  try {
    return await fsp.open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((await lstatOptional(directoryPath))?.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${directoryPath}`);
    }
    throw error;
  }
}

function descriptorChildPath(directoryFd: number, childName: string): string {
  return `/proc/self/fd/${directoryFd}/${childName}`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

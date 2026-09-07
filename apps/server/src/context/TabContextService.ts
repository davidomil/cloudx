import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { WorkspaceTab } from "@cloudx/shared";

import { appendTextFileNoFollow, openOwnedDirectoryNoFollow, openOwnedRegularFileNoFollow, openOwnedTextFileNoFollow, readTextFileNoFollow, requireRegularFile, requireSafeDirectory, writeTextFileAtomic, type OwnedDirectory, type OwnedDirectoryIdentity } from "../jsonStateFile.js";
import { isDirectChildPath } from "../pathBoundary.js";
import { isCapacityStateWriteError } from "../statePersistence.js";

const MAX_CONTEXT_BYTES = 64_000;
const MAX_CONTEXT_ENTRY_BYTES = 12_000;
const TRIMMED_CONTEXT_HEADER = `# Cloudx Tab Context\n\n_Trimmed to the latest ${MAX_CONTEXT_BYTES} bytes._\n\n`;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>\\)]+/giu;
const SENSITIVE_URL_PARAM_NAMES = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "code",
  "id_token",
  "jwt",
  "key",
  "password",
  "passwd",
  "refresh_token",
  "secret",
  "session",
  "sid",
  "token"
]);

export interface TabContextFileOperations {
  appendTextFileNoFollow: typeof appendTextFileNoFollow;
  openOwnedRegularFileNoFollow: typeof openOwnedRegularFileNoFollow;
  openOwnedTextFileNoFollow: typeof openOwnedTextFileNoFollow;
  openOwnedDirectoryNoFollow: typeof openOwnedDirectoryNoFollow;
  readTextFileNoFollow: typeof readTextFileNoFollow;
  requireRegularFile: typeof requireRegularFile;
  requireSafeDirectory: typeof requireSafeDirectory;
  writeTextFileAtomic: typeof writeTextFileAtomic;
}

const defaultFileOperations: TabContextFileOperations = {
  appendTextFileNoFollow,
  openOwnedRegularFileNoFollow,
  openOwnedTextFileNoFollow,
  openOwnedDirectoryNoFollow,
  readTextFileNoFollow,
  requireRegularFile,
  requireSafeDirectory,
  writeTextFileAtomic
};

interface OwnedTabContext {
  identity: OwnedDirectoryIdentity;
  deleting?: Promise<void>;
}

export class TabContextService {
  private readonly dataRoot: string;
  private readonly contextDir: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly ownedContexts = new Map<string, OwnedTabContext>();

  constructor(dataDir: string, private readonly files: TabContextFileOperations = defaultFileOperations) {
    this.dataRoot = path.resolve(dataDir);
    this.contextDir = path.join(this.dataRoot, "context");
  }

  async create(tab: Pick<WorkspaceTab, "id" | "pluginId" | "title" | "cwd" | "status">, options: { ownedDirectory?: boolean } = {}): Promise<string | undefined> {
    if (options.ownedDirectory) return this.ignoreCapacityError(() => this.createOwned(tab));
    const fileName = `${tabContextFileStem(tab.id)}.md`;
    return this.ignoreCapacityError(async () => {
      const owned = await this.files.openOwnedTextFileNoFollow(this.dataRoot, this.contextDir, fileName, "Tab context file");
      try {
        await owned.write(initialContext(tab));
        return owned.path;
      } catch (error) {
        await owned.unlink();
        throw error;
      } finally {
        await owned.close();
      }
    });
  }

  directory(contextPath: string | undefined): OwnedDirectoryIdentity | undefined {
    const owned = contextPath ? this.ownedContexts.get(path.resolve(contextPath)) : undefined;
    return owned ? { ...owned.identity } : undefined;
  }

  async record(tab: WorkspaceTab, kind: string, payload: string): Promise<void> {
    const owned = tab.contextPath ? this.ownedContexts.get(path.resolve(tab.contextPath)) : undefined;
    if (owned?.deleting) return;
    const contextPath = owned ? path.resolve(tab.contextPath!) : await this.requireContextPath(tab.contextPath);
    if (!contextPath) {
      return;
    }
    const sanitized = sanitize(payload);
    if (!sanitized) {
      return;
    }
    const entry = [`### ${new Date().toISOString()} ${kind}`, "", "```text", sanitized, "```", ""].join("\n");
    await this.ignoreCapacityError(() => this.enqueue(contextPath, async () => {
      if (owned) return this.withOwnedDirectory(owned, async directory => {
        await withContextFile(directory, constants.O_WRONLY | constants.O_APPEND, file => file.writeFile(entry, "utf8"));
        const content = await readOwnedContext(directory);
        if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_BYTES) await writeOwnedContextAtomic(directory, trimmedContext(content));
      });
      await this.files.appendTextFileNoFollow(contextPath, entry, "Tab context file");
      await this.truncate(contextPath);
    }));
  }

  async read(tab: WorkspaceTab): Promise<string> {
    const owned = tab.contextPath ? this.ownedContexts.get(path.resolve(tab.contextPath)) : undefined;
    if (owned?.deleting) {
      await owned.deleting;
      return "";
    }
    if (owned) return this.enqueue(path.resolve(tab.contextPath!), () => this.withOwnedDirectory(owned, readOwnedContext)).catch(error => {
      if (isNotFound(error)) return "";
      throw error;
    });
    const contextPath = await this.requireContextPath(tab.contextPath);
    if (!contextPath) {
      return "";
    }
    await this.writeQueues.get(contextPath);
    return this.files.readTextFileNoFollow(contextPath, "Tab context file").catch((error) => {
      if (isNotFound(error)) {
        return "";
      }
      throw error;
    });
  }

  async delete(tab: Pick<WorkspaceTab, "contextPath">): Promise<void> {
    if (!tab.contextPath) {
      return;
    }
    const contextPath = path.resolve(tab.contextPath);
    const ownedContext = this.ownedContexts.get(contextPath);
    if (ownedContext) {
      if (ownedContext.deleting) return ownedContext.deleting;
      const deletion = this.enqueue(contextPath, async () => {
        await this.withOwnedDirectory(ownedContext, directory => directory.remove()).catch(error => { if (!isNotFound(error)) throw error; });
        this.ownedContexts.delete(contextPath);
      });
      ownedContext.deleting = deletion;
      try { await deletion; } catch (error) { ownedContext.deleting = undefined; throw error; }
      return;
    }
    if (!isDirectChildPath(this.contextDir, contextPath)) {
      throw new Error(`Tab context file must stay directly within the CloudX context directory: ${contextPath}`);
    }
    await this.writeQueues.get(contextPath);
    const owned = await this.files.openOwnedRegularFileNoFollow(this.dataRoot, this.contextDir, path.basename(contextPath), "Tab context file").catch((error) => {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (!owned) {
      return;
    }
    try {
      await owned.unlink();
    } finally {
      await owned.close();
    }
  }

  private async truncate(contextPath: string): Promise<void> {
    const content = await this.files.readTextFileNoFollow(contextPath, "Tab context file").catch((error) => {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (content === undefined || Buffer.byteLength(content, "utf8") <= MAX_CONTEXT_BYTES) {
      return;
    }
    await this.files.writeTextFileAtomic(this.dataRoot, contextPath, trimmedContext(content), "Tab context file");
  }

  private async createOwned(tab: Pick<WorkspaceTab, "id" | "pluginId" | "title" | "cwd" | "status">): Promise<string> {
    await this.files.requireSafeDirectory(this.dataRoot, this.contextDir, { create: true, label: "Tab context directory" });
    const directory = await this.files.openOwnedDirectoryNoFollow(this.contextDir, path.join(this.contextDir, tabContextFileStem(tab.id)), "Tab context directory");
    const contextPath = path.join(directory.identity.path, "context.md");
    try {
      await fs.writeFile(directory.childPath("context.md"), initialContext(tab), { encoding: "utf8", flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode: 0o600 });
      await directory.assertCurrent();
      this.ownedContexts.set(contextPath, { identity: { ...directory.identity } });
      return contextPath;
    } catch (error) {
      try { await directory.remove(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Context creation failed and owned directory cleanup is incomplete."); }
      throw error;
    } finally {
      await directory.close();
    }
  }

  private async withOwnedDirectory<T>(owned: OwnedTabContext, operation: (directory: OwnedDirectory) => Promise<T>): Promise<T> {
    await this.files.requireSafeDirectory(this.dataRoot, this.contextDir, { create: false, label: "Tab context directory" });
    const directory = await this.files.openOwnedDirectoryNoFollow(this.contextDir, owned.identity.path, "Tab context directory", owned.identity);
    try { return await operation(directory); } finally { await directory.close(); }
  }

  private async requireContextPath(candidate: string | undefined): Promise<string | undefined> {
    if (!candidate) {
      return undefined;
    }
    const contextPath = path.resolve(candidate);
    if (!isDirectChildPath(this.contextDir, contextPath)) {
      throw new Error(`Tab context file must stay directly within the CloudX context directory: ${contextPath}`);
    }
    if (!(await this.files.requireSafeDirectory(this.dataRoot, path.dirname(contextPath), { create: false, label: "Tab context directory" }))) {
      return undefined;
    }
    if (!(await this.files.requireRegularFile(contextPath, "Tab context file"))) {
      return undefined;
    }
    return contextPath;
  }

  private async ignoreCapacityError<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (isCapacityStateWriteError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private enqueue<T>(contextPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(contextPath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    let settled: Promise<void>;
    settled = current
      .catch(() => undefined)
      .then(() => {
        if (this.writeQueues.get(contextPath) === settled) {
          this.writeQueues.delete(contextPath);
        }
      });
    this.writeQueues.set(contextPath, settled);
    return current;
  }
}

function initialContext(tab: Pick<WorkspaceTab, "id" | "pluginId" | "title" | "cwd" | "status">): string {
  return ["# Cloudx Tab Context", "", `- tabId: ${tab.id}`, `- plugin: ${tab.pluginId}`, `- title: ${tab.title}`, `- cwd: ${tab.cwd}`, `- status: ${tab.status}`, "", "## Events", ""].join("\n");
}

function trimmedContext(content: string): string {
  const keepBytes = Math.max(0, MAX_CONTEXT_BYTES - Buffer.byteLength(TRIMMED_CONTEXT_HEADER, "utf8"));
  return `${TRIMMED_CONTEXT_HEADER}${trimUtf8ToLastBytes(content, keepBytes)}`;
}

async function withContextFile<T>(directory: OwnedDirectory, flags: number, operation: (file: Awaited<ReturnType<typeof fs.open>>) => Promise<T>): Promise<T> {
  const file = await fs.open(directory.childPath("context.md"), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Owned tab context must be a regular file without hard links.");
    if (stat.size > MAX_CONTEXT_BYTES * 2) throw new Error("Owned tab context exceeds its bounded file size.");
    return await operation(file);
  } finally { await file.close(); }
}

function readOwnedContext(directory: OwnedDirectory): Promise<string> {
  return withContextFile(directory, constants.O_RDONLY, async file => {
    const bytes = Buffer.alloc(MAX_CONTEXT_BYTES * 2 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CONTEXT_BYTES * 2) throw new Error("Owned tab context exceeds its bounded file size.");
    return bytes.subarray(0, length).toString("utf8");
  });
}

async function writeOwnedContextAtomic(directory: OwnedDirectory, content: string): Promise<void> {
  const temporary = directory.childPath(`context.md.${randomUUID()}.tmp`);
  const staged = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let published = false;
  try {
    await staged.writeFile(content, "utf8");
    await directory.assertCurrent();
    await requireRegularFile(directory.childPath("context.md"), "Tab context file");
    await fs.rename(temporary, directory.childPath("context.md"));
    published = true;
  } finally {
    await staged.close();
    if (!published) await fs.unlink(temporary).catch(error => { if (!isNotFound(error)) throw error; });
  }
}

function tabContextFileStem(tabId: string): string {
  if (!tabId) {
    throw new Error("Tab id is required.");
  }
  const slug = tabId.replace(/[^a-z0-9._-]/gi, "_").slice(0, 64) || "tab";
  const digest = createHash("sha256").update(tabId).digest("hex");
  return `${slug}-${digest}`;
}

function sanitize(payload: string): string {
  const normalized = stripVTControlCharacters(payload)
    .replace(URL_PATTERN, redactSensitiveUrl)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n")
    .trim();
  return trimUtf8ToLastBytes(normalized, MAX_CONTEXT_ENTRY_BYTES);
}

function redactSensitiveUrl(match: string): string {
  try {
    const url = new URL(match);
    let redacted = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveUrlParamName(key)) {
        url.searchParams.set(key, "redacted");
        redacted = true;
      }
    }
    if (url.hash && containsSensitiveUrlParam(url.hash.slice(1))) {
      url.hash = "#redacted";
      redacted = true;
    }
    return redacted ? url.href : match;
  } catch {
    return match;
  }
}

function containsSensitiveUrlParam(value: string): boolean {
  for (const key of new URLSearchParams(value).keys()) {
    if (isSensitiveUrlParamName(key)) {
      return true;
    }
  }
  return false;
}

function isSensitiveUrlParamName(name: string): boolean {
  return SENSITIVE_URL_PARAM_NAMES.has(name.trim().toLowerCase());
}

function trimUtf8ToLastBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const kept: string[] = [];
  let bytes = 0;
  const codePoints = Array.from(value);
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index]!;
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    kept.push(codePoint);
  }
  return kept.reverse().join("");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import { createHash } from "node:crypto";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { WorkspaceTab } from "@cloudx/shared";

import { appendTextFileNoFollow, readTextFileNoFollow, requireRegularFile, requireSafeDirectory, writeNewTextFileNoFollow, writeTextFileAtomic } from "../jsonStateFile.js";
import { isDirectChildPath } from "../pathBoundary.js";

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

export class TabContextService {
  private readonly dataRoot: string;
  private readonly contextDir: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dataRoot = path.resolve(dataDir);
    this.contextDir = path.join(this.dataRoot, "context");
  }

  async create(tab: Pick<WorkspaceTab, "id" | "pluginId" | "title" | "cwd" | "status">): Promise<string> {
    const contextPath = path.join(this.contextDir, `${tabContextFileStem(tab.id)}.md`);
    await writeNewTextFileNoFollow(
      this.dataRoot,
      contextPath,
      [
        "# Cloudx Tab Context",
        "",
        `- tabId: ${tab.id}`,
        `- plugin: ${tab.pluginId}`,
        `- title: ${tab.title}`,
        `- cwd: ${tab.cwd}`,
        `- status: ${tab.status}`,
        "",
        "## Events",
        ""
      ].join("\n"),
      "Tab context file"
    );
    return contextPath;
  }

  async record(tab: WorkspaceTab, kind: string, payload: string): Promise<void> {
    const contextPath = await this.requireContextPath(tab.contextPath);
    if (!contextPath) {
      return;
    }
    const sanitized = sanitize(payload);
    if (!sanitized) {
      return;
    }
    const entry = [`### ${new Date().toISOString()} ${kind}`, "", "```text", sanitized, "```", ""].join("\n");
    await this.enqueue(contextPath, async () => {
      await appendTextFileNoFollow(contextPath, entry, "Tab context file");
      await this.truncate(contextPath);
    });
  }

  async read(tab: WorkspaceTab): Promise<string> {
    const contextPath = await this.requireContextPath(tab.contextPath);
    if (!contextPath) {
      return "";
    }
    await this.writeQueues.get(contextPath);
    return readTextFileNoFollow(contextPath, "Tab context file").catch((error) => {
      if (isNotFound(error)) {
        return "";
      }
      throw error;
    });
  }

  private async truncate(contextPath: string): Promise<void> {
    const content = await readTextFileNoFollow(contextPath, "Tab context file").catch((error) => {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (content === undefined || Buffer.byteLength(content, "utf8") <= MAX_CONTEXT_BYTES) {
      return;
    }
    const keepBytes = Math.max(0, MAX_CONTEXT_BYTES - Buffer.byteLength(TRIMMED_CONTEXT_HEADER, "utf8"));
    await writeTextFileAtomic(this.dataRoot, contextPath, `${TRIMMED_CONTEXT_HEADER}${trimUtf8ToLastBytes(content, keepBytes)}`, "Tab context file");
  }

  private async requireContextPath(candidate: string | undefined): Promise<string | undefined> {
    if (!candidate) {
      return undefined;
    }
    const contextPath = path.resolve(candidate);
    if (!isDirectChildPath(this.contextDir, contextPath)) {
      throw new Error(`Tab context file must stay directly within the CloudX context directory: ${contextPath}`);
    }
    if (!(await requireSafeDirectory(this.dataRoot, path.dirname(contextPath), { create: false, label: "Tab context directory" }))) {
      return undefined;
    }
    if (!(await requireRegularFile(contextPath, "Tab context file"))) {
      return undefined;
    }
    return contextPath;
  }

  private enqueue(contextPath: string, operation: () => Promise<void>): Promise<void> {
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

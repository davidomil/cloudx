import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { FileSearchFileResult, FileSearchMatch, FileSearchMode, FileSearchResult } from "@cloudx/shared";

const execFileAsync = promisify(execFile);

const MAX_RG_OUTPUT_BYTES = 2_000_000;
const MAX_SEARCH_FILES = 200;
const MAX_MATCHES_PER_FILE = 5;
const MAX_SNIPPET_CHARS = 1_000;
const MAX_FILE_SIZE = "1M";

interface SearchInput {
  query: string;
  mode?: FileSearchMode;
  relativePath?: string;
  caseSensitive?: boolean;
  glob?: string;
  maxResults?: number;
}

interface RgCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RgMatchMessage {
  type: "match";
  data: {
    path?: RgTextValue;
    lines?: RgTextValue;
    line_number?: number;
    submatches?: Array<{
      match?: RgTextValue;
      start?: number;
    }>;
  };
}

type RgTextValue = { text?: string; bytes?: string };

export class FileSearchService {
  async search(cwd: string, input: SearchInput): Promise<FileSearchResult> {
    const query = requireSearchQuery(input.query);
    const mode = input.mode ?? "all";
    const relativePath = normalizeSearchPath(input.relativePath);
    const glob = normalizedOptionalString(input.glob);
    const maxResults = normalizeMaxResults(input.maxResults);

    if (mode === "all") {
      const [filenameResult, contentResult] = await Promise.all([
        this.searchFilenames(cwd, { query, relativePath, glob, maxResults, caseSensitive: input.caseSensitive === true }),
        this.searchContent(cwd, { query, relativePath, glob, maxResults, caseSensitive: input.caseSensitive === true })
      ]);
      return mergeSearchResults(query, relativePath, glob, maxResults, filenameResult, contentResult);
    }
    if (mode === "filename") {
      return this.searchFilenames(cwd, { query, relativePath, glob, maxResults, caseSensitive: input.caseSensitive === true });
    }
    if (mode === "content") {
      return this.searchContent(cwd, { query, relativePath, glob, maxResults, caseSensitive: input.caseSensitive === true });
    }
    throw new Error(`Unsupported file search mode: ${mode}`);
  }

  private async searchFilenames(cwd: string, input: Required<Pick<SearchInput, "query" | "relativePath" | "maxResults" | "caseSensitive">> & { glob?: string }): Promise<FileSearchResult> {
    const args = ["--no-config", "--files", "--color", "never", ...globArgs(input.glob), input.relativePath];
    const result = await this.runRg(cwd, args, { allowExitCodes: [0, 1] });
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    const files: FileSearchFileResult[] = [];
    const seen = new Set<string>();
    let truncated = false;

    for (const filePath of result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      for (const entry of filenameCandidates(normalizeResultPath(filePath))) {
        const haystack = input.caseSensitive ? entry.path : entry.path.toLowerCase();
        const seenKey = `${entry.entryType}:${entry.path}`;
        if (!haystack.includes(needle) || seen.has(seenKey)) {
          continue;
        }
        if (files.length >= input.maxResults) {
          truncated = true;
          break;
        }
        seen.add(seenKey);
        files.push({
          path: entry.path,
          type: "filename",
          entryType: entry.entryType,
          matches: [{ text: entry.path, matchText: input.query }],
          truncated: false
        });
      }
      if (truncated) {
        break;
      }
    }

    return {
      query: input.query,
      mode: "filename",
      relativePath: input.relativePath,
      glob: input.glob,
      files,
      truncated,
      searchedAt: new Date().toISOString()
    };
  }

  private async searchContent(cwd: string, input: Required<Pick<SearchInput, "query" | "relativePath" | "maxResults" | "caseSensitive">> & { glob?: string }): Promise<FileSearchResult> {
    const args = [
      "--no-config",
      "--json",
      "--line-number",
      "--column",
      "--color",
      "never",
      "--max-count",
      String(MAX_MATCHES_PER_FILE),
      "--max-filesize",
      MAX_FILE_SIZE,
      ...(input.caseSensitive ? [] : ["--ignore-case"]),
      ...globArgs(input.glob),
      input.query,
      input.relativePath
    ];
    const result = await this.runRg(cwd, args, { allowExitCodes: [0, 1] });
    const byPath = new Map<string, FileSearchFileResult>();
    let truncated = false;

    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const message = parseRgJsonLine(line);
      if (message?.type !== "match") {
        continue;
      }
      const filePath = normalizeResultPath(textValue(message.data.path));
      if (!filePath) {
        continue;
      }
      let file = byPath.get(filePath);
      if (!file) {
        if (byPath.size >= input.maxResults) {
          truncated = true;
          break;
        }
        file = { path: filePath, type: "content", entryType: "file", matches: [], truncated: false };
        byPath.set(filePath, file);
      }
      if (file.matches.length >= MAX_MATCHES_PER_FILE) {
        file.truncated = true;
        continue;
      }
      file.matches.push(matchFromMessage(message));
    }

    return {
      query: input.query,
      mode: "content",
      relativePath: input.relativePath,
      glob: input.glob,
      files: Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path)),
      truncated,
      searchedAt: new Date().toISOString()
    };
  }

  private async runRg(cwd: string, args: string[], options: { allowExitCodes: number[] }): Promise<RgCommandResult> {
    try {
      const result = await execFileAsync("rg", args, {
        cwd,
        maxBuffer: MAX_RG_OUTPUT_BYTES,
        timeout: 10_000,
        windowsHide: true
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
      if (execError.code === "ENOENT") {
        throw new Error("File search requires ripgrep (`rg`) to be installed.");
      }
      if (execError.killed) {
        throw new Error("File search timed out.");
      }
      if (execError.message.includes("stdout maxBuffer") || execError.message.includes("stderr maxBuffer")) {
        throw new Error("File search produced too many results. Narrow the query or glob.");
      }
      const code = typeof execError.code === "number" ? execError.code : 1;
      const stdout = typeof execError.stdout === "string" ? execError.stdout : "";
      const stderr = typeof execError.stderr === "string" ? execError.stderr : execError.message;
      if (options.allowExitCodes.includes(code)) {
        return { stdout, stderr, code };
      }
      throw new Error((stderr || stdout || execError.message).trim());
    }
  }
}

function requireSearchQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("query must not be empty.");
  }
  return value.trim();
}

function normalizeSearchPath(value: unknown): string {
  if (value === undefined || value === "") {
    return ".";
  }
  if (typeof value !== "string") {
    throw new Error("relativePath must be a string.");
  }
  const normalized = value.split(/[\\/]/).filter(Boolean).join("/");
  if (!normalized || normalized === ".") {
    return ".";
  }
  if (path.isAbsolute(value) || normalized.split("/").includes("..")) {
    throw new Error("relativePath must stay under the tab working directory.");
  }
  return normalized;
}

function normalizedOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("glob must be a string.");
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeMaxResults(value: unknown): number {
  if (value === undefined) {
    return MAX_SEARCH_FILES;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("maxResults must be a number.");
  }
  return Math.max(1, Math.min(MAX_SEARCH_FILES, Math.floor(value)));
}

function globArgs(glob: string | undefined): string[] {
  return glob ? ["--glob", glob] : [];
}

function parseRgJsonLine(line: string): RgMatchMessage | undefined {
  const parsed = JSON.parse(line) as { type?: unknown; data?: unknown };
  if (parsed.type !== "match" || typeof parsed.data !== "object" || !parsed.data) {
    return undefined;
  }
  return parsed as RgMatchMessage;
}

function matchFromMessage(message: RgMatchMessage): FileSearchMatch {
  const firstSubmatch = message.data.submatches?.[0];
  return {
    lineNumber: message.data.line_number,
    column: firstSubmatch?.start === undefined ? undefined : firstSubmatch.start + 1,
    text: truncateSnippet(textValue(message.data.lines)),
    matchText: textValue(firstSubmatch?.match)
  };
}

function textValue(value: RgTextValue | undefined): string {
  return value?.text ?? "";
}

function truncateSnippet(value: string): string {
  if (value.length <= MAX_SNIPPET_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_SNIPPET_CHARS)}...`;
}

function normalizeResultPath(filePath: string): string {
  const normalized = filePath.split(path.sep).join("/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function filenameCandidates(filePath: string): Array<{ path: string; entryType: "file" | "directory" }> {
  const parts = filePath.split("/").filter(Boolean);
  const candidates: Array<{ path: string; entryType: "file" | "directory" }> = [];
  for (let index = 1; index < parts.length; index += 1) {
    candidates.push({ path: parts.slice(0, index).join("/"), entryType: "directory" });
  }
  candidates.push({ path: filePath, entryType: "file" });
  return candidates;
}

function mergeSearchResults(query: string, relativePath: string, glob: string | undefined, maxResults: number, filenameResult: FileSearchResult, contentResult: FileSearchResult): FileSearchResult {
  const files = new Map<string, FileSearchFileResult>();
  let truncated = filenameResult.truncated || contentResult.truncated;

  for (const file of [...filenameResult.files, ...contentResult.files]) {
    const existing = files.get(file.path);
    if (!existing) {
      if (files.size >= maxResults) {
        truncated = true;
        break;
      }
      files.set(file.path, { ...file, type: "all" });
      continue;
    }
    const combinedMatches = [...existing.matches, ...file.matches];
    existing.matches = combinedMatches.slice(0, MAX_MATCHES_PER_FILE);
    existing.truncated = existing.truncated || file.truncated || combinedMatches.length > existing.matches.length;
  }

  return {
    query,
    mode: "all",
    relativePath,
    glob,
    files: Array.from(files.values()),
    truncated,
    searchedAt: new Date().toISOString()
  };
}

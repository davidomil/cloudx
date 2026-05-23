import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { FileSearchFileResult, FileSearchMatch, FileSearchMode, FileSearchResult } from "@cloudx/shared";

const MAX_SEARCH_FILES = 200;
const MAX_MATCHES_PER_FILE = 5;
const RG_MATCH_LINES_PER_FILE_LIMIT = MAX_MATCHES_PER_FILE + 1;
const MAX_SNIPPET_CHARS = 1_000;
const MAX_FILE_SIZE = "1M";
const RG_TIMEOUT_MS = 10_000;
const MAX_RG_STDERR_CHARS = 64_000;

interface SearchInput {
  query: string;
  mode?: FileSearchMode;
  relativePath?: string;
  caseSensitive?: boolean;
  glob?: string;
  maxResults?: number;
}

interface FilenameSearchMatches {
  files: FileSearchFileResult[];
  truncated: boolean;
}

type ContentSearchMatches = FilenameSearchMatches;

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
    const args = ["--no-config", "--files", "--null", "--color", "never", ...globArgs(input.glob), "--", input.relativePath];
    const result = await this.streamFilenameMatches(cwd, args, input);

    return {
      query: input.query,
      mode: "filename",
      relativePath: input.relativePath,
      glob: input.glob,
      files: result.files,
      truncated: result.truncated,
      searchedAt: new Date().toISOString()
    };
  }

  private async streamFilenameMatches(
    cwd: string,
    args: string[],
    input: Required<Pick<SearchInput, "query" | "relativePath" | "maxResults" | "caseSensitive">> & { glob?: string }
  ): Promise<FilenameSearchMatches> {
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();

    return new Promise((resolve, reject) => {
      const child = spawn("rg", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      const decoder = new StringDecoder("utf8");
      const files: FileSearchFileResult[] = [];
      const seen = new Set<string>();
      let pending = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let stoppedAfterLimit = false;
      let settled = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, RG_TIMEOUT_MS);

      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      const processRecord = (filePath: string): boolean => {
        const normalizedPath = normalizeResultPath(filePath);
        if (!normalizedPath) {
          return false;
        }
        for (const entry of filenameCandidates(normalizedPath)) {
          const haystack = input.caseSensitive ? entry.path : entry.path.toLowerCase();
          const seenKey = `${entry.entryType}:${entry.path}`;
          if (!haystack.includes(needle) || seen.has(seenKey)) {
            continue;
          }
          if (files.length >= input.maxResults) {
            truncated = true;
            return true;
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
        return false;
      };

      const stopAfterLimit = (): void => {
        stoppedAfterLimit = true;
        child.kill("SIGTERM");
      };

      const processOutput = (output: string): void => {
        pending += output;
        while (!stoppedAfterLimit) {
          const separatorIndex = pending.indexOf("\0");
          if (separatorIndex === -1) {
            return;
          }
          const record = pending.slice(0, separatorIndex);
          pending = pending.slice(separatorIndex + 1);
          if (record.length > 0 && processRecord(record)) {
            stopAfterLimit();
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (!stoppedAfterLimit) {
          processOutput(decoder.write(chunk));
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_RG_STDERR_CHARS) {
          stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, MAX_RG_STDERR_CHARS);
        }
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        settle(() => {
          if (error.code === "ENOENT") {
            reject(new Error("File search requires ripgrep (`rg`) to be installed."));
            return;
          }
          reject(error);
        });
      });

      child.on("close", (code) => {
        settle(() => {
          if (timedOut) {
            reject(new Error("File search timed out."));
            return;
          }
          if (!stoppedAfterLimit) {
            processOutput(decoder.end());
            if (pending.length > 0) {
              processRecord(pending);
            }
          }
          if (stoppedAfterLimit || code === 0 || code === 1) {
            resolve({ files, truncated });
            return;
          }
          reject(new Error((stderr || `ripgrep exited with code ${code ?? "unknown"}`).trim()));
        });
      });
    });
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
      String(RG_MATCH_LINES_PER_FILE_LIMIT),
      "--max-filesize",
      MAX_FILE_SIZE,
      ...(input.caseSensitive ? [] : ["--ignore-case"]),
      ...globArgs(input.glob),
      "-e",
      input.query,
      "--",
      input.relativePath
    ];
    const result = await this.streamContentMatches(cwd, args, input.maxResults);

    return {
      query: input.query,
      mode: "content",
      relativePath: input.relativePath,
      glob: input.glob,
      files: result.files,
      truncated: result.truncated,
      searchedAt: new Date().toISOString()
    };
  }

  private async streamContentMatches(cwd: string, args: string[], maxResults: number): Promise<ContentSearchMatches> {
    return new Promise((resolve, reject) => {
      const child = spawn("rg", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      const decoder = new StringDecoder("utf8");
      const byPath = new Map<string, FileSearchFileResult>();
      let pending = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let stoppedAfterLimit = false;
      let outputError: Error | undefined;
      let settled = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, RG_TIMEOUT_MS);

      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      const processRecord = (line: string): boolean => {
        if (!line.trim()) {
          return false;
        }
        const message = parseRgJsonLine(line);
        if (message?.type !== "match") {
          return false;
        }
        const filePath = normalizeResultPath(textValue(message.data.path));
        if (!filePath) {
          return false;
        }
        let file = byPath.get(filePath);
        if (!file) {
          if (byPath.size >= maxResults) {
            truncated = true;
            return true;
          }
          file = { path: filePath, type: "content", entryType: "file", matches: [], truncated: false };
          byPath.set(filePath, file);
        }
        if (file.matches.length >= MAX_MATCHES_PER_FILE) {
          file.truncated = true;
          return false;
        }
        file.matches.push(matchFromMessage(message));
        return false;
      };

      const stopAfterLimit = (): void => {
        stoppedAfterLimit = true;
        child.kill("SIGTERM");
      };

      const stopWithOutputError = (error: unknown): void => {
        if (outputError || settled) {
          return;
        }
        outputError = invalidRipgrepJsonOutputError(error);
        child.kill("SIGTERM");
      };

      const processOutput = (output: string): void => {
        pending += output;
        while (!stoppedAfterLimit && !outputError) {
          const separatorIndex = pending.indexOf("\n");
          if (separatorIndex === -1) {
            return;
          }
          const record = pending.slice(0, separatorIndex);
          pending = pending.slice(separatorIndex + 1);
          let limitReached = false;
          try {
            limitReached = processRecord(record);
          } catch (error) {
            stopWithOutputError(error);
            return;
          }
          if (limitReached) {
            stopAfterLimit();
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (!stoppedAfterLimit && !outputError) {
          processOutput(decoder.write(chunk));
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_RG_STDERR_CHARS) {
          stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, MAX_RG_STDERR_CHARS);
        }
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        settle(() => {
          if (error.code === "ENOENT") {
            reject(new Error("File search requires ripgrep (`rg`) to be installed."));
            return;
          }
          reject(error);
        });
      });

      child.on("close", (code) => {
        settle(() => {
          if (timedOut) {
            reject(new Error("File search timed out."));
            return;
          }
          if (outputError) {
            reject(outputError);
            return;
          }
          if (!stoppedAfterLimit) {
            processOutput(decoder.end());
            if (outputError) {
              reject(outputError);
              return;
            }
            if (pending.length > 0) {
              try {
                processRecord(pending);
              } catch (error) {
                reject(invalidRipgrepJsonOutputError(error));
                return;
              }
            }
          }
          if (stoppedAfterLimit || code === 0 || code === 1) {
            resolve({ files: Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path)), truncated });
            return;
          }
          reject(new Error((stderr || `ripgrep exited with code ${code ?? "unknown"}`).trim()));
        });
      });
    });
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

function invalidRipgrepJsonOutputError(error: unknown): Error {
  return new Error(`Invalid ripgrep JSON output: ${error instanceof Error ? error.message : String(error)}`);
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

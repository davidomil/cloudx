import fs from "node:fs/promises";
import path from "node:path";

import { isRecord, usageIndexing } from "@cloudx/shared";

import { MissingTranscriptError } from "../missingTranscript.js";
import { findClaudeTranscript } from "../claude/ClaudeLaunch.js";
import { JsonlCache, type JsonlCacheOptions } from "./JsonlCache.js";
import { UsageReadRequests } from "./UsageReadRequests.js";
import { count, isUsageRecord, type UsageRecord, type UsageSnapshot } from "./usageRecord.js";

// Reads token usage from Claude Code transcripts: the session file and its
// subagents/*.jsonl. A message is written once per content block with the same
// id and usage, so callers count each id once.
export class ClaudeUsageReader {
  private readonly cache: JsonlCache<null, UsageRecord>;
  private readonly requests = new UsageReadRequests();

  constructor(private readonly claudeHome: () => string, options: JsonlCacheOptions<null, UsageRecord> = {}) {
    this.cache = new JsonlCache(() => null, parseClaudeLine, {
      ...options, validateState: value => value === null, validateResult: isUsageRecord
    });
  }

  snapshot(sessionId: string, signal?: AbortSignal): Promise<UsageSnapshot> {
    const home = path.resolve(this.claudeHome());
    return this.requests.read(JSON.stringify([home, sessionId]), active => this.readSnapshot(home, sessionId, active), signal);
  }

  async idle(): Promise<void> {
    await this.requests.idle();
    await this.cache.idle();
  }

  async dispose(): Promise<void> {
    await this.requests.dispose();
    await this.cache.dispose();
  }

  private async readSnapshot(home: string, sessionId: string, signal: AbortSignal): Promise<UsageSnapshot> {
    signal.throwIfAborted();
    let transcript: string;
    try { transcript = await findClaudeTranscript(path.join(home, "projects"), sessionId, signal); }
    catch (error) { if (error instanceof MissingTranscriptError) return { records: [], indexing: "error" }; throw error; }
    signal.throwIfAborted();
    const subagents = path.join(path.dirname(transcript), sessionId, "subagents");
    let names: string[] = [];
    try { names = await fs.readdir(subagents); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const files = [transcript, ...names.filter(name => name.endsWith(".jsonl")).map(name => path.join(subagents, name))];
    const snapshots = [];
    for (const file of files) {
      signal.throwIfAborted();
      const snapshot = await this.cache.readWithStatus(file);
      signal.throwIfAborted();
      snapshots.push(snapshot);
    }
    return { records: snapshots.flatMap(snapshot => snapshot.results), ...usageIndexing(snapshots) };
  }
}

function parseClaudeLine(line: unknown): UsageRecord | undefined {
  if (!isRecord(line) || line.type !== "assistant" || typeof line.timestamp !== "string" || !isRecord(line.message) || !Number.isFinite(Date.parse(line.timestamp))) return undefined;
  const { id, model, usage } = line.message;
  // Claude Code writes local "<synthetic>" messages that used no model.
  if (typeof id !== "string" || typeof model !== "string" || model.startsWith("<") || !isRecord(usage)) return undefined;
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const cacheWrite1h = count(cacheCreation?.ephemeral_1h_input_tokens);
  const cacheWrite = cacheCreation ? count(cacheCreation.ephemeral_5m_input_tokens) : count(usage.cache_creation_input_tokens);
  return {
    id: `claude:${id}`,
    at: Date.parse(line.timestamp),
    model,
    input: count(usage.input_tokens),
    cachedInput: count(usage.cache_read_input_tokens),
    cacheWrite,
    cacheWrite1h,
    output: count(usage.output_tokens),
    reasoning: count(isRecord(usage.output_tokens_details) ? usage.output_tokens_details.thinking_tokens : 0),
    webSearches: count(isRecord(usage.server_tool_use) ? usage.server_tool_use.web_search_requests : 0),
    fast: usage.speed === "fast",
    usInference: usage.inference_geo === "us"
  };
}

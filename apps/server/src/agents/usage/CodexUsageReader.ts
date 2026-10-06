import fs from "node:fs/promises";
import path from "node:path";

import { isRecord } from "@cloudx/shared";

import { findCodexTranscript } from "../../plugins/CodexConversationRecovery.js";
import { JsonlCache } from "./JsonlCache.js";
import { count, type UsageRecord } from "./usageRecord.js";

interface CodexParseState {
  ownThread?: string;
  model: string;
}

interface CodexUsage {
  rootSession: string;
  record: UsageRecord;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Reads token usage from Codex rollouts. Each model response is one
// token_usage_record. A forked rollout repeats its parent's history, so only
// records of the file's own thread count, and subagent threads are found by
// the root session id their records carry.
export class CodexUsageReader {
  private readonly cache = new JsonlCache<CodexParseState, CodexUsage>(() => ({ model: "unknown" }), parseCodexLine);
  private readonly rootFiles = new Map<string, string>();

  constructor(private readonly codexHome: () => string) {}

  async records(sessionId: string, since: number): Promise<UsageRecord[]> {
    const sessions = path.join(this.codexHome(), "sessions");
    const files = new Set(await this.datedRollouts(sessions, since));
    const root = await this.rootFile(sessionId);
    if (root) files.add(root);
    const records: UsageRecord[] = [];
    for (const file of files)
      for (const usage of await this.cache.read(file))
        if (usage.rootSession === sessionId) records.push(usage.record);
    return records;
  }

  private async rootFile(sessionId: string): Promise<string | undefined> {
    const cached = this.rootFiles.get(sessionId);
    if (cached) return cached;
    try {
      const file = await findCodexTranscript(sessionId, this.codexHome());
      this.rootFiles.set(sessionId, file);
      return file;
    } catch {
      return undefined;
    }
  }

  // Rollouts live under sessions/YYYY/MM/DD by local creation date. Subagent
  // and resumed work after `since` is in folders from that day onward; one
  // extra day on each side covers the local time zone offset.
  private async datedRollouts(sessions: string, since: number): Promise<string[]> {
    const files: string[] = [];
    for (let day = startOfUtcDay(since - DAY_MS); day <= Date.now() + DAY_MS; day += DAY_MS) {
      const date = new Date(day);
      const directory = path.join(sessions, String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), pad(date.getUTCDate()));
      let names: string[];
      try { names = await fs.readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const name of names) if (name.startsWith("rollout-") && name.endsWith(".jsonl")) files.push(path.join(directory, name));
    }
    return files;
  }
}

function parseCodexLine(line: unknown, state: CodexParseState): CodexUsage | undefined {
  if (!isRecord(line) || !isRecord(line.payload)) return undefined;
  const payload = line.payload;
  if (line.type === "session_meta") {
    if (!state.ownThread && typeof payload.id === "string") state.ownThread = payload.id;
    return undefined;
  }
  if (line.type === "turn_context") {
    if (typeof payload.model === "string" && payload.model) state.model = payload.model;
    return undefined;
  }
  if (line.type !== "token_usage_record" || payload.thread_id !== state.ownThread || !isRecord(payload.usage) ||
      typeof payload.response_id !== "string" || typeof payload.session_id !== "string" || typeof line.timestamp !== "string")
    return undefined;
  const usage = payload.usage;
  // input_tokens includes both cache reads and cache writes.
  const cachedInput = count(usage.cached_input_tokens);
  const cacheWrite = count(usage.cache_write_input_tokens);
  return {
    rootSession: payload.session_id,
    record: {
      id: `codex:${payload.response_id}`,
      at: Date.parse(line.timestamp),
      model: state.model,
      input: Math.max(0, count(usage.input_tokens) - cachedInput - cacheWrite),
      cachedInput,
      cacheWrite,
      cacheWrite1h: 0,
      output: count(usage.output_tokens),
      reasoning: count(usage.reasoning_output_tokens),
      webSearches: 0,
      fast: false,
      usInference: false
    }
  };
}

function startOfUtcDay(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

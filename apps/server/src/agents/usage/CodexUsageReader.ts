import fs from "node:fs/promises";
import path from "node:path";

import { isRecord, usageIndexing } from "@cloudx/shared";

import { isCodexConversationId } from "../../plugins/CodexConversationRecovery.js";
import { JsonlCache, type JsonlCacheOptions } from "./JsonlCache.js";
import { UsageReadRequests } from "./UsageReadRequests.js";
import { count, isUsageRecord, type UsageRecord, type UsageSnapshot } from "./usageRecord.js";

interface CodexParseState {
  ownThread?: string;
  model: string;
  serviceTier?: string;
  activeTurn?: string;
  tierSnapshotTurn?: string;
  tierSnapshotPending?: boolean;
  tierUncertain?: boolean;
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
  private readonly cache: JsonlCache<CodexParseState, CodexUsage>;
  private readonly rootFiles = new Map<string, string>();
  private readonly requests = new UsageReadRequests();

  constructor(private readonly codexHome: () => string, options: JsonlCacheOptions<CodexParseState, CodexUsage> = {}) {
    this.cache = new JsonlCache(() => ({ model: "unknown" }), parseCodexLine, {
      ...options,
      // A parser revision must replay historical transcripts, not reuse records
      // indexed before requested service tiers were retained.
      directory: options.directory ? path.join(options.directory, "service-tiers-v3") : undefined,
      validateState: value => isRecord(value) && typeof value.model === "string" &&
        (value.ownThread === undefined || typeof value.ownThread === "string") &&
        (value.serviceTier === undefined || typeof value.serviceTier === "string") &&
        (value.activeTurn === undefined || typeof value.activeTurn === "string") &&
        (value.tierSnapshotTurn === undefined || typeof value.tierSnapshotTurn === "string") &&
        (value.tierSnapshotPending === undefined || typeof value.tierSnapshotPending === "boolean") &&
        (value.tierUncertain === undefined || typeof value.tierUncertain === "boolean"),
      validateResult: value => isRecord(value) && typeof value.rootSession === "string" && isUsageRecord(value.record)
    });
  }

  snapshot(sessionId: string, since: number, signal?: AbortSignal): Promise<UsageSnapshot> {
    const home = path.resolve(this.codexHome());
    return this.requests.read(JSON.stringify([home, sessionId, since]), active => this.readSnapshot(home, sessionId, since, active), signal);
  }

  async idle(): Promise<void> {
    await this.requests.idle();
    await this.cache.idle();
  }

  async dispose(): Promise<void> {
    await this.requests.dispose();
    await this.cache.dispose();
  }

  private async readSnapshot(home: string, sessionId: string, since: number, signal: AbortSignal): Promise<UsageSnapshot> {
    if (!isCodexConversationId(sessionId) || !Number.isFinite(since)) throw new Error("Usage requires an exact session and finite start time.");
    signal.throwIfAborted();
    const sessions = path.join(home, "sessions");
    const files = new Set(await this.datedRollouts(sessions, since, signal));
    const root = await this.rootFile(sessions, sessionId, files, signal);
    if (root) files.add(root);
    const snapshots = [];
    const records: UsageRecord[] = [];
    for (const file of files) {
      signal.throwIfAborted();
      const snapshot = await this.cache.readWithStatus(file);
      signal.throwIfAborted();
      snapshots.push(snapshot);
      for (const usage of snapshot.results)
        if (usage.rootSession === sessionId) records.push(usage.record);
    }
    if (!root) snapshots.push({ indexing: "error" as const });
    return { records, ...usageIndexing(snapshots) };
  }

  // Locate by directory metadata only. The normal recovery helper reads a 1 MiB
  // header; using it here would reread historical payload after every restart.
  private async rootFile(sessions: string, sessionId: string, candidates: Set<string>, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted();
    const key = JSON.stringify([sessions, sessionId]);
    const known = this.rootFiles.get(key);
    if (known) {
      try { if ((await fs.lstat(known)).isFile()) return known; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.rootFiles.delete(key);
    }
    let found = [...candidates].find(file => file.endsWith(`-${sessionId}.jsonl`));
    const pending = found ? [] : [sessions];
    let inspected = 0;
    while (pending.length && !found) {
      signal.throwIfAborted();
      const directory = pending.pop()!;
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      signal.throwIfAborted();
      for (const entry of entries) {
        if (++inspected > 100_000) throw new Error("Usage transcript lookup exceeded the directory limit.");
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(file);
        if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) { found = file; break; }
      }
    }
    if (found) this.rootFiles.set(key, found);
    return found;
  }

  // Rollouts live under sessions/YYYY/MM/DD by local creation date. Subagent
  // and resumed work after `since` is in folders from that day onward; one
  // extra day on each side covers the local time zone offset.
  private async datedRollouts(sessions: string, since: number, signal: AbortSignal): Promise<string[]> {
    const files: string[] = [];
    for (let day = startOfUtcDay(since - DAY_MS); day <= Date.now() + DAY_MS; day += DAY_MS) {
      signal.throwIfAborted();
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
  const initialTierSnapshot = state.tierSnapshotPending === true;
  state.tierSnapshotPending = false;
  if (line.type === "session_meta") {
    if (!state.ownThread && typeof payload.id === "string") state.ownThread = payload.id;
    return undefined;
  }
  if (line.type === "event_msg" && ["task_started", "turn_started"].includes(String(payload.type)) && typeof payload.turn_id === "string") {
    state.activeTurn = payload.turn_id;
    state.tierUncertain = false;
    return undefined;
  }
  if (line.type === "event_msg" && ["task_complete", "turn_complete"].includes(String(payload.type)) && payload.turn_id === state.activeTurn) {
    state.activeTurn = undefined;
    state.tierUncertain = false;
    return undefined;
  }
  if (line.type === "event_msg" && payload.type === "thread_settings_applied" && isRecord(payload.thread_settings) &&
      (payload.thread_id === undefined || payload.thread_id === state.ownThread)) {
    const tier = typeof payload.thread_settings.service_tier === "string" ? payload.thread_settings.service_tier : undefined;
    // Native checkpoints pair a new turn_context with its initial thread
    // snapshot. Later thread edits cannot identify an in-flight step's tier.
    if (initialTierSnapshot && state.activeTurn) state.tierSnapshotTurn = state.activeTurn;
    else if (state.activeTurn && tier !== state.serviceTier) state.tierUncertain = true;
    state.serviceTier = tier;
    return undefined;
  }
  if (line.type === "turn_context") {
    if (typeof payload.model === "string" && payload.model) state.model = payload.model;
    if (typeof payload.turn_id === "string") {
      if (payload.turn_id !== state.activeTurn) {
        state.activeTurn = payload.turn_id;
        state.tierUncertain = false;
      }
      state.tierSnapshotPending = state.tierSnapshotTurn !== payload.turn_id;
    }
    return undefined;
  }
  if (line.type !== "token_usage_record" || payload.thread_id !== state.ownThread || !isRecord(payload.usage) ||
      typeof payload.response_id !== "string" || typeof payload.session_id !== "string" || typeof line.timestamp !== "string" || !Number.isFinite(Date.parse(line.timestamp)))
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
      usInference: false,
      ...(state.serviceTier !== undefined ? { serviceTier: state.serviceTier } : {}),
      ...(state.tierUncertain ? { serviceTierUncertain: true } : {})
    }
  };
}

function startOfUtcDay(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

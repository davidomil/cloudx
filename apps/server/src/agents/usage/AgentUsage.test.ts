import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentUsageLedger } from "./AgentUsageLedger.js";
import { AgentUsageService } from "./AgentUsageService.js";
import { ClaudeUsageReader } from "./ClaudeUsageReader.js";
import { CodexUsageReader } from "./CodexUsageReader.js";
import { AgentPricing } from "./pricing.js";

const ROOT = "01a0d020-ce73-7ac0-aa53-fae268f725a0";
const CHILD = "01a0d37e-68ab-7d00-b67b-f247568d358f";
const CLAUDE_SESSION = "a5570c58-978a-4694-84f9-c67756be3acd";
const T0 = Date.parse("2026-10-05T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const lines = (entries: unknown[]) => `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;

function codexUsage(thread: string, session: string, response: string, minutes: number, usage: Record<string, number>) {
  return { timestamp: at(minutes), type: "token_usage_record", payload: { response_id: response, thread_id: thread, session_id: session, usage } };
}

async function codexHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-usage-"));
  const day = path.join(home, "sessions", "2026", "10", "05");
  await fs.mkdir(day, { recursive: true });
  // Root thread: two responses, one before and one after the tab took it over.
  await fs.writeFile(path.join(day, `rollout-2026-10-05T10-00-00-${ROOT}.jsonl`), lines([
    { timestamp: at(0), type: "session_meta", payload: { id: ROOT, source: "cli" } },
    { timestamp: at(0), type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    codexUsage(ROOT, ROOT, "resp-old", 1, { input_tokens: 1_000, cached_input_tokens: 0, output_tokens: 10 }),
    codexUsage(ROOT, ROOT, "resp-1", 20, { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 100_000, reasoning_output_tokens: 20_000 })
  ]));
  // Subagent fork: repeats the parent's history before its own records.
  await fs.writeFile(path.join(day, `rollout-2026-10-05T10-30-00-${CHILD}.jsonl`), lines([
    { timestamp: at(30), type: "session_meta", payload: { id: CHILD, source: { subagent: { thread_spawn: { parent_thread_id: ROOT } } } } },
    { timestamp: at(30), type: "session_meta", payload: { id: ROOT, source: "cli" } },
    codexUsage(ROOT, ROOT, "resp-1", 20, { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 100_000 }),
    { timestamp: at(30), type: "turn_context", payload: { model: "gpt-5.6-luna" } },
    codexUsage(CHILD, ROOT, "resp-2", 31, { input_tokens: 2_000_000, cached_input_tokens: 0, output_tokens: 0 })
  ]));
  return home;
}

async function claudeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-usage-"));
  const project = path.join(home, "projects", "-work");
  await fs.mkdir(path.join(project, CLAUDE_SESSION, "subagents"), { recursive: true });
  const usage = { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 }, output_tokens: 100_000,
    speed: "standard", inference_geo: "global", server_tool_use: { web_search_requests: 2 } };
  const message = (id: string, model: string, minutes: number) => ({ type: "assistant", timestamp: at(minutes), message: { id, model, usage } });
  await fs.writeFile(path.join(project, `${CLAUDE_SESSION}.jsonl`), lines([
    { type: "user", timestamp: at(0), message: { role: "user", content: "Hi" } },
    // One message written once per content block.
    message("msg-1", "claude-sonnet-5-5", 1), message("msg-1", "claude-sonnet-5-5", 1),
    { type: "assistant", timestamp: at(2), message: { id: "synthetic", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }
  ]));
  await fs.writeFile(path.join(project, CLAUDE_SESSION, "subagents", "agent-1.jsonl"), lines([message("msg-2", "claude-haiku-4-5-20251001", 3)]));
  return home;
}

describe("transcript readers", () => {
  it("counts each Codex response once and only in its own thread, with subagent threads", async () => {
    const records = await new CodexUsageReader(() => "").records(ROOT, T0);
    expect(records).toEqual([]);
    const home = await codexHome();
    const reader = new CodexUsageReader(() => home);
    const found = await reader.records(ROOT, T0);
    expect(found.map(record => [record.id, record.model, record.input, record.cachedInput]).sort()).toEqual([
      ["codex:resp-1", "gpt-6.1-sol", 200_000, 800_000],
      ["codex:resp-2", "gpt-5.6-luna", 2_000_000, 0],
      ["codex:resp-old", "gpt-6.1-sol", 1_000, 0]
    ]);
  });

  it("reads appended Codex records without rereading the file", async () => {
    const home = await codexHome();
    const reader = new CodexUsageReader(() => home);
    expect(await reader.records(ROOT, T0)).toHaveLength(3);
    const file = path.join(home, "sessions", "2026", "10", "05", `rollout-2026-10-05T10-00-00-${ROOT}.jsonl`);
    await fs.appendFile(file, lines([codexUsage(ROOT, ROOT, "resp-3", 40, { input_tokens: 10, output_tokens: 1 })]));
    expect((await reader.records(ROOT, T0)).map(record => record.id)).toContain("codex:resp-3");
  });

  it("reads Claude messages and subagents with cache lifetimes and web searches", async () => {
    const records = await new ClaudeUsageReader(await claudeHome().then(home => () => home)).records(CLAUDE_SESSION);
    expect(records.map(record => record.id)).toEqual(["claude:msg-1", "claude:msg-1", "claude:msg-2"]);
    expect(records[0]).toMatchObject({ input: 1_000_000, cachedInput: 1_000_000, cacheWrite: 0, cacheWrite1h: 1_000_000, output: 100_000, webSearches: 2 });
  });
});

describe("AgentUsageService", () => {
  async function service() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-usage-data-"));
    let now = T0 + 10 * 60_000;
    const ledger = new AgentUsageLedger(dataDir, () => now);
    const codex = await codexHome();
    const claude = await claudeHome();
    const usage = new AgentUsageService(ledger, new AgentPricing(dataDir), {
      codex: new CodexUsageReader(() => codex), claude: new ClaudeUsageReader(() => claude)
    });
    return { ledger, usage, dataDir, setNow: (minutes: number) => { now = T0 + minutes * 60_000; } };
  }

  it("counts only usage inside each tab's segments and prices it", async () => {
    const { ledger, usage, setNow } = await service();
    // The tab takes over the Codex conversation at minute 10, then switches to Claude at minute 35.
    await ledger.open({ tabId: "tab-1", forgeWorkerId: "issue-7" }, { providerId: "codex", accountKind: "subscription", sessionId: ROOT });
    setNow(0);
    await ledger.open({ tabId: "tab-2" }, { providerId: "claude", accountKind: "api-key", sessionId: CLAUDE_SESSION });
    setNow(35);
    await ledger.close("tab-1");

    const result = await usage.read({ tabIds: ["tab-1", "tab-2"], forgeWorkerIds: ["issue-7"] });
    const codexTab = result.tabs["tab-1"]!;
    // resp-old (minute 1) is before the segment; resp-1 and resp-2 count once each.
    expect(codexTab.totals).toMatchObject({ input: 2_200_000, cachedInput: 800_000, output: 100_000, reasoning: 20_000, requests: 2 });
    // Both requests exceed 272K input tokens, so long-context prices apply.
    // gpt-6.1-sol: 0.2M*$4 + 0.8M*$0.20 + 0.1M*$15 = $2.46. gpt-5.6-luna: 2M*$0.40 = $0.80.
    expect(codexTab.costUsd).toBeCloseTo(3.26, 6);
    expect(codexTab.costBasis).toBe("api-equivalent");
    expect(result.forgeWorkers["issue-7"]).toEqual(codexTab);

    const claudeTab = result.tabs["tab-2"]!;
    expect(claudeTab.totals.requests).toBe(2);
    // Sonnet 5.5: 1M*$2 + 1M*$0.20 + 1M*$4 (1h write) + 0.1M*$10 + 2 searches * $0.01 = $7.22.
    // Haiku 4.5: 1M*$1 + 1M*$0.10 + 1M*$2 + 0.1M*$5 + $0.02 = $3.62.
    expect(claudeTab.costUsd).toBeCloseTo(10.84, 6);
    expect(claudeTab.costBasis).toBe("api");
    expect(result.total.costUsd).toBeCloseTo(14.1, 6);
    expect(result.total.costBasis).toBe("mixed");
    expect(result.total.totals.requests).toBe(4);
  });

  it("reports unpriced models and applies price overrides", async () => {
    const { ledger, usage, dataDir } = await service();
    await ledger.open({ tabId: "tab-1" }, { providerId: "codex", accountKind: "api-key", sessionId: ROOT });
    await new AgentPricing(dataDir).updateOverrides({ "gpt-5.6-luna": { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 } });
    const priced = (await usage.read({ tabIds: ["tab-1"] })).tabs["tab-1"]!;
    expect(priced.costUsd).toBeCloseTo(2.46, 6);
    await expect(new AgentPricing(dataDir).updateOverrides({ "gpt-x": { input: -1 } })).rejects.toThrow("non-negative");
  });

  it("drops closed tabs from the ledger but keeps Forge worker history", async () => {
    const { ledger } = await service();
    await ledger.open({ tabId: "tab-1", forgeWorkerId: "issue-7" }, { providerId: "codex", accountKind: "subscription", sessionId: ROOT });
    await ledger.open({ tabId: "tab-2" }, { providerId: "codex", accountKind: "subscription", sessionId: ROOT });
    await ledger.prune(new Set());
    expect(await ledger.segments({ tabId: "tab-2" })).toEqual([]);
    expect(await ledger.segments({ forgeWorkerId: "issue-7" })).toHaveLength(1);
  });
});

describe("AgentUsageRecorder", () => {
  it("records the account kind and Forge worker of a tab's conversation", async () => {
    const { AgentUsageRecorder } = await import("./AgentUsageRecorder.js");
    const opened: unknown[] = [];
    const closed: string[] = [];
    const recorder = new AgentUsageRecorder(
      { open: async (owner, conversation) => { opened.push({ owner, conversation }); }, close: async tabId => { closed.push(tabId); } },
      { list: async () => [{ id: "claude-key", providerId: "claude", label: "Key", kind: "api-key", isDefault: true, createdAt: "" }] }
    );
    const tab = { id: "tab-1", pluginMetadata: { "forge-workers": { workerId: "issue-7" } } } as never;
    recorder.conversationStarted(tab, "claude", "claude-key", CLAUDE_SESSION);
    recorder.conversationStarted({ id: "tab-2" } as never, "codex", undefined, ROOT);
    recorder.ended("tab-1");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(opened).toHaveLength(2);
    expect(opened).toContainEqual({ owner: { tabId: "tab-1", forgeWorkerId: "issue-7" }, conversation: { providerId: "claude", sessionId: CLAUDE_SESSION, accountKind: "api-key" } });
    expect(opened).toContainEqual({ owner: { tabId: "tab-2" }, conversation: { providerId: "codex", sessionId: ROOT, accountKind: "subscription" } });
    expect(closed).toEqual(["tab-1"]);
  });
});

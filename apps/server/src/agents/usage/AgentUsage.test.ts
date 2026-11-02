import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentUsageLedger } from "./AgentUsageLedger.js";
import { AgentUsageService } from "./AgentUsageService.js";
import { ClaudeUsageReader } from "./ClaudeUsageReader.js";
import { CodexUsageReader } from "./CodexUsageReader.js";
import { AgentPricing } from "./pricing.js";
import { AgentUsagePlugin } from "../../plugins/AgentUsagePlugin.js";
import { HookRegistry } from "../../hooks/HookRegistry.js";

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

  it("separates Codex cache writes from ordinary input and prices each once", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-cache-write-"));
    const day = path.join(home, "sessions", "2026", "10", "05");
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(path.join(day, `rollout-2026-10-05T10-00-00-${ROOT}.jsonl`), lines([
      { timestamp: at(0), type: "session_meta", payload: { id: ROOT, source: "cli" } },
      { timestamp: at(0), type: "turn_context", payload: { model: "gpt-6.1-sol" } },
      codexUsage(ROOT, ROOT, "resp-write", 1, { input_tokens: 100_000, cached_input_tokens: 0, cache_write_input_tokens: 100_000, output_tokens: 0 })
    ]));
    const [record] = await new CodexUsageReader(() => home).records(ROOT, T0);
    expect(record).toMatchObject({ input: 0, cachedInput: 0, cacheWrite: 100_000 });
    const price = await new AgentPricing(home).pricer();
    expect(price(record!)).toBeCloseTo(0.25, 10);
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

  it("retains mixed-provider window totals after the last tab closes and the service restarts", async () => {
    const { ledger, usage, dataDir, setNow } = await service();
    setNow(0);
    await ledger.open({ tabId: "codex", windowId: "window-1" }, { providerId: "codex", accountKind: "subscription", sessionId: ROOT });
    await ledger.open({ tabId: "claude", windowId: "window-1" }, { providerId: "claude", accountKind: "api-key", sessionId: CLAUDE_SESSION });
    const before = (await usage.read({ windowIds: ["window-1"] })).windows["window-1"]!;
    setNow(35);
    await ledger.close("codex");
    await ledger.prune(new Set(["claude"]), undefined, new Set(["window-1"]));
    expect((await usage.read({ windowIds: ["window-1"] })).windows["window-1"]).toEqual(before);
    await ledger.close("claude");
    await ledger.prune(new Set(), undefined, new Set(["window-1"]));
    expect((await usage.read({ windowIds: ["window-1"] })).windows["window-1"]).toEqual(before);

    const restarted = new AgentUsageService(new AgentUsageLedger(dataDir), new AgentPricing(dataDir), {
      codex: new CodexUsageReader(() => codex), claude: new ClaudeUsageReader(() => claude)
    });
    const codex = await codexHome();
    const claude = await claudeHome();
    const result = await restarted.read({ windowIds: ["window-1", "unrelated"], tabIds: ["codex", "claude"] });
    expect(result.windows["window-1"]).toEqual(before);
    expect(result.total).toEqual(before);
    expect(result.windows.unrelated!.totals.requests).toBe(0);

    await ledger.prune(new Set(), new Set(), new Set());
    expect(await ledger.segments({ windowId: "window-1" })).toEqual([]);
  });

  it("counts continued work once when a closed conversation resumes in another tab", async () => {
    const { ledger, usage, setNow } = await service();
    setNow(10);
    await ledger.open({ tabId: "old", windowId: "window-1", forgeWorkerId: "worker" }, { providerId: "codex", accountKind: "subscription", sessionId: ROOT });
    setNow(25);
    await ledger.close("old");
    await ledger.open({ tabId: "new", windowId: "window-1" }, { providerId: "codex", accountKind: "subscription", sessionId: ROOT });
    const result = await usage.read({ windowIds: ["window-1"], tabIds: ["old", "new"], forgeWorkerIds: ["worker"] });
    expect(result.windows["window-1"]!.totals.requests).toBe(2);
    expect(result.tabs.old!.totals.requests).toBe(1);
    expect(result.tabs.new!.totals.requests).toBe(1);
    expect(result.total).toEqual(result.windows["window-1"]);
  });

  it("leaves recorded usage in its window when a running tab moves", async () => {
    const { ledger, usage, setNow } = await service();
    await ledger.open({ tabId: "moving", windowId: "window-1" }, { providerId: "codex", accountKind: "subscription", sessionId: ROOT });
    setNow(25);
    await ledger.synchronizeWindows(new Map([["moving", "window-2"]]));
    await ledger.synchronizeWindows(new Map([["moving", "window-2"]]));
    const result = await usage.read({ windowIds: ["window-1", "window-2"] });
    expect(result.windows["window-1"]!.totals.requests).toBe(1);
    expect(result.windows["window-2"]!.totals.requests).toBe(1);
    expect(await ledger.segments({ tabId: "moving" })).toHaveLength(2);
  });

  it("keeps a long-lived window's earliest usage beyond the former segment cap", async () => {
    const { dataDir } = await service();
    const segment = { tabId: "closed", windowId: "window-1", providerId: "codex", accountKind: "subscription", sessionId: ROOT, from: T0, to: T0 + 1 };
    await fs.writeFile(path.join(dataDir, "agent-usage-ledger.json"), JSON.stringify({ version: 1, segments: Array.from({ length: 20_001 }, (_, n) => ({ ...segment, tabId: `closed-${n}` })) }));
    const ledger = new AgentUsageLedger(dataDir);
    await ledger.open({ tabId: "new", windowId: "window-1" }, { providerId: "claude", accountKind: "api-key", sessionId: CLAUDE_SESSION });
    expect(await ledger.segments({ tabId: "closed-0" })).toHaveLength(1);
    expect(await new AgentUsageLedger(dataDir).segments({ windowId: "window-1" })).toHaveLength(20_002);
  });

  it("serves retained windows through the validated public hook with no open tabs", async () => {
    const { ledger, usage, dataDir, setNow } = await service();
    await ledger.open({ tabId: "closed", windowId: "window-1" }, { providerId: "codex", accountKind: "subscription", sessionId: ROOT });
    setNow(35);
    await ledger.close("closed");
    const hooks = new HookRegistry();
    const plugin = new AgentUsagePlugin(usage, ledger, new AgentPricing(dataDir), () => ({ tabIds: [], windowIds: ["window-1"], tabWindows: new Map() }));
    for (const hook of plugin.hooks) hooks.register(hook);
    const context = { caller: { kind: "ui" } } as never;
    const result = await hooks.call("agent-usage.read", { windowIds: ["window-1"] }, context);
    expect(result).toMatchObject({ usage: { windows: { "window-1": { totals: { requests: 2 }, costUsd: 3.26 } } } });
    await expect(hooks.call("agent-usage.read", { windowIds: [42] }, context)).rejects.toThrow();
    await expect(hooks.call("agent-usage.read", { windowIds: Array(501).fill("window-1") }, context)).rejects.toThrow();
    expect(await ledger.segments({ windowId: "window-1" })).toHaveLength(1);
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
  it("attributes prepared tabs to the requested window, then follows published placement", async () => {
    const { AgentUsageRecorder } = await import("./AgentUsageRecorder.js");
    const opened: unknown[] = [];
    const placement = new Map<string, string>();
    const recorder = new AgentUsageRecorder(
      { open: async owner => { opened.push(owner); }, close: async () => undefined },
      { list: async () => [] }, undefined,
      (tabId, launchWindow) => placement.get(tabId) ?? launchWindow
    );
    recorder.conversationStarted({ id: "prepared" } as never, "codex", undefined, ROOT, "requested");
    placement.set("prepared", "moved");
    recorder.conversationStarted({ id: "prepared" } as never, "claude", undefined, CLAUDE_SESSION, "requested");
    await recorder.flush();
    expect(opened).toEqual([{ tabId: "prepared", windowId: "requested" }, { tabId: "prepared", windowId: "moved" }]);
  });

  it("captures the originating window and closes after an asynchronous account lookup", async () => {
    const { AgentUsageRecorder } = await import("./AgentUsageRecorder.js");
    const calls: unknown[] = [];
    let finishLookup!: (accounts: never[]) => void;
    let windowId = "original";
    const recorder = new AgentUsageRecorder(
      { open: async owner => { calls.push(owner); }, close: async tabId => { calls.push({ closed: tabId }); } },
      { list: () => new Promise(resolve => { finishLookup = resolve; }) },
      undefined
    );
    recorder.conversationStarted({ id: "tab" } as never, "claude", "account", CLAUDE_SESSION, windowId);
    recorder.ended("tab");
    windowId = "different";
    await Promise.resolve();
    expect(calls).toEqual([]);
    finishLookup([]);
    await recorder.flush();
    expect(calls).toEqual([{ tabId: "tab", windowId: "original" }, { closed: "tab" }]);
  });

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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentUsageLedger } from "./AgentUsageLedger.js";
import { AgentUsageService } from "./AgentUsageService.js";
import { ClaudeUsageReader } from "./ClaudeUsageReader.js";
import { CodexUsageReader } from "./CodexUsageReader.js";
import { UsageScanScheduler } from "./UsageScanScheduler.js";
import { AgentPricing } from "./pricing.js";

const ROOT = "01a0d020-ce73-7ac0-aa53-fae268f725a0";
const CHILD = "01a0d37e-68ab-7d00-b67b-f247568d358f";
const OTHER = "01a0d020-ce73-7ac0-aa53-fae268f725a1";
const CLAUDE = "a5570c58-978a-4694-84f9-c67756be3acd";
const FROM = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const REQUEST = { tabIds: ["codex", "claude"], windowIds: ["window"], forgeWorkerIds: ["worker"] };
const encode = (entries: unknown[]) => `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
const timestamp = (seconds: number) => new Date(FROM + seconds * 1000).toISOString();

interface SourceRead { file: string; offset: number; bytes: number }
interface Fixture { root: string; data: string; codexHome: string; claudeHome: string; codexFile: string; claudeFile: string; files: string[] }
interface Runtime {
  scheduler: UsageScanScheduler;
  codex: CodexUsageReader;
  claude: ClaudeUsageReader;
  ledger: AgentUsageLedger;
  pricing: AgentPricing;
  usage: AgentUsageService;
  reads: SourceRead[];
}

const roots: string[] = [];
const runtimes: Runtime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) {
    await runtime.usage.dispose();
    await runtime.scheduler.dispose();
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function codexResponse(thread: string, response: string, seconds: number, multiplier = 1, session = ROOT) {
  return { type: "token_usage_record", timestamp: timestamp(seconds), payload: {
    thread_id: thread, session_id: session, response_id: response,
    usage: { input_tokens: 100 * multiplier, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 3 }
  } };
}

function claudeResponse(id: string, seconds: number, multiplier = 1) {
  return { type: "assistant", timestamp: timestamp(seconds), message: { id, model: "claude-sonnet-5-5",
    usage: { input_tokens: 50 * multiplier, cache_read_input_tokens: 10, output_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 } }
  } };
}

async function fixture(multiplier = 1): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-usage-backfill-"));
  roots.push(root);
  const codexHome = path.join(root, "codex");
  const claudeHome = path.join(root, "claude");
  const day = (time: number) => path.join(codexHome, "sessions", ...new Date(time).toISOString().slice(0, 10).split("-"));
  const current = day(FROM);
  const historical = day(FROM - 7 * 86_400_000);
  const project = path.join(claudeHome, "projects", "-project");
  const subagents = path.join(project, CLAUDE, "subagents");
  await Promise.all([fs.mkdir(current, { recursive: true }), fs.mkdir(historical, { recursive: true }), fs.mkdir(subagents, { recursive: true })]);
  const codexFile = path.join(historical, `rollout-old-${ROOT}.jsonl`);
  const codexChild = path.join(current, `rollout-child-${CHILD}.jsonl`);
  const unrelated = path.join(current, `rollout-other-${OTHER}.jsonl`);
  const claudeFile = path.join(project, `${CLAUDE}.jsonl`);
  const claudeChild = path.join(subagents, "agent-1.jsonl");
  const padding = { type: "event_msg", payload: { message: "history ".repeat(256) } };
  await Promise.all([
    fs.writeFile(codexFile, encode([
      { type: "session_meta", payload: { id: ROOT } },
      { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
      codexResponse(ROOT, "before-window", -1, multiplier),
      ...Array.from({ length: 8 }, (_, n) => [padding, codexResponse(ROOT, `shared-${n}`, n + 1, multiplier)]).flat()
    ])),
    fs.writeFile(codexChild, encode([
      { type: "session_meta", payload: { id: CHILD } },
      { type: "session_meta", payload: { id: ROOT } },
      { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
      codexResponse(ROOT, "shared-0", 1, multiplier),
      ...Array.from({ length: 3 }, (_, n) => [padding, codexResponse(CHILD, `child-${n}`, n + 20, multiplier)]).flat()
    ])),
    fs.writeFile(unrelated, encode([
      { type: "session_meta", payload: { id: OTHER } },
      codexResponse(OTHER, "unrelated", 1, 1000, OTHER)
    ])),
    fs.writeFile(claudeFile, encode(Array.from({ length: 8 }, (_, n) => [padding,
      claudeResponse(`shared-${n}`, n + 1, multiplier), claudeResponse(`shared-${n}`, n + 1, multiplier)
    ]).flat())),
    fs.writeFile(claudeChild, encode(Array.from({ length: 3 }, (_, n) => [padding, claudeResponse(`child-${n}`, n + 20, multiplier)]).flat()))
  ]);
  const data = path.join(root, "data");
  const ledger = new AgentUsageLedger(data, () => FROM);
  await ledger.open({ tabId: "codex", windowId: "window", forgeWorkerId: "worker" },
    { providerId: "codex", accountKind: "subscription", sessionId: ROOT });
  await ledger.open({ tabId: "claude", windowId: "window", forgeWorkerId: "worker" },
    { providerId: "claude", accountKind: "api-key", sessionId: CLAUDE });
  return { root, data, codexHome, claudeHome, codexFile, claudeFile, files: [codexFile, codexChild, unrelated, claudeFile, claudeChild] };
}

function start(source: Fixture, options: { sliceBytes?: number; intervalMs?: number; onRead?: (read: SourceRead) => void } = {}): Runtime {
  const scheduler = new UsageScanScheduler({ sliceBytes: options.sliceBytes ?? 4096, intervalMs: options.intervalMs ?? 0 });
  const reads: SourceRead[] = [];
  const onRead = (file: string, offset: number, bytes: number) => {
    const read = { file, offset, bytes };
    reads.push(read);
    options.onRead?.(read);
  };
  const index = path.join(source.data, "agent-usage-index", "v1");
  const codex = new CodexUsageReader(() => source.codexHome, { directory: path.join(index, "codex"), scheduler, onRead });
  const claude = new ClaudeUsageReader(() => source.claudeHome, { directory: path.join(index, "claude"), scheduler, onRead });
  const ledger = new AgentUsageLedger(source.data, () => FROM + 100_000);
  const pricing = new AgentPricing(source.data);
  const usage = new AgentUsageService(ledger, pricing, { codex, claude });
  const runtime = { scheduler, codex, claude, ledger, pricing, usage, reads };
  runtimes.push(runtime);
  return runtime;
}

async function complete(runtime: ReturnType<typeof start>) {
  await runtime.usage.read(REQUEST);
  await runtime.scheduler.idle();
  return runtime.usage.read(REQUEST);
}

async function expectSinglePass(reads: SourceRead[], files: string[], starts: Map<string, number> = new Map()) {
  for (const file of files) {
    let position = starts.get(file) ?? 0;
    for (const read of reads.filter(read => read.file === file).sort((a, b) => a.offset - b.offset)) {
      expect(read.offset, file).toBe(position);
      position += read.bytes;
    }
    expect(position, file).toBe((await fs.stat(file)).size);
  }
}

describe("durable usage backfill through the production service", () => {
  it("returns incomplete totals while overlapping requests share bounded background reads", async () => {
    const source = await fixture();
    const runtime = start(source, { sliceBytes: 1024, intervalMs: 10 });
    const responses = await Promise.all(Array.from({ length: 12 }, () => runtime.usage.read(REQUEST)));
    for (const response of responses) {
      expect(response.total.indexing).toBe("backfilling");
      expect(response.total.totals.requests).toBeLessThan(22);
    }
    await runtime.scheduler.idle();
    const result = await runtime.usage.read(REQUEST);
    expect(result.total.indexing).toBeUndefined();
    expect(result.total.totals.requests).toBe(22);
    expect(result.tabs.codex!.totals.requests).toBe(11);
    expect(result.tabs.claude!.totals.requests).toBe(11);
    expect(result.tabs.codex!.costBasis).toBe("api-equivalent");
    expect(result.tabs.claude!.costBasis).toBe("api");
    expect(result.total.costBasis).toBe("mixed");
    expect(runtime.reads.every(read => read.bytes <= 1024)).toBe(true);
    await expectSinglePass(runtime.reads, source.files);
  });

  it("reopens retained mixed-provider window and Forge totals without historical payload reads", async () => {
    const source = await fixture();
    const first = start(source);
    const before = await complete(first);
    await first.ledger.close("codex");
    await first.ledger.close("claude");
    await first.ledger.prune(new Set(), new Set(["worker"]), new Set(["window"]));
    await first.usage.dispose();
    await first.scheduler.dispose();

    const payloadReads: number[] = [];
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (source.files.includes(String(args[0]))) {
        const originalRead = handle.read;
        handle.read = (async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(originalRead, handle, readArgs);
          payloadReads.push(result.bytesRead);
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    const restarted = start(source);
    const result = await restarted.usage.read(REQUEST);
    await restarted.scheduler.idle();
    expect(result).toEqual(before);
    expect(restarted.reads).toEqual([]);
    expect(payloadReads).toEqual([]);
    expect(result.windows.window).toEqual(result.forgeWorkers.worker);
    expect(result.total).toEqual(result.windows.window);
  });

  it("ignores malformed timestamp records without corrupting the durable provider indexes", async () => {
    const source = await fixture();
    const badCodex = { ...codexResponse(ROOT, "invalid", 40), timestamp: "invalid" };
    const badClaude = { ...claudeResponse("invalid", 40), timestamp: "invalid" };
    await Promise.all([fs.appendFile(source.codexFile, encode([badCodex])), fs.appendFile(source.claudeFile, encode([badClaude]))]);
    const first = start(source);
    const result = await complete(first);
    expect(result.total.totals.requests).toBe(22);
    expect(result.total.indexing).toBeUndefined();
    await first.usage.dispose();
    await first.scheduler.dispose();
    const restarted = start(source);
    expect(await restarted.usage.read(REQUEST)).toEqual(result);
    expect(restarted.reads).toEqual([]);
  });

  it("reads only appended byte ranges and counts each provider response once after restart", async () => {
    const source = await fixture();
    const first = start(source);
    await complete(first);
    await first.usage.dispose();
    await first.scheduler.dispose();
    const offsets = new Map(await Promise.all(source.files.map(async file => [file, (await fs.stat(file)).size] as const)));
    const codexAppend = encode([codexResponse(ROOT, "appended", 40)]);
    const claudeAppend = encode([claudeResponse("appended", 40), claudeResponse("appended", 40)]);
    await Promise.all([fs.appendFile(source.codexFile, codexAppend), fs.appendFile(source.claudeFile, claudeAppend)]);
    const restarted = start(source);
    const result = await complete(restarted);
    expect(result.total.totals.requests).toBe(24);
    expect(result.tabs.codex!.totals.requests).toBe(12);
    expect(result.tabs.claude!.totals.requests).toBe(12);
    expect(restarted.reads.reduce((sum, read) => sum + read.bytes, 0)).toBe(Buffer.byteLength(codexAppend + claudeAppend));
    await expectSinglePass(restarted.reads, source.files, offsets);
    const count = restarted.reads.length;
    expect(await restarted.usage.read(REQUEST)).toEqual(result);
    expect(restarted.reads).toHaveLength(count);
  });

  it("stops scheduled scans on service disposal and resumes their durable checkpoint", async () => {
    const source = await fixture();
    let readFirst!: () => void;
    const firstRead = new Promise<void>(resolve => { readFirst = resolve; });
    const first = start(source, { sliceBytes: 1024, intervalMs: 50, onRead: () => readFirst() });
    expect((await first.usage.read(REQUEST)).total.indexing).toBe("backfilling");
    await firstRead;
    await first.usage.dispose();
    await expect(first.usage.read(REQUEST)).rejects.toMatchObject({ name: "AbortError" });
    const stopped = first.reads.length;
    await first.scheduler.idle();
    expect(first.reads).toHaveLength(stopped);
    expect(stopped).toBeGreaterThan(0);
    const totalBytes = (await Promise.all(source.files.map(file => fs.stat(file)))).reduce((sum, info) => sum + info.size, 0);
    expect(first.reads.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThan(totalBytes);
    const durableOffsets = new Map(await Promise.all(source.files.map(async file => {
      const bytes = await fs.readFile(file);
      const position = Math.max(0, ...first.reads.filter(read => read.file === file).map(read => read.offset + read.bytes));
      const completeLine = position === bytes.length ? position : position ? bytes.lastIndexOf(10, position - 1) + 1 : 0;
      return [file, completeLine] as const;
    })));
    const restarted = start(source);
    expect((await complete(restarted)).total.totals.requests).toBe(22);
    await expectSinglePass(restarted.reads, source.files, durableOffsets);
  });

  it("cancels obsolete owner work while previously scheduled shared indexing continues", async () => {
    const source = await fixture();
    const runtime = start(source);
    const controller = new AbortController();
    const originalSnapshot = runtime.codex.snapshot.bind(runtime.codex);
    vi.spyOn(runtime.codex, "snapshot").mockImplementation(async (...args) => {
      const snapshot = await originalSnapshot(...args);
      controller.abort();
      return snapshot;
    });
    await expect(runtime.usage.read({ tabIds: ["codex", "claude"] }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await runtime.scheduler.idle();
    expect(runtime.reads.some(read => read.file === source.codexFile)).toBe(true);
    expect(runtime.reads.some(read => read.file.startsWith(source.claudeHome))).toBe(false);
    vi.restoreAllMocks();
    expect((await complete(runtime)).total.totals.requests).toBe(22);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(runtime.usage.read(REQUEST, alreadyAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects canceled consumers before native discovery finishes and stops further discovery", async () => {
    const source = await fixture();
    const runtime = start(source);
    const controller = new AbortController();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalReadDirectory = fs.readdir.bind(fs);
    const discovered: string[] = [];
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
      const directory = String(args[0]);
      discovered.push(directory);
      if (directory === path.dirname(source.files[1]!)) {
        enter();
        await gate;
      }
      return Reflect.apply(originalReadDirectory, fs, args);
    }) as typeof fs.readdir);
    const reading = runtime.usage.read(REQUEST, controller.signal);
    await entered;
    const count = discovered.length;
    let timeout!: ReturnType<typeof setTimeout>;
    const stalled = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Canceled consumer waited for native discovery.")), 1000);
    });
    try {
      controller.abort();
      await expect(Promise.race([reading, stalled])).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timeout);
      release();
    }
    await runtime.usage.dispose();
    expect(discovered).toHaveLength(count);
    expect(runtime.reads).toEqual([]);
  });

  it("isolates cached provider records when homes contain the same session and response identities", async () => {
    const source = await fixture();
    const first = start(source);
    const before = await complete(first);
    await first.usage.dispose();
    await first.scheduler.dispose();
    const alternate = await fixture(2);
    const second = start({ ...alternate, data: source.data });
    const after = await complete(second);
    expect(after.total.totals.requests).toBe(22);
    expect(after.total.totals.input).toBeGreaterThan(before.total.totals.input);
    expect(after.tabs.codex!.totals.input).toBe(11 * 180);
    expect(after.tabs.claude!.totals.input).toBe(11 * 100);
    expect(second.reads.every(read => alternate.files.includes(read.file))).toBe(true);
    await expectSinglePass(second.reads, alternate.files);
  });
});

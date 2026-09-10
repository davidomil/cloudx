import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginSessionNotStartedError, type PreparedCodexLaunch } from "@cloudx/plugin-api";

import { CodexStateSources } from "../plugins/CodexStateSources.js";
import { AppServerOwnershipError } from "../appServer/OwnedAppServerTransport.js";
import { ForgeReviewConversation, isReviewConversationBinding, retireReviewSessionView, type ReviewConversationBinding } from "./ForgeReviewConversation.js";

const threadId = "01a08470-d118-7b72-b1df-439e72e5c744";
let root: string;
let dataDir: string;
let launch: PreparedCodexLaunch;
let thread: Record<string, unknown>;
let binding: ReviewConversationBinding | undefined;

class ConversationTransport {
  requests: Record<string, unknown>[] = [];
  respond: (method: string) => unknown = method => method === "initialize" || method === "thread/inject_items" ? {} : method === "thread/unsubscribe" ? { status: "unsubscribed" } : { thread };
  private listener: ((message: Record<string, unknown>) => void) | undefined;
  close = vi.fn();
  finish = vi.fn(async () => undefined);
  terminate = vi.fn(async () => undefined);
  send(message: Record<string, unknown>): void {
    this.requests.push(message);
    if (message.id !== undefined) this.listener?.({ id: message.id, result: this.respond(message.method as string) });
  }
  onMessage(listener: (message: Record<string, unknown>) => void): void { this.listener = listener; }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-review-conversation-"));
  const home = path.join(root, "home");
  dataDir = path.join(root, "data");
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(path.join(home, "sessions"), { mode: 0o700 });
  await fs.mkdir(path.join(home, "archived_sessions"), { mode: 0o700 });
  vi.stubEnv("CODEX_HOME", home);
  const sources = new CodexStateSources(dataDir);
  const source = await sources.resolve();
  const overlay = await sources.bind("review-tab", source);
  await fs.symlink(path.join(home, "sessions"), path.join(overlay, "sessions"));
  await fs.symlink(path.join(home, "archived_sessions"), path.join(overlay, "archived_sessions"));
  await sources.dispose();
  const rollout = path.join(home, "sessions", `rollout-${threadId}.jsonl`);
  await fs.writeFile(rollout, "Native-owned conversation\n");
  launch = { tabId: "review-tab", cwd: root, command: "/configured/codex", configurationArgs: ["--disable", "plugins"], env: { CODEX_HOME: overlay, CODEX_SQLITE_HOME: home } };
  thread = { id: threadId, cwd: root, ephemeral: false, path: rollout };
  binding = undefined;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function options() {
  return { binding, model: "gpt-6-astra", reasoningEffort: "max" as const, save: async (next: ReviewConversationBinding | undefined) => { binding = structuredClone(next); } };
}

it("persists the returned exact thread before releasing its app-server writer", async () => {
  const transport = new ConversationTransport();
  transport.terminate.mockImplementation(async () => { expect(binding).toMatchObject({ threadId, creating: false }); });
  const createTransport = vi.fn(async () => transport);
  const service = new ForgeReviewConversation(dataDir, createTransport);

  expect(await service.prepare(launch, options())).toBe(threadId);

  expect(createTransport).toHaveBeenCalledExactlyOnceWith(launch, undefined);
  expect(transport.requests.map(request => request.method)).toEqual(["initialize", "initialized", "thread/start", "thread/inject_items", "thread/unsubscribe", "thread/resume", "thread/unsubscribe"]);
  expect(transport.requests[2]).toMatchObject({ params: { cwd: root, model: "gpt-6-astra", ephemeral: false, config: { model_reasoning_effort: "max" } } });
  expect(transport.requests[3]).toMatchObject({ params: { threadId, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: expect.stringContaining("Forge review") }] }] } });
  expect(transport.terminate).toHaveBeenCalledOnce();
  const second = new ConversationTransport();
  expect(await new ForgeReviewConversation(dataDir, async () => second).prepare(launch, options())).toBe(threadId);
  expect(second.requests.map(request => request.method)).toEqual(["initialize", "initialized", "thread/resume", "thread/unsubscribe"]);
  expect(second.requests[2]).toMatchObject({ params: { threadId, excludeTurns: true } });
  expect(second.requests[2]!.params).not.toHaveProperty("cwd");
});

it.each([
  { cwd: "/another-checkout" }, { ephemeral: true }, { id: "latest" },
])("rejects an invalid native conversation receipt %j and retains ambiguous creation", async mutation => {
  const transport = new ConversationTransport();
  thread = { ...thread, ...mutation };
  await expect(new ForgeReviewConversation(dataDir, async () => transport).prepare(launch, options())).rejects.toBeInstanceOf(PluginSessionNotStartedError);
  expect(binding).toMatchObject({ creating: true });
  expect(transport.terminate).toHaveBeenCalledOnce();
  const createTransport = vi.fn(async () => new ConversationTransport());
  await expect(new ForgeReviewConversation(dataDir, createTransport).prepare(launch, options())).rejects.toThrow(/initialization.*unresolved/i);
  expect(createTransport).not.toHaveBeenCalled();
});

it("uses Codex's saved thread authority when no JSONL projection exists", async () => {
  await fs.rm(thread.path as string);
  const transport = new ConversationTransport();
  transport.respond = method => {
    if (method === "thread/unsubscribe") {
      expect(binding).toMatchObject({ threadId, creating: false });
      return { status: "unsubscribed" };
    }
    return method === "initialize" || method === "thread/inject_items" ? {} : { thread };
  };
  expect(await new ForgeReviewConversation(dataDir, async () => transport).prepare(launch, options())).toBe(threadId);
  await expect(fs.stat(thread.path as string)).rejects.toMatchObject({ code: "ENOENT" });
  expect(transport.requests.some(request => request.method === "thread/resume")).toBe(true);
});

it.each(["thread/unsubscribe", "thread/resume"])("retains a known exact identity when %s fails", async failedMethod => {
  const transport = new ConversationTransport();
  transport.respond = method => {
    if (method === failedMethod) throw new Error("Native saved conversation is unavailable.");
    return method === "initialize" || method === "thread/inject_items" ? {} : method === "thread/unsubscribe" ? { status: "unsubscribed" } : { thread };
  };
  await expect(new ForgeReviewConversation(dataDir, async () => transport).prepare(launch, options())).rejects.toBeInstanceOf(PluginSessionNotStartedError);
  expect(binding).toMatchObject({ threadId, creating: false });
  expect(transport.requests.at(-1)?.method).toBe(failedMethod);
  const second = new ConversationTransport();
  expect(await new ForgeReviewConversation(dataDir, async () => second).prepare(launch, options())).toBe(threadId);
  expect(second.requests.some(request => request.method === "thread/start")).toBe(false);
});

it.each(["rejected", "response lost"])("preserves an unresolved initialization after its context injection is %s", async outcome => {
  const transport = new ConversationTransport();
  let nativeContextStored = false;
  transport.respond = method => {
    if (method === "thread/inject_items") {
      nativeContextStored = outcome === "response lost";
      throw new Error("Context initialization was not confirmed.");
    }
    return method === "initialize" ? {} : { thread };
  };
  await expect(new ForgeReviewConversation(dataDir, async () => transport).prepare(launch, options())).rejects.toThrow("not confirmed");
  expect(binding).toMatchObject({ threadId, creating: true });
  expect(isReviewConversationBinding(binding)).toBe(true);
  expect(nativeContextStored).toBe(outcome === "response lost");
  const createTransport = vi.fn(async () => new ConversationTransport());

  await expect(new ForgeReviewConversation(dataDir, createTransport).prepare(launch, options())).rejects.toThrow(/initialization.*unresolved/i);
  expect(createTransport).not.toHaveBeenCalled();
});

it.each(["source marker", "history link"])("rejects a changed origin %s before resuming from a later view", async mutation => {
  await new ForgeReviewConversation(dataDir, async () => new ConversationTransport()).prepare(launch, options());
  const sources = new CodexStateSources(dataDir);
  const laterView = await sources.bind("later-review", binding!.source);
  await sources.dispose();
  if (mutation === "source marker") await fs.unlink(path.join(launch.env.CODEX_HOME!, ".cloudx-source.json"));
  else {
    await fs.unlink(path.join(launch.env.CODEX_HOME!, "sessions"));
    await fs.symlink(root, path.join(launch.env.CODEX_HOME!, "sessions"));
  }
  const laterLaunch = { ...launch, tabId: "later-review", env: { ...launch.env, CODEX_HOME: laterView } };
  const createTransport = vi.fn(async () => new ConversationTransport());

  await expect(new ForgeReviewConversation(dataDir, createTransport).prepare(laterLaunch, options())).rejects.toThrow(/source.*missing|history link changed/i);
  expect(createTransport).not.toHaveBeenCalled();
});

it("keeps the exact created thread when cancellation stops preparation", async () => {
  const transport = new ConversationTransport();
  const controller = new AbortController();
  const setup = options();
  setup.save = async next => {
    binding = structuredClone(next);
    if (next?.threadId) controller.abort(new Error("Review paused."));
  };
  await expect(new ForgeReviewConversation(dataDir, async () => transport).prepare(launch, setup, controller.signal)).rejects.toThrow("Review paused.");
  expect(binding).toMatchObject({ threadId, creating: false });
  expect(transport.terminate).toHaveBeenCalledOnce();
});

it("preserves unresolved process ownership instead of declaring a safe startup failure", async () => {
  const transport = new ConversationTransport();
  const failure = new AppServerOwnershipError("Native descendant cleanup is unconfirmed.");
  transport.terminate.mockRejectedValue(failure);
  await expect(new ForgeReviewConversation(dataDir, async () => transport).prepare(launch, options())).rejects.toBe(failure);
  expect(binding).toMatchObject({ threadId, creating: false });
});

it("rejects changed shared storage before starting another app-server", async () => {
  await new ForgeReviewConversation(dataDir, async () => new ConversationTransport()).prepare(launch, options());
  binding!.source.ino = "0";
  const createTransport = vi.fn(async () => new ConversationTransport());
  await expect(new ForgeReviewConversation(dataDir, createTransport).prepare(launch, options())).rejects.toThrow(/source.*changed/i);
  expect(createTransport).not.toHaveBeenCalled();
});

it("retires launch credentials and generated files while native history keeps its original path", async () => {
  await new ForgeReviewConversation(dataDir, async () => new ConversationTransport()).prepare(launch, options());
  const view = launch.env.CODEX_HOME!;
  const stat = await fs.stat(view, { bigint: true });
  const expected = { path: view, dev: stat.dev.toString(), ino: stat.ino.toString() };
  await fs.mkdir(path.join(view, "skills"));
  await fs.writeFile(path.join(view, "skills", "SKILL.md"), "Generated skills");
  await fs.writeFile(path.join(view, "auth.json"), "Private launch authentication");
  await fs.writeFile(path.join(view, "config.toml"), "Generated trusted configuration");

  await retireReviewSessionView(dataDir, launch.tabId, expected, binding!);

  expect((await fs.readdir(view)).sort()).toEqual([".cloudx-source.json", "archived_sessions", "sessions"]);
  expect(await fs.readFile(path.join(view, "sessions", path.basename(thread.path as string)), "utf8")).toBe("Native-owned conversation\n");
  await retireReviewSessionView(dataDir, launch.tabId, expected, binding!);
  expect((await fs.stat(view, { bigint: true })).ino).toBe(stat.ino);
});

it.each(["view", "history link"])("preserves a replaced reviewer %s during retirement", async replacement => {
  await new ForgeReviewConversation(dataDir, async () => new ConversationTransport()).prepare(launch, options());
  const view = launch.env.CODEX_HOME!;
  const stat = await fs.stat(view, { bigint: true });
  const expected = { path: view, dev: stat.dev.toString(), ino: stat.ino.toString() };
  if (replacement === "view") {
    await fs.rename(view, `${view}-original`);
    await fs.mkdir(view);
    await fs.writeFile(path.join(view, ".cloudx-source.json"), JSON.stringify({ version: 1, ...binding!.source }));
  } else {
    await fs.unlink(path.join(view, "sessions"));
    await fs.symlink(root, path.join(view, "sessions"));
  }
  await fs.writeFile(path.join(view, "auth.json"), "Preserve replacement evidence");

  await expect(retireReviewSessionView(dataDir, launch.tabId, expected, binding!)).rejects.toThrow(/ownership changed|history link changed/i);
  expect(await fs.readFile(path.join(view, "auth.json"), "utf8")).toBe("Preserve replacement evidence");
});

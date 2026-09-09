import fs from "node:fs/promises";
import path from "node:path";
import { PluginSessionNotStartedError, type PreparedCodexLaunch } from "@cloudx/plugin-api";
import { isRecord, type CodexReasoningEffort } from "@cloudx/shared";

import { AppServerClient, type AppServerTransport } from "../appServer/AppServerClient.js";
import { AppServerOwnershipError, OwnedAppServerTransport } from "../appServer/OwnedAppServerTransport.js";
import { openOwnedDirectoryNoFollow, type OwnedDirectoryIdentity } from "../jsonStateFile.js";
import { CodexStateSources, type ResolvedCodexStateSource } from "../plugins/CodexStateSources.js";

interface ConversationDirectory { path: string; dev: string; ino: string }

export interface ReviewConversationBinding {
  source: ResolvedCodexStateSource;
  sqliteHome: ConversationDirectory;
  originView: OwnedDirectoryIdentity;
  creating: boolean;
  threadId?: string;
}

interface ConversationTransport extends AppServerTransport { finish(): Promise<void>; terminate(): Promise<void> }

/** Creates one durable reviewer thread and verifies that exact thread on later launches. */
export class ForgeReviewConversation {
  constructor(
    private readonly dataDir: string,
    private readonly createTransport: (launch: PreparedCodexLaunch, signal?: AbortSignal) => Promise<ConversationTransport> = (launch, signal) => OwnedAppServerTransport.create(launch, signal),
  ) {}

  async prepare(
    launch: PreparedCodexLaunch,
    options: {
      binding?: ReviewConversationBinding;
      model: string;
      reasoningEffort: CodexReasoningEffort;
      save: (binding: ReviewConversationBinding | undefined) => Promise<void>;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const sources = new CodexStateSources(this.dataDir);
    let transport: ConversationTransport | undefined;
    let client: AppServerClient | undefined;
    let abortError: unknown;
    let creatingThread = false;
    const abort = () => {
      if (creatingThread) return;
      try { client?.close(); } catch (error) { abortError = error; }
    };
    try {
      signal?.throwIfAborted();
      const source = await sources.readBinding(launch.tabId, signal);
      if (!source || launch.env.CODEX_HOME !== sources.viewPath(launch.tabId))
        throw new Error("Reviewer conversation requires the prepared Codex source overlay.");
      const sqlitePath = launch.env.CODEX_SQLITE_HOME?.trim();
      if (!sqlitePath || !path.isAbsolute(sqlitePath)) throw new Error("Reviewer conversation requires an absolute Codex SQLite home.");
      const sqliteHome = await directory(sqlitePath);
      const view = await directory(launch.env.CODEX_HOME);
      let binding = options.binding;
      if (binding && (!sameSource(binding.source, source) || !sameDirectory(binding.sqliteHome, sqliteHome)))
        throw new Error("The reviewer conversation source changed. Its existing context was preserved.");
      if (binding?.creating) throw new Error("Reviewer conversation initialization is unresolved. Its pending context was preserved.");
      if (binding) {
        const origin = await openReviewSessionView(sources, binding.originView, binding.source);
        await origin.close();
      }
      transport = await this.createTransport(launch, signal);
      client = new AppServerClient(transport);
      signal?.addEventListener("abort", abort, { once: true });
      signal?.throwIfAborted();
      await client.initialize();
      if (!binding) {
        binding = { source, sqliteHome, originView: view, creating: true };
        await options.save(binding);
        if (signal?.aborted) {
          await options.save(undefined);
          signal.throwIfAborted();
        }
        creatingThread = true;
        const started = await client.request("thread/start", {
          cwd: launch.cwd, model: options.model, ephemeral: false,
          approvalPolicy: "never", sandbox: "danger-full-access",
          config: { model_reasoning_effort: options.reasoningEffort },
        });
        const threadId = this.requireThreadIdentity(started, launch.cwd).id;
        binding = { ...binding, threadId };
        await options.save(binding);
        const initialized = await client.request("thread/inject_items", {
          threadId,
          items: [{
            type: "message", role: "user",
            content: [{ type: "input_text", text: `This conversation belongs to one Forge review worker in ${JSON.stringify(launch.cwd)}. Retain prior review findings as context, and assess each requested revision from the current owned checkout. Wait for the review request before starting work.` }],
          }],
        });
        if (!isRecord(initialized) || Object.keys(initialized).length !== 0)
          throw new Error("Codex did not confirm the reviewer context was initialized.");
        binding = { ...binding, creating: false };
        await options.save(binding);
        const unsubscribed = await client.request("thread/unsubscribe", { threadId });
        if (!isRecord(unsubscribed) || unsubscribed.status !== "unsubscribed")
          throw new Error("Codex did not confirm the new reviewer thread was saved and unloaded.");
      }
      const threadId = binding.threadId!;
      const resumed = await client.request("thread/resume", { threadId, excludeTurns: true });
      this.requireThreadIdentity(resumed, launch.cwd, threadId);
      const unsubscribed = await client.request("thread/unsubscribe", { threadId });
      if (!isRecord(unsubscribed) || unsubscribed.status !== "unsubscribed")
        throw new Error("Codex did not confirm the reviewer conversation was unloaded.");
      await transport.finish();
      creatingThread = false;
      await sources.assertCurrent(source, signal);
      signal?.throwIfAborted();
      return threadId;
    } catch (error) {
      if (error instanceof AppServerOwnershipError) throw error;
      throw new PluginSessionNotStartedError(signal?.aborted ? signal.reason : error);
    } finally {
      signal?.removeEventListener("abort", abort);
      const errors: unknown[] = abortError ? [abortError] : [];
      try { client?.close(); } catch (error) { errors.push(error); }
      try { await transport?.terminate(); } catch (error) { errors.push(error); }
      try { await sources.dispose(); } catch (error) { errors.push(error); }
      if (errors.length === 1 && errors[0] instanceof AppServerOwnershipError) throw errors[0];
      if (errors.length) throw new AppServerOwnershipError("Reviewer conversation cleanup is incomplete. Local resources were preserved.", { cause: new AggregateError(errors) });
    }
  }

  private requireThreadIdentity(result: unknown, cwd: string, expectedId?: string): Record<string, unknown> & { id: string } {
    const thread = isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
    if (!thread || !isThreadId(thread.id) || expectedId !== undefined && thread.id !== expectedId ||
      thread.cwd !== cwd || thread.ephemeral !== false)
      throw new Error("Codex returned a reviewer conversation that does not match its owned checkout.");
    return thread as Record<string, unknown> & { id: string };
  }
}

/** Retires launch material while keeping native history paths resolvable. */
export async function retireReviewSessionView(dataDir: string, tabId: string, expected: OwnedDirectoryIdentity, binding: ReviewConversationBinding): Promise<void> {
  const { source, originView } = binding;
  const sources = new CodexStateSources(dataDir, { CODEX_HOME: source.home });
  try {
    if (sources.viewPath(tabId) !== expected.path) throw new Error("Reviewer session view ownership does not match.");
    const isOrigin = expected.path === originView.path;
    if (isOrigin && !sameDirectory(expected, originView)) throw new Error("Reviewer conversation origin view ownership changed.");
    const view = await openReviewSessionView(sources, expected, source);
    try {
      const retained = new Set(isOrigin ? [".cloudx-source.json", "sessions", "archived_sessions"] : []);
      for (const name of await fs.readdir(path.dirname(view.childPath(".cloudx-source.json")))) {
        if (!retained.has(name)) await fs.rm(view.childPath(name), { recursive: true });
      }
      await view.assertCurrent();
      if (!isOrigin) await view.remove();
    } finally { await view.close(); }
  } finally { await sources.dispose(); }
}

async function openReviewSessionView(sources: CodexStateSources, expected: OwnedDirectoryIdentity, source: ResolvedCodexStateSource) {
  const tabId = path.basename(expected.path);
  if (sources.viewPath(tabId) !== expected.path) throw new Error("Reviewer session view ownership does not match.");
  const bound = await sources.readBinding(tabId);
  if (!bound || !sameSource(bound, source)) throw new Error("Reviewer session source changed; its view was preserved.");
  await sources.assertCurrent(source);
  const view = await openOwnedDirectoryNoFollow(path.dirname(expected.path), expected.path, "Reviewer session view", expected);
  try {
    for (const name of ["sessions", "archived_sessions"]) {
      const link = view.childPath(name);
      if (!(await fs.lstat(link)).isSymbolicLink() || await fs.realpath(link) !== path.join(source.home, name))
        throw new Error("Reviewer session history link changed; its view was preserved.");
    }
    return view;
  } catch (error) {
    await view.close();
    throw error;
  }
}

async function directory(candidate: string): Promise<ConversationDirectory> {
  const resolved = await fs.realpath(candidate);
  const stat = await fs.stat(resolved, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Codex conversation storage must be a directory.");
  return { path: resolved, dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameDirectory(left: ConversationDirectory, right: ConversationDirectory): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino;
}

function sameSource(left: ResolvedCodexStateSource, right: ResolvedCodexStateSource): boolean {
  return left.sourceId === right.sourceId && left.home === right.home && left.dev === right.dev && left.ino === right.ino;
}

function isThreadId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
}

export function isReviewConversationBinding(value: unknown): value is ReviewConversationBinding {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.sqliteHome) || !isRecord(value.originView)) return false;
  const { source, sqliteHome, originView } = value;
  return source.sourceId === "shared" && typeof source.home === "string" && path.isAbsolute(source.home) &&
    [source.dev, source.ino, sqliteHome.dev, sqliteHome.ino, originView.dev, originView.ino].every(part => typeof part === "string" && /^\d+$/u.test(part)) &&
    typeof sqliteHome.path === "string" && path.isAbsolute(sqliteHome.path) &&
    typeof originView.path === "string" && path.isAbsolute(originView.path) &&
    (value.creating === true && (value.threadId === undefined || isThreadId(value.threadId)) || value.creating === false && isThreadId(value.threadId));
}

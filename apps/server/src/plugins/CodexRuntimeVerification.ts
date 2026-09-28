import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PluginSession } from "@cloudx/plugin-api";
import { isForgeTurnCompletion, isRecord, type WorkspaceTab } from "@cloudx/shared";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { CodexStateCompatibility } from "./CodexStateCompatibility.js";
import { completedVerificationTurn, readVerificationTranscript, type VerificationTranscriptEvent } from "./CodexVerificationTranscript.js";

export interface CodexRuntimeVerificationOptions {
  assistantBin: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  sharedStateHome?: string;
  dataDir?: string;
  previousAssistantBin?: string;
}

/** Verify the installed binary through the same isolated overlay, PTY and bridge as a new tab. */
export async function verifyCodexRuntime(options: CodexRuntimeVerificationOptions): Promise<void> {
  await verifyIsolatedCodexRuntime(options);
  if (!options.sharedStateHome) return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-state-verification-"));
  try {
    const compatibility = new CodexStateCompatibility(options.env ?? process.env, options.signal);
    const snapshots = await compatibility.snapshots(options.sharedStateHome, options.dataDir, path.join(directory, "snapshots"));
    for (const sqliteHome of snapshots) {
      const sessionId = await verifyIsolatedCodexRuntime(options, sqliteHome);
      await compatibility.verifyConversation(sqliteHome, sessionId);
      if (options.previousAssistantBin && options.previousAssistantBin !== options.assistantBin) {
        const previousSessionId = await verifyIsolatedCodexRuntime({ ...options, assistantBin: options.previousAssistantBin }, sqliteHome);
        await compatibility.verifyConversation(sqliteHome, previousSessionId);
        await compatibility.verifyConversation(sqliteHome, sessionId);
      }
    }
    options.onOutput?.(`Native compatibility verified against ${snapshots.length} distinct retained SQLite schemas using isolated copies.\n`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function verifyIsolatedCodexRuntime({ assistantBin, env = process.env, signal, onOutput }: CodexRuntimeVerificationOptions, sqliteHome?: string): Promise<string> {
  if (typeof assistantBin !== "string" || !path.isAbsolute(assistantBin)) throw new Error("Codex runtime verification requires an absolute executable path.");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-verification-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const isolatedEnv = { PATH: env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: assistantBin, SHELL: "/bin/sh", TERM: "xterm-256color" };
  const sources = new CodexStateSources(data, isolatedEnv);
  const recovery = new CodexConversationRecovery(sources.viewPath("runtime-verification"));
  const requests: string[] = [];
  const startedAt = performance.now();
  const phases: Array<{ phase: string; elapsedMs: number }> = [];
  let phase = "launch";
  const enterPhase = (name: string) => { phase = name; phases.push({ phase, elapsedMs: Math.round(performance.now() - startedAt) }); };
  enterPhase(phase);
  let transcript: VerificationTranscriptEvent[] = [];
  let confirmedTurn: { threadId: string; turnId: string } | undefined;
  let receipt: unknown;
  const receiptPath = path.join(root, "forge-turn.json");
  const answer = "CloudX native runtime verification succeeded.";
  const provider = createVerificationProvider(answer, requests);
  let session: PluginSession | undefined;
  const deadline = performance.now() + 25_000;
  async function waitFor(description: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
    while (!(await predicate())) {
      signal?.throwIfAborted();
      if (session?.hasExited?.() || performance.now() >= deadline) {
        throw new Error(description);
      }
      await delay(50, undefined, { signal });
    }
  }
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
    const port = (provider.address() as { port: number }).port;
    await fs.mkdir(home, { mode: 0o700 });
    await fs.writeFile(path.join(home, "config.toml"), [
      '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
      'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'check_for_update_on_startup = false', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"',
      ...(sqliteHome ? [`sqlite_home = ${JSON.stringify(sqliteHome)}`] : []),
      '[model_providers.cloudx-native]', 'name = "CloudX runtime verification"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    const tab: WorkspaceTab = {
      id: "runtime-verification", pluginId: "codex-terminal", title: "Runtime verification", cwd: root,
      status: "starting", createdAt: "", updatedAt: "", indicator: { color: "green", label: "Starting", updatedAt: "" }
    };
    const plugin = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, isolatedEnv);
    session = await plugin.createSession({ tab, cwd: root, controls: { closeTab: () => undefined, setTabIndicator: () => undefined } });
    session.onData?.(text => { if (text.includes("\u001b[6n")) session!.write!("\u001b[1;1R"); });
    await waitFor("Codex did not save a selected conversation before the first prompt", () => Boolean(recovery.read()?.selection));
    assert.deepEqual(requests, [], "A native tab must save its selection without contacting a model.");
    const identity = recovery.read()!;
    assert.equal(identity.selection!.tabId, tab.id);
    assert.equal(identity.selection!.executionId, session.restoreInput?.()?.codexExecutionId);
    onOutput?.("Selected conversation saved before any model prompt.\n");
    enterPhase("interactive-readiness");
    // The bridge persists selection before forwarding the reply to the TUI. Wait for its output to settle separately.
    await session.handleAction("wait_until_ready", { timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) }, { signal });
    enterPhase("interactive-turn");
    await session.handleAction("enter_text", { text: "Verify this isolated CloudX launch.", submit: true });
    const completeTurn = async (firstNewEvent: number) => {
      let completed: ReturnType<typeof completedVerificationTurn>;
      await waitFor("The synthetic local-provider turn did not complete", async () => {
        const selected = recovery.read();
        assert.equal(selected?.sessionId, identity.sessionId, "Verification changed the selected native conversation.");
        assert.equal(selected?.selection?.executionId, session!.restoreInput?.()?.codexExecutionId);
        transcript = await readVerificationTranscript(selected?.transcriptPath);
        completed = completedVerificationTurn(transcript, firstNewEvent, identity.sessionId, answer);
        return Boolean(completed);
      });
      confirmedTurn = { threadId: completed!.threadId, turnId: completed!.turnId };
      return completed!.context;
    };
    const context = await completeTurn(0);
    assert.equal(context?.approval_policy, "never", "The native turn lost CloudX's configured approval policy.");
    assert.equal(isRecord(context?.sandbox_policy) ? context.sandbox_policy.type : undefined, "danger-full-access", "The native turn lost CloudX's launch sandbox policy.");
    const roots = context?.workspace_roots;
    assert.ok(Array.isArray(roots) && [root, path.join(data, "rules-skills")].every(value => roots.includes(value)), "The native turn lost its workspace or CloudX skills root.");
    assert.equal(requests.filter(value => value === "conversation").length, 1);
    assert.equal(recovery.read()!.sessionId, identity.sessionId);
    onOutput?.("Synthetic local-provider turn preserved selection, launch permissions and workspace/skills roots.\n");
    enterPhase("forge-resume");
    const firstNewEvent = transcript.length;
    await session.terminate!();
    const binding = { workerId: "runtime-verification", attemptId: "resumed-attempt", receiptPath };
    session = await plugin.createSession({
      tab: { ...tab, ownerPluginId: "forge" }, cwd: root, codexTurn: binding,
      initialInput: { resume: { mode: "session", sessionId: identity.sessionId }, prompt: "Verify this resumed Forge turn." },
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    session.onData?.(text => { if (text.includes("\u001b[6n")) session!.write!("\u001b[1;1R"); });
    await waitFor("Codex did not confirm the exact resumed conversation", () => Boolean(recovery.read()?.selection));
    enterPhase("forge-turn");
    const resumedContext = await completeTurn(firstNewEvent);
    assert.equal(resumedContext.approval_policy, context?.approval_policy);
    assert.deepEqual(resumedContext.sandbox_policy, context?.sandbox_policy);
    assert.deepEqual(resumedContext.workspace_roots, context?.workspace_roots);
    await waitFor("Forge did not save the exact native completion receipt", async () => {
      try { receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      if (!isForgeTurnCompletion(receipt)) return false;
      assert.equal(receipt.workerId, binding.workerId);
      assert.equal(receipt.attemptId, binding.attemptId);
      assert.equal(receipt.threadId, confirmedTurn!.threadId);
      assert.equal(receipt.turnId, confirmedTurn!.turnId);
      assert.ok(receipt.status === "running" || receipt.status === "completed", "The native Forge turn failed.");
      return receipt.status === "completed";
    });
    enterPhase("forge-finish");
    await session.handleAction("finish", confirmedTurn!);
    assert.equal(session.snapshot().status, "completed");
    assert.equal(requests.filter(value => value === "conversation").length, 2);
    onOutput?.("Resumed Forge turn matched the selected thread, native completion and final shutdown.\n");
    return identity.sessionId;
  } catch (error) {
    // Read the latest evidence before teardown, including failures before the transcript checkpoint.
    let selected: ReturnType<CodexConversationRecovery["read"]>;
    const evidenceErrors: string[] = [];
    try {
      selected = recovery.read();
      transcript = await readVerificationTranscript(selected?.transcriptPath);
    } catch { evidenceErrors.push("transcript-unavailable"); }
    try { receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")); }
    catch (receiptError) { if ((receiptError as NodeJS.ErrnoException).code !== "ENOENT") evidenceErrors.push("receipt-unavailable"); }
    const diagnostic = {
      version: 1, phase, elapsedMs: Math.round(performance.now() - startedAt), phases,
      providerRequests: { count: requests.length, purposes: requests.slice(-32) },
      selection: selected ? { threadId: selected.sessionId, executionId: selected.selection?.executionId, tabId: selected.selection?.tabId } : undefined,
      confirmedTurn,
      receipt: isForgeTurnCompletion(receipt) ? { threadId: receipt.threadId, turnId: receipt.turnId, status: receipt.status } : undefined,
      transcriptEvents: transcript.slice(-64).map(item => ({ type: item.type, event: item.payload?.type, turnId: item.payload?.turn_id })),
      process: { exited: session?.hasExited?.(), status: session?.snapshot().status, readiness: session?.snapshot().state?.readiness },
      screenTail: stripVTControlCharacters(session?.snapshot().recentOutput ?? "").slice(-8192),
      error: { name: error instanceof Error ? error.name : "UnknownError", code: (error as NodeJS.ErrnoException)?.code },
      evidenceErrors
    };
    try {
      const directory = env.CLOUDX_CODEX_VERIFICATION_DIAGNOSTICS_DIR ?? path.join(os.tmpdir(), "cloudx-codex-verification-failures");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      assert.ok(stat.isDirectory() && (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid()), "Verification diagnostics require an owned private directory.");
      const file = path.join(directory, `failure-${randomUUID()}.json`);
      await fs.writeFile(file, JSON.stringify(diagnostic, null, 2), { mode: 0o600, flag: "wx" });
      onOutput?.(`Private native verification diagnostics: ${file}\n`);
    } catch {
      onOutput?.("Private native verification diagnostics could not be saved.\n");
    }
    throw error;
  } finally {
    try {
      await session?.terminate?.();
    } finally {
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
      try { await sources.dispose(); }
      finally { await fs.rm(root, { recursive: true, force: true }); }
    }
  }
}

function createVerificationProvider(answer: string, requests: string[]) {
  return createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    let body = "";
    let oversized = false;
    request.setEncoding("utf8");
    request.on("data", chunk => {
      if (oversized) return;
      body += chunk;
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) { oversized = true; body = ""; response.writeHead(413).end(); }
    });
    request.on("end", () => {
      if (oversized) return;
      try {
        const input = JSON.parse(body);
        const purpose = input.text?.format?.schema?.properties?.title ? "title" : "conversation";
        requests.push(purpose);
        const text = purpose === "title" ? '{"title":"CloudX runtime verification"}' : answer;
        const item = { type: "message", id: `msg_${purpose}`, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id: `resp_${purpose}`, status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
          { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: `resp_${purpose}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      } catch {
        response.writeHead(400).end();
      }
    });
  });
}

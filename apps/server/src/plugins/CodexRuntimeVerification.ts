import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PluginSession } from "@cloudx/plugin-api";
import { isForgeTurnCompletion, isRecord, type WorkspaceTab } from "@cloudx/shared";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";

export interface CodexRuntimeVerificationOptions {
  assistantBin: string;
  previousAssistantBin?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
}

/** Verify the installed binary through the same isolated overlay, PTY and bridge as a new tab. */
export async function verifyCodexRuntime({ assistantBin, previousAssistantBin, env = process.env, signal, onOutput }: CodexRuntimeVerificationOptions): Promise<void> {
  if (typeof assistantBin !== "string" || !path.isAbsolute(assistantBin)) throw new Error("Codex runtime verification requires an absolute executable path.");
  if (previousAssistantBin !== undefined && !path.isAbsolute(previousAssistantBin)) throw new Error("Previous Codex verification requires an absolute executable path.");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-verification-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const isolatedEnv = { PATH: env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: assistantBin, SHELL: "/bin/sh", TERM: "xterm-256color" };
  const sources = new CodexStateSources(data, isolatedEnv);
  const requests: string[] = [];
  const answer = "CloudX native runtime verification succeeded.";
  const provider = createVerificationProvider(answer, requests);
  const sessions: PluginSession[] = [];
  const deadline = Date.now() + 50_000;
  async function waitFor(session: PluginSession, description: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
    while (!(await predicate())) {
      signal?.throwIfAborted();
      if (session?.hasExited?.() || Date.now() >= deadline) {
        throw new Error(`${description}. ${session?.snapshot().recentOutput ?? "Native session did not start."}`);
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
      '[model_providers.cloudx-native]', 'name = "CloudX runtime verification"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    async function start(tabId: string, binary: string, resumeId?: string, forge = false) {
      const tab: WorkspaceTab = {
        id: tabId, pluginId: "codex-terminal", ...(forge ? { ownerPluginId: "forge" } : {}), title: "Runtime verification", cwd: root,
        status: "starting", createdAt: "", updatedAt: "", indicator: { color: "green", label: "Starting", updatedAt: "" }
      };
      const binding = { workerId: "runtime-worker", attemptId: "runtime-attempt", receiptPath: path.join(root, "forge-turn.json") };
      const plugin = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, { ...isolatedEnv, CLOUDX_ASSISTANT_BIN: binary });
      const session = await plugin.createSession({
        tab, cwd: root, controls: { closeTab: () => undefined, setTabIndicator: () => undefined },
        ...(resumeId ? { initialInput: { resume: { mode: "session", sessionId: resumeId } } } : {}),
        ...(forge ? { codexTurn: binding, initialInput: { prompt: "Verify this isolated Forge worker." } } : {})
      });
      sessions.push(session);
      session.onData?.(text => { if (text.includes("\u001b[6n")) session.write!("\u001b[1;1R"); });
      const recovery = new CodexConversationRecovery(sources.viewPath(tabId));
      await waitFor(session, "Codex did not save a selected conversation before the first prompt", () => Boolean(recovery.read()?.selection));
      const identity = recovery.read()!;
      assert.equal(identity.selection!.tabId, tab.id);
      assert.equal(identity.selection!.executionId, session.restoreInput?.()?.codexExecutionId);
      if (resumeId) assert.equal(identity.sessionId, resumeId, "The candidate selected a different saved conversation.");
      return { session, recovery, identity, binding };
    }
    async function transcript(recovery: CodexConversationRecovery): Promise<Array<{ type: string; payload?: Record<string, unknown> }>> {
      const transcriptPath = recovery.read()?.transcriptPath;
      if (!transcriptPath) return [];
      try {
        return (await fs.readFile(transcriptPath, "utf8")).split("\n").slice(0, -1).map(line => JSON.parse(line));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    }
    async function completeTurn(launch: Awaited<ReturnType<typeof start>>) {
      await launch.session.handleAction("wait_until_ready", { timeoutMs: 10_000, quietMs: 250 }, { signal });
      const before = (await transcript(launch.recovery)).filter(item => item.type === "event_msg" && item.payload?.type === "task_complete").length;
      await launch.session.handleAction("enter_text", { text: "Verify this isolated CloudX launch.", submit: true });
      let messages: Awaited<ReturnType<typeof transcript>> = [];
      await waitFor(launch.session, "The synthetic local-provider turn did not complete", async () => {
        messages = await transcript(launch.recovery);
        return messages.filter(item => item.type === "event_msg" && item.payload?.type === "task_complete" && item.payload.last_agent_message === answer).length > before;
      });
      const context = messages.filter(item => item.type === "turn_context").at(-1)?.payload;
      assert.equal(context?.approval_policy, "never", "The native turn lost CloudX's configured approval policy.");
      assert.equal(isRecord(context?.sandbox_policy) ? context.sandbox_policy.type : undefined, "danger-full-access", "The native turn lost CloudX's launch sandbox policy.");
      const roots = context?.workspace_roots;
      assert.ok(Array.isArray(roots) && [root, path.join(data, "rules-skills")].every(value => roots.includes(value)), "The native turn lost its workspace or CloudX skills root.");
      assert.equal(launch.recovery.read()!.sessionId, launch.identity.sessionId);
    }
    const existing = previousAssistantBin ? await start("previous-running", previousAssistantBin) : undefined;
    let previousConversation: string | undefined;
    if (existing) {
      const saved = await start("previous-saved", previousAssistantBin!);
      await completeTurn(saved);
      previousConversation = saved.identity.sessionId;
      await saved.session.terminate?.();
    }
    const requestsBeforeLaunch = requests.length;
    const ordinary = await start("runtime-verification", assistantBin, previousConversation);
    assert.equal(requests.length, requestsBeforeLaunch, "A native tab must save its selection without contacting a model.");
    onOutput?.("Selected conversation saved before any model prompt.\n");
    await completeTurn(ordinary);
    onOutput?.("Synthetic local-provider turn preserved selection, launch permissions and workspace/skills roots.\n");
    if (previousConversation) onOutput?.("Candidate resumed the previous version's saved conversation and completed a native turn using shared isolated state.\n");
    const titlesBeforeWorker = requests.filter(purpose => purpose === "title").length;
    const worker = await start("runtime-forge", assistantBin, undefined, true);
    let receipt: unknown;
    await waitFor(worker.session, "The native Forge turn did not complete", async () => {
      try { receipt = JSON.parse(await fs.readFile(worker.binding.receiptPath, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      return isForgeTurnCompletion(receipt) && receipt.status === "completed";
    });
    assert.ok(isForgeTurnCompletion(receipt));
    assert.equal(receipt.threadId, worker.identity.sessionId);
    assert.equal(receipt.workerId, worker.binding.workerId);
    assert.equal(receipt.attemptId, worker.binding.attemptId);
    await waitFor(worker.session, "The native Forge conversation title did not complete", () => requests.filter(purpose => purpose === "title").length > titlesBeforeWorker);
    await worker.session.handleAction("wait_until_ready", { timeoutMs: 10_000, quietMs: 250 }, { signal });
    await worker.session.handleAction("finish", { threadId: receipt.threadId, turnId: receipt.turnId });
    assert.equal(worker.session.snapshot().status, "completed");
    onOutput?.("Native Forge worker saved its conversation identity and completed its owned turn.\n");
    if (existing) {
      assert.equal(existing.session.hasExited?.(), false, "Selecting a candidate stopped the previous running session.");
      await completeTurn(existing);
      onOutput?.("The existing previous-version session completed its turn after candidate tab and Forge verification.\n");
    }
  } finally {
    try {
      const stopped = await Promise.allSettled(sessions.map(session => session.terminate?.()));
      const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Native verification could not stop every isolated session.");
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

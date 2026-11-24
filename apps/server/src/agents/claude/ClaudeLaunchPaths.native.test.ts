import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { PluginSession } from "@cloudx/plugin-api";
import type { ClaudeLaunchMode, WorkspaceTab } from "@cloudx/shared";
import { expect, it, vi } from "vitest";
import headless from "@xterm/headless";

import { CodexTerminalPlugin } from "../../plugins/CodexTerminalPlugin.js";
import { CodexConversationRecovery } from "../../plugins/CodexConversationRecovery.js";
import { NodePtyTerminalProcessFactory } from "../../terminal/NodePtyTerminalProcess.js";
import type { TerminalSpawnOptions } from "../../terminal/TerminalProcess.js";
import { AgentAccountStore } from "../AgentAccountStore.js";
import { createAgentExec } from "../AgentExec.js";
import { AgentLaunchRecords } from "../AgentLaunchRecords.js";
import { agentTurnReceiptPath } from "../agentTurn.js";
import { AgentUsageRecorder } from "../usage/AgentUsageRecorder.js";
import { ClaudeUsageReader } from "../usage/ClaudeUsageReader.js";
import { ClaudeSettingsService } from "./ClaudeSettingsService.js";
import { claudeOverlayPath } from "./ClaudeHomeOverlay.js";

const claude = process.env.CLOUDX_NATIVE_CLAUDE;
const modes: ClaudeLaunchMode[] = ["native-project", "cloudx-managed"];
const finalText = "The isolated native launch completed.";

it.skipIf(!claude)("identifies native API-key confirmation before unattended Forge work without using or exposing the key", async () => {
  const fixture = await launchFixture("cloudx-managed");
  const factory = new CapturingNativeTerminal();
  const plugin = new CodexTerminalPlugin(factory, undefined, fixture.dataDir, undefined, fixture.env,
    { accounts: fixture.accounts, claudeSettings: fixture.settings });
  try {
    await fixture.settings.acceptBypass();
    const launch = plugin.createSession({
      tab: { id: "native-forge-unapproved", pluginId: "codex-terminal", ownerPluginId: "forge", title: "Native account consent", cwd: fixture.cwd,
        status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "Ready", updatedAt: "" } },
      cwd: fixture.cwd, agentTurn: { workerId: "worker", attemptId: "attempt", receiptPath: path.join(fixture.root, "turn.json") },
      prepareAgentSession: async () => randomUUID(),
      initialInput: { agent: { providerId: "claude", accountId: fixture.account.id }, model: "claude-sonnet-4-6", prompt: "Never submit this work." },
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    await expect(launch).rejects.toThrow("API-key confirmation");
    await expect(launch).rejects.not.toThrow("selected-local-key");
    expect(fixture.requests).toEqual([]);
    await expect(fs.stat(path.join(fixture.root, "turn.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fixture.close(); }
}, 45_000);

it.skipIf(!claude).each(modes)("completes the production Claude Forge PTY turn in %s with exact receipts", async mode => {
  const fixture = await launchFixture(mode, ["native-forge-launch"]);
  const factory = new CapturingNativeTerminal();
  const plugin = new CodexTerminalPlugin(factory, undefined, fixture.dataDir, undefined, fixture.env,
    { accounts: fixture.accounts, claudeSettings: fixture.settings });
  const threadId = randomUUID();
  const binding = { workerId: "native-claude-worker", attemptId: "native-claude-attempt", receiptPath: path.join(fixture.root, "turn.json") };
  const tab: WorkspaceTab = { id: "native-forge-launch", pluginId: "codex-terminal", ownerPluginId: "forge", title: "Native Forge", cwd: fixture.cwd,
    status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "Ready", updatedAt: "" } };
  let session: PluginSession | undefined;
  try {
    await fixture.settings.acceptBypass();
    try {
      session = await plugin.createSession({ tab, cwd: fixture.cwd, agentTurn: binding, prepareAgentSession: async () => threadId,
        initialInput: { agent: { providerId: "claude", accountId: fixture.account.id }, claudeLaunchMode: mode,
          model: "claude-sonnet-4-6", prompt: "Return the synthetic response." },
        controls: { closeTab: () => undefined, setTabIndicator: () => undefined } });
    } catch (error) { throw new Error(`${String(error)}\n${factory.output}`, { cause: error }); }
    await expect.poll(async () => JSON.parse(await fs.readFile(binding.receiptPath, "utf8")), { timeout: 20_000 }).toMatchObject({
      workerId: binding.workerId, attemptId: binding.attemptId, threadId, status: "completed"
    });
    const receipt = JSON.parse(await fs.readFile(binding.receiptPath, "utf8"));
    expect(JSON.parse(await fs.readFile(`${binding.receiptPath}.final.json`, "utf8"))).toMatchObject({ threadId, turnId: receipt.turnId, text: finalText });
    await session.handleAction("finish", { threadId, turnId: receipt.turnId });
    expect(session.snapshot().status).toBe("completed");
    expect(fixture.requests).toEqual([expect.objectContaining({ selectedAccount: true })]);
  } finally { await session?.terminate?.(); await fixture.close(); }
}, 75_000);

class CapturingNativeTerminal extends NodePtyTerminalProcessFactory {
  output = "";
  override async spawn(command: string, args: string[], options: TerminalSpawnOptions) {
    const terminal = await super.spawn(command, args, options);
    terminal.onData(data => {
      this.output = (this.output + data).slice(-64 * 1024);
      if (data.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
    });
    return terminal;
  }
}

it.skipIf(!claude).each(modes)("runs production Claude JSON execution in %s with the selected account and cleans its overlay", async mode => {
  const fixture = await launchFixture(mode);
  try {
    const codex = vi.fn();
    const execute = createAgentExec(fixture.accounts, codex, fixture.env);
    expect(await execute("claude-sonnet-4-6", "Return the synthetic response.", { claudeLaunchMode: mode })).toBe(finalText);
    expect(codex).not.toHaveBeenCalled();
    expect(fixture.requests).toEqual([expect.objectContaining({ selectedAccount: true, model: "claude-sonnet-4-6" })]);
    expect(await fs.readdir(path.join(fixture.dataDir, "claude-launches"))).toEqual([]);
    expect(await fs.readFile(fixture.settingsPath, "utf8")).toBe(fixture.originalSettings);
  } finally { await fixture.close(); }
}, 60_000);

it.skipIf(!claude).each(modes)("completes and recovers the exact production Claude PTY conversation in %s", async mode => {
  const fixture = await launchFixture(mode, ["native-launch-path"]);
  const usageOpen = vi.fn(), usageClose = vi.fn();
  const usage = new AgentUsageRecorder({ open: usageOpen, close: usageClose }, fixture.accounts);
  const plugin = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, fixture.dataDir, undefined, fixture.env,
    { accounts: fixture.accounts, claudeSettings: fixture.settings, usage });
  const tab: WorkspaceTab = { id: "native-launch-path", pluginId: "codex-terminal", title: "Claude native acceptance", cwd: fixture.cwd,
    status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "Ready", updatedAt: "" } };
  const controls = { closeTab: () => undefined, setTabIndicator: () => undefined, setRestoreInput: () => undefined };
  let session: PluginSession | undefined;
  const reader = new ClaudeUsageReader(() => fixture.accounts.providerHome("claude"));
  try {
    session = await plugin.createSession({ tab, cwd: fixture.cwd, controls,
      initialInput: { agent: { providerId: "claude", accountId: fixture.account.id }, claudeLaunchMode: mode,
        model: "claude-sonnet-4-6", prompt: "Return the synthetic response." } });
    respondToTerminal(session);
    await expect.poll(() => displayedOutput(session!), { timeout: 30_000 }).toContain(finalText);
    await expect.poll(() => session!.restoreInput?.()?.resume, { timeout: 10_000 }).toMatchObject({ mode: "session" });
    const restored = session.restoreInput!()!;
    const sessionId = (restored.resume as { sessionId: string }).sessionId;
    const turnReceipt = agentTurnReceiptPath(claudeOverlayPath(fixture.dataDir, tab.id));
    await expect.poll(async () => JSON.parse(await fs.readFile(turnReceipt, "utf8")), { timeout: 10_000 }).toMatchObject({ status: "completed", sessionId });
    await usage.flush();
    expect(usageOpen).toHaveBeenCalledWith(expect.objectContaining({ tabId: tab.id }),
      { providerId: "claude", sessionId, accountKind: "api-key" });
    const firstLaunch = await new AgentLaunchRecords(fixture.dataDir).read(tab.id, "claude");
    expect(firstLaunch).toMatchObject({ accountId: fixture.account.id, claudeLaunchPolicy: { mode } });
    await session.terminate?.();
    session = undefined;
    const input = { tab, cwd: fixture.cwd, controls, initialInput: restored };
    expect(await plugin.describeRecovery(input)).toMatchObject({ canResume: true, conversationId: sessionId });
    session = await plugin.recoverSession(input);
    respondToTerminal(session);
    const recovery = new CodexConversationRecovery(claudeOverlayPath(fixture.dataDir, tab.id));
    await expect.poll(() => recovery.readForExecution(tab.id, session!.restoreInput?.()?.codexExecutionId), { timeout: 10_000 }).toMatchObject({ sessionId });
    await session.handleAction("wait_until_ready", { timeoutMs: 30_000 });
    await session.handleAction("enter_text", { text: "Return another synthetic response.", submit: true });
    await expect.poll(() => fixture.requests.length, { timeout: 30_000 }).toBe(2);
    await expect.poll(async () => (await reader.snapshot(sessionId)).records.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(async () => JSON.parse(await fs.readFile(turnReceipt, "utf8")), { timeout: 10_000 }).toMatchObject({ status: "completed", sessionId });
    expect(session.restoreInput?.()?.resume).toEqual({ mode: "session", sessionId });
    const recovered = await new AgentLaunchRecords(fixture.dataDir).read(tab.id, "claude");
    expect(recovered).toMatchObject({ accountId: fixture.account.id, claudeLaunchPolicy: { mode }, claudeLaunchModeSource: "conversation" });
    expect(recovered!.executionId).not.toBe(firstLaunch!.executionId);
    expect(fixture.requests.every(request => request.selectedAccount)).toBe(true);
    expect((await reader.snapshot(sessionId)).records).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "claude-sonnet-4-6", input: 3, output: 2 })
    ]));
  } finally {
    await session?.terminate?.();
    await reader.dispose();
    await usage.flush();
    await fixture.close();
  }
}, 120_000);

function respondToTerminal(session: PluginSession): void {
  session.onData?.(data => { if (data.includes("\u001b[6n")) session.write?.("\u001b[1;1R"); });
}

async function displayedOutput(session: PluginSession): Promise<string> {
  const attachment = await session.attachTerminal!(() => undefined);
  attachment.dispose();
  const terminal = new headless.Terminal({ cols: attachment.screen.cols, rows: attachment.screen.rows, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(attachment.screen.data, resolve));
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)!.translateToString(true)).join("\n");
  } finally { terminal.dispose(); }
}

async function launchFixture(mode: ClaudeLaunchMode, acknowledgedTabs: string[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-launch-path-"));
  const home = path.join(root, "home"), cwd = path.join(root, "project"), dataDir = path.join(root, "data");
  const requests: Array<{ selectedAccount: boolean; model: string }> = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url?.includes("count_tokens")) { response.setHeader("content-type", "application/json"); response.end('{"input_tokens":3}'); return; }
    if (!request.url?.includes("messages")) { response.writeHead(404); response.end(); return; }
    const input = JSON.parse(body);
    requests.push({ selectedAccount: request.headers["x-api-key"] === "fake-selected-local-key", model: input.model });
    const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: input.model,
      content: [{ type: "text", text: finalText }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 } };
    if (!input.stream) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(message)); return; }
    response.setHeader("content-type", "text/event-stream");
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: finalText } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" }
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Native acceptance requires a loopback provider.");
  await Promise.all([home, cwd, dataDir].map(directory => fs.mkdir(directory, { recursive: true })));
  const env = { PATH: process.env.PATH, HOME: home, SHELL: "/bin/sh", TERM: "xterm-256color", CLOUDX_CLAUDE_BIN: claude!,
    ANTHROPIC_API_KEY: "fake-inherited-unselected-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  const accounts = new AgentAccountStore(dataDir, env);
  await fs.mkdir(accounts.providerHome("claude"), { recursive: true });
  await fs.writeFile(path.join(accounts.providerHome("claude"), "settings.json"), "{}\n");
  const account = await accounts.create({ providerId: "claude", label: "Selected synthetic account", kind: "api-key", apiKey: "fake-selected-local-key" });
  // Model acceptance starts after the native user has acknowledged this exact
  // synthetic key. Production keeps Claude's separate first-use consent prompt.
  for (const tabId of acknowledgedTabs) {
    const overlay = claudeOverlayPath(dataDir, tabId);
    await fs.mkdir(overlay, { recursive: true });
    await fs.writeFile(path.join(overlay, ".claude.json"), JSON.stringify({
      customApiKeyResponses: { approved: ["fake-selected-local-key".trim().slice(-20)], rejected: [] }
    }));
  }
  const settings = new ClaudeSettingsService(dataDir, () => accounts.providerHome("claude"), env);
  await settings.update({ expectedRevision: (await settings.read()).revision, launchMode: mode, permissionMode: "manual", autoTrustWorkspace: true });
  const settingsPath = path.join(accounts.providerHome("claude"), "settings.json");
  const originalSettings = await fs.readFile(settingsPath, "utf8");
  return { root, cwd, dataDir, env, accounts, account, settings, settingsPath, originalSettings, requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    } };
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_TERMINAL_PLUGIN_ID, type CodexNativeWork } from "@cloudx/shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { AgentAccountStore } from "./agents/AgentAccountStore.js";
import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { CodexConversationRecovery } from "./plugins/CodexConversationRecovery.js";
import { codexNativeWorkPath } from "./plugins/CodexNativeWork.js";
import { CodexStateSources } from "./plugins/CodexStateSources.js";
import { CodexTerminalPlugin } from "./plugins/CodexTerminalPlugin.js";
import { SessionStore } from "./sessionStore.js";
import { DurableTerminalProcessFactory } from "./terminal/DurableTerminalProcess.js";
import { TerminalBroker } from "./terminal/TerminalBroker.js";
import type { TerminalProducer, TerminalSpawnOptions } from "./terminal/TerminalProcess.js";
import type { TerminalExit } from "./terminal/TerminalSupervisor.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";
import { WorkspaceCommandService } from "./workspace/WorkspaceCommandService.js";
import { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";

const storageFailure = "Terminal supervisor could not save descendant-quiescence evidence: ENOSPC. Free disk space or quota, then retry close.";

class ReceiptBlockedTerminal implements TerminalProducer {
  receiptStorageAvailable = true;
  private exit = (_event: TerminalExit) => {};
  onData = () => () => {};
  onExit(listener: (event: TerminalExit) => void) { this.exit = listener; return () => {}; }
  write = vi.fn();
  resize = vi.fn();
  pauseOutput = vi.fn();
  resumeOutput = vi.fn();
  kill = vi.fn();
  readonly terminate = vi.fn(async () => {
    if (!this.receiptStorageAvailable) throw new Error(storageFailure);
    this.exit({ exitCode: 0 });
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-storage-recovery-"));
  const dataDir = path.join(root, "data");
  const home = path.join(root, "codex-home");
  const skill = path.join(home, "skills", ".system", "imagegen");
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true });
  await fs.mkdir(path.join(home, "sessions"));
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: imagegen\ndescription: Generate images.\n---\n");
  await fs.writeFile(path.join(skill, "scripts", "image_gen.py"), "# test skill\n");
  const env = { ...process.env, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" };
  const accounts = new AgentAccountStore(dataDir, env);
  const account = await accounts.create({ providerId: "codex", label: "Original account", kind: "subscription" });
  await fs.writeFile(path.join(accounts.home(account), "auth.json"), JSON.stringify({ fixture: "original account" }));
  const sources = new CodexStateSources(dataDir, env);
  const launches: Array<{ terminal: ReceiptBlockedTerminal; args: string[]; options: TerminalSpawnOptions }> = [];
  const spawn = vi.fn(async (_command: string, args: string[], options: TerminalSpawnOptions) => {
    const terminal = new ReceiptBlockedTerminal();
    launches.push({ terminal, args, options });
    return terminal;
  });
  const socketPath = path.join(root, "broker.sock");
  const broker = new TerminalBroker(socketPath, { spawn });
  await broker.start();
  const factory = new DurableTerminalProcessFactory(socketPath, { spawn });
  const plugin = new CodexTerminalPlugin(factory, undefined, dataDir, sources, env, {
    accounts, claudeSettings: { read: vi.fn() }
  });
  const plugins = new PluginRegistry();
  plugins.register(plugin);
  const policy = new PathPolicy([root]);
  const workspace = new WorkspaceLayoutStore(dataDir, policy);
  const saved = new SessionStateStore(dataDir);
  const stores: SessionStore[] = [];
  onTestFinished(async () => {
    for (const launch of launches) launch.terminal.receiptStorageAvailable = true;
    for (const current of stores.reverse()) await current.dispose();
    await broker.stop();
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  function createStore() {
    const store = new SessionStore(plugins, policy, new TabContextService(dataDir), undefined, workspace, undefined, undefined, saved);
    stores.push(store);
    return store;
  }
  const store = createStore();
  const commands = new WorkspaceCommandService(store, workspace);
  const window = workspace.getActiveWindow();
  const { tab } = await commands.createTab({
    pluginId: AGENT_TERMINAL_PLUGIN_ID, cwd: root, title: "Affected conversation",
    windowId: window.id, paneId: window.layout.activePaneId,
    initialInput: { agent: { providerId: "codex", accountId: account.id }, prompt: "Never replay this original prompt." }
  });
  const original = launches[0]!;
  original.terminal.receiptStorageAvailable = false;
  const previous = store.getSession(tab.id);
  const executionId = String(previous.restoreInput?.()?.codexExecutionId);
  const threadId = "01a08470-d118-7b72-b1df-439e72e5c744";
  const transcript = path.join(home, "sessions", `rollout-${threadId}.jsonl`);
  const transcriptContents = JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: root } }) + "\n";
  await fs.writeFile(transcript, transcriptContents);
  await fs.writeFile(new CodexConversationRecovery(original.options.env.CODEX_HOME!).receiptPath,
    JSON.stringify({ version: 2, authority: "selected", tabId: tab.id, executionId, sessionId: threadId, cwd: root }));
  const work: CodexNativeWork = {
    version: 1, tabId: tab.id, executionId, threadId, updatedAt: new Date().toISOString(),
    turnId: "failed-turn", turnStatus: "failed", goalStatus: "blocked",
    lastError: { kind: "terminal", message: "The provider reported an internal processing error." }
  };
  await fs.writeFile(codexNativeWorkPath(original.options.env.CODEX_HOME!), JSON.stringify(work));
  await vi.waitFor(() => {
    expect(previous.nativeWork?.()).toEqual(work);
    expect(previous.restoreInput?.()).toMatchObject({ resume: { mode: "session", sessionId: threadId } });
  });
  const { tab: sibling } = await commands.createTab({
    pluginId: AGENT_TERMINAL_PLUGIN_ID, cwd: root, title: "Healthy sibling",
    windowId: window.id, paneId: window.layout.activePaneId,
    initialInput: { agent: { providerId: "codex", accountId: account.id } }
  });
  const siblingTerminal = launches[1]!.terminal;
  const otherAccount = await accounts.create({ providerId: "codex", label: "Different default account", kind: "subscription" });
  await accounts.setDefault(otherAccount.id);
  const otherWindow = await workspace.createWindow({ name: "Same directory, different workspace", defaultCwd: root });
  await workspace.selectWindow(otherWindow.id);
  store.setActiveTab(sibling.id);
  const layout = workspace.snapshot();
  return {
    root, account, accountHome: accounts.home(account), tab, sibling, siblingTerminal, original, launches, spawn, factory, store, workspace, saved, layout,
    request: { action: "restart-native" as const, executionId, sessionId: threadId },
    transcript, transcriptContents,
    async restore() {
      await store.dispose();
      const restored = createStore();
      await restored.restore();
      return restored;
    }
  };
}

describe("receipt storage recovery through the terminal broker", () => {
  it("keeps repeated failed closes retryable and retires only the affected terminal once receipt storage is restored", async () => {
    const f = await fixture();
    const restored = await f.restore();
    const siblingSession = restored.getSession(f.sibling.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(restored.closeTab(f.tab.id)).rejects.toThrow(storageFailure);
      expect(restored.getTab(f.tab.id).statusMessage).toContain("ENOSPC");
      expect(f.spawn).toHaveBeenCalledTimes(2);
      expect(f.siblingTerminal.terminate).not.toHaveBeenCalled();
    }
    expect(f.original.terminal.terminate).toHaveBeenCalledTimes(2);
    f.original.terminal.receiptStorageAvailable = true;
    await restored.closeTab(f.tab.id);
    await expect(f.factory.attach(f.tab.id)).rejects.toThrow("not restarted");
    expect(f.original.terminal.terminate).toHaveBeenCalledTimes(3);
    expect(restored.listTabs().map(tab => tab.id)).toEqual([f.sibling.id]);
    expect(restored.getSession(f.sibling.id)).toBe(siblingSession);
    expect(restored.getActiveTabId()).toBe(f.sibling.id);
    expect(f.siblingTerminal.terminate).not.toHaveBeenCalled();
    expect((await f.saved.read())!.sessions.map(saved => saved.tab.id)).toEqual([f.sibling.id]);
  });

  it("resumes the exact conversation, account and workspace after explicit storage reconciliation without replaying a prompt", async () => {
    const f = await fixture();
    const restored = await f.restore();
    const siblingSession = restored.getSession(f.sibling.id);
    await expect(restored.recoverTab(f.tab.id, f.request)).rejects.toThrow(storageFailure);
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect((await restored.recoverTab(f.tab.id, { action: "reconnect" })).status).toBe("running");
    expect(f.original.terminal.terminate).toHaveBeenCalledOnce();
    f.original.terminal.receiptStorageAvailable = true;
    const recovered = await restored.recoverTab(f.tab.id, f.request);
    expect(recovered).toMatchObject({ id: f.tab.id, cwd: f.root, title: f.tab.title, status: "running" });
    expect(f.spawn).toHaveBeenCalledTimes(3);
    const replacement = restored.getSession(f.tab.id);
    expect(replacement.restoreInput?.()).toMatchObject({
      agent: { providerId: "codex", accountId: f.account.id },
      resume: { mode: "session", sessionId: f.request.sessionId },
      codexWorkspaceId: f.workspace.findWindowForTab(f.tab.id)!.id
    });
    expect(replacement.restoreInput?.()).not.toHaveProperty("prompt");
    expect(await fs.readlink(path.join(f.launches[2]!.options.env.CODEX_HOME!, "auth.json"))).toBe(path.join(f.accountHome, "auth.json"));
    expect(f.launches[2]!.args.join(" ")).not.toContain("Never replay");
    expect(f.launches[2]!.terminal.write).not.toHaveBeenCalled();
    expect(await fs.readFile(f.transcript, "utf8")).toBe(f.transcriptContents);
    expect(f.workspace.snapshot()).toEqual(f.layout);
    expect(restored.getSession(f.sibling.id)).toBe(siblingSession);
    expect(f.siblingTerminal.terminate).not.toHaveBeenCalled();
    expect(restored.getActiveTabId()).toBe(f.sibling.id);
    await f.saved.flush();
    expect((await f.saved.read())!.sessions.find(saved => saved.tab.id === f.tab.id)!.initialInput)
      .toMatchObject({ agent: { providerId: "codex", accountId: f.account.id }, resume: { mode: "session", sessionId: f.request.sessionId } });
  });
});

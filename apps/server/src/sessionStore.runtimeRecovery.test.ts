import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AGENT_TERMINAL_PLUGIN_ID, type CodexNativeWork, type RecoverTabRequest, type WorkspaceRuntimeContext } from "@cloudx/shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { CodexConversationRecovery } from "./plugins/CodexConversationRecovery.js";
import { codexNativeWorkPath } from "./plugins/CodexNativeWork.js";
import { CodexStateSources } from "./plugins/CodexStateSources.js";
import { CodexTerminalPlugin, templateFromRuntimeContext } from "./plugins/CodexTerminalPlugin.js";
import { SessionStore } from "./sessionStore.js";
import type { TerminalProcess, TerminalProcessFactory, TerminalSpawnOptions } from "./terminal/TerminalProcess.js";
import type { TerminalExit } from "./terminal/TerminalSupervisor.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";

class Gate {
  release!: () => void;
  readonly waiting = new Promise<void>(resolve => { this.release = resolve; });
}

class ControlledTerminal implements TerminalProcess {
  written = "";
  writtenBeforeTermination: string | undefined;
  termination: Gate | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(exit: TerminalExit) => void>();

  onData(listener: (data: string) => void) { this.dataListeners.add(listener); return () => this.dataListeners.delete(listener); }
  onExit(listener: (exit: TerminalExit) => void) { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  write(data: string) { this.written += data; }
  resize() {}
  detach() {}
  kill() { for (const listener of this.exitListeners) listener({ exitCode: 130 }); }
  readonly terminate = vi.fn(async () => {
    this.writtenBeforeTermination = this.written;
    await this.termination?.waiting;
    this.kill();
  });
}

class ControlledTerminals implements TerminalProcessFactory {
  readonly launches: Array<{ terminal: ControlledTerminal; options: TerminalSpawnOptions }> = [];
  launchDelay: Gate | undefined;
  nextSpawnFailure: Error | undefined;

  readonly spawn = vi.fn(async (_command: string, _args: string[], options: TerminalSpawnOptions) => {
    await this.launchDelay?.waiting;
    if (this.nextSpawnFailure) throw this.nextSpawnFailure;
    const terminal = new ControlledTerminal();
    this.launches.push({ terminal, options });
    return terminal;
  });
}

function templateContext(name: string): WorkspaceRuntimeContext {
  return { pluginRuntime: { "rules-skills": { personalityTemplate: {
    source: "default", template: { id: name.toLowerCase(), name, color: "green", ruleIds: [], skillIds: [] }, rules: [], skills: []
  } } } };
}

async function fixture(options: { precedingTab?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-runtime-recovery-"));
  const home = path.join(root, "codex-home");
  const dataDir = path.join(root, "data");
  const skill = path.join(home, "skills", ".system", "imagegen");
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: imagegen\ndescription: Generate images.\n---\n");
  await fs.writeFile(path.join(skill, "scripts", "image_gen.py"), "# test skill\n");
  const env = { ...process.env, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" };
  const sources = new CodexStateSources(dataDir, env);
  const terminals = new ControlledTerminals();
  const plugin = new CodexTerminalPlugin(terminals, undefined, dataDir, sources, env);
  const plugins = new PluginRegistry();
  plugins.register(plugin);
  let currentContext = templateContext("Original");
  const resolver = {
    runtimeContextFor: vi.fn(async () => currentContext),
    tabIndicatorFor: () => ({ color: "green" as const, label: templateFromRuntimeContext(currentContext)!.template.name })
  };
  const saved = new SessionStateStore(dataDir);
  const store = new SessionStore(plugins, new PathPolicy([root]), new TabContextService(dataDir), undefined, undefined, resolver, undefined, saved);
  const gates: Gate[] = [];
  onTestFinished(async () => {
    for (const gate of gates) gate.release();
    await store.dispose();
    for (const { terminal } of terminals.launches) { terminal.termination = undefined; await terminal.terminate(); }
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const precedingTab = options.precedingTab ? await store.createTab({ pluginId: AGENT_TERMINAL_PLUGIN_ID, cwd: root }) : undefined;
  const tab = await store.createTab({ pluginId: AGENT_TERMINAL_PLUGIN_ID, cwd: root, initialInput: { prompt: "Never replay the original prompt." } });
  const previous = store.getSession(tab.id);
  const launch = terminals.launches.at(-1)!;
  const executionId = String(previous.restoreInput?.()?.codexExecutionId);
  const threadId = "01a08470-d118-7b72-b1df-439e72e5c744";
  const work: CodexNativeWork = {
    version: 1, tabId: tab.id, executionId, threadId, updatedAt: new Date().toISOString(),
    turnId: "failed-turn", turnStatus: "failed", goalStatus: "blocked",
    lastError: { kind: "terminal", message: "The provider reported an internal processing error.", requestId: "provider-request" }
  };
  const receipt = new CodexConversationRecovery(launch.options.env.CODEX_HOME!);
  await fs.mkdir(path.join(home, "sessions"), { recursive: true });
  await fs.writeFile(path.join(home, "sessions", `rollout-${threadId}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: root } }) + "\n");
  await fs.writeFile(receipt.receiptPath, JSON.stringify({ version: 2, authority: "selected", tabId: tab.id, executionId, sessionId: threadId, cwd: root }));
  await fs.writeFile(codexNativeWorkPath(launch.options.env.CODEX_HOME!), JSON.stringify(work));
  await vi.waitFor(() => {
    expect(previous.nativeWork?.()).toEqual(work);
    expect(previous.restoreInput?.()).toMatchObject({ resume: { mode: "session", sessionId: threadId } });
  });
  const request: RecoverTabRequest = { action: "restart-native", executionId, sessionId: threadId };
  return {
    root, store, tab, precedingTab, previous, terminals, resolver, saved, request, retiring: launch.terminal,
    selectTemplate(name: string) { currentContext = templateContext(name); },
    gate() { const gate = new Gate(); gates.push(gate); return gate; }
  };
}

describe("runtime context during native recovery", () => {
  it("queues bulk template saves during replacement launch and persists the update on the replacement", async () => {
    const f = await fixture();
    const sibling = await f.store.createTab({ pluginId: AGENT_TERMINAL_PLUGIN_ID, cwd: f.root });
    const siblingSession = f.store.getSession(sibling.id);
    const siblingTerminal = f.terminals.launches[1]!.terminal;
    const launch = f.gate();
    f.terminals.launchDelay = launch;
    const recovering = f.store.recoverTab(f.tab.id, f.request);
    await vi.waitFor(() => expect(f.terminals.spawn).toHaveBeenCalledTimes(3));
    expect(() => f.store.getSession(f.tab.id)).toThrow();
    f.selectTemplate("Changed");
    const updating = f.store.applyRuntimeContexts(candidate => candidate.id === f.tab.id, "Applying window template changes.");
    const savedUpdate = vi.fn();
    void updating.then(savedUpdate);
    await f.store.applyRuntimeContexts(candidate => candidate.id === sibling.id);
    expect(savedUpdate).not.toHaveBeenCalled();
    expect(siblingTerminal.written).toContain("Changed");
    expect(siblingTerminal.terminate).not.toHaveBeenCalled();
    expect(f.store.getSession(sibling.id)).toBe(siblingSession);
    expect(f.retiring.written).toBe("");
    launch.release();
    await recovering;
    const applied = await updating;
    expect(applied.map(tab => tab.id)).toEqual([f.tab.id]);
    const replacement = f.store.getSession(f.tab.id);
    expect(replacement.restoreInput?.()).toMatchObject({ resume: { mode: "session", sessionId: f.request.sessionId } });
    expect(templateFromRuntimeContext(replacement.restoreInput?.()?.codexRuntimeContext as WorkspaceRuntimeContext)?.template.name).toBe("Changed");
    expect(f.terminals.launches[2]!.terminal.written).toContain("Changed");
    expect(f.terminals.launches[2]!.terminal.written).not.toContain("Never replay");
    expect(f.retiring.written).toBe("");
    await f.saved.flush();
    const persisted = (await f.saved.read())!.sessions.find(saved => saved.tab.id === f.tab.id)!;
    expect(templateFromRuntimeContext(persisted.initialInput?.codexRuntimeContext as WorkspaceRuntimeContext)?.template.name).toBe("Changed");
  });

  it("rejects bulk template saves queued during a failed replacement launch without submitting the update", async () => {
    const f = await fixture();
    const launch = f.gate();
    f.terminals.launchDelay = launch;
    f.terminals.nextSpawnFailure = new Error("Replacement launch rejected.");
    const recovering = f.store.recoverTab(f.tab.id, f.request);
    await vi.waitFor(() => expect(f.terminals.spawn).toHaveBeenCalledTimes(2));
    expect(() => f.store.getSession(f.tab.id)).toThrow();
    f.selectTemplate("Changed");
    const updating = f.store.applyRuntimeContexts(() => true, "Applying saved rules/skills changes.");
    const outcomes = Promise.allSettled([recovering, updating]);
    launch.release();
    expect(await outcomes).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "Replacement launch rejected." }) },
      { status: "rejected", reason: expect.objectContaining({ message: "Replacement launch rejected." }) }
    ]);
    expect(f.retiring.written).toBe("");
    expect(f.terminals.launches).toHaveLength(1);
    expect(f.store.getTab(f.tab.id)).toMatchObject({ status: "failed", nativeWork: { recoveryStatus: "failed" } });
    await f.saved.flush();
    const persisted = (await f.saved.read())!.sessions.find(saved => saved.tab.id === f.tab.id)!;
    expect(templateFromRuntimeContext(persisted.initialInput?.codexRuntimeContext as WorkspaceRuntimeContext)?.template.name).toBe("Original");
    expect(await f.store.applyRuntimeContexts(() => true)).toEqual([]);
  });

  it("queues every bulk target before an earlier tab update can outlast a replacement failure", async () => {
    const f = await fixture({ precedingTab: true });
    const launch = f.gate();
    f.terminals.launchDelay = launch;
    f.terminals.nextSpawnFailure = new Error("Replacement launch rejected.");
    const recovering = f.store.recoverTab(f.tab.id, f.request);
    await vi.waitFor(() => expect(f.terminals.spawn).toHaveBeenCalledTimes(3));
    f.selectTemplate("Changed");
    const resolution = f.gate();
    f.resolver.runtimeContextFor.mockImplementationOnce(async () => { await resolution.waiting; return templateContext("Changed"); });
    const updating = f.store.applyRuntimeContexts(() => true);
    const outcomes = Promise.allSettled([recovering, updating]);
    launch.release();
    await expect(recovering).rejects.toThrow("Replacement launch rejected.");
    resolution.release();
    expect(await outcomes).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "Replacement launch rejected." }) },
      { status: "rejected", reason: expect.objectContaining({ message: "Replacement launch rejected." }) }
    ]);
    await vi.waitFor(() => expect(f.terminals.launches[0]!.terminal.written).toContain("Changed"));
    expect(f.store.getSession(f.precedingTab!.id)).toBeDefined();
    expect(f.retiring.written).toBe("");
    expect(f.terminals.launches).toHaveLength(2);
  });

  it("acknowledges a template update on the replacement while shutdown waits and other tabs keep accepting updates", async () => {
    const f = await fixture();
    const sibling = await f.store.createTab({ pluginId: AGENT_TERMINAL_PLUGIN_ID, cwd: f.root });
    const siblingTerminal = f.terminals.launches[1]!.terminal;
    const shutdown = f.gate();
    f.retiring.termination = shutdown;
    const recovering = f.store.recoverTab(f.tab.id, f.request);
    await vi.waitFor(() => expect(f.retiring.terminate).toHaveBeenCalledOnce());
    f.selectTemplate("Changed");
    const updating = f.store.applyRuntimeContext(f.tab.id);
    await f.store.applyRuntimeContext(sibling.id);
    expect(siblingTerminal.written).toContain("Changed");
    expect(siblingTerminal.terminate).not.toHaveBeenCalled();
    expect(f.retiring.written).toBe("");
    shutdown.release();
    await recovering;
    await updating;
    const replacement = f.store.getSession(f.tab.id);
    expect(templateFromRuntimeContext(replacement.restoreInput?.()?.codexRuntimeContext as WorkspaceRuntimeContext)?.template.name).toBe("Changed");
    expect(f.terminals.launches[2]!.terminal.written).toContain("Changed");
    expect(f.terminals.launches[2]!.terminal.written).not.toContain("Never replay");
    expect(f.retiring.written).toBe("");
    await f.saved.flush();
    const persisted = (await f.saved.read())!.sessions.find(saved => saved.tab.id === f.tab.id)!;
    expect(templateFromRuntimeContext(persisted.initialInput?.codexRuntimeContext as WorkspaceRuntimeContext)?.template.name).toBe("Changed");
  });

  it("finishes an already resolving update before preparing recovery and preserves its acknowledged template at launch", async () => {
    const f = await fixture();
    f.selectTemplate("Changed");
    const resolution = f.gate();
    const changed = templateContext("Changed");
    f.resolver.runtimeContextFor.mockImplementationOnce(async () => { await resolution.waiting; return changed; });
    const updating = f.store.applyRuntimeContext(f.tab.id);
    const recovering = f.store.recoverTab(f.tab.id, f.request);
    await Promise.resolve();
    expect(f.retiring.terminate).not.toHaveBeenCalled();
    resolution.release();
    await updating;
    await recovering;
    expect(f.retiring.writtenBeforeTermination).toContain("Changed");
    expect(f.retiring.written).toBe(f.retiring.writtenBeforeTermination);
    expect(f.terminals.launches[1]!.options.env.CLOUDX_PERSONALITY_TEMPLATE_ID).toBe("changed");
    const restored = f.store.getSession(f.tab.id).restoreInput?.();
    expect(templateFromRuntimeContext(restored?.codexRuntimeContext as WorkspaceRuntimeContext)?.template.name).toBe("Changed");
    expect(f.terminals.launches[1]!.terminal.written).toBe("");
  });

  it("rejects a queued update without submitting it when the replacement fails to launch", async () => {
    const f = await fixture();
    const shutdown = f.gate();
    f.retiring.termination = shutdown;
    const recovering = f.store.recoverTab(f.tab.id, f.request);
    await vi.waitFor(() => expect(f.retiring.terminate).toHaveBeenCalledOnce());
    f.selectTemplate("Changed");
    f.terminals.nextSpawnFailure = new Error("Replacement launch rejected.");
    const updating = f.store.applyRuntimeContext(f.tab.id);
    const outcomes = Promise.allSettled([recovering, updating]);
    shutdown.release();
    expect(await outcomes).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "Replacement launch rejected." }) },
      { status: "rejected", reason: expect.objectContaining({ message: "Replacement launch rejected." }) }
    ]);
    expect(f.retiring.written).toBe("");
    expect(f.terminals.launches).toHaveLength(1);
    expect(f.store.getTab(f.tab.id)).toMatchObject({ status: "failed" });
  });
});

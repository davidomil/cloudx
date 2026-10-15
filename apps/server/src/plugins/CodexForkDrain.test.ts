import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { listTabLayoutPanes } from "@cloudx/shared";

import { TabContextService } from "../context/TabContextService.js";
import { PathPolicy } from "../pathPolicy.js";
import { PluginRegistry } from "../pluginRegistry.js";
import { SessionStore } from "../sessionStore.js";
import type { TerminalProcess, TerminalProcessFactory, TerminalSpawnOptions } from "../terminal/TerminalProcess.js";
import type { TerminalExit } from "../terminal/TerminalSupervisor.js";
import { SessionStateStore } from "../workspace/SessionStateStore.js";
import { WorkspaceCommandService } from "../workspace/WorkspaceCommandService.js";
import { WorkspaceLayoutStore } from "../workspace/WorkspaceLayoutStore.js";
import { CodexConversationForks } from "./CodexConversationForks.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CODEX_CLOSE_ON_EXIT_GRACE_MS, CodexTerminalPlugin } from "./CodexTerminalPlugin.js";

const firstId = "01a08470-d118-7b72-b1df-439e72e5c745";
const secondId = "01a08470-d118-7b72-b1df-439e72e5c746";

it.each([false, true])("opens later confirmed forks exactly once before source closure when the first directory is missing: %s", async missingFirstDirectory => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fork-drain-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const env = { HOME: root, CODEX_HOME: home, SHELL: "/bin/bash", CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" };
  const sources = new CodexStateSources(data, env);
  const factory = new DrainTerminalFactory();
  const plugin = new CodexTerminalPlugin(factory, undefined, data, sources, env);
  const registry = new PluginRegistry();
  registry.register(plugin);
  const policy = new PathPolicy([root]);
  const workspace = new WorkspaceLayoutStore(data, policy);
  const saved = new SessionStateStore(data);
  const sessions = new SessionStore(registry, policy, new TabContextService(data), undefined, workspace, undefined, undefined, saved);
  const commands = new WorkspaceCommandService(sessions, workspace);
  let restoreClock: (() => void) | undefined;
  try {
    const imagegen = path.join(home, "skills", ".system", "imagegen");
    await fs.mkdir(imagegen, { recursive: true });
    await fs.writeFile(path.join(imagegen, "SKILL.md"), "---\nname: imagegen\ndescription: Generate images.\n---\nGenerate images.\n");
    const firstCwd = path.join(root, "first-fork");
    const secondCwd = path.join(root, "second-fork");
    if (!missingFirstDirectory) await fs.mkdir(firstCwd);
    await fs.mkdir(secondCwd);
    const window = workspace.getActiveWindow();
    const { tab: source } = await commands.createTab({
      pluginId: plugin.id, cwd: root, windowId: window.id, paneId: window.layout.activePaneId
    });
    const sourceSession = sessions.getSession(source.id);
    const journal = new CodexConversationForks(sources.viewPath(source.id));
    const closeTab = sessions.closeTab.bind(sessions);
    let childrenBeforeSourceClose: unknown[] | undefined;
    const close = vi.spyOn(sessions, "closeTab").mockImplementation((tabId, options) => {
      if (tabId === source.id) childrenBeforeSourceClose = sessions.listTabs()
        .filter(tab => tab.id !== source.id).map(tab => sessions.getSession(tab.id).restoreInput?.()?.resume);
      return closeTab(tabId, options);
    });
    await new Promise(resolve => setImmediate(resolve));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + CODEX_CLOSE_ON_EXIT_GRACE_MS + 1);
    restoreClock = () => clock.mockRestore();
    const first = { sessionId: firstId, cwd: firstCwd };
    const second = { sessionId: secondId, cwd: secondCwd };
    writeFileSync(journal.receiptPath, JSON.stringify({
      version: 1, tabId: source.id, executionId: sourceSession.restoreInput!()!.codexExecutionId,
      forks: [first, second, first, second]
    }));
    factory.terminals.get(source.id)!.exit(0);
    await vi.waitFor(() => expect(sessions.listTabs().some(tab => tab.id === source.id)).toBe(false));

    const expectedConversations = (missingFirstDirectory ? [secondId] : [firstId, secondId])
      .map(sessionId => ({ mode: "session", sessionId }));
    expect(childrenBeforeSourceClose).toEqual(expectedConversations);
    expect(sessions.listTabs().map(tab => sessions.getSession(tab.id).restoreInput?.()?.resume)).toEqual(expectedConversations);
    expect(sourceSession.restoreInput!()).toMatchObject({ codexOpenedForks: [firstId, secondId] });
    if (missingFirstDirectory) expect(sourceSession.restoreInput!()).toHaveProperty("codexForkError", expect.stringContaining("Could not open the confirmed Codex fork"));
    const state = await sessions.snapshot();
    const pane = listTabLayoutPanes(state.windows!.find(candidate => candidate.id === window.id)!.layout.root)[0]!;
    const childIds = sessions.listTabs().map(tab => tab.id);
    expect(pane.tabIds).toEqual(childIds);
    expect(pane.activeTabId).toBe(childIds.at(-1));
    expect((await saved.read())!.sessions.map(entry => entry.initialInput?.resume)).toEqual(expectedConversations);
    expect(factory.terminals.size).toBe(expectedConversations.length + 1);
    expect(close.mock.calls.filter(([tabId]) => tabId === source.id)).toHaveLength(1);
  } finally {
    restoreClock?.();
    await sessions.dispose();
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

class DrainTerminalFactory implements TerminalProcessFactory {
  readonly terminals = new Map<string, DrainTerminal>();

  async spawn(_command: string, _args: string[], options: TerminalSpawnOptions): Promise<TerminalProcess> {
    const terminal = new DrainTerminal();
    this.terminals.set(options.sessionId!, terminal);
    return terminal;
  }
}

class DrainTerminal implements TerminalProcess {
  private readonly exitListeners = new Set<(event: TerminalExit) => void>();
  private exited = false;

  onData() { return () => {}; }
  onExit(listener: (event: TerminalExit) => void) {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }
  write() {}
  resize() {}
  detach() {}
  kill() { this.exit(130); }
  async terminate() { this.kill(); }
  exit(exitCode: number) {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

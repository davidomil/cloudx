import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import type { CreatePluginSessionInput, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";
import { listTabLayoutPanes } from "@cloudx/shared";
import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { SessionStore } from "./sessionStore.js";
import { WorkspaceCommandService } from "./workspace/WorkspaceCommandService.js";
import { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fork-ownership-"));
  const data = path.join(root, "data");
  const policy = new PathPolicy([root]);
  const inputs = new Map<string, CreatePluginSessionInput>();
  const createSession = vi.fn((input: CreatePluginSessionInput): PluginSession => {
    inputs.set(input.tab.id, input);
    return {
      tab: input.tab, snapshot: () => ({ tabId: input.tab.id, pluginId: input.tab.pluginId, title: input.tab.title, cwd: input.cwd, status: "running" }),
      voiceContext: () => ({ kind: "test", cwd: input.cwd, summary: "Fork ownership" }),
      handleAction: () => ({}), restoreInput: () => input.initialInput, stop: () => undefined,
      detach: () => undefined
    };
  });
  const plugin: WorkspacePlugin = {
    id: "codex-terminal", acronym: "CDX", displayName: "Codex", description: "Test", panelKind: "terminal",
    creatable: true, requiresDirectory: true, actions: [], createSession, restoreSession: createSession,
    descriptor() { return { id: this.id, acronym: this.acronym, displayName: this.displayName, description: this.description,
      panelKind: this.panelKind, creatable: true, requiresDirectory: true, configFields: [], actions: [] }; }
  };
  const registry = new PluginRegistry();
  registry.register(plugin);
  const workspace = new WorkspaceLayoutStore(data, policy);
  const saved = new SessionStateStore(data);
  const makeStore = () => new SessionStore(registry, policy, new TabContextService(data), undefined, workspace, undefined, undefined, saved);
  const stores: SessionStore[] = [];
  const sessions = makeStore();
  stores.push(sessions);
  const commands = new WorkspaceCommandService(sessions, workspace);
  const window = workspace.getActiveWindow();
  const { tab: source } = await commands.createTab({
    pluginId: plugin.id, cwd: root, windowId: window.id, paneId: window.layout.activePaneId,
    initialInput: { resume: { mode: "session", sessionId: "parent" }, prompt: "Do not replay" }
  });
  const sourceInput = inputs.get(source.id)!;
  onTestFinished(async () => {
    for (const store of stores.reverse()) await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, sessions, workspace, saved, source, sourceInput, inputs, createSession, commands,
    async reconnect() {
      await sessions.dispose();
      const restored = makeStore();
      stores.push(restored);
      await restored.restore();
      return restored;
    }
  };
}

it("places and focuses one confirmed fork in the source pane even after workspace selection changes", async () => {
  const f = await fixture();
  const sourceWindow = f.workspace.findWindowForTab(f.source.id)!;
  const other = await f.workspace.createWindow({ name: "Elsewhere", defaultCwd: f.root });
  expect(f.workspace.getActiveWindow().id).toBe(other.id);
  const childCwd = path.join(f.root, "native-fork-directory");
  await fs.mkdir(childCwd);
  const request = { key: "fork-id", cwd: childCwd, initialInput: { resume: { mode: "session", sessionId: "child" } } };
  await Promise.all([f.sourceInput.controls.openSiblingTab!(request), f.sourceInput.controls.openSiblingTab!(request)]);
  const child = f.sessions.listTabs().find(tab => tab.id !== f.source.id)!;
  expect(f.sessions.listTabs()).toHaveLength(2);
  expect(f.createSession).toHaveBeenCalledTimes(2);
  expect(child.cwd).toBe(childCwd);
  expect(f.sessions.getTab(f.source.id).cwd).toBe(f.root);
  expect(f.workspace.findWindowForTab(child.id)?.id).toBe(sourceWindow.id);
  const pane = listTabLayoutPanes(f.workspace.getWindow(sourceWindow.id).layout.root).find(pane => pane.tabIds.includes(f.source.id))!;
  expect(pane.tabIds).toEqual([f.source.id, child.id]);
  expect(pane.activeTabId).toBe(child.id);
  expect(f.workspace.getActiveWindow().id).toBe(sourceWindow.id);
  const saved = await f.saved.read();
  expect(saved!.sessions.find(entry => entry.tab.id === f.source.id)!.initialInput).toEqual(f.sourceInput.initialInput);
  expect(saved!.sessions.find(entry => entry.tab.id === child.id)!.initialInput).toMatchObject({ resume: { sessionId: "child" } });
  expect(f.inputs.get(child.id)!.initialInput).not.toHaveProperty("prompt");
  const restored = await f.reconnect();
  await f.inputs.get(f.source.id)!.controls.openSiblingTab!(request);
  expect(restored.listTabs()).toHaveLength(2);
});

it("does not reopen a closed child when the same receipt is observed again", async () => {
  const f = await fixture();
  const request = { key: "fork-id", cwd: f.root, initialInput: { resume: { mode: "session", sessionId: "child" } } };
  await f.sourceInput.controls.openSiblingTab!(request);
  const child = f.sessions.listTabs().find(tab => tab.id !== f.source.id)!;
  await f.sessions.closeTab(child.id);
  await f.sourceInput.controls.openSiblingTab!(request);
  expect(f.sessions.listTabs().map(tab => tab.id)).toEqual([f.source.id]);
});

it("keeps a confirmed fork visible and focused when a workspace read queues during its durable placement", async () => {
  const f = await fixture();
  const window = f.workspace.findWindowForTab(f.source.id)!;
  const workspaceFile = (f.workspace as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
  const originalWrite = workspaceFile.write.bind(workspaceFile);
  let notifyWriteStarted!: () => void;
  let releaseWrite!: () => void;
  const writeStarted = new Promise<void>(resolve => { notifyWriteStarted = resolve; });
  const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve; });
  workspaceFile.write = vi.fn(originalWrite).mockImplementationOnce(async value => {
    notifyWriteStarted();
    await writeReleased;
    await originalWrite(value);
  });
  const placement = f.sourceInput.controls.openSiblingTab!({
    key: "fork-during-workspace-read", cwd: f.root,
    initialInput: { resume: { mode: "session", sessionId: "child" } }
  });
  let snapshot: ReturnType<SessionStore["snapshot"]> | undefined;
  try {
    await writeStarted;
    expect(f.sessions.listTabs().map(tab => tab.id)).toEqual([f.source.id]);
    snapshot = f.sessions.snapshot();
    releaseWrite();
    await placement;
    const state = await snapshot;
    const child = f.sessions.listTabs().find(tab => tab.id !== f.source.id)!;
    expect(f.sessions.getSession(child.id).restoreInput?.()).toMatchObject({ resume: { sessionId: "child" } });
    expect(state.tabs.map(tab => tab.id)).toEqual([f.source.id, child.id]);
    expect(state.activeTabId).toBe(child.id);
    const pane = listTabLayoutPanes(state.windows!.find(candidate => candidate.id === window.id)!.layout.root)[0]!;
    expect(pane).toMatchObject({ tabIds: [f.source.id, child.id], activeTabId: child.id });
    const persisted = new WorkspaceLayoutStore(path.dirname(f.workspace.workspacePath), new PathPolicy([f.root]));
    expect(listTabLayoutPanes(persisted.getWindow(window.id).layout.root)[0]).toMatchObject({ tabIds: [f.source.id, child.id], activeTabId: child.id });
    expect((await f.saved.read())!.sessions.map(entry => entry.tab.id)).toEqual([f.source.id, child.id]);
  } finally {
    releaseWrite();
    await Promise.allSettled([placement, snapshot]);
    workspaceFile.write = originalWrite;
  }
});

it("leaves no empty tab after a failed fork launch and does not replay it", async () => {
  const f = await fixture();
  f.createSession.mockImplementationOnce(() => { throw new Error("Child launch failed"); });
  const request = { key: "fork-id", cwd: f.root, initialInput: { resume: { mode: "session", sessionId: "child" } } };
  await expect(f.sourceInput.controls.openSiblingTab!(request)).rejects.toThrow("Child launch failed");
  await expect(f.sourceInput.controls.openSiblingTab!(request)).rejects.toThrow("Child launch failed");
  expect(f.createSession).toHaveBeenCalledTimes(2);
  expect(f.sessions.listTabs().map(tab => tab.id)).toEqual([f.source.id]);
  expect(f.sessions.getSession(f.source.id).restoreInput?.()).toEqual(f.sourceInput.initialInput);
});

it("refuses a fork whose source has left the layout or whose cwd is outside allowed roots", async () => {
  const f = await fixture();
  await expect(f.sourceInput.controls.openSiblingTab!({ key: "outside-root", cwd: "/", initialInput: {} })).rejects.toThrow();
  await f.sessions.closeTab(f.source.id);
  await expect(f.sourceInput.controls.openSiblingTab!({ key: "closed-source", cwd: f.root, initialInput: {} })).rejects.toThrow();
  expect(f.sessions.listTabs()).toEqual([]);
});

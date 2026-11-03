import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { descriptorFromPlugin, type CreatePluginSessionInput, type PluginSession, type WorkspacePlugin } from "@cloudx/plugin-api";
import { SessionStore, type SessionRuntimeContextResolver } from "./sessionStore.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";
import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(managed = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-session-lifecycle-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const events: string[] = [];
  const ended = vi.fn<NonNullable<SessionRuntimeContextResolver["executionEnded"]>>(async (_tab, execution) => { events.push(`ended:${execution.executionId}`); });
  let exited = false;
  let terminationFails = false;
  let sequence = 0;
  const detach = vi.fn();
  const plugin: WorkspacePlugin = {
    id: "codex-terminal", acronym: "AI", displayName: "Agent", description: "Lifecycle fixture", panelKind: "terminal", creatable: true, requiresDirectory: true,
    actions: [{ name: "stop", description: "Stop", voiceExposed: false, inputSchema: { type: "object", additionalProperties: false } }],
    descriptor() { return descriptorFromPlugin(this); },
    prepareAgentSwitch: async (_input, request) => ({ agent: { providerId: request.providerId } }),
    async createSession(input: CreatePluginSessionInput): Promise<PluginSession> {
      const initialInput = { ...input.initialInput, codexExecutionId: `execution-${++sequence}` };
      events.push(`create:${initialInput.codexExecutionId}`);
      await input.controls.setRestoreInput?.(initialInput);
      exited = false;
      return { tab: input.tab, restoreInput: () => initialInput, hasExited: () => exited, detach,
        async terminate() { events.push("terminate"); if (terminationFails) throw new Error("Execution is still alive"); exited = true; },
        stop() { exited = true; },
        snapshot: () => ({ tabId: input.tab.id, pluginId: plugin.id, title: input.tab.title, cwd: root, status: "running", state: { turn: "idle" } }),
        voiceContext: () => ({ kind: "agent", cwd: root, summary: "Lifecycle fixture" }),
        handleAction() { exited = true; return {}; } };
    }
  };
  const registry = new PluginRegistry(); registry.register(plugin);
  if (managed) registry.register({ ...plugin, id: "forge", creatable: false });
  const sessions = new SessionStore(registry, new PathPolicy([root]), new TabContextService(root), undefined, undefined,
    { runtimeContextFor: () => ({}), tabIndicatorFor: () => undefined, executionEnded: ended }, undefined, new SessionStateStore(root));
  cleanup.push(() => sessions.dispose());
  const tab = managed ? await sessions.prepareTab({ pluginId: plugin.id, cwd: root, initialInput: { agent: { providerId: "codex" } } }, undefined, { ownerPluginId: "forge", agentTurn: { workerId: "worker-1", attemptId: "attempt-1", receiptPath: path.join(root, "turn.json") } }) :
    await sessions.createTab({ pluginId: plugin.id, cwd: root, initialInput: { agent: { providerId: "codex" } } });
  return { sessions, tab, events, ended, detach, failTermination: () => { terminationFails = true; } };
}

it("reports the original exact execution after termination and before a provider switch relaunch", async () => {
  const f = await fixture();
  await f.sessions.switchAgent(f.tab.id, { providerId: "claude", accountId: "claude-fixture" });
  expect(f.events).toEqual(["create:execution-1", "terminate", "ended:execution-1", "create:execution-2"]);
  expect(f.ended).toHaveBeenCalledWith(f.tab, { providerId: "codex", executionId: "execution-1" });
  expect(f.sessions.agentLineage(f.tab.id).executionId).toBe("execution-2");
});

it("reports confirmed restart, stop, and close without assigning their replacement execution", async () => {
  const f = await fixture();
  await f.sessions.restartTab(f.tab.id);
  expect(f.ended.mock.calls[0]?.[1].executionId).toBe("execution-1");
  await f.sessions.executePluginAction(f.tab.id, "stop", {});
  expect(f.ended.mock.calls[1]?.[1].executionId).toBe("execution-2");
  await f.sessions.closeTab(f.tab.id);
  expect(f.ended.mock.calls.at(-1)?.[1].executionId).toBe("execution-2");
});

it("does not report confirmed termination when process termination fails or the server detaches", async () => {
  const f = await fixture();
  f.failTermination();
  await expect(f.sessions.closeTab(f.tab.id)).rejects.toThrow("still alive");
  expect(f.ended).not.toHaveBeenCalled();
  await f.sessions.dispose();
  expect(f.detach).toHaveBeenCalledOnce();
  expect(f.ended).not.toHaveBeenCalled();
});

it("leaves Forge termination authority with the worker runtime's quiescence evidence", async () => {
  const f = await fixture(true);
  await f.sessions.discardPreparedTab(f.tab.id);
  expect(f.ended).not.toHaveBeenCalled();
});

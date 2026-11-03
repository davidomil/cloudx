import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab, WorkspaceTabsUpdate } from "@cloudx/shared";

import { BlackboardService } from "../cooperation/BlackboardService.js";
import { AgentCooperationContext } from "../cooperationAgent/AgentCooperationContext.js";
import type { SessionStore } from "../sessionStore.js";
import { CooperationHost } from "./CooperationHost.js";

let root: string;
let boards: BlackboardService;
let contexts: AgentCooperationContext;
let host: CooperationHost;
let tabs: WorkspaceTab[];
let provider: "codex" | "claude";
let forget = vi.fn<(tabId: string) => void>();
const removalListeners = new Set<(tab: WorkspaceTab) => void | Promise<void>>();
const changeListeners = new Set<(update: WorkspaceTabsUpdate) => void>();
const agent = { id: "agent", pluginId: "codex-terminal", title: "Managed architect", ownerPluginId: "forge-workers", status: "running" } as WorkspaceTab;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cooperation-host-"));
  boards = new BlackboardService({ rootDir: path.join(root, "boards") });
  await boards.init();
  tabs = [agent];
  provider = "codex";
  contexts = new AgentCooperationContext({ dataDir: root, endpoint: () => "http://localhost:4317/api/cooperation/agent",
    binding: id => tabs.some(tab => tab.id === id) ? { ...boards.metadataForTab(id), providerId: provider } : undefined });
  const sessions = { listTabs: () => tabs, getTab: (id: string) => {
    const tab = tabs.find(tab => tab.id === id);
    if (!tab) throw new Error("Unknown tab");
    return tab;
  }, agentProvider: () => provider, agentLineage: () => ({ logicalRunId: "worker", attemptId: "attempt" }),
  onTabRemoved: (listener: (tab: WorkspaceTab) => void | Promise<void>) => { removalListeners.add(listener); return () => removalListeners.delete(listener); },
  onTabsChange: (listener: (update: WorkspaceTabsUpdate) => void) => { changeListeners.add(listener); return () => changeListeners.delete(listener); }
  } as unknown as SessionStore;
  forget = vi.fn<(tabId: string) => void>();
  host = new CooperationHost(boards, contexts, sessions, error => { throw error; }, { forget });
});
afterEach(async () => { await host.dispose(); removalListeners.clear(); changeListeners.clear(); await fs.rm(root, { recursive: true, force: true }); });
function changed() { for (const listener of changeListeners) listener({ tabs } as WorkspaceTabsUpdate); }
async function remove(tab: WorkspaceTab) { tabs = tabs.filter(candidate => candidate.id !== tab.id); for (const listener of removalListeners) await listener(tab); }

describe("cooperation host restoration and ownership", () => {
  it("preserves restored managed ownership and closes only after the final assigned tab is definitively removed", async () => {
    const board = await boards.createBoard({ title: "Architecture", tab: { tabId: agent.id, providerId: provider, label: agent.title } });
    const viewer = { ...agent, id: "viewer", pluginId: "cooperation", ownerPluginId: undefined };
    tabs.push(viewer);
    await host.start();
    expect(boards.getBoard(board.boardId).status).toBe("active");
    await remove(viewer);
    expect(boards.getBoard(board.boardId).members).toHaveLength(1);
    await remove(agent);
    expect(boards.getBoard(board.boardId)).toMatchObject({ status: "closed", members: [] });
    await expect(fs.stat(contexts.contextPath(agent.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await boards.readBoard(board.boardId)).board.title).toBe("Architecture");
  });

  it("refreshes provider identity without changing membership generation and leaves siblings unassigned", async () => {
    const board = await boards.createBoard({ title: "Switch", tab: { tabId: agent.id, providerId: provider, label: agent.title } });
    await host.start();
    const generation = boards.metadataForTab(agent.id).assignmentGeneration;
    provider = "claude";
    tabs = [{ ...agent, title: "Renamed" }, { ...agent, id: "sibling" }];
    changed();
    await vi.waitFor(() => expect(boards.getBoard(board.boardId).members[0]).toMatchObject({ providerId: "claude", label: "Renamed", assignmentGeneration: generation }));
    expect(boards.metadataForTab("sibling").boardId).toBeNull();
  });

  it("treats shutdown as teardown while retaining the durable assignment", async () => {
    const board = await boards.createBoard({ title: "Resume", tab: { tabId: agent.id, providerId: provider, label: agent.title } });
    await host.start();
    host.beginShutdown();
    await remove(agent);
    changed();
    await host.dispose();
    const restored = new BlackboardService({ rootDir: path.join(root, "boards") });
    await restored.init();
    expect(restored.getBoard(board.boardId)).toMatchObject({ status: "active", members: [expect.objectContaining({ tabId: agent.id })] });
  });

  it("keeps an explicit owner continuation live until the same logical run binds its replacement", async () => {
    const board = await boards.createBoard({ title: "Continue", tab: { tabId: agent.id, providerId: provider, label: agent.title } });
    await host.start();
    expect(await host.beginContinuation(agent.id)).toBe(true);
    await remove(agent);
    expect(boards.getBoard(board.boardId).status).toBe("active");
    await expect(fs.stat(contexts.contextPath(agent.id))).rejects.toMatchObject({ code: "ENOENT" });
    const replacement = { ...agent, id: "replacement" };
    tabs.push(replacement);
    await host.transferContinuation(agent.id, replacement.id);
    expect(boards.getBoard(board.boardId).members.map(member => member.tabId)).toEqual([replacement.id]);
    expect(boards.continuationForTab(agent.id)).toBeUndefined();
    expect((await contexts.prepare(replacement.id)).boardId).toBe(board.boardId);
  });

  it("rejects another owner and closes a removed source when continuation is abandoned", async () => {
    const board = await boards.createBoard({ title: "Failed continuation", tab: { tabId: agent.id, providerId: provider, label: agent.title } });
    await host.start();
    await host.beginContinuation(agent.id);
    await remove(agent);
    tabs.push({ ...agent, id: "unrelated", ownerPluginId: "another-owner" });
    await expect(host.transferContinuation(agent.id, "unrelated")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await host.abortContinuation(agent.id);
    expect(boards.getBoard(board.boardId)).toMatchObject({ status: "closed", members: [] });
  });

  it("revokes the ended tab even when durable membership cleanup reports a storage failure", async () => {
    await boards.createBoard({ title: "Storage failure", tab: { tabId: agent.id, providerId: provider, label: agent.title } });
    await host.start();
    vi.spyOn(boards, "removeTab").mockRejectedValueOnce(new Error("Authority write unavailable"));
    await expect(remove(agent)).rejects.toThrow("Authority write unavailable");
    await expect(fs.stat(contexts.contextPath(agent.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(forget).toHaveBeenCalledExactlyOnceWith(agent.id);
  });
});

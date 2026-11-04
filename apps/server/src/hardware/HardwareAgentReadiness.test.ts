import { expect, it, vi } from "vitest";
import type { AgentLaunchRecord, WorkspaceTab } from "@cloudx/shared";
import { hardwareAgentReadiness } from "./HardwareAgentReadiness.js";

it("distinguishes an old running process from a launch that received its exact helper environment", async () => {
  const tabs = [{ id: "old", pluginId: "codex-terminal", status: "running" }, { id: "ready", pluginId: "codex-terminal", status: "running" }, { id: "other", pluginId: "hardware", status: "running" }] as WorkspaceTab[];
  const sessions = { listTabs: () => tabs, agentProvider: () => "codex" as const, agentLineage: (tabId: string) => ({ executionId: `${tabId}-execution` }) };
  const keys = ["CLOUDX_HARDWARE_CONTEXT", "CLOUDX_HARDWARE_HELPER"];
  const launches = { read: vi.fn(async (tabId: string) => ({ executionId: `${tabId}-execution`, environmentKeys: tabId === "ready" ? keys : [], enforcedEnvironmentKeys: keys }) as AgentLaunchRecord) };
  expect(await hardwareAgentReadiness(sessions, launches)).toEqual([
    { tabId: "old", providerId: "codex", executionId: "old-execution", state: "relaunch_required", reason: expect.stringContaining("Relaunch") },
    { tabId: "ready", providerId: "codex", executionId: "ready-execution", state: "ready" }
  ]);
  expect(launches.read).toHaveBeenCalledTimes(2);
});

it("does not treat a stale, missing, unenforced, or unreadable launch record as ready", async () => {
  const tab = { id: "agent", pluginId: "codex-terminal", status: "running" } as WorkspaceTab;
  const sessions = { listTabs: () => [tab], agentProvider: () => "claude" as const, agentLineage: () => ({ executionId: "current" }) };
  for (const launch of [undefined, { executionId: "old", environmentKeys: [], enforcedEnvironmentKeys: [] }, { executionId: "current", environmentKeys: ["CLOUDX_HARDWARE_CONTEXT", "CLOUDX_HARDWARE_HELPER"], enforcedEnvironmentKeys: [] }])
    expect((await hardwareAgentReadiness(sessions, { read: async () => launch as AgentLaunchRecord | undefined }))[0].state).toBe("relaunch_required");
  expect((await hardwareAgentReadiness(sessions, { read: async () => { throw new Error("Corrupt original launch record"); } }))[0].state).toBe("unavailable");
  tab.status = "failed";
  const read = vi.fn();
  expect((await hardwareAgentReadiness(sessions, { read }))[0]).toMatchObject({ state: "unavailable", reason: expect.stringContaining("not running") });
  expect(read).not.toHaveBeenCalled();
});

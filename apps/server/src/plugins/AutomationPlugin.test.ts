import type { AutomationGroup } from "@cloudx/shared";
import { describe, expect, it, vi } from "vitest";

import type { AutomationService } from "../automation/AutomationService.js";
import { AutomationPlugin } from "./AutomationPlugin.js";

describe("AutomationPlugin", () => {
  it("requires a boolean enabled value when executing the setEnabled hook", async () => {
    const service = {
      setEnabled: vi.fn(async (_groupId: string, enabled: boolean) => ({ id: "group", enabled }) as AutomationGroup)
    } as unknown as AutomationService;
    const plugin = new AutomationPlugin(() => service);
    const hook = plugin.hooks.find((candidate) => candidate.id === "automation.groups.setEnabled");

    await expect(hook!.execute({ groupId: "group" }, { caller: { kind: "plugin", pluginId: plugin.id } })).rejects.toThrow("enabled must be a boolean.");
    expect(service.setEnabled).not.toHaveBeenCalled();
  });

  it("requires a non-empty group id when executing the delete hook", async () => {
    const service = {
      deleteGroup: vi.fn(async () => [])
    } as unknown as AutomationService;
    const plugin = new AutomationPlugin(() => service);
    const hook = plugin.hooks.find((candidate) => candidate.id === "automation.groups.delete");

    await expect(hook!.execute({ groupId: "  " }, { caller: { kind: "plugin", pluginId: plugin.id } })).rejects.toThrow("groupId must be a non-empty string.");
    expect(service.deleteGroup).not.toHaveBeenCalled();

    await expect(hook!.execute({ groupId: " group " }, { caller: { kind: "plugin", pluginId: plugin.id } })).resolves.toEqual({ groups: [] });
    expect(service.deleteGroup).toHaveBeenCalledWith("group");
  });

  it("rejects malformed automation group saves before service calls", async () => {
    const service = {
      saveGroup: vi.fn()
    } as unknown as AutomationService;
    const plugin = new AutomationPlugin(() => service);
    const hook = plugin.hooks.find((candidate) => candidate.id === "automation.groups.save");

    await expect(hook!.execute({ group: { id: "group", name: "Group", enabled: true, graph: {} } }, { caller: { kind: "plugin", pluginId: plugin.id } })).rejects.toThrow("group.graph must be an automation graph document.");
    expect(service.saveGroup).not.toHaveBeenCalled();
  });

  it("rejects malformed automation graph overrides before service calls", async () => {
    const service = {
      validate: vi.fn(),
      startTest: vi.fn()
    } as unknown as AutomationService;
    const plugin = new AutomationPlugin(() => service);
    const validateHook = plugin.hooks.find((candidate) => candidate.id === "automation.graph.validate");
    const testRunHook = plugin.hooks.find((candidate) => candidate.id === "automation.runs.startTest");

    await expect(validateHook!.execute({ graph: {} }, { caller: { kind: "plugin", pluginId: plugin.id } })).rejects.toThrow("graph must be an automation graph document.");
    await expect(testRunHook!.execute({ groupId: "group", graph: {} }, { caller: { kind: "plugin", pluginId: plugin.id } })).rejects.toThrow("graph must be an automation graph document.");
    expect(service.validate).not.toHaveBeenCalled();
    expect(service.startTest).not.toHaveBeenCalled();
  });
});

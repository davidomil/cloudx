import { describe, expect, it, vi } from "vitest";

import type { WorkspaceLayoutTemplate, WorkspaceWindow } from "@cloudx/shared";

import type { SessionStore } from "../sessionStore.js";
import { WorkspaceCommandService } from "./WorkspaceCommandService.js";
import type { WorkspaceLayoutStore } from "./WorkspaceLayoutStore.js";

describe("WorkspaceCommandService", () => {
  it("retires every replaced tab and reports all post-commit cleanup failures", async () => {
    const window = workspaceWindow();
    const template: WorkspaceLayoutTemplate = {
      id: "template-1",
      name: "Template",
      basePath: "/workspace",
      layout: window.layout,
      tabs: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const closeTab = vi.fn((tabId: string) => {
      if (tabId === "tab-old-a") {
        throw new Error("first session did not stop cleanly");
      }
    });
    const publishPreparedTabs = vi.fn();
    const sessions = { assertPreparedTabsReady: vi.fn(), closeTab, publishPreparedTabs } as unknown as SessionStore;
    const notifyChange = vi.fn();
    const workspace = {
      prepareTemplateApplication: vi.fn().mockResolvedValue({
        template,
        window,
        projectPath: "/workspace",
        createdWindow: false,
        replacedTabIds: ["tab-old-a", "tab-old-b"]
      }),
      remapTemplateLayout: vi.fn().mockReturnValue(window.layout),
      commitTemplateAndPublish: vi.fn(async (_prepared: unknown, _layout: unknown, _name: unknown, publish: () => unknown) => ({ published: publish(), window })),
      notifyChange
    } as unknown as WorkspaceLayoutStore;
    const service = new WorkspaceCommandService(sessions, workspace);

    await expect(service.applyLayoutTemplate("template-1", { projectPath: "/workspace" })).rejects.toMatchObject({
      name: "AggregateError",
      message: "Workspace template committed, but one or more replaced tabs did not stop cleanly."
    });

    expect(publishPreparedTabs).toHaveBeenCalledWith([]);
    expect(closeTab.mock.calls).toEqual([["tab-old-a"], ["tab-old-b"]]);
    expect(notifyChange).toHaveBeenCalledTimes(1);
  });
});

function workspaceWindow(): WorkspaceWindow {
  const now = new Date(0).toISOString();
  return {
    id: "window-1",
    name: "Workspace",
    defaultCwd: "/workspace",
    layout: {
      root: { type: "pane", pane: { id: "pane-1", tabIds: [], activeTabId: undefined } },
      activePaneId: "pane-1"
    },
    pluginMetadata: {},
    createdAt: now,
    updatedAt: now
  };
}

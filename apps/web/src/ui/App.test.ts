import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceStateResponse } from "@cloudx/shared";

import { requestAudioInputEnumerationAccess, workspaceStateWithPreservedLayout } from "./App.js";

describe("requestAudioInputEnumerationAccess", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests microphone permission and immediately stops the temporary stream", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await requestAudioInputEnumerationAccess();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable microphone capture when getUserMedia is missing", async () => {
    vi.stubGlobal("navigator", { mediaDevices: {} });

    await expect(requestAudioInputEnumerationAccess()).rejects.toThrow("This browser does not expose microphone capture.");
  });
});

describe("workspaceStateWithPreservedLayout", () => {
  it("keeps a pending local layout instead of accepting a stale active-window snapshot", () => {
    const staleLayout = layoutWithActiveTab("tab-old");
    const localLayout = layoutWithActiveTab("tab-new");
    const state = workspaceState("window-1", staleLayout);

    const merged = workspaceStateWithPreservedLayout(state, localLayout, "window-1");

    expect(merged.windows[0]?.layout).toBe(localLayout);
    expect(merged).not.toBe(state);
  });

  it("does not alter snapshots for unrelated windows", () => {
    const state = workspaceState("window-1", layoutWithActiveTab("tab-old"));

    expect(workspaceStateWithPreservedLayout(state, layoutWithActiveTab("tab-new"), "window-2")).toBe(state);
    expect(workspaceStateWithPreservedLayout(state, layoutWithActiveTab("tab-new"), undefined)).toBe(state);
  });
});

function workspaceState(windowId: string, layout: WorkspaceStateResponse["windows"][number]["layout"]): WorkspaceStateResponse {
  return {
    activeTabId: "tab-new",
    tabs: [],
    windows: [
      {
        id: windowId,
        name: "Main",
        defaultCwd: "~",
        layout,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      }
    ],
    activeWindowId: windowId,
    templates: []
  };
}

function layoutWithActiveTab(tabId: string): WorkspaceStateResponse["windows"][number]["layout"] {
  return {
    root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-old", "tab-new"], activeTabId: tabId } },
    activePaneId: "pane-1"
  };
}

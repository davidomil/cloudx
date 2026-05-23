// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { runTabAction } from "../api.js";
import { WebViewerPanel } from "./WebViewerPanel.js";

vi.mock("../api.js", () => ({
  runTabAction: vi.fn()
}));

const runTabActionMock = vi.mocked(runTabAction);

let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("WebViewerPanel", () => {
  it("reloads local web state when the tab timestamp changes", async () => {
    runTabActionMock.mockResolvedValueOnce({ url: "http://127.0.0.1:5173/" }).mockResolvedValueOnce({ url: "http://127.0.0.1:5174/dashboard" });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(WebViewerPanel, { tab: workspaceTab("2026-05-23T00:00:00.000Z") }));
    });
    expect(runTabActionMock).toHaveBeenCalledTimes(1);
    const initialFrame = container.querySelector("iframe");
    expect(initialFrame?.getAttribute("src")).toBe("/api/local-web/tab-1/proxy/");
    expect(initialFrame?.getAttribute("sandbox")?.split(" ")).toEqual([
      "allow-downloads",
      "allow-forms",
      "allow-modals",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-pointer-lock",
      "allow-scripts"
    ]);

    await act(async () => {
      root!.render(createElement(WebViewerPanel, { tab: workspaceTab("2026-05-23T00:00:01.000Z") }));
    });

    expect(runTabActionMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("/api/local-web/tab-1/proxy/dashboard");
  });
});

function workspaceTab(updatedAt: string): WorkspaceTab {
  return {
    id: "tab-1",
    pluginId: "local-web",
    title: "Local Web",
    cwd: "/workspace",
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt },
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt
  };
}

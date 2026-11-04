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
    const notice = container.querySelector('[aria-label="Restricted preview"]');
    expect(notice?.textContent).toContain("Browser storage (localStorage and sessionStorage) is unavailable here");
    expect(notice?.textContent).toContain("localhost refers to this device in the new tab");
    for (const popout of container.querySelectorAll("a")) {
      expect(popout.getAttribute("href")).toBe("http://127.0.0.1:5173/");
      expect(popout.getAttribute("target")).toBe("_blank");
      expect(popout.getAttribute("rel")).toBe("noopener noreferrer");
    }

    await act(async () => {
      root!.render(createElement(WebViewerPanel, { tab: workspaceTab("2026-05-23T00:00:01.000Z") }));
    });

    expect(runTabActionMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("/api/local-web/tab-1/proxy/dashboard");
    expect(container.querySelector(".web-viewer-popout")?.getAttribute("href")).toBe("http://127.0.0.1:5174/dashboard");
  });

  it("shows the restriction only while a site is loaded and clears it with the viewer", async () => {
    runTabActionMock.mockResolvedValueOnce({ url: "http://127.0.0.1:5173/dashboard?token=abc#comparison" }).mockResolvedValueOnce({});
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(WebViewerPanel, { tab: workspaceTab("2026-05-23T00:00:00.000Z") }));
    });
    expect(container.querySelector(".web-viewer-popout")?.getAttribute("href")).toBe("http://127.0.0.1:5173/dashboard?token=abc#comparison");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[title="Clear URL"]')!.click();
    });
    expect(container.querySelector('[aria-label="Restricted preview"]')).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
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

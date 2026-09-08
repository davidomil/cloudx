// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDescriptor, TabLayoutState, WorkspaceStateResponse, WorkspaceTab } from "@cloudx/shared";

import { App } from "./App.js";
import { disposeFileBrowserPanelStatesExcept, type DirectoryEntry } from "./fileBrowserPanelState.js";

let root: Root;
let container: HTMLDivElement;
let server: FileBrowserServer;
let workspaceSocket: EventTarget;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("WebSocket", class extends EventTarget {
    constructor() {
      super();
      workspaceSocket = this;
    }
    close() {}
  });
  server = new FileBrowserServer();
  vi.stubGlobal("fetch", server.fetch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await import("./FileBrowserPanel.js");
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeFileBrowserPanelStatesExcept(new Set());
  container.remove();
  vi.unstubAllGlobals();
});

describe("retained Files tab listings", () => {
  it("refreshes the current directory on reselection while retaining the preview and download selection", async () => {
    await renderApp();
    expect(server.directoryRequests).toEqual([""]);

    await clickButton(".file-list-entry", "src");
    await clickButton(".file-list-entry", "notes.txt");
    const preview = container.querySelector('[aria-label="src/notes.txt preview"]');
    expect(preview?.textContent).toContain("Opened notes");
    await clickButton("button", "Select files or folders to download", "aria-label");
    const selection = container.querySelector<HTMLInputElement>('[aria-label="Select notes.txt for download"]')!;
    await act(async () => selection.click());
    expect(selection.checked).toBe(true);
    expect(server.directoryRequests).toEqual(["", "src"]);

    await selectTab("Other");
    expect(container.querySelector(".file-browser-panel")?.parentElement?.hidden).toBe(true);
    expect(server.directoryRequests).toEqual(["", "src"]);
    server.directories.src!.push({ name: "created-elsewhere.txt", type: "file" });
    await publishWorkspaceUpdate({ type: "automation-runs", runs: [] });
    expect(server.directoryRequests).toEqual(["", "src"]);

    await selectTab("Files");
    expect(server.directoryRequests).toEqual(["", "src", "src"]);
    expect(container.querySelector(".file-list")?.textContent).toContain("created-elsewhere.txt");
    expect(container.querySelector('[aria-label="src/notes.txt preview"]')).toBe(preview);
    expect(preview?.textContent).toContain("Opened notes");
    expect(container.querySelector('[aria-label="Select notes.txt for download"]')).toBe(selection);
    expect(selection.checked).toBe(true);

    await selectTab("Files");
    await publishWorkspaceUpdate({ type: "automation-runs", runs: [] });
    expect(server.directoryRequests).toEqual(["", "src", "src"]);
  });

  it("refreshes a reselected tab in an unfocused pane without refreshing on pane focus changes", async () => {
    const filesPane = server.workspace.windows[0]!.layout.root;
    server.workspace.tabs.push({ ...tab("focus", "Focus"), pluginId: "other" });
    server.workspace.activeTabId = "focus";
    server.workspace.windows[0]!.layout = {
      activePaneId: "pane-2",
      root: {
        type: "split", id: "split-1", direction: "row", sizes: [50, 50],
        children: [filesPane, { type: "pane", pane: { id: "pane-2", tabIds: ["focus"], activeTabId: "focus" } }]
      }
    };
    await renderApp();
    const files = container.querySelector(".file-browser-panel")!;
    expect(files.closest(".workspace-pane")?.classList.contains("active")).toBe(false);
    expect(server.directoryRequests).toEqual([""]);

    await publishPaneSelection("pane-1", "other");
    server.directories[""]!.push({ name: "new.txt", type: "file" });
    expect(server.directoryRequests).toEqual([""]);
    await publishPaneSelection("pane-1", "files");
    expect(files.closest(".workspace-pane")?.classList.contains("active")).toBe(false);
    expect(server.directoryRequests).toEqual(["", ""]);
    expect(files.querySelector(".file-list")?.textContent).toContain("new.txt");

    server.workspace.activeTabId = "files";
    server.workspace.windows[0]!.layout.activePaneId = "pane-1";
    await publishWorkspaceUpdate({ type: "workspace", ...server.workspace });
    expect(files.closest(".workspace-pane")?.classList.contains("active")).toBe(true);
    expect(server.directoryRequests).toEqual(["", ""]);
  });

  it.each([
    ["navigation", "success"], ["navigation", "failure"],
    ["deselection", "success"], ["deselection", "failure"]
  ] as const)("ignores a delayed refresh after %s when it returns %s", async (boundary, outcome) => {
    server.directories.src!.push({ name: "nested", type: "directory" });
    server.directories["src/nested"] = [{ name: "current.txt", type: "file" }];
    await renderApp();
    await clickButton(".file-list-entry", "src");
    await selectTab("Other");
    const refresh = deferredResponse();
    server.nextDirectoryResponse = refresh.response;
    await selectTab("Files");
    expect(server.directoryRequests).toEqual(["", "src", "src"]);

    if (boundary === "navigation") {
      await clickButton(".file-list-entry", "nested");
    } else {
      await selectTab("Other");
      server.directories.src = [{ name: "current.txt", type: "file" }];
      await selectTab("Files");
    }
    const currentListing = container.querySelector(".file-list")?.textContent;
    expect(currentListing).toContain("current.txt");
    await act(async () => refresh.resolve(outcome === "success"
      ? jsonResponse({ result: { path: "src", entries: [{ name: "stale.txt", type: "file" }] } })
      : jsonResponse({ message: "Stale refresh failed" }, 500)));
    expect(container.querySelector(".file-list")?.textContent).toBe(currentListing);
    expect(container.querySelector(".file-browser-panel .inline-error")).toBeNull();
  });

  it("retains an in-flight download and its error while refreshing listings on reselection", async () => {
    await renderApp();
    await clickButton(".file-list-entry", "src");
    await clickButton("button", "Select files or folders to download", "aria-label");
    const selection = container.querySelector<HTMLInputElement>('[aria-label="Select notes.txt for download"]')!;
    await act(async () => selection.click());
    const download = deferredResponse();
    server.downloadResponse = download.response;
    await clickButton("button", "Download 1 selected entries", "aria-label");
    await selectTab("Other");
    await selectTab("Files");
    expect(server.directoryRequests).toEqual(["", "src", "src"]);
    expect(selection.checked).toBe(true);
    expect(selection.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Download 1 selected entries"]')?.disabled).toBe(true);

    await selectTab("Other");
    await act(async () => download.resolve(jsonResponse({ message: "Download unavailable" }, 500)));
    await selectTab("Files");
    expect(container.querySelector(".file-browser-panel .inline-error")?.textContent).toBe("Download unavailable");
    expect(server.directoryRequests).toEqual(["", "src", "src", "src"]);
    expect(server.downloadRequests).toBe(1);
  });

  it("shows a current refresh failure without clearing the listing, preview or selection", async () => {
    await renderApp();
    await clickButton(".file-list-entry", "src");
    await clickButton(".file-list-entry", "notes.txt");
    const preview = container.querySelector('[aria-label="src/notes.txt preview"]');
    await clickButton("button", "Select files or folders to download", "aria-label");
    const selection = container.querySelector<HTMLInputElement>('[aria-label="Select notes.txt for download"]')!;
    await act(async () => selection.click());
    await selectTab("Other");
    server.nextDirectoryResponse = Promise.resolve(jsonResponse({ message: "Directory unavailable" }, 500));
    await selectTab("Files");

    expect(container.querySelector(".file-browser-panel .inline-error")?.textContent).toBe("Directory unavailable");
    expect(container.querySelector(".file-list")?.textContent).toContain("notes.txt");
    expect(container.querySelector('[aria-label="src/notes.txt preview"]')).toBe(preview);
    expect(selection.checked).toBe(true);
  });
});

async function renderApp() {
  await act(async () => root.render(createElement(App)));
}

async function selectTab(title: string) {
  await clickButton(".tab-activation", title);
}

async function clickButton(selector: string, text: string, attribute?: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>(selector)).find((candidate) =>
    (attribute ? candidate.getAttribute(attribute) : candidate.textContent) === text
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}

async function publishWorkspaceUpdate(update: unknown) {
  await act(async () => workspaceSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(update) })));
}

async function publishPaneSelection(paneId: string, tabId: string) {
  const root = server.workspace.windows[0]!.layout.root;
  if (root.type !== "split") throw new Error("Expected split workspace");
  const node = root.children.find((node) => node.type === "pane" && node.pane.id === paneId);
  if (node?.type !== "pane") throw new Error(`Missing pane: ${paneId}`);
  node.pane.activeTabId = tabId;
  await publishWorkspaceUpdate({ type: "workspace", ...server.workspace });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>((complete) => { resolve = complete; });
  return { response, resolve };
}

class FileBrowserServer {
  directoryRequests: string[] = [];
  nextDirectoryResponse?: Promise<Response>;
  downloadRequests = 0;
  downloadResponse?: Promise<Response>;
  directories: Record<string, DirectoryEntry[]> = {
    "": [{ name: "src", type: "directory" }],
    src: [{ name: "notes.txt", type: "file" }]
  };
  workspace = workspaceState();

  fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(url);
    if (path === "/api/plugins") return jsonResponse({ plugins: [plugin("files", "file-browser"), plugin("other", "placeholder")] });
    if (path === "/api/config") return jsonResponse({
      globalFields: [], plugins: [], values: { global: { aiControlEnabled: false }, plugins: { files: { showGitDiff: false } } }
    });
    if (path === "/api/workspace" || path === "/api/windows/window-1") return jsonResponse(this.workspace);
    if (path === "/api/notifications") return jsonResponse({ notifications: [] });
    if (path === "/api/automation/catalog") return jsonResponse({ nodes: [] });
    if (path === "/api/automation/groups") return jsonResponse({ groups: [] });
    if (path === "/api/hooks/rules-skills.catalog.list") return jsonResponse({ result: {} });
    if (/^\/api\/tabs\/[^/]+\/active$/.test(path)) return jsonResponse({});
    if (path === "/api/tabs/files/files/download" && this.downloadResponse) {
      this.downloadRequests += 1;
      return this.downloadResponse;
    }
    if (path === "/api/tabs/files/actions") {
      const request = JSON.parse(init?.body as string) as { action: string; input: { relativePath: string } };
      const relativePath = request.input.relativePath;
      if (request.action === "list_directory") {
        this.directoryRequests.push(relativePath);
        if (this.nextDirectoryResponse) {
          const response = this.nextDirectoryResponse;
          this.nextDirectoryResponse = undefined;
          return response;
        }
        return jsonResponse({ result: { path: relativePath, entries: this.directories[relativePath] } });
      }
      if (request.action === "open_file") return jsonResponse({ result: {
        path: `/repo/${relativePath}`, relativePath, truncated: false, content: "Opened notes"
      } });
      throw new Error(`Unexpected file action: ${request.action}`);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  const serialized = JSON.stringify(body);
  return { ok: status === 200, status, json: async () => JSON.parse(serialized), text: async () => serialized } as Response;
}

function workspaceState(): WorkspaceStateResponse {
  const layout: TabLayoutState = {
    root: { type: "pane", pane: { id: "pane-1", tabIds: ["files", "other"], activeTabId: "files" } },
    activePaneId: "pane-1"
  };
  return {
    tabs: [tab("files", "Files"), tab("other", "Other")],
    activeTabId: "files", activeWindowId: "window-1", templates: [],
    windows: [{ id: "window-1", name: "Workspace", defaultCwd: "/repo", layout, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]
  };
}

function tab(id: string, title: string): WorkspaceTab {
  return {
    id, pluginId: id, title, cwd: "/repo", status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
}

function plugin(id: string, panelKind: PluginDescriptor["panelKind"]): PluginDescriptor {
  return { id, panelKind, acronym: id, displayName: id, description: id, creatable: false, requiresDirectory: false, actions: [], configFields: [] };
}

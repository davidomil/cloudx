// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileSearchResult, GitDiffSummary, GitRepositoryState, PluginDescriptor, TabLayoutState, WorkspaceStateResponse, WorkspaceTab } from "@cloudx/shared";

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
  vi.useRealTimers();
});

describe("retained Files tab listings", () => {
  it.each(["success", "failure"])("ignores an initial directory %s superseded by reselection", async (outcome) => {
    const initial = deferredResponse();
    server.nextDirectoryResponse = initial.response;
    await renderApp();
    await selectTab("Other");
    await selectTab("Files");
    expect(server.directoryRequests).toEqual(["", ""]);
    expect(container.querySelector(".file-list")?.textContent).toContain("src");

    await act(async () => initial.resolve(outcome === "success"
      ? jsonResponse({ result: { path: "", entries: [{ name: "obsolete.txt", type: "file" }] } })
      : jsonResponse({ message: "Obsolete directory failure" }, 500)));
    expect(container.querySelector(".file-list")?.textContent).toContain("src");
    expect(container.textContent).not.toContain("obsolete.txt");
    expect(container.querySelector(".file-browser-panel .inline-error")).toBeNull();
  });

  it("invalidates a refresh as soon as navigation starts", async () => {
    await renderApp();
    await selectTab("Other");
    const refresh = deferredResponse();
    server.nextDirectoryResponse = refresh.response;
    await selectTab("Files");
    const navigation = deferredResponse();
    server.nextDirectoryResponse = navigation.response;
    await clickButton(".file-list-entry", "src");
    await act(async () => refresh.resolve(jsonResponse({ message: "Obsolete refresh failure" }, 500)));
    expect(container.querySelector(".file-browser-panel .inline-error")).toBeNull();
    await act(async () => navigation.resolve(jsonResponse({ result: { path: "src", entries: server.directories.src } })));
    expect(container.querySelector(".file-list")?.textContent).toContain("notes.txt");
  });

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

describe("retained Files tab Git state", () => {
  beforeEach(() => { server.showGitDiff = true; });

  it.each(["success", "metadata failure", "diff failure"])("preserves an open diff during a reselection refresh with %s", async (outcome) => {
    server.diffSummary.files = [{ path: "src/notes.txt", status: "modified", statusCode: "M" }];
    await renderApp();
    await clickButton(".file-list-entry", "src");
    await clickButton(".file-list-entry", "notes.txt");
    const preview = container.querySelector(".git-diff-preview");
    expect(preview?.textContent).toContain("Retained diff preview");
    await selectTab("Other");
    if (outcome === "metadata failure") server.nextGitResponse = Promise.resolve(jsonResponse({ message: "Git unavailable" }, 500));
    if (outcome === "diff failure") server.nextDiffResponse = Promise.resolve(jsonResponse({ message: "Git unavailable" }, 500));
    server.diffSummary.files.push({ path: "src/new.txt", status: "added", statusCode: "A" });
    await selectTab("Files");
    expect(container.querySelector(".git-diff-preview")).toBe(preview);
    expect(preview?.textContent).toContain("Retained diff preview");
    expect(container.querySelector(".git-diff-files")?.textContent).toContain("src/notes.txt");
    if (outcome === "success") {
      expect(container.querySelector(".git-diff-files")?.textContent).toContain("src/new.txt");
    } else {
      expect(container.querySelector(".file-browser-panel .inline-error")?.textContent).toBe("Git unavailable");
    }
    expect(container.querySelector<HTMLButtonElement>('[title="Refresh Git state"]')?.disabled).toBe(false);
  });

  it("refreshes branch and changes with polling disabled while retaining preview, comparison and transfers", async () => {
    await renderApp();
    await clickButton(".file-list-entry", "src");
    await clickButton(".file-list-entry", "notes.txt");
    const preview = container.querySelector('[aria-label="src/notes.txt preview"]');
    await clickButton("button", "Select files or folders to download", "aria-label");
    const selection = container.querySelector<HTMLInputElement>('[aria-label="Select notes.txt for download"]')!;
    await act(async () => selection.click());
    const download = deferredResponse();
    server.downloadResponse = download.response;
    await clickButton("button", "Download 1 selected entries", "aria-label");
    await selectTab("Other");
    server.gitState.currentBranch = "feature";
    server.gitState.defaultCompareRef = "release";
    server.gitState.compareRefs.push("release");
    server.diffSummary.files = [{ path: "src/changed.txt", status: "modified", statusCode: "M" }];
    await selectTab("Files");

    expect(server.gitRequests).toBe(2);
    expect(server.diffRequests).toEqual(["main", "main"]);
    expect(container.querySelector(".git-bar-summary")?.textContent).toContain("feature");
    expect(container.querySelector(".file-list")?.textContent).toContain("changed.txt");
    expect(container.querySelector('[aria-label="src/notes.txt preview"]')).toBe(preview);
    expect(selection.checked).toBe(true);
    expect(selection.disabled).toBe(true);
    await selectTab("Other");
    await act(async () => download.resolve(jsonResponse({ message: "Download unavailable" }, 500)));
    await selectTab("Files");
    expect(container.querySelector(".file-browser-panel .inline-error")?.textContent).toBe("Download unavailable");
    expect(server.downloadRequests).toBe(1);
    expect(container.querySelector<HTMLButtonElement>('[title="Refresh Git state"]')?.disabled).toBe(false);
  });

  it.each([
    ["metadata", "success"], ["metadata", "failure"],
    ["diff", "success"], ["diff", "failure"]
  ] as const)("ignores superseded Git %s %s and releases busy controls", async (stage, outcome) => {
    const initial = deferredResponse();
    if (stage === "metadata") server.nextGitResponse = initial.response;
    else server.nextDiffResponse = initial.response;
    await renderApp();
    await selectTab("Other");
    server.gitState.currentBranch = "feature";
    server.diffSummary.files = [{ path: "current.txt", status: "modified", statusCode: "M" }];
    await selectTab("Files");
    const diffCount = server.diffRequests.length;
    await act(async () => initial.resolve(outcome === "failure"
      ? jsonResponse({ message: "Obsolete Git failure" }, 500)
      : jsonResponse({ result: stage === "metadata"
        ? { ...server.gitState, currentBranch: "obsolete" }
        : { files: [{ path: "obsolete.txt", status: "modified", statusCode: "M" }], truncated: false } })));

    expect(container.querySelector(".git-bar-summary")?.textContent).toContain("feature");
    expect(container.querySelector(".git-diff-files")?.textContent).toContain("current.txt");
    expect(container.textContent).not.toContain("obsolete");
    expect(container.querySelector(".file-browser-panel .inline-error")).toBeNull();
    expect(server.diffRequests).toHaveLength(diffCount);
    expect(container.querySelector<HTMLButtonElement>('[title="Refresh Git state"]')?.disabled).toBe(false);
  });
});

describe("retained Files tab searches", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("keeps download selections when manually submitting the same query", async () => {
    await renderApp();
    await searchFor("notes");
    await clickButton("button", "Select files or folders to download", "aria-label");
    const selection = container.querySelector<HTMLInputElement>('[aria-label="Select src/notes.txt for download"]')!;
    await act(async () => selection.click());
    await submitSearch();
    expect(server.searchRequests).toHaveLength(2);
    expect(container.querySelector('[aria-label="Select src/notes.txt for download"]')).toBe(selection);
    expect(selection.checked).toBe(true);
  });

  it("keeps the current results, preview and selection when a reselection search fails", async () => {
    await renderApp();
    await searchFor("notes");
    await clickButton(".file-list-entry", "src/notes.txt");
    const preview = container.querySelector('[aria-label="src/notes.txt preview"]');
    await clickButton("button", "Select files or folders to download", "aria-label");
    const selection = container.querySelector<HTMLInputElement>('[aria-label="Select src/notes.txt for download"]')!;
    await act(async () => selection.click());
    await selectTab("Other");
    server.nextSearchResponse = Promise.resolve(jsonResponse({ message: "Search unavailable" }, 500));
    await selectTab("Files");
    await advanceSearch();
    expect(container.querySelector(".file-browser-panel .inline-error")?.textContent).toBe("Search unavailable");
    expect(container.querySelector(".file-list")?.textContent).toContain("notes.txt");
    expect(container.querySelector('[aria-label="src/notes.txt preview"]')).toBe(preview);
    expect(selection.checked).toBe(true);
    expect(container.querySelector('.file-search-bar [aria-busy="true"]')).toBeNull();
  });

  it.each([
    ["all", ""], ["filename", "**/*.txt"], ["content", "src/**"]
  ] as const)("refreshes the active %s query and glob '%s' while retaining its preview, selection and download", async (mode, glob) => {
    await renderApp();
    await searchFor("notes", mode, glob);
    await clickButton(".file-list-entry", "src/notes.txt");
    const preview = container.querySelector('[aria-label="src/notes.txt preview"]');
    expect(preview?.textContent).toContain("Opened notes");
    await clickButton("button", "Select files or folders to download", "aria-label");
    const selection = container.querySelector<HTMLInputElement>('[aria-label="Select src/notes.txt for download"]')!;
    await act(async () => selection.click());
    const download = deferredResponse();
    server.downloadResponse = download.response;
    await clickButton("button", "Download 1 selected entries", "aria-label");
    await selectTab("Other");
    server.searchFiles.push("src/new-notes.txt");
    await selectTab("Files");
    await advanceSearch();

    expect(server.searchRequests).toHaveLength(2);
    expect(server.searchRequests[1]).toEqual(server.searchRequests[0]);
    expect(server.searchRequests[1]).toMatchObject({ query: "notes", mode, ...(glob ? { glob } : {}) });
    expect(container.querySelector(".file-list")?.textContent).toContain("new-notes.txt");
    expect(container.querySelector('[aria-label="src/notes.txt preview"]')).toBe(preview);
    expect(selection.checked).toBe(true);
    expect(selection.disabled).toBe(true);
    await selectTab("Other");
    await act(async () => download.resolve(jsonResponse({ message: "Download unavailable" }, 500)));
    await selectTab("Files");
    await advanceSearch();
    expect(container.querySelector(".file-browser-panel .inline-error")?.textContent).toBe("Download unavailable");
    expect(server.downloadRequests).toBe(1);
    await publishWorkspaceUpdate({ type: "automation-runs", runs: [] });
    await advanceSearch();
    expect(server.searchRequests).toHaveLength(3);
  });

  it.each([
    ["automatic", "success"], ["automatic", "failure"],
    ["manual", "success"], ["manual", "failure"]
  ] as const)("ignores an older %s search %s after reselection", async (trigger, outcome) => {
    await renderApp();
    if (trigger === "manual") await searchFor("notes");
    const initial = deferredResponse();
    server.nextSearchResponse = initial.response;
    if (trigger === "automatic") await searchFor("notes");
    else await submitSearch();
    await selectTab("Other");
    server.searchFiles.push("src/new-notes.txt");
    await selectTab("Files");
    await advanceSearch();
    expect(container.querySelector(".file-list")?.textContent).toContain("new-notes.txt");
    const currentListing = container.querySelector(".file-list")?.textContent;
    await act(async () => initial.resolve(outcome === "success"
      ? jsonResponse({ result: searchResult({ query: "notes", mode: "all" }, ["obsolete-notes.txt"]) })
      : jsonResponse({ message: "Obsolete search failure" }, 500)));
    expect(container.querySelector(".file-list")?.textContent).toBe(currentListing);
    expect(container.querySelector(".file-browser-panel .inline-error")).toBeNull();
    expect(container.querySelector('.file-search-bar [aria-busy="true"]')).toBeNull();
  });

  it("invalidates a pending search when the query changes, before the next debounce completes", async () => {
    await renderApp();
    const initial = deferredResponse();
    server.nextSearchResponse = initial.response;
    await searchFor("notes");
    await setSearchQuery("current");
    await act(async () => initial.resolve(jsonResponse({ message: "Obsolete search failure" }, 500)));
    expect(container.querySelector(".file-browser-panel .inline-error")).toBeNull();
    server.searchFiles = ["current.txt"];
    await advanceSearch();
    expect(container.querySelector(".file-list")?.textContent).toContain("current.txt");
  });

  it("cancels the hidden tab's debounce and does not repeat a manual search", async () => {
    await renderApp();
    await clickButton("button", "Show search bar", "aria-label");
    await setSearchQuery("notes");
    await selectTab("Other");
    await advanceSearch();
    expect(server.searchRequests).toHaveLength(0);
    await selectTab("Files");
    await submitSearch();
    await advanceSearch();
    expect(server.searchRequests).toHaveLength(1);
    expect(container.querySelector(".file-list")?.textContent).toContain("notes.txt");
  });
});

async function setSearchQuery(query: string) {
  const input = container.querySelector<HTMLInputElement>('.file-search-bar input[aria-label="Search files"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function searchFor(query: string, mode: FileSearchResult["mode"] = "all", glob = "") {
  await clickButton("button", "Show search bar", "aria-label");
  await setSearchQuery(query);
  await clickButton(".file-search-mode button", { all: "All", filename: "Names", content: "Contents" }[mode]);
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search glob"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, glob);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await advanceSearch();
}

async function advanceSearch() {
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
}

async function submitSearch() {
  await act(async () => container.querySelector('.file-search-bar')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

async function renderApp() {
  await act(async () => root.render(createElement(App)));
}

async function selectTab(title: string) {
  await clickButton(".tab-activation", title);
}

async function clickButton(selector: string, text: string, attribute?: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>(selector)).find((candidate) =>
    (attribute ? candidate.getAttribute(attribute) : selector === ".file-list-entry" ? candidate.querySelector("span")?.textContent : candidate.textContent) === text
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
  showGitDiff = false;
  gitRequests = 0;
  nextGitResponse?: Promise<Response>;
  nextDiffResponse?: Promise<Response>;
  diffRequests: Array<string | undefined> = [];
  gitState: GitRepositoryState = {
    isRepository: true, cwd: "/repo", rootPath: "/repo", folderEmpty: false, currentBranch: "main",
    defaultCompareRef: "main", compareRefs: ["main"], setup: { canInitialize: false, canClone: false, canSetOrigin: false }
  };
  diffSummary: GitDiffSummary = { files: [], truncated: false };
  searchRequests: Record<string, string>[] = [];
  nextSearchResponse?: Promise<Response>;
  searchFiles = ["src/notes.txt"];
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
      globalFields: [], plugins: [], values: { global: { aiControlEnabled: false }, plugins: { files: { showGitDiff: this.showGitDiff, gitAutoRefresh: false } } }
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
      const request = JSON.parse(init?.body as string) as { action: string; input: Record<string, string> };
      const relativePath = request.input.relativePath!;
      if (request.action === "get_git_state") {
        this.gitRequests += 1;
        const response = this.nextGitResponse;
        this.nextGitResponse = undefined;
        return response ?? jsonResponse({ result: this.gitState });
      }
      if (request.action === "list_git_diff") {
        this.diffRequests.push(request.input.compareRef);
        const response = this.nextDiffResponse;
        this.nextDiffResponse = undefined;
        return response ?? jsonResponse({ result: this.diffSummary });
      }
      if (request.action === "open_git_diff_file") return jsonResponse({ result: {
        path: request.input.path, status: "modified", statusCode: "M", message: "Retained diff preview"
      } });
      if (request.action === "search_files") {
        this.searchRequests.push(request.input);
        const response = this.nextSearchResponse;
        this.nextSearchResponse = undefined;
        return response ?? jsonResponse({ result: searchResult(request.input, this.searchFiles) });
      }
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

function searchResult(input: Record<string, string>, paths: string[]): FileSearchResult {
  return {
    query: input.query!, mode: input.mode as FileSearchResult["mode"], glob: input.glob, relativePath: "",
    files: paths.map((path) => ({ path, type: "filename", matches: [], truncated: false })),
    truncated: false, searchedAt: new Date(0).toISOString()
  };
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

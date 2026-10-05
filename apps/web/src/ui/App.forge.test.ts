// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxConfigResponse, ForgeRepository, PluginDescriptor, WorkspaceCleanupJob, WorkspaceTab } from "@cloudx/shared";
import { App } from "./App.js";

const roots: Root[] = [];
const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "cloudx/first" };
const tab: WorkspaceTab = { id: "forge-tab", pluginId: "forge", title: "Forge", cwd: "/unused", status: "idle", indicator: { color: "green", label: "Ready", updatedAt: "2026-09-08" }, createdAt: "2026-09-08", updatedAt: "2026-09-08" };
const plugin: PluginDescriptor = {
  id: "forge", acronym: "FRG", displayName: "Forge", description: "Forge", panelKind: "placeholder", creatable: false, requiresDirectory: false, actions: [],
  configFields: [
    { key: "provider", label: "Provider", type: "select", defaultValue: "github", options: [{ label: "GitHub", value: "github" }, { label: "GitLab", value: "gitlab" }] },
    { key: "apiUrl", label: "API URL", type: "string", defaultValue: repository.apiUrl },
    { key: "projectPath", label: "Repository path", type: "string", defaultValue: repository.projectPath },
    { key: "workerModel", label: "Worker model", type: "string", defaultValue: "gpt-6" },
  ],
  uiContributions: [{ id: "forge.panel", owner: { kind: "plugin", pluginId: "forge" }, slot: "plugin.panel", renderer: "forge.panel", title: "Forge", targetPluginId: "forge" }],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", class { addEventListener() {} close() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
});
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fixture(updateBlocked = false, splitWindow = false, capacityRecovery = false, cleanupTransport?: (url: string, init?: RequestInit) => Promise<Response>) {
  let current = repository;
  let saving = false;
  let submitted: CloudxConfigResponse["values"] | undefined;
  const save = deferred<Response>();
  const dashboard = deferred<Response>();
  const mutations: Record<string, unknown>[] = [];
  const capacityChecks: unknown[] = [];
  const updateStatus = { available: true, ...(capacityRecovery ? { run: { id: "11111111-1111-4111-8111-111111111111", state: "failed", resumable: true, targetCommit: "b".repeat(40), message: "Capacity shortage", startedAt: "2026-10-05" } } : {}) };
  const config: CloudxConfigResponse = {
    globalFields: [], plugins: [{ pluginId: "forge", displayName: "Forge", fields: plugin.configFields }],
    values: { global: { microphoneEnabled: false, voiceCommandsEnabled: false, aiControlEnabled: false }, plugins: { forge: { ...repository, workerModel: "gpt-6" } } },
  };
  const issue = () => ({ number: 7, title: `Issue in ${current.projectPath}`, body: "Inspect this issue before starting.", state: "open", author: "author", labels: [], comments: [], updatedAt: "2026-09-08", url: "https://example.test/issue/7" });
  const dashboardBody = () => ({ result: { configured: true, repository: current, workers: [] } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (cleanupTransport && url.startsWith("/api/system/workspace-cleanup")) return cleanupTransport(url, init);
    if (url === "/api/windows/window" && init?.method === "PATCH") return reply({ persistence: [{ name: "Workspace layout", state: "available" }] });
    if (url === "/api/tabs/forge-tab/active") return reply({});
    if (updateBlocked && url === "/api/system/update") return reply({ available: true, forgeBlocker: {
      kind: "forge", workerId: "worker-149", issueNumber: 149,
      message: "Forge has an uncertain merge.", recoveryAction: "Recover the worker through Forge.",
    } });
    if (url === "/api/system/update/capacity") { capacityChecks.push(JSON.parse(String(init?.body))); return reply(updateStatus); }
    if (url === "/api/config" && init?.method === "PATCH") { saving = true; submitted = JSON.parse(String(init.body)); return save.promise; }
    if (url === "/api/hooks/forge.dashboard") return saving ? dashboard.promise : reply(dashboardBody());
    if (url === "/api/hooks/forge.issues.list") return reply({ result: { items: [issue()] } });
    if (url === "/api/hooks/forge.issue.get") return reply({ result: { issue: issue() } });
    if (url === "/api/hooks/forge.issue.start") { mutations.push(JSON.parse(String(init?.body)).input); return reply({ result: {} }); }
    const responses: Record<string, unknown> = {
      "/api/plugins": { plugins: [plugin] },
      "/api/workspace": { tabs: [tab], activeTabId: tab.id, activeWindowId: "window", templates: [], windows: [{ id: "window", name: "Test", defaultCwd: "/unused", createdAt: "2026-09-08", updatedAt: "2026-09-08", layout: { root: splitWindow ? { type: "split", id: "split", direction: "horizontal", sizes: [50, 50], children: [{ type: "pane", pane: { id: "pane-1", tabIds: [tab.id], activeTabId: tab.id } }, { type: "pane", pane: { id: "pane-2", tabIds: [] } }] } : { type: "pane", pane: { id: "pane-1", tabIds: [tab.id], activeTabId: tab.id } }, activePaneId: "pane-1" } }] },
      "/api/config": config,
      "/api/system/workspace-cleanup": null,
      "/api/forge/resources": { resources: [] },
      "/api/forge/checkout-evidence": { archives: [] },
      "/api/system/update": updateStatus,
      "/api/system/update/backups": { backups: [] },
      "/api/system/update/backups/cleanup": null,
      "/api/system/update/preview": {
        runtime: { verification: "verified", commit: "a".repeat(40), builtAt: "2026-10-05", sourceDirty: false },
        channel: "main", currentCommit: "a".repeat(40), checkedAt: "2026-10-05", state: "available", changelog: [], changelogComplete: true,
        target: { commit: "b".repeat(40), name: "main", url: "https://github.com/davidomil/cloudx/tree/main" },
      },
      "/api/hooks/rules-skills.catalog.list": { result: {} },
      "/api/automation/catalog": { nodes: [] },
      "/api/automation/groups": { groups: [] },
      "/api/notifications": { notifications: [] },
      "/api/health": { ok: true },
      "/api/forge/connections": { repository: current, roles: [{ role: "worker", state: "connected" }, { role: "reviewer", state: "connected" }] },
    };
    if (!(url in responses)) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    return reply(responses[url]);
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(createElement(App)); await import("./ForgePanel.js"); });
  await vi.waitFor(() => expect(container.querySelector(".forge-items"), container.textContent ?? "").not.toBeNull());
  return {
    container, mutations, capacityChecks,
    async completeSave(success: boolean) {
      if (success) current = { provider: submitted!.plugins.forge.provider, apiUrl: submitted!.plugins.forge.apiUrl, projectPath: submitted!.plugins.forge.projectPath } as ForgeRepository;
      await act(async () => { save.resolve(success ? reply({ ...config, values: submitted }) : reply({ message: "Settings could not be saved." }, 500)); });
    },
    async completeDashboard() { await act(async () => { dashboard.resolve(reply(dashboardBody())); }); },
    current: () => current,
  };
}

function button(container: Element, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(container: Element, label: string) { await act(async () => { button(container, label).click(); }); }
async function changeSetting(container: Element, label: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

describe("Forge repository settings in App", () => {
  it("keeps cleanup and update capacity blocked across navigation after a failed poll until explicit reconnect reports completion", async () => {
    let job: WorkspaceCleanupJob | null = null;
    let statusFailure = false;
    let statusRequests = 0;
    let reconnect: ReturnType<typeof deferred<Response>> | undefined;
    const candidateId = "22222222-2222-4222-8222-222222222222";
    const f = await fixture(false, false, true, async (url, init) => {
      if (url.endsWith("/preview")) return reply({ id: "33333333-3333-4333-8333-333333333333", createdAt: "2026-10-05", availableBytes: 8192, warnings: [], reclaimableBytes: 4096, reclaimGroups: [{ bytes: 4096, candidateIds: [candidateId] }],
        candidates: [{ id: candidateId, path: "/work/completed-forge", repository: "team/project", kind: "forge", state: "completed", allocatedBytes: 4096, eligible: true, reason: "Completed and inactive", sourceChanges: [], unpublishedCommits: 0, requiresDiscard: false }] });
      if (init?.method === "POST") {
        job = { id: "44444444-4444-4444-8444-444444444444", state: "running", startedAt: "2026-10-05", availableBytesBefore: 8192,
          results: [{ id: candidateId, path: "/work/completed-forge", status: "deleting", reason: "Revalidating activity" }] };
        return reply(job);
      }
      statusRequests++;
      if (statusFailure) throw new Error("Cleanup status connection lost.");
      if (reconnect) return reconnect.promise;
      return reply(job);
    });
    const forge = () => f.container.querySelector(".forge-panel")!;
    async function updates() {
      await click(forge(), "Settings");
      await act(async () => f.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Updates"]')!.click());
    }
    await updates(); await click(f.container, "Manage Forge environments");
    await vi.waitFor(() => expect(f.container.querySelector('[aria-label="Workspace cleanup"]')).not.toBeNull());
    await click(f.container, "Scan workspaces and environments");
    await click(f.container, "Review deletion of 1 workspace"); await click(f.container, "Delete permanently");
    statusFailure = true;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect(f.container.textContent).toContain("Cleanup status unavailable: Cleanup status connection lost.");
    const disconnectedRequests = statusRequests;
    job = { ...job!, state: "completed", availableBytesAfter: 16384, results: job!.results.map(item => ({ ...item, status: "deleted", reason: "Deleted" })) };
    statusFailure = false;
    await click(forge(), "Issues"); await click(forge(), "Environments"); await click(f.container, "Refresh environments");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect(statusRequests).toBe(disconnectedRequests);
    expect(button(f.container, "Scan workspaces and environments").disabled).toBe(true);
    expect(button(f.container, "Reconnect cleanup status").disabled).toBe(false);
    await updates();
    expect(button(f.container, "Resume update").disabled).toBe(true);
    expect(f.capacityChecks).toEqual([]);
    await click(f.container, "Manage Forge environments");
    reconnect = deferred<Response>();
    await click(f.container, "Reconnect cleanup status");
    expect(button(f.container, "Checking cleanup status…").disabled).toBe(true);
    expect(button(f.container, "Scan workspaces and environments").disabled).toBe(true);
    await updates();
    expect(button(f.container, "Resume update").disabled).toBe(true);
    expect(f.capacityChecks).toEqual([]);
    await act(async () => reconnect!.resolve(reply(job)));
    await vi.waitFor(() => expect(f.capacityChecks.length).toBeGreaterThan(0));
    expect(button(f.container, "Resume update").disabled).toBe(false);
    expect(f.capacityChecks.every(request => JSON.stringify(request) === JSON.stringify({ channel: "main", targetCommit: "b".repeat(40), resumeRunId: "11111111-1111-4111-8111-111111111111" }))).toBe(true);
    await click(f.container, "Manage Forge environments");
    expect(f.container.textContent).toContain("16.00 KiB available after cleanup");
    expect(f.container.textContent).not.toContain("Cleanup status unavailable");
    expect(button(f.container, "Scan workspaces and environments").disabled).toBe(false);
    expect(statusRequests).toBe(disconnectedRequests + 1);
  });

  it("opens canonical cleanup with Settings filters and refreshes update capacity on returning", async () => {
    const f = await fixture(false, false, true);
    await click(f.container.querySelector(".forge-panel")!, "Settings");
    await act(async () => f.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Workspaces"]')!.click());
    expect(f.container.querySelector('.settings-dialog [aria-label="Workspace cleanup"]')).toBeNull();
    await click(f.container, "Open workspace management");
    await vi.waitFor(() => expect(f.container.querySelector('[aria-label="Workspace cleanup"]')).not.toBeNull());
    expect(f.container.querySelector<HTMLSelectElement>('[aria-label="Workspace filter"]')!.value).toBe("all");
    expect(f.container.querySelectorAll(".forge-panel")).toHaveLength(1);
    await click(f.container.querySelector(".forge-panel")!, "Issues");
    await click(f.container.querySelector(".forge-panel")!, "Settings");
    await act(async () => f.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Updates"]')!.click());
    await click(f.container, "Manage Forge environments");
    await vi.waitFor(() => expect(f.container.querySelector('[aria-label="Workspace cleanup"]')).not.toBeNull());
    expect(f.container.querySelector<HTMLSelectElement>('[aria-label="Workspace filter"]')!.value).toBe("forge");
    expect(f.capacityChecks).toHaveLength(0);
    await click(f.container.querySelector(".forge-panel")!, "Settings");
    await act(async () => f.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Updates"]')!.click());
    await vi.waitFor(() => expect(f.capacityChecks).toEqual([{ channel: "main", targetCommit: "b".repeat(40), resumeRunId: "11111111-1111-4111-8111-111111111111" }]));
    expect(f.container.querySelector('.settings-dialog [aria-label="Workspace cleanup"]')).toBeNull();
    expect(f.container.querySelectorAll(".forge-panel")).toHaveLength(1);
  });

  it("opens the existing Forge tab from an update blocker without creating another tab", async () => {
    const f = await fixture(true);
    await click(f.container.querySelector(".forge-panel")!, "Settings");
    await act(async () => f.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="General"]')!.click());
    await vi.waitFor(() => expect(f.container.textContent).toContain("Open Forge recovery"));
    await click(f.container, "Open Forge recovery");
    expect(f.container.querySelector(".settings-dialog")).toBeNull();
    expect(f.container.querySelector(".forge-panel")).not.toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/tabs" && init?.method === "POST")).toBe(false);
  });

  it("reveals an existing Forge pane hidden by another maximized pane", async () => {
    const f = await fixture(true, true);
    await act(async () => f.container.querySelector<HTMLButtonElement>('[data-pane-id="pane-2"] [aria-label="Maximize pane"]')!.click());
    const forgePane = f.container.querySelector('[data-pane-id="pane-1"]')!;
    expect(forgePane.closest(".maximized-hidden-branch")).not.toBeNull();
    await click(f.container.querySelector(".forge-panel")!, "Settings");
    await act(async () => f.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="General"]')!.click());
    await vi.waitFor(() => expect(f.container.textContent).toContain("Open Forge recovery"));
    await click(f.container, "Open Forge recovery");
    expect(f.container.querySelector(".settings-dialog")).toBeNull();
    expect(forgePane.closest(".maximized-hidden-branch")).toBeNull();
    expect(forgePane.classList.contains("active")).toBe(true);
    expect(f.container.querySelectorAll(".forge-panel")).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/tabs" && init?.method === "POST")).toBe(false);
  });

  it.each([
    { label: "Repository path", value: "cloudx/second", success: true },
    { label: "API URL", value: "https://github.enterprise.test/api/v3", success: true },
    { label: "Provider", value: "gitlab", success: true },
    { label: "Repository path", value: "cloudx/second", success: false },
  ])("invalidates item actions before saving $label and waits for fresh context when success=$success", async ({ label, value, success }) => {
    const f = await fixture();
    await click(f.container.querySelector(".forge-panel")!, "Settings");
    await act(async () => f.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Forge"]')!.click());
    await changeSetting(f.container, label, value);
    await click(f.container.querySelector(".settings-dialog")!, "Save");
    expect(f.container.querySelector(".forge-items")).toBeNull();
    await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(f.container.querySelector(".settings-dialog")).toBeNull();
    expect(f.container.querySelector(".forge-items")).toBeNull();
    await f.completeSave(success);
    expect(f.container.querySelector(".forge-items")).toBeNull();
    if (!success) expect(f.container.textContent).toContain("Settings could not be saved.");
    await f.completeDashboard();
    expect(f.container.querySelector(".forge-header")?.textContent).toContain(f.current().projectPath);
    expect(f.mutations).toEqual([]);
    await click(f.container, "Start work");
    expect(f.mutations).toEqual([{ repository: f.current(), number: 7, autoReview: false, windowId: "window", paneId: "pane-1" }]);
  });

  it("preserves item state when saving a model setting without changing the repository", async () => {
    const f = await fixture();
    const items = f.container.querySelector(".forge-items");
    await click(f.container.querySelector(".forge-panel")!, "Settings");
    await act(async () => f.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Forge"]')!.click());
    await changeSetting(f.container, "Worker model", "gpt-6-astra");
    await click(f.container.querySelector(".settings-dialog")!, "Save");
    expect(f.container.querySelector(".forge-items")).toBe(items);
    await f.completeSave(true);
    expect(f.container.querySelector(".forge-items")).toBe(items);
    expect(f.mutations).toEqual([]);
  });
});

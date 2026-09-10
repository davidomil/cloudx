// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeDashboard, ForgeIssueDetail, ForgeRepository, ForgeWorker, WorkspaceTab } from "@cloudx/shared";
import { ForgePanel } from "./ForgePanel.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

vi.mock("./TerminalPanel.js", () => ({
  TerminalPanel: ({ tab, active, uiScale }: { tab: WorkspaceTab; active: boolean; uiScale: number }) => createElement("div", { "data-terminal-tab": tab.id, "data-active": String(active), "data-scale": uiScale }, createElement("textarea", { "aria-label": "Terminal input" }))
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const dialogMethods = ["showModal", "close"] as const;
const nativeDialogMethods = dialogMethods.map(method => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method));
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) {
      if (!this.open) return;
      this.open = false;
      queueMicrotask(() => this.dispatchEvent(new Event("close")));
    } }
  });
});
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach((root) => root.unmount()); });
  dialogMethods.forEach((method, index) => {
    const descriptor = nativeDialogMethods[index];
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  });
  vi.useRealTimers();
  document.body.replaceChildren();
});

const repository = { provider: "github" as const, apiUrl: "https://api.github.com", projectPath: "cloudx/example" };
const issue: ForgeIssueDetail = { number: 7, title: "Fix deployment", body: "The deployment fails.", url: "https://github.com/cloudx/example/issues/7", state: "open", author: "ari", labels: ["bug"], updatedAt: "2026-09-07", comments: [{ id: "note-1", author: "nia", body: "Reproduced in staging." }] };
const change: ForgeChangeRequest = { ...issue, number: 12, title: "Repair deployment", url: "https://github.com/cloudx/example/pull/12", draft: false, headSha: "a".repeat(40), headBranch: "fix/deploy", baseBranch: "main", merged: false, mergeable: true, requiresBaseUpdate: false, reviewReady: true, approved: false, unresolvedDiscussions: 1, baseSha: "b".repeat(40), targetHeadSha: "b".repeat(40), linkedIssues: [], comments: [{ id: "note-2", author: "nia", body: "Needs a timeout.", path: "deploy.ts", line: 8, resolved: false }] };
const worker: ForgeWorker = { id: "work-1", kind: "issue", number: 7, title: issue.title, repository, repositoryPath: "/repo", baseBranch: "main", templateId: "worker-template", status: "running", tabId: "codex-worker", autoPost: false, startedAt: "2026-09-07", updatedAt: "2026-09-07" };
const reviewWorker: ForgeWorker = { ...worker, id: "review-1", kind: "review", number: 12, title: change.title, status: "completed", draft: { id: "33333333-3333-4333-8333-333333333333", startedAt: "2026-09-07T00:00:00.000Z", headSha: change.headSha, body: "Add a timeout.", event: "request_changes", comments: [{ path: "deploy.ts", line: 8, side: "RIGHT", body: "This can wait forever." }], status: "draft" } };
const publishingWorker: ForgeWorker = {
  ...worker, status: "awaiting_publication", changeNumber: change.number, headSha: "a".repeat(40),
  pendingPublication: {
    report: { kind: "issue", title: change.title, body: change.body, resolvedDiscussionIds: [], discussionReplies: [] },
    headSha: "b".repeat(40), previousHeadSha: "a".repeat(40), confirmationStartedAt: "2026-09-07T12:00:00.000Z", repliedDiscussionIds: []
  }
};
const conflictedWorker: ForgeWorker = {
  ...worker, status: "awaiting_merge", branch: change.headBranch, worktreePath: "/repo/worker",
  changeNumber: change.number, headSha: change.headSha,
  mergeConflict: { headSha: change.headSha, targetHeadSha: "c".repeat(40) },
};
const rebaseRecovery: NonNullable<ForgeWorker["rebaseRecovery"]> = {
  branch: change.headBranch, baseBranch: "main", expectedHeadSha: change.headSha, originalHeadSha: change.headSha,
  targetHeadSha: "b".repeat(40), phase: "reviewing", headSha: change.headSha,
};
const tab: WorkspaceTab = { id: "forge-tab", pluginId: "forge", title: "Forge", cwd: "/repo", status: "idle", indicator: { color: "green", label: "Ready", updatedAt: "2026-09-07" }, createdAt: "2026-09-07", updatedAt: "2026-09-07" };
const workerTab: WorkspaceTab = { ...tab, id: "codex-worker", pluginId: "codex-terminal", ownerPluginId: "forge", pluginMetadata: { "forge-workers": { workerId: worker.id } } };

type HookHandler = (hook: string, input: Record<string, unknown>) => unknown | Promise<unknown>;
function fixture(overrides: Partial<ForgeDashboard> = {}, handler?: HookHandler) {
  const dashboard: ForgeDashboard = { configured: true, repository, workers: [], ...overrides };
  const calls: Array<{ hook: string; input: Record<string, unknown>; tabId?: string }> = [];
  const callHook: NonNullable<UiContributionRenderContext["callHook"]> = async <T extends Record<string, unknown>>(hook: string, input: Record<string, unknown> = {}, tabId?: string) => {
    calls.push({ hook, input, tabId });
    const handled = await handler?.(hook, input);
    if (handled !== undefined) return handled as T;
    const responses: Record<string, unknown> = {
      "forge.dashboard": dashboard,
      "forge.issues.list": { items: [issue] },
      "forge.changes.list": { items: [change] },
      "forge.issue.get": { issue },
      "forge.change.get": { change },
      "forge.issue.start": { worker },
      "forge.review.start": { worker: reviewWorker },
      "forge.review.save": { worker: reviewWorker },
      "forge.review.submit": { worker: reviewWorker },
      "forge.change.review": { change },
      "forge.worker.pause": { worker: { ...worker, status: "paused" } },
      "forge.worker.stop": { worker: { ...worker, status: "stopped" } },
      "forge.worker.resume": { worker },
      "forge.worker.syncAndReview": { worker },
      "forge.worker.rebaseAndResolve": { worker },
      "forge.worker.autoReview": { worker }
    };
    if (!(hook in responses)) throw new Error(`Unexpected hook: ${hook}`);
    return responses[hook] as T;
  };
  return { dashboard, callHook, calls };
}

async function renderPanel(testFixture: ReturnType<typeof fixture>, extra: Partial<Parameters<typeof ForgePanel>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [], active: true, uiScale: 100, repositorySettingsKey: "repository:0", repositoryChangePending: false, ...extra })); });
  return container;
}

function button(container: Element, text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === text || element.getAttribute("aria-label") === text);
  if (!result) throw new Error(`Button not found: ${text}`);
  return result;
}

async function click(container: Element, text: string) { await act(async () => { button(container, text).click(); }); }
function autoReviewToggle(container: Element) { return container.querySelector<HTMLInputElement>('input[aria-label="Auto review"]')!; }
async function toggleAutoReview(container: Element) { await act(async () => { autoReviewToggle(container).click(); }); }
async function fill(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

describe("ForgePanel", () => {
  it.each(["github", "gitlab"] as const)("pins every %s item read and decision to the displayed repository", async provider => {
    const displayed = { ...repository, provider };
    const testFixture = fixture({ repository: displayed });
    const panel = await renderPanel(testFixture);
    await click(panel, "Start work");
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    await click(panel, "Review");
    await click(panel, "Review and post");
    await click(panel, "Mark as approved");
    await fill(panel.querySelector(".forge-review-decision textarea")!, "Please fix the timeout.");
    await click(panel, "Mark as request changes");

    const itemCalls = testFixture.calls.filter(call => call.hook !== "forge.dashboard");
    expect(new Set(itemCalls.map(call => call.hook))).toEqual(new Set([
      "forge.issues.list", "forge.issue.get", "forge.issue.start", "forge.changes.list", "forge.change.get", "forge.review.start", "forge.change.review",
    ]));
    expect(itemCalls.every(call => JSON.stringify(call.input.repository) === JSON.stringify(displayed))).toBe(true);
  });

  it.each(["github", "gitlab"] as const)("keeps stale %s item actions bound to the displayed repository until an explicit fresh decision", async provider => {
    const displayed = { ...repository, provider };
    let current: ForgeRepository = displayed;
    const published: Record<string, unknown>[] = [];
    const testFixture = fixture({ repository: displayed }, (hook, input) => {
      if (hook === "forge.dashboard") return { configured: true, repository: current, workers: [] };
      if (hook === "forge.issue.start" || hook === "forge.change.review") {
        if (JSON.stringify(input.repository) !== JSON.stringify(current)) throw new Error("The Forge repository changed. Refresh before continuing.");
        published.push(input);
        return {};
      }
    });
    const panel = await renderPanel(testFixture);
    current = { ...displayed, projectPath: "another/repository" };
    expect(panel.textContent).toContain(displayed.projectPath);
    await click(panel, "Start work");
    expect(published).toEqual([]);
    expect(testFixture.calls.find(call => call.hook === "forge.issue.start")?.input.repository).toEqual(displayed);
    expect(panel.textContent).toContain(current.projectPath);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const displayedReview = current;
    current = { ...current, projectPath: "third/repository" };
    await click(panel, "Mark as approved");
    expect(published).toEqual([]);
    expect(testFixture.calls.find(call => call.hook === "forge.change.review")?.input.repository).toEqual(displayedReview);
    await click(panel, "Mark as approved");
    expect(published).toEqual([{ repository: current, number: change.number, headSha: change.headSha, event: "approve", body: "" }]);
  });

  it.each(["saved", "failed"] as const)("invalidates items from save start until a fresh dashboard after a %s repository change", async outcome => {
    const fresh = deferred<ForgeDashboard>();
    let refreshing = false;
    const testFixture = fixture({ workers: [worker] }, hook => hook === "forge.dashboard" && refreshing ? fresh.promise : undefined);
    const extra = { repositorySettingsKey: "repository-a:0", repositoryChangePending: false, workerTabs: [workerTab] };
    const panel = await renderPanel(testFixture, extra);
    const root = roots.at(-1)!;
    const render = async () => { await act(async () => { root.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", active: true, uiScale: 100, ...extra })); }); };
    await click(panel, "View worker");
    const overlay = panel.querySelector("dialog");
    extra.repositorySettingsKey = "repository-a:1";
    extra.repositoryChangePending = true;
    await render();
    expect(panel.querySelector(".forge-items")).toBeNull();
    expect(panel.querySelector("dialog")).toBe(overlay);
    refreshing = true;
    extra.repositoryChangePending = false;
    extra.repositorySettingsKey = outcome === "saved" ? "repository-b:1" : "repository-a:1";
    await render();
    expect(panel.querySelector(".forge-items")).toBeNull();
    expect(panel.querySelector("dialog")).toBe(overlay);
    const nextRepository = outcome === "saved" ? { ...repository, projectPath: "another/repository" } : repository;
    await act(async () => { fresh.resolve({ configured: true, repository: nextRepository, workers: [worker] }); });
    expect(panel.querySelector(".forge-items")).not.toBeNull();
    expect(panel.textContent).toContain(nextRepository.projectPath);
    expect(panel.querySelector("dialog")).toBe(overlay);
    expect(testFixture.calls.every(call => call.hook === "forge.dashboard" || call.hook.endsWith(".list") || call.hook.endsWith(".get"))).toBe(true);
  });

  it("ignores a dashboard response from before a repository settings change", async () => {
    vi.useFakeTimers();
    const stale = deferred<ForgeDashboard>();
    const fresh = deferred<ForgeDashboard>();
    let reads = 0;
    const testFixture = fixture({}, hook => hook === "forge.dashboard" && ++reads > 1 ? reads === 2 ? stale.promise : fresh.promise : undefined);
    const extra = { repositorySettingsKey: "repository-a:0", repositoryChangePending: false };
    const panel = await renderPanel(testFixture, extra);
    const root = roots.at(-1)!;
    const render = async () => { await act(async () => { root.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [], active: true, uiScale: 100, ...extra })); }); };
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    extra.repositorySettingsKey = "repository-b:1";
    await render();
    expect(panel.querySelector(".forge-items")).toBeNull();
    await act(async () => { stale.resolve(testFixture.dashboard); });
    expect(panel.querySelector(".forge-items")).toBeNull();
    await act(async () => { fresh.resolve({ configured: true, repository: { ...repository, projectPath: "another/repository" }, workers: [] }); });
    expect(panel.querySelector(".forge-header")?.textContent).toContain("another/repository");
  });

  it.each([
    { ...repository, projectPath: "another/repository" },
    { ...repository, apiUrl: "https://github.enterprise.test/api/v3" },
    { ...repository, provider: "gitlab" as const, apiUrl: "https://gitlab.com/api/v4" },
  ])("discards previous items and decision drafts when polling observes repository $provider $apiUrl $projectPath", async nextRepository => {
    vi.useFakeTimers();
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({}, hook => hook === "forge.dashboard" ? structuredClone(testFixture.dashboard) : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    const previousItems = panel.querySelector(".forge-items");
    await fill(panel.querySelector(".forge-review-decision textarea")!, "Decision for the previous repository.");
    testFixture.dashboard.repository = nextRepository;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(panel.querySelector(".forge-items")).not.toBe(previousItems);
    expect(panel.querySelector<HTMLTextAreaElement>(".forge-review-decision textarea")?.value).toBe("");
    expect(testFixture.calls.filter(call => call.hook === "forge.changes.list").at(-1)?.input.repository).toEqual(nextRepository);
    expect(testFixture.calls.filter(call => call.hook === "forge.change.get").at(-1)?.input.repository).toEqual(nextRepository);
    expect(testFixture.calls.every(call => call.hook === "forge.dashboard" || call.hook.endsWith(".list") || call.hook.endsWith(".get"))).toBe(true);
  });

  it("keeps a pending item action on its original repository and requires a fresh action after settings change", async () => {
    const pending = deferred<unknown>();
    let starts = 0;
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({}, hook => hook === "forge.dashboard" ? structuredClone(testFixture.dashboard) : hook === "forge.issue.start" ? ++starts === 1 ? pending.promise : {} : undefined);
    const extra = { repositorySettingsKey: "repository-a:0", repositoryChangePending: false };
    const panel = await renderPanel(testFixture, extra);
    const root = roots.at(-1)!;
    const render = async () => { await act(async () => { root.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [], active: true, uiScale: 100, ...extra })); }); };
    await click(panel, "Start work");
    const nextRepository = { ...repository, projectPath: "another/repository" };
    testFixture.dashboard.repository = nextRepository;
    extra.repositorySettingsKey = "repository-b:1";
    extra.repositoryChangePending = true;
    await render();
    extra.repositoryChangePending = false;
    await render();
    expect(button(panel, "Start work").disabled).toBe(true);
    await act(async () => { pending.resolve({}); });
    expect(testFixture.calls.filter(call => call.hook === "forge.issue.start").map(call => call.input.repository)).toEqual([repository]);
    expect(button(panel, "Start work").disabled).toBe(false);
    await click(panel, "Start work");
    expect(testFixture.calls.filter(call => call.hook === "forge.issue.start").map(call => call.input.repository)).toEqual([repository, nextRepository]);
  });

  it("requests configuration before loading a repository and opens settings", async () => {
    const testFixture = fixture({ configured: false, repository: undefined, configurationError: "Worker credentials are required." });
    const openSettings = vi.fn();
    const panel = await renderPanel(testFixture, { onOpenSettings: openSettings });
    expect(panel.textContent).toContain("Worker credentials are required.");
    expect(testFixture.calls.map((call) => call.hook)).toEqual(["forge.dashboard"]);
    await click(panel, "Configure Forge");
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("loads issue context and starts work in the panel's window and pane", async () => {
    const testFixture = fixture();
    const panel = await renderPanel(testFixture);
    expect(panel.textContent).toContain("The deployment fails.");
    expect(panel.textContent).toContain("Reproduced in staging.");
    expect(panel.querySelector('[aria-label="Open issue #7"]')?.getAttribute("href")).toBe(issue.url);
    await click(panel, "Start work");
    expect(autoReviewToggle(panel).checked).toBe(false);
    expect(testFixture.calls).toContainEqual({ hook: "forge.issue.start", input: { repository, number: 7, autoReview: false, windowId: "window-1", paneId: "pane-2" }, tabId: "forge-tab" });
  });

  it.each(["github", "gitlab"] as const)("keeps a fresh %s issue's auto review choice beside Start work and isolated from other issues", async provider => {
    const another = { ...issue, number: 8, title: "Fix uploads" };
    const testFixture = fixture({ repository: { ...repository, provider } }, (hook, input) => {
      if (hook === "forge.issues.list") return { items: [issue, another] };
      if (hook === "forge.issue.get") return { issue: input.number === issue.number ? issue : another };
    });
    const panel = await renderPanel(testFixture);
    const actions = button(panel, "Start work").parentElement!;
    expect(autoReviewToggle(actions).checked).toBe(false);
    await toggleAutoReview(actions);
    expect(autoReviewToggle(actions).checked).toBe(true);
    expect(panel.textContent).toContain("Automatically review changes, address feedback, and merge after approval.");
    await act(async () => { panel.querySelectorAll<HTMLButtonElement>(".forge-item")[1].click(); });
    expect(autoReviewToggle(panel).checked).toBe(false);
    await act(async () => { panel.querySelectorAll<HTMLButtonElement>(".forge-item")[0].click(); });
    expect(autoReviewToggle(panel).checked).toBe(true);
    await click(panel, "Start work");
    expect(testFixture.calls.filter(call => call.hook === "forge.issue.start")).toEqual([
      { hook: "forge.issue.start", input: { repository: testFixture.dashboard.repository, number: issue.number, autoReview: true, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id }
    ]);
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it.each(["github", "gitlab"] as const)("keeps a saved %s auto review setting controllable from its issue, request toolbar, and worker tab", async provider => {
    const currentRepository = { ...repository, provider };
    const coding: ForgeWorker = { ...worker, repository: currentRepository, changeNumber: change.number, status: "awaiting_review", autoReview: { enabled: true, phase: "reviewing", placement: { windowId: "original-window", paneId: "original-pane" } } };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ repository: currentRepository, workers: [coding] }, (hook, input) => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === "forge.worker.autoReview") {
        testFixture.dashboard.workers = [{ ...coding, autoReview: { ...coding.autoReview!, enabled: input.enabled as boolean } }];
        return { worker: testFixture.dashboard.workers[0] };
      }
    });
    const panel = await renderPanel(testFixture);
    expect(panel.querySelectorAll('input[aria-label="Auto review"]')).toHaveLength(1);
    expect(autoReviewToggle(button(panel, "Start work").parentElement!).checked).toBe(true);
    await toggleAutoReview(panel);
    expect(autoReviewToggle(panel).checked).toBe(false);
    expect(button(panel.querySelector(".forge-worker")!, "Resume").disabled).toBe(false);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const toolbar = panel.querySelector(".forge-change-toolbar")!;
    expect(autoReviewToggle(toolbar).checked).toBe(false);
    await toggleAutoReview(toolbar);
    expect(autoReviewToggle(toolbar).checked).toBe(true);
    await click(panel, "Workers (1)");
    expect(autoReviewToggle(panel.querySelector('[role="tabpanel"]')!).checked).toBe(true);
    expect(testFixture.calls.filter(call => call.hook === "forge.worker.autoReview")).toEqual([
      { hook: "forge.worker.autoReview", input: { id: coding.id, enabled: false, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id },
      { hook: "forge.worker.autoReview", input: { id: coding.id, enabled: true, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id }
    ]);
    expect(testFixture.calls.some(call => call.hook === "forge.worker.resume" || call.hook === "forge.review.start")).toBe(false);
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it.each(["paused", "stopped", "failed", "cleanup_failed"] as const)("opts a %s issue worker into auto review without resuming it", async status => {
    const coding: ForgeWorker = { ...worker, status };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [coding] }, (hook, input) => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === "forge.worker.autoReview") {
        testFixture.dashboard.workers = [{ ...coding, autoReview: { enabled: input.enabled as boolean, phase: "implementing", placement: { windowId: "window-1", paneId: "pane-2" } } }];
        return { worker: testFixture.dashboard.workers[0] };
      }
    });
    const panel = await renderPanel(testFixture);
    await toggleAutoReview(panel);
    expect(autoReviewToggle(panel).checked).toBe(true);
    expect(button(panel, "Resume").disabled).toBe(false);
    expect(panel.querySelector(".forge-auto-review-status")?.textContent).toContain("Resume");
    expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker.")).map(call => call.hook)).toEqual(["forge.worker.autoReview"]);
  });

  it("keeps an in-flight auto review setting targeted to its original worker and prevents duplicate saves", async () => {
    const saved = deferred<unknown>();
    const another = { ...issue, number: 8, title: "Fix uploads" };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [worker] }, (hook, input) => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === "forge.issues.list") return { items: [issue, another] };
      if (hook === "forge.issue.get") return { issue: input.number === issue.number ? issue : another };
      if (hook === "forge.worker.autoReview") return saved.promise;
    });
    const panel = await renderPanel(testFixture);
    await act(async () => { autoReviewToggle(panel).click(); autoReviewToggle(panel).click(); });
    expect(autoReviewToggle(panel).disabled).toBe(true);
    await act(async () => { panel.querySelectorAll<HTMLButtonElement>(".forge-item")[1].click(); });
    expect(autoReviewToggle(panel).checked).toBe(false);
    testFixture.dashboard.workers = [{ ...worker, autoReview: { enabled: true, phase: "implementing", placement: { windowId: "window-1", paneId: "pane-2" } } }];
    await act(async () => { saved.resolve({ worker: testFixture.dashboard.workers[0] }); });
    expect(autoReviewToggle(panel).checked).toBe(false);
    await act(async () => { panel.querySelectorAll<HTMLButtonElement>(".forge-item")[0].click(); });
    expect(autoReviewToggle(panel).checked).toBe(true);
    expect(testFixture.calls.filter(call => call.hook === "forge.worker.autoReview")).toEqual([
      { hook: "forge.worker.autoReview", input: { id: worker.id, enabled: true, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id }
    ]);
  });

  it("retains the saved auto review setting when changing it fails", async () => {
    const panel = await renderPanel(fixture({ workers: [worker] }, hook => {
      if (hook === "forge.worker.autoReview") throw new Error("Reviewer credentials are required.");
    }));
    await toggleAutoReview(panel);
    expect(autoReviewToggle(panel).checked).toBe(false);
    expect(autoReviewToggle(panel).disabled).toBe(false);
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Reviewer credentials are required.");
  });

  it("requires an open issue for a fresh loop while letting an existing loop be turned off", async () => {
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({}, hook => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === "forge.issues.list") return { items: [{ ...issue, state: "closed" }] };
      if (hook === "forge.issue.get") return { issue: { ...issue, state: "closed" } };
    });
    const panel = await renderPanel(testFixture);
    expect(button(panel, "Start work").disabled).toBe(true);
    expect(autoReviewToggle(panel).disabled).toBe(true);
    testFixture.dashboard.workers = [{ ...worker, autoReview: { enabled: true, phase: "implementing", placement: { windowId: "window-1", paneId: "pane-2" } } }];
    await click(panel, "Refresh Forge");
    expect(button(panel, "Start work").disabled).toBe(true);
    expect(autoReviewToggle(panel).disabled).toBe(false);
    await toggleAutoReview(panel);
    expect(testFixture.calls.find(call => call.hook === "forge.worker.autoReview")?.input).toEqual({ id: worker.id, enabled: false, windowId: "window-1", paneId: "pane-2" });
  });

  it.each(["failed", "cleanup_failed", "completed"] as const)("keeps a linked %s review's failure visible under its issue", async status => {
    const child: ForgeWorker = { ...reviewWorker, issueWorkerId: worker.id, status, error: "Review publication needs attention.", draft: { ...reviewWorker.draft!, status: "post_failed" } };
    const foreign = { ...child, id: "foreign-child", repository: { ...repository, projectPath: "another/project" }, error: "Foreign review failure." };
    const panel = await renderPanel(fixture({ workers: [worker, child, foreign] }));
    const row = panel.querySelector(".forge-item")!;
    expect(row.querySelectorAll(".forge-item-worker")).toHaveLength(2);
    expect(row.textContent).toContain(`Review · ${status === "completed" ? "post failed" : status.replaceAll("_", " ")}`);
    expect(row.textContent).toContain("Review publication needs attention.");
    expect(row.textContent).not.toContain("Foreign review failure.");
    expect(panel.querySelector('[aria-label="review worker #12"] [role="alert"]')?.textContent).toBe("Review publication needs attention.");
  });

  it("shows the automatic loop's review worker and phase under its issue without opening a terminal", async () => {
    vi.useFakeTimers();
    const autoReview: NonNullable<ForgeWorker["autoReview"]> = { enabled: true, phase: "implementing", placement: { windowId: "window-1", paneId: "pane-2" } };
    const coding: ForgeWorker = { ...worker, autoReview, changeNumber: change.number };
    const child: ForgeWorker = { ...reviewWorker, issueWorkerId: worker.id, status: "running", draft: undefined };
    const unrelated = { ...child, id: "unrelated-review", issueWorkerId: "another-coder" };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [coding, unrelated] }, hook => hook === "forge.dashboard" ? structuredClone(testFixture.dashboard) : undefined);
    const panel = await renderPanel(testFixture);
    expect(panel.querySelector(".forge-item-workers")?.textContent).toContain("Auto review · implementing");
    expect(panel.querySelector(".forge-auto-review-status")?.textContent).toContain("Implementing changes");
    expect(panel.querySelectorAll(".forge-item-worker")).toHaveLength(1);

    testFixture.dashboard.workers = [{ ...coding, status: "awaiting_review", autoReview: { ...autoReview, phase: "reviewing", reviewWorkerId: child.id } }, child, unrelated];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const card = panel.querySelector('[aria-label="issue worker #7"]')!;
    expect(panel.querySelector(".forge-auto-review-status")?.textContent).toContain("Reviewing changes");
    expect(panel.querySelectorAll(".forge-item-worker")).toHaveLength(2);
    expect(panel.querySelector(".forge-item-workers")?.textContent).toContain("Review · running");
    expect(panel.querySelector('[aria-label="review worker #12"]')).not.toBeNull();
    expect(button(card, "Pause").disabled).toBe(false);
    expect(button(card, "Stop").disabled).toBe(false);
    expect(Array.from(card.querySelectorAll("button")).some(item => item.textContent?.trim() === "Resume")).toBe(false);
    expect(card.textContent).not.toContain("Resume after feedback");

    testFixture.dashboard.workers = [{ ...coding, status: "awaiting_merge", autoReview: { ...autoReview, phase: "merging", reviewWorkerId: child.id } }, { ...child, status: "completed" }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(panel.querySelector(".forge-auto-review-status")?.textContent).toContain("Waiting to merge");
    expect(panel.querySelector(".forge-item .forge-status-awaiting_merge")?.textContent).toBe("Coding · awaiting merge");
    expect(button(card, "Pause").disabled).toBe(false);
    expect(button(card, "Stop").disabled).toBe(false);
    expect(panel.querySelector("dialog")).toBeNull();
    expect(testFixture.calls.every(call => call.hook === "forge.dashboard" || call.hook.endsWith(".list") || call.hook.endsWith(".get"))).toBe(true);
  });

  it.each([
    { status: "awaiting_review" as const, phase: "reviewing" as const, action: "Pause" },
    { status: "awaiting_review" as const, phase: "reviewing" as const, action: "Stop" },
    { status: "awaiting_merge" as const, phase: "merging" as const, action: "Pause" },
    { status: "awaiting_merge" as const, phase: "merging" as const, action: "Stop" }
  ])("$action controls the whole issue loop while $status", async ({ status, phase, action }) => {
    const coding: ForgeWorker = { ...worker, status, autoReview: { enabled: true, phase, placement: { windowId: "window-1", paneId: "pane-2" } } };
    const testFixture = fixture({ workers: [coding] });
    const panel = await renderPanel(testFixture);
    await click(panel.querySelector('[aria-label="issue worker #7"]')!, action);
    expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker."))).toEqual([
      { hook: `forge.worker.${action.toLowerCase()}`, input: { id: coding.id }, tabId: tab.id }
    ]);
  });

  it.each([
    { provider: "github" as const, kind: "issues", defaultFilter: "is:open", filter: "is:open label:bug", changesLabel: "Pull requests" },
    { provider: "github" as const, kind: "changes", defaultFilter: "is:open", filter: "is:open label:bug", changesLabel: "Pull requests" },
    { provider: "gitlab" as const, kind: "issues", defaultFilter: "state=opened", filter: "state=opened&labels=bug", changesLabel: "Merge requests" },
    { provider: "gitlab" as const, kind: "changes", defaultFilter: "state=opened", filter: "state=opened&labels=bug", changesLabel: "Merge requests" }
  ])("applies all quick filters to $provider $kind with editable native filters and pagination", async ({ provider, kind, defaultFilter, filter, changesLabel }) => {
    const hook = `forge.${kind}.list`;
    const testFixture = fixture({ repository: { ...repository, provider } }, (name, input) => name === hook ? { items: [kind === "issues" ? issue : change], nextPage: input.page === 1 ? 2 : undefined } : undefined);
    const panel = await renderPanel(testFixture);
    if (kind === "changes") await click(panel, changesLabel);
    const input = panel.querySelector<HTMLInputElement>(".forge-filter input")!;
    const quickFilters = panel.querySelector('[role="group"][aria-label="Quick filters"]')!;
    const appliedQuery = () => testFixture.calls.filter(call => call.hook === hook).at(-1)!.input;
    expect(input.value).toBe(defaultFilter);
    expect(appliedQuery()).toEqual({ repository: testFixture.dashboard.repository, filter: defaultFilter, page: 1, perPage: 25 });
    expect(quickFilters.querySelectorAll("button")).toHaveLength(4);
    expect(button(quickFilters, "All open items").getAttribute("aria-pressed")).toBe("true");

    for (const [label, scope] of [["Assigned to me", "assigned_to_me"], ["Created by me", "created_by_me"], ["Created by Forge workers", "created_by_workers"]]) {
      await click(panel, "Next");
      await fill(input, filter);
      await click(quickFilters, label);
      expect(input.value).toBe(filter);
      expect(appliedQuery()).toEqual({ repository: testFixture.dashboard.repository, filter, scope, page: 1, perPage: 25 });
      expect(quickFilters.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
      expect(button(quickFilters, label).getAttribute("aria-pressed")).toBe("true");
      expect(button(quickFilters, "All open items").getAttribute("aria-pressed")).toBe("false");
    }

    const editedFilter = provider === "github" ? "is:closed label:bug" : "state=closed&labels=bug";
    await fill(input, editedFilter);
    await click(panel, "Next");
    expect(appliedQuery()).toEqual({ repository: testFixture.dashboard.repository, filter, scope: "created_by_workers", page: 2, perPage: 25 });
    await click(panel, "Previous");
    expect(appliedQuery()).toEqual({ repository: testFixture.dashboard.repository, filter, scope: "created_by_workers", page: 1, perPage: 25 });
    await click(panel, "Next");
    await click(panel, "Apply filter");
    expect(appliedQuery()).toEqual({ repository: testFixture.dashboard.repository, filter: editedFilter, scope: "created_by_workers", page: 1, perPage: 25 });
    expect(button(quickFilters, "Created by Forge workers").getAttribute("aria-pressed")).toBe("true");
    await click(panel, "Next");
    expect(appliedQuery()).toEqual({ repository: testFixture.dashboard.repository, filter: editedFilter, scope: "created_by_workers", page: 2, perPage: 25 });

    await click(quickFilters, "All open items");
    expect(input.value).toBe(defaultFilter);
    expect(appliedQuery()).toEqual({ repository: testFixture.dashboard.repository, filter: defaultFilter, page: 1, perPage: 25 });
    expect(button(quickFilters, "All open items").getAttribute("aria-pressed")).toBe("true");
    await fill(input, editedFilter);
    expect(button(quickFilters, "All open items").getAttribute("aria-pressed")).toBe("true");
    await click(panel, "Apply filter");
    expect(appliedQuery()).toEqual({ repository: testFixture.dashboard.repository, filter: editedFilter, page: 1, perPage: 25 });
    expect(quickFilters.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  });

  it.each(["response", "error"])("ignores a stale quick-filter %s after another scope is applied", async outcome => {
    const oldList = deferred<unknown>();
    const testFixture = fixture({}, (hook, input) => {
      if (hook !== "forge.issues.list") return;
      if (input.scope === "assigned_to_me") return oldList.promise;
      if (input.scope === "created_by_me") return { items: [] };
    });
    const panel = await renderPanel(testFixture);
    await click(panel, "Assigned to me");
    await click(panel, "Created by me");
    await act(async () => {
      if (outcome === "response") oldList.resolve({ items: [issue] });
      else oldList.reject(new Error("Superseded identity error."));
    });
    expect(panel.textContent).toContain("No issues match this filter.");
    expect(panel.textContent).not.toContain(issue.title);
    expect(panel.textContent).not.toContain("Superseded identity error.");
    expect(button(panel, "Created by me").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows missing personal identity as a list error and can return to all open items", async () => {
    const testFixture = fixture({}, (hook, input) => {
      if (hook === "forge.issues.list" && input.scope === "assigned_to_me") throw new Error("Forge username is not configured.");
    });
    const panel = await renderPanel(testFixture);
    await click(panel, "Assigned to me");
    expect(panel.querySelector('.forge-list [role="alert"]')?.textContent).toBe("Forge username is not configured.");
    await click(panel, "All open items");
    expect(panel.querySelector('.forge-list [role="alert"]')).toBeNull();
    expect(panel.querySelector(".forge-list")?.textContent).toContain(issue.title);
  });

  it.each([
    { provider: "github" as const, filter: "is:open label:bug assignee:@me", label: "GitHub search qualifiers" },
    { provider: "gitlab" as const, filter: "state=opened&labels=bug&scope=assigned_to_me", label: "GitLab URL query parameters" }
  ])("passes $provider native filters and pagination to its list hook", async ({ provider, filter, label }) => {
    const testFixture = fixture({ repository: { ...repository, provider } }, (hook, input) => hook === "forge.issues.list" ? { items: [issue], nextPage: input.page === 1 ? 2 : undefined } : undefined);
    const panel = await renderPanel(testFixture);
    expect(panel.textContent).toContain(label);
    await fill(panel.querySelector(".forge-filter input")!, filter);
    await act(async () => { panel.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await click(panel, "Next");
    expect(testFixture.calls).toContainEqual({ hook: "forge.issues.list", input: { repository: testFixture.dashboard.repository, filter, page: 2, perPage: 25 }, tabId: "forge-tab" });
    expect(button(panel, "Next").disabled).toBe(true);
    await click(panel, "Previous");
    expect(testFixture.calls.at(-2)?.input.page ?? testFixture.calls.at(-1)?.input.page).toBe(1);
  });

  it("ignores a list response superseded by a new filter", async () => {
    const oldList = deferred<unknown>();
    const testFixture = fixture({}, (hook, input) => hook === "forge.issues.list" ? input.filter === "label:new" ? { items: [] } : oldList.promise : undefined);
    const panel = await renderPanel(testFixture);
    await fill(panel.querySelector(".forge-filter input")!, "label:new");
    await act(async () => { panel.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => { oldList.resolve({ items: [issue] }); });
    expect(panel.textContent).toContain("No issues match this filter.");
    expect(panel.textContent).not.toContain(issue.title);
  });

  it("ignores late detail responses after selecting another issue", async () => {
    const oldDetail = deferred<unknown>();
    const nextIssue = { ...issue, number: 8, title: "Fix uploads", body: "Uploads fail.", comments: [] };
    const testFixture = fixture({}, (hook, input) => {
      if (hook === "forge.issues.list") return { items: [issue, nextIssue] };
      if (hook === "forge.issue.get") return input.number === 7 ? oldDetail.promise : { issue: nextIssue };
    });
    const panel = await renderPanel(testFixture);
    await act(async () => { panel.querySelectorAll<HTMLButtonElement>(".forge-item")[1].click(); });
    await act(async () => { oldDetail.resolve({ issue }); });
    expect(panel.querySelector(".forge-detail")?.textContent).toContain("Uploads fail.");
    expect(panel.querySelector(".forge-detail")?.textContent).not.toContain("Reproduced in staging.");
    await click(panel, "Start work");
    expect(testFixture.calls.find((call) => call.hook === "forge.issue.start")?.input.number).toBe(8);
  });

  it.each(["github", "gitlab"] as const)("distinguishes %s review, automatic posting, approval, and requested changes", async provider => {
    const testFixture = fixture({ repository: { ...repository, provider } });
    const panel = await renderPanel(testFixture);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    expect(panel.textContent).toContain("Needs a timeout.");
    await click(panel, "Review");
    await click(panel, "Review and post");
    await click(panel, "Mark as approved");
    expect(button(panel, "Mark as request changes").disabled).toBe(true);
    await fill(panel.querySelector(".forge-change-actions .forge-field textarea")!, "Please add a timeout.");
    await click(panel, "Mark as request changes");
    expect(testFixture.calls.filter((call) => call.hook === "forge.review.start").map((call) => call.input)).toEqual([
      { repository: testFixture.dashboard.repository, number: 12, autoPost: false, windowId: "window-1", paneId: "pane-2" },
      { repository: testFixture.dashboard.repository, number: 12, autoPost: true, windowId: "window-1", paneId: "pane-2" }
    ]);
    expect(testFixture.calls.filter((call) => call.hook === "forge.change.review").map((call) => call.input)).toEqual([
      { repository: testFixture.dashboard.repository, number: 12, headSha: change.headSha, event: "approve", body: "" },
      { repository: testFixture.dashboard.repository, number: 12, headSha: change.headSha, event: "request_changes", body: "Please add a timeout." }
    ]);
  });

  it.each([
    { provider: "github", event: "approve", label: "Mark as approved" },
    { provider: "github", event: "request_changes", label: "Mark as request changes" },
    { provider: "gitlab", event: "approve", label: "Mark as approved" },
    { provider: "gitlab", event: "request_changes", label: "Mark as request changes" },
  ] as const)("pins $provider $event to the displayed revision and requires a new decision after a head change", async ({ provider, event, label }) => {
    let current = { ...change };
    const published: Record<string, unknown>[] = [];
    const testFixture = fixture({ repository: { ...repository, provider } }, (hook, input) => {
      if (hook === "forge.change.get") return { change: { ...current } };
      if (hook === "forge.change.review") {
        if (input.headSha !== current.headSha) throw new Error("The request head changed. Review the latest details before submitting a decision.");
        published.push(input);
        return { change: { ...current } };
      }
    });
    const panel = await renderPanel(testFixture);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const body = "Decision based on the displayed revision.";
    await fill(panel.querySelector(".forge-change-actions .forge-field textarea")!, body);
    current = { ...change, headSha: "c".repeat(40), body: "New revision to inspect." };
    expect(panel.textContent).not.toContain(current.body);

    await click(panel, label);

    expect(testFixture.calls.filter(call => call.hook === "forge.change.review")).toEqual([
      { hook: "forge.change.review", input: { repository: testFixture.dashboard.repository, number: change.number, headSha: change.headSha, event, body }, tabId: tab.id },
    ]);
    expect(published).toEqual([]);
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("The request head changed");
    expect(panel.textContent).toContain(current.body);
    await click(panel, label);
    expect(published).toEqual([{ repository: testFixture.dashboard.repository, number: change.number, headSha: current.headSha, event, body }]);
  });

  it.each(["github", "gitlab"] as const)("shows %s review workers collapsed and newest first by start time", async provider => {
    const currentRepository = { ...repository, provider };
    const oldest = { ...reviewWorker, repository: currentRepository, id: "oldest", startedAt: "2026-09-07T10:00:00Z", updatedAt: "2026-09-07T14:00:00Z", draft: { ...reviewWorker.draft!, startedAt: "2026-09-07T10:00:00Z", status: "posted" as const } };
    const failed = { ...reviewWorker, repository: currentRepository, id: "failed", startedAt: "2026-09-07T11:00:00Z", status: "failed" as const, error: "Review publication failed.", draft: { ...reviewWorker.draft!, startedAt: "2026-09-07T11:00:00Z", status: "post_failed" as const } };
    const newest = { ...reviewWorker, repository: currentRepository, id: "newest", startedAt: "2026-09-07T12:00:00Z", status: "running" as const, draft: undefined };
    const coding = { ...worker, repository: currentRepository, changeNumber: change.number };
    const workers = [failed, oldest, coding, newest, { ...newest, id: "unrelated", number: 13 }];
    const testFixture = fixture({ repository: currentRepository, workers });
    const panel = await renderPanel(testFixture);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const histories = Array.from(panel.querySelectorAll<HTMLDetailsElement>(".forge-worker-history"));
    expect(histories.map(history => history.querySelector("summary time")?.getAttribute("datetime"))).toEqual([newest.startedAt, failed.startedAt, oldest.startedAt]);
    expect(histories.every(history => !history.open)).toBe(true);
    expect(histories[0].querySelector("summary")?.textContent).toContain("running");
    expect(histories[2].querySelector("summary")?.textContent).toContain("Posted review · 1 comment");
    expect(histories[1].querySelector(".forge-worker")?.textContent).toContain(failed.error);
    expect(histories[1].textContent).toContain("Submission could be incomplete");
    expect(histories[2].querySelectorAll(".forge-review textarea")).toHaveLength(2);
    expect(histories[2].textContent).toContain("Review posted.");
    expect(panel.querySelector('.forge-change-actions [aria-label="issue worker #7"]')?.closest("details")).toBeNull();
    expect(panel.querySelector(".forge-comments")?.closest("details")).toBeNull();
    expect(testFixture.dashboard.workers.map(worker => worker.id)).toEqual(["failed", "oldest", "work-1", "newest", "unrelated"]);
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it.each(["github", "gitlab"] as const)("shows a reused %s reviewer's current work and archived messages as collapsed newest-first rounds", async provider => {
    const currentRepository = { ...repository, provider };
    const previous = { ...reviewWorker.draft!, id: "44444444-4444-4444-8444-444444444444", startedAt: "2026-09-07T11:00:00.000Z", body: "Saved previous draft." };
    const oldest = { ...reviewWorker.draft!, id: "55555555-5555-4555-8555-555555555555", startedAt: "2026-09-07T10:00:00.000Z", body: "Posted older review.", status: "posted" as const };
    const current = { ...reviewWorker, repository: currentRepository, status: "running" as const, startedAt: "2026-09-07T12:00:00.000Z", draft: undefined, reviewHistory: [oldest, previous] };
    const testFixture = fixture({ repository: currentRepository, workers: [current] });
    const panel = await renderPanel(testFixture);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const histories = Array.from(panel.querySelectorAll<HTMLDetailsElement>(".forge-worker-history"));
    expect(histories.map(history => history.querySelector("summary time")?.getAttribute("datetime"))).toEqual([current.startedAt, previous.startedAt, oldest.startedAt]);
    expect(histories.every(history => !history.open)).toBe(true);
    expect(histories[0].querySelector("summary")?.textContent).toContain("running");
    expect(Array.from(panel.querySelectorAll(".forge-worker button"), button => button.textContent?.trim()).filter(text => text === "Pause")).toHaveLength(1);
    for (const [index, draft] of [previous, oldest].entries()) {
      const history = histories[index + 1];
      expect(history.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
      expect(history.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft.body);
      expect(history.querySelectorAll("textarea")).toHaveLength(2);
      expect(history.querySelector(".forge-worker-heading .forge-status")).toBeNull();
      expect(history.querySelector(".forge-worker > .forge-actions")).toBeNull();
    }
    expect(panel.querySelector(".forge-item")?.textContent).not.toContain("review draft");
    expect(testFixture.calls.every(call => call.hook === "forge.dashboard" || call.hook.endsWith(".list") || call.hook.endsWith(".get"))).toBe(true);
  });

  it("preserves open unsaved messages as readonly history when polling replaces the same worker's draft on the same SHA", async () => {
    vi.useFakeTimers();
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [reviewWorker] }, hook => hook === "forge.dashboard" ? structuredClone(testFixture.dashboard) : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    const history = panel.querySelector<HTMLDetailsElement>(".forge-worker-history")!;
    await act(async () => { history.querySelector("summary")!.click(); });
    const summary = history.querySelector<HTMLTextAreaElement>(".forge-review textarea")!;
    await fill(summary, "Keep my unsaved previous summary.");
    await fill(history.querySelectorAll<HTMLTextAreaElement>(".forge-review textarea")[1], "Keep my unsaved previous finding.");
    const nextDraft = { ...reviewWorker.draft!, id: "44444444-4444-4444-8444-444444444444", startedAt: "2026-09-07T12:00:00.000Z", body: "Fresh review of the same SHA." };
    testFixture.dashboard.workers = [{ ...reviewWorker, startedAt: nextDraft.startedAt, draft: nextDraft, reviewHistory: [reviewWorker.draft!] }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    const histories = Array.from(panel.querySelectorAll<HTMLDetailsElement>(".forge-worker-history"));
    expect(histories).toHaveLength(2);
    expect(histories[0].open).toBe(false);
    expect(histories[1]).toBe(history);
    expect(history.open).toBe(true);
    expect(history.querySelector(".forge-review textarea")).toBe(summary);
    expect(Array.from(history.querySelectorAll<HTMLTextAreaElement>(".forge-review textarea"), input => input.value)).toEqual(["Keep my unsaved previous summary.", "Keep my unsaved previous finding."]);
    expect(history.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
    expect(histories[0].querySelector<HTMLTextAreaElement>(".forge-review textarea")?.value).toBe(nextDraft.body);
    expect(histories[0].querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(false);
    expect(panel.querySelector("dialog")).toBeNull();
    expect(testFixture.calls.every(call => call.hook === "forge.dashboard" || call.hook.endsWith(".list") || call.hook.endsWith(".get"))).toBe(true);
  });

  it("preserves expanded reviews and all unsaved messages when polling adds a newer worker", async () => {
    vi.useFakeTimers();
    const oldest = { ...reviewWorker, id: "oldest", startedAt: "2026-09-07T10:00:00Z", draft: { ...reviewWorker.draft!, startedAt: "2026-09-07T10:00:00Z", status: "posted" as const } };
    const current = { ...reviewWorker, startedAt: "2026-09-07T11:00:00Z", draft: { ...reviewWorker.draft!, startedAt: "2026-09-07T11:00:00Z" } };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [oldest, current] }, hook => hook === "forge.dashboard" ? structuredClone(testFixture.dashboard) : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    const [history, olderHistory] = Array.from(panel.querySelectorAll<HTMLDetailsElement>(".forge-worker-history"));
    await act(async () => { history.querySelector("summary")!.click(); olderHistory.querySelector("summary")!.click(); });
    expect(history.open && olderHistory.open).toBe(true);
    const [summary, comment] = Array.from(history.querySelectorAll<HTMLTextAreaElement>(".forge-review textarea"));
    await fill(summary, "Keep my unsaved summary.");
    await fill(comment, "Keep my unsaved inline comment.");
    await click(history, "Add comment");
    const generalComment = history.querySelectorAll<HTMLTextAreaElement>(".forge-review textarea")[2];
    await fill(generalComment, "Keep my new general comment.");
    const newest = { ...current, id: "newest", startedAt: "2026-09-07T12:00:00Z", draft: undefined, status: "running" as const };
    testFixture.dashboard.workers = [oldest, newest, { ...current, updatedAt: "2026-09-07T14:00:00Z" }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const refreshed = Array.from(panel.querySelectorAll<HTMLDetailsElement>(".forge-worker-history"));
    expect(refreshed[0].open).toBe(false);
    expect(refreshed[1]).toBe(history);
    expect(refreshed[2]).toBe(olderHistory);
    expect(history.open && olderHistory.open).toBe(true);
    await act(async () => { history.querySelector("summary")!.click(); });
    expect(history.open).toBe(false);
    expect(olderHistory.open).toBe(true);
    await act(async () => { history.querySelector("summary")!.click(); });
    expect(history.open).toBe(true);
    expect(Array.from(history.querySelectorAll<HTMLTextAreaElement>(".forge-review textarea"), textarea => textarea.value)).toEqual(["Keep my unsaved summary.", "Keep my unsaved inline comment.", "Keep my new general comment."]);
    expect(history.querySelector(".forge-review textarea")).toBe(summary);
    expect(panel.querySelector("dialog")).toBeNull();
    expect(testFixture.calls.every(call => call.hook === "forge.dashboard" || call.hook.endsWith(".list") || call.hook.endsWith(".get"))).toBe(true);
  });

  it.each(["github", "gitlab"] as const)("keeps the %s issue worker beside review actions above a long description without losing draft edits", async provider => {
    const currentRepository = { ...repository, provider };
    const coding = { ...worker, repository: currentRepository, changeNumber: change.number, status: "awaiting_review" as const };
    const reviewer = { ...reviewWorker, repository: currentRepository };
    const testFixture = fixture({ repository: currentRepository, workers: [coding, reviewer] }, hook => hook === "forge.change.get" ? { change: { ...change, body: "Long change description.\n".repeat(100) } } : undefined);
    const panel = await renderPanel(testFixture, { workerTabs: [workerTab] });
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const actions = panel.querySelector(".forge-change-actions")!;
    const cards = panel.querySelectorAll(".forge-detail .forge-worker");
    const body = panel.querySelector(".forge-detail > .forge-prose")!;
    for (const label of ["Review", "Review and post", "Mark as approved", "Mark as request changes"]) expect(button(actions, label)).toBeDefined();
    expect(button(actions, "Review").disabled).toBe(false);
    expect(actions.contains(cards[0])).toBe(true);
    expect(button(cards[0], "Resume").disabled).toBe(false);
    expect(actions.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    for (const card of cards) expect(actions.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const message = actions.querySelector<HTMLTextAreaElement>("textarea")!;
    const draft = panel.querySelector<HTMLTextAreaElement>(".forge-review textarea")!;
    await fill(message, "Keep my approval message.");
    await fill(draft, "Keep my draft changes.");
    await click(cards[0], "View worker");
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')).not.toBeNull();
    await click(panel, "Close worker terminal");
    await click(panel, "Refresh Forge");
    expect(panel.querySelector(".forge-change-actions textarea")).toBe(message);
    expect(message.value).toBe("Keep my approval message.");
    expect(panel.querySelector(".forge-review textarea")).toBe(draft);
    expect(draft.value).toBe("Keep my draft changes.");
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it.each([
    { provider: "github" as const, state: "closed" as const, merged: false },
    { provider: "github" as const, state: "merged" as const, merged: true },
    { provider: "github" as const, state: "open" as const, merged: true },
    { provider: "gitlab" as const, state: "closed" as const, merged: false },
    { provider: "gitlab" as const, state: "merged" as const, merged: true },
    { provider: "gitlab" as const, state: "open" as const, merged: true }
  ])("disables $provider review publication for state=$state merged=$merged despite a stale open list", async ({ provider, state, merged }) => {
    let currentChange = change;
    const currentRepository = { ...repository, provider };
    const testFixture = fixture({ repository: currentRepository, workers: [{ ...reviewWorker, repository: currentRepository }] }, hook => hook === "forge.change.get" ? { change: currentChange } : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    await fill(panel.querySelector(".forge-change-actions textarea")!, "Please address the remaining issue.");
    currentChange = { ...change, state, merged };
    await click(panel, "Refresh Forge");
    expect(panel.querySelector(".forge-item .forge-muted")?.textContent).toContain("open");
    for (const label of ["Review", "Review and post", "Mark as approved", "Mark as request changes", "Submit review"]) {
      expect(button(panel, label).disabled).toBe(true);
      await click(panel, label);
    }
    expect(button(panel, "Save draft").disabled).toBe(false);
    await click(panel, "Save draft");
    expect(testFixture.calls.filter(call => call.hook === "forge.review.save")).toHaveLength(1);
    expect(testFixture.calls.some(call => ["forge.review.start", "forge.change.review", "forge.review.submit"].includes(call.hook))).toBe(false);
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it("keeps top review actions visible but prevents publication before fresh details load or after they fail", async () => {
    const pending = deferred<unknown>();
    const testFixture = fixture({ workers: [reviewWorker] }, hook => hook === "forge.change.get" ? pending.promise : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    for (const label of ["Review", "Review and post", "Mark as approved", "Mark as request changes", "Submit review"]) expect(button(panel, label).disabled).toBe(true);
    expect(button(panel, "Save draft").disabled).toBe(false);
    await act(async () => pending.reject(new Error("Request details unavailable.")));
    expect(panel.textContent).toContain("Request details unavailable.");
    expect(button(panel, "Mark as approved").disabled).toBe(true);
    expect(button(panel, "Submit review").disabled).toBe(true);
    expect(testFixture.calls.some(call => ["forge.review.start", "forge.change.review", "forge.review.submit"].includes(call.hook))).toBe(false);
  });

  it.each(["github", "gitlab"] as const)("resumes the associated %s issue worker from review actions after the review finishes", async provider => {
    vi.useFakeTimers();
    const currentRepository = { ...repository, provider };
    const coding = { ...worker, repository: currentRepository, changeNumber: change.number, status: "awaiting_review" as const };
    const reviewer = { ...reviewWorker, repository: currentRepository, status: "running" as const, draft: undefined };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ repository: currentRepository, workers: [coding, reviewer] }, hook => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === "forge.worker.resume") {
        testFixture.dashboard.workers = [{ ...coding, status: "running" }];
        return { worker: testFixture.dashboard.workers[0] };
      }
    });
    const panel = await renderPanel(testFixture);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const actions = panel.querySelector(".forge-change-actions")!;
    const card = actions.querySelector('[aria-label="issue worker #7"]')!;
    expect(card).not.toBeNull();
    expect(panel.querySelectorAll('[aria-label="issue worker #7"]')).toHaveLength(1);
    testFixture.dashboard.workers = [coding, { ...reviewWorker, repository: currentRepository, draft: { ...reviewWorker.draft!, status: "posted" } }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(panel.textContent).toContain("Review posted.");
    expect(button(card, "Resume").disabled).toBe(false);
    expect(testFixture.calls.some(call => call.hook === "forge.worker.resume")).toBe(false);
    await click(card, "Resume");
    expect(testFixture.calls.filter(call => call.hook === "forge.worker.resume")).toEqual([
      { hook: "forge.worker.resume", input: { id: coding.id, windowId: "window-1", paneId: "pane-2" }, tabId: "forge-tab" }
    ]);
    expect(actions.querySelector(".forge-status")?.textContent).toBe("running");
    expect(button(card, "Pause").disabled).toBe(false);
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it("keeps Resume beside the review disabled until submitting the review finishes", async () => {
    const submitted = deferred<unknown>();
    const coding = { ...worker, changeNumber: change.number, status: "awaiting_review" as const };
    const testFixture = fixture({ workers: [coding, reviewWorker] }, hook => hook === "forge.review.submit" ? submitted.promise : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    const actions = panel.querySelector(".forge-change-actions")!;
    const resume = button(actions, "Resume");
    await click(panel, "Submit review");
    expect(resume.disabled).toBe(true);
    await click(actions, "Resume");
    expect(testFixture.calls.some(call => call.hook === "forge.worker.resume")).toBe(false);
    await act(async () => submitted.resolve({ worker: reviewWorker }));
    expect(resume.disabled).toBe(false);
    await click(actions, "Resume");
    expect(testFixture.calls.find(call => call.hook === "forge.worker.resume")?.input.id).toBe(coding.id);
  });

  it("removes a retired issue worker from review actions without substituting an external issue link", async () => {
    vi.useFakeTimers();
    const coding = { ...worker, changeNumber: change.number, status: "awaiting_review" as const };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [coding] }, hook => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === "forge.change.get") return { change: { ...change, linkedIssues: [{ id: "issue-7", number: issue.number, title: issue.title, state: "open", url: issue.url }] } };
    });
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    const actions = panel.querySelector(".forge-change-actions")!;
    expect(actions.querySelectorAll(".forge-worker")).toHaveLength(1);
    testFixture.dashboard.workers = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(actions.querySelector(".forge-worker")).toBeNull();
    expect(actions.querySelector("a")).toBeNull();
    expect(button(actions, "Review").disabled).toBe(false);
  });

  it("edits suggested reviews and saves the exact edits before submission", async () => {
    const testFixture = fixture({ workers: [reviewWorker] });
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    expect(panel.querySelector(".forge-item")?.textContent).toContain("1 suggested comment · 1 review draft");
    const editor = panel.querySelector(".forge-review")!;
    await fill(editor.querySelector("textarea")!, "Use a bounded timeout.");
    await fill(editor.querySelectorAll("textarea")[1], "Cancel after 30 seconds.");
    await fill(editor.querySelector('[aria-label="Comment 1 line"]')!, "11");
    await fill(editor.querySelector('[aria-label="Comment 1 side"]')!, "LEFT");
    await click(editor, "Save draft");
    expect(editor.textContent).toContain("Draft saved.");
    await click(editor, "Submit review");
    const publication = testFixture.calls.filter((call) => call.hook === "forge.review.save" || call.hook === "forge.review.submit");
    expect(publication.map((call) => call.hook)).toEqual(["forge.review.save", "forge.review.save", "forge.review.submit"]);
    expect(publication[1].input).toEqual({ id: "review-1", draftId: reviewWorker.draft!.id, event: "request_changes", body: "Use a bounded timeout.", comments: [{ path: "deploy.ts", line: 11, side: "LEFT", body: "Cancel after 30 seconds." }] });
    expect(publication[2].input).toEqual({ id: "review-1", draftId: reviewWorker.draft!.id });
  });

  it("keeps edits during worker polling and cleans up the polling timer on unmount", async () => {
    vi.useFakeTimers();
    const testFixture = fixture({ workers: [reviewWorker] });
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    const summary = panel.querySelector<HTMLTextAreaElement>(".forge-review textarea")!;
    await fill(summary, "My edited summary");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(summary.value).toBe("My edited summary");
    expect(testFixture.calls.filter((call) => call.hook === "forge.dashboard")).toHaveLength(2);
    await act(async () => { roots.pop()!.unmount(); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an in-flight submission bound to the displayed draft when its worker starts a new review", async () => {
    vi.useFakeTimers();
    const saved = deferred<unknown>();
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [reviewWorker] }, hook => hook === "forge.review.save" ? saved.promise : hook === "forge.dashboard" ? structuredClone(testFixture.dashboard) : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    await click(panel, "Submit review");
    const nextDraft = { ...reviewWorker.draft!, id: "44444444-4444-4444-8444-444444444444", startedAt: "2026-09-07T12:00:00.000Z", body: "New review." };
    testFixture.dashboard.workers = [{ ...reviewWorker, draft: nextDraft, reviewHistory: [reviewWorker.draft!] }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => { saved.resolve({ worker: reviewWorker }); });

    const mutations = testFixture.calls.filter(call => call.hook === "forge.review.save" || call.hook === "forge.review.submit");
    expect(mutations.map(call => call.input?.draftId)).toEqual([reviewWorker.draft!.id, reviewWorker.draft!.id]);
    expect(panel.querySelector<HTMLTextAreaElement>(".forge-review textarea")?.value).toBe(nextDraft.body);
  });

  it.each(["posting", "posted", "post_failed"] as const)("keeps %s reviews read-only", async (status) => {
    const panel = await renderPanel(fixture({ workers: [{ ...reviewWorker, draft: { ...reviewWorker.draft!, status } }] }));
    await click(panel, "Pull requests");
    expect(panel.querySelector<HTMLFieldSetElement>(".forge-review fieldset")?.disabled).toBe(true);
    if (status === "post_failed") expect(panel.textContent).toContain("Inspect the PR/MR for published comments");
    if (status === "posted") expect(panel.textContent).toContain("Review posted.");
  });

  it("keeps a running command targeted to its original issue and prevents duplicate starts", async () => {
    const started = deferred<unknown>();
    const testFixture = fixture({}, (hook) => {
      if (hook === "forge.issues.list") return { items: [issue, { ...issue, number: 8, title: "Fix uploads" }] };
      if (hook === "forge.issue.start") return started.promise;
    });
    const panel = await renderPanel(testFixture);
    await act(async () => { button(panel, "Start work").click(); button(panel, "Start work").click(); });
    await act(async () => { panel.querySelectorAll<HTMLButtonElement>(".forge-item")[1].click(); });
    expect(testFixture.calls.filter((call) => call.hook === "forge.issue.start").map((call) => call.input.number)).toEqual([7]);
    expect(button(panel, "Start work").disabled).toBe(true);
    await act(async () => { started.resolve({ worker }); });
  });

  it.each(["github", "gitlab"] as const)("shows every active or blocked coding/review status under %s items", async provider => {
    const currentRepository = { ...repository, provider };
    const statuses = ["starting", "running", "paused", "awaiting_review", "stopped", "failed", "cleanup_failed"] as const;
    const codingWorkers = statuses.map(status => ({ ...worker, repository: currentRepository, id: `coding-${status}`, changeNumber: change.number, status, error: status === "failed" || status === "cleanup_failed" ? `Coding ${status} reason.` : undefined }));
    const reviewers = statuses.map(status => ({ ...reviewWorker, repository: currentRepository, id: `review-${status}`, status, draft: undefined, error: status === "failed" || status === "cleanup_failed" ? `Review ${status} reason.` : undefined }));
    const panel = await renderPanel(fixture({ repository: currentRepository, workers: [...codingWorkers, ...reviewers] }));
    const issueRow = panel.querySelector(".forge-item")!;
    expect(issueRow.querySelectorAll(".forge-item-workers .forge-item-worker")).toHaveLength(statuses.length);
    for (const status of statuses) expect(issueRow.textContent).toContain(`Coding · ${status.replaceAll("_", " ")}`);
    expect(issueRow.querySelectorAll(".forge-item-worker-error")).toHaveLength(2);
    expect(issueRow.textContent).toContain("Coding failed reason.");
    expect(issueRow.textContent).toContain("Coding cleanup_failed reason.");

    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const changeRow = panel.querySelector(".forge-item")!;
    expect(changeRow.querySelectorAll(".forge-item-workers .forge-item-worker")).toHaveLength(statuses.length * 2);
    for (const status of statuses) {
      expect(changeRow.textContent).toContain(`Coding · ${status.replaceAll("_", " ")}`);
      expect(changeRow.textContent).toContain(`Review · ${status.replaceAll("_", " ")}`);
    }
    expect(changeRow.querySelectorAll(".forge-item-worker-error")).toHaveLength(4);
    expect(changeRow.textContent).toContain("Review failed reason.");
    expect(changeRow.textContent).toContain("Review cleanup_failed reason.");
    const cards = panel.querySelectorAll(".forge-detail .forge-worker");
    expect(cards).toHaveLength(statuses.length * 2);
    const body = panel.querySelector(".forge-detail > .forge-prose")!;
    for (const card of cards) expect(card.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it.each(["github", "gitlab"] as const)("shows %s publication waiting as normal progress in issues, requests, and worker tabs", async provider => {
    const currentRepository = { ...repository, provider };
    const publishing = { ...publishingWorker, repository: currentRepository };
    const testFixture = fixture({ repository: currentRepository, workers: [publishing] });
    const panel = await renderPanel(testFixture);
    const expectedMessage = `The commit was pushed. Waiting for ${provider === "github" ? "GitHub" : "GitLab"} to confirm the ${provider === "github" ? "pull" : "merge"} request update; work continues automatically.`;
    const assertWaitingCard = (card: Element) => {
      expect(card.querySelector(".forge-status-awaiting_publication")?.textContent).toBe("awaiting publication");
      expect(card.querySelector('[role="status"]')?.textContent).toBe(expectedMessage);
      expect(button(card, "Pause").disabled).toBe(false);
      expect(button(card, "Stop").disabled).toBe(false);
      expect(Array.from(card.querySelectorAll("button")).some(item => item.textContent?.trim() === "Resume")).toBe(false);
      expect(card.querySelector('[role="alert"], .forge-notice')).toBeNull();
    };
    expect(panel.querySelector(".forge-item .forge-status-awaiting_publication")?.textContent).toBe("Coding · awaiting publication");
    expect(button(panel, "Start work").disabled).toBe(true);
    assertWaitingCard(panel.querySelector(".forge-detail .forge-worker")!);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    expect(panel.querySelector(".forge-item .forge-status-awaiting_publication")?.textContent).toBe("Coding · awaiting publication");
    assertWaitingCard(panel.querySelector(".forge-change-toolbar .forge-worker")!);
    await click(panel, "Workers (1)");
    expect(panel.querySelector('[role="tab"][aria-selected="true"] small')?.textContent).toBe("awaiting publication");
    assertWaitingCard(panel.querySelector('[role="tabpanel"] .forge-worker')!);
    expect(panel.querySelector(".forge-item-worker-error, [role=alert], dialog")).toBeNull();
    expect(testFixture.calls.every(call => call.hook === "forge.dashboard" || call.hook.endsWith(".list") || call.hook.endsWith(".get"))).toBe(true);
  });

  it.each([
    { provider: "github" as const, action: "Pause", status: "paused" as const },
    { provider: "github" as const, action: "Stop", status: "stopped" as const },
    { provider: "gitlab" as const, action: "Pause", status: "paused" as const },
    { provider: "gitlab" as const, action: "Stop", status: "stopped" as const }
  ])("$action interrupts a $provider worker waiting for publication", async ({ provider, action, status }) => {
    const currentRepository = { ...repository, provider };
    const publishing = { ...publishingWorker, repository: currentRepository };
    const hook = `forge.worker.${action.toLowerCase()}`;
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ repository: currentRepository, workers: [publishing] }, requested => {
      if (requested === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (requested === hook) {
        testFixture.dashboard.workers = [{ ...publishing, status }];
        return { worker: testFixture.dashboard.workers[0] };
      }
    });
    const panel = await renderPanel(testFixture);
    await click(panel.querySelector(".forge-worker")!, action);
    expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker."))).toEqual([{ hook, input: { id: publishing.id }, tabId: tab.id }]);
    expect(panel.querySelector(".forge-worker-heading .forge-status")?.textContent).toBe(status);
    expect(button(panel, "Retry publication").disabled).toBe(false);
    expect(panel.textContent).not.toContain("work continues automatically");
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it.each(["github", "gitlab"] as const)("waits for every associated %s coding publication before review and preserves selection and drafts on confirmation", async provider => {
    vi.useFakeTimers();
    const currentRepository = { ...repository, provider };
    const selected = { ...change, number: change.number + 1, title: "Selected request" };
    const publishing = { ...publishingWorker, repository: currentRepository, changeNumber: selected.number };
    const ready: ForgeWorker = { ...publishing, id: "ready-coder", status: "awaiting_review", headSha: publishing.pendingPublication!.headSha, pendingPublication: undefined };
    const reviewer = { ...reviewWorker, repository: currentRepository, number: selected.number };
    const unrelated = [
      { ...publishing, id: "number-collision", number: selected.number, changeNumber: change.number },
      { ...publishing, id: "other-provider", repository: { ...currentRepository, provider: provider === "github" ? "gitlab" as const : "github" as const } },
      { ...publishing, id: "other-host", repository: { ...currentRepository, apiUrl: "https://other.example/api" } },
      { ...publishing, id: "other-project", repository: { ...currentRepository, projectPath: "another/project" } }
    ];
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ repository: currentRepository, workers: [ready, publishing, reviewer, ...unrelated] }, (hook, input) => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === "forge.changes.list") return { items: [change, selected] };
      if (hook === "forge.change.get") return { change: input.number === selected.number ? selected : change };
    });
    const panel = await renderPanel(testFixture, { workerTabs: [workerTab] });
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const row = panel.querySelectorAll<HTMLButtonElement>(".forge-item")[1];
    await act(async () => { row.click(); });
    const actions = panel.querySelector(".forge-change-actions")!;
    const message = actions.querySelector<HTMLTextAreaElement>("textarea")!;
    const draft = panel.querySelector<HTMLTextAreaElement>(".forge-review textarea")!;
    await fill(message, "Keep my message.");
    await fill(draft, "Keep my draft.");
    for (const label of ["Review", "Review and post", "Mark as approved", "Mark as request changes", "Submit review"]) {
      expect(button(panel, label).disabled).toBe(true);
      await click(panel, label);
    }
    expect(testFixture.calls.filter(call => call.hook === "forge.review.start")).toHaveLength(0);
    expect(testFixture.calls.filter(call => call.hook === "forge.change.review" || call.hook === "forge.review.submit")).toHaveLength(0);
    expect(draft.closest("fieldset")!.disabled).toBe(false);
    expect(button(panel, "Save draft").disabled).toBe(false);
    await click(panel, "Save draft");
    expect(testFixture.calls.filter(call => call.hook === "forge.review.save").map(call => call.input)).toEqual([
      { id: reviewer.id, draftId: reviewer.draft!.id, body: "Keep my draft.", event: reviewer.draft!.event, comments: reviewer.draft!.comments }
    ]);
    const refreshedRow = panel.querySelectorAll<HTMLButtonElement>(".forge-item")[1];
    expect(panel.querySelector("dialog")).toBeNull();
    const publishingCard = actions.querySelectorAll(".forge-worker")[1];
    await click(publishingCard, "View worker");
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')).not.toBeNull();
    await click(panel, "Close worker terminal");

    testFixture.dashboard.workers = [ready, { ...publishing, status: "awaiting_review", headSha: publishing.pendingPublication!.headSha, pendingPublication: undefined }, reviewer, ...unrelated];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(refreshedRow.getAttribute("aria-pressed")).toBe("true");
    expect(panel.querySelector(".forge-detail-heading h3")?.textContent).toContain("Selected request");
    expect(refreshedRow.textContent).toContain("Coding · awaiting review");
    expect(refreshedRow.textContent).not.toContain("awaiting publication");
    expect(publishingCard.textContent).toContain("Ready for review.");
    expect(button(publishingCard, "Resume").disabled).toBe(false);
    expect(panel.querySelector(".forge-change-actions textarea")).toBe(message);
    expect(message.value).toBe("Keep my message.");
    expect(panel.querySelector(".forge-review textarea")).toBe(draft);
    expect(draft.value).toBe("Keep my draft.");
    expect(panel.querySelector("dialog, [data-terminal-tab]")).toBeNull();
    for (const label of ["Mark as approved", "Mark as request changes", "Submit review"]) expect(button(panel, label).disabled).toBe(false);
    for (const label of ["Review", "Review and post"]) {
      expect(button(actions, label).disabled).toBe(false);
      await click(actions, label);
    }
    expect(testFixture.calls.filter(call => call.hook === "forge.review.start").map(call => call.input)).toEqual([
      { repository: currentRepository, number: selected.number, autoPost: false, windowId: "window-1", paneId: "pane-2" },
      { repository: currentRepository, number: selected.number, autoPost: true, windowId: "window-1", paneId: "pane-2" }
    ]);
    expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker."))).toHaveLength(0);
  });

  it.each([
    { provider: "github" as const, status: "paused" as const },
    { provider: "github" as const, status: "stopped" as const },
    { provider: "github" as const, status: "failed" as const },
    { provider: "gitlab" as const, status: "paused" as const },
    { provider: "gitlab" as const, status: "stopped" as const },
    { provider: "gitlab" as const, status: "failed" as const }
  ])("keeps $provider review blocked for a $status worker until the pushed head is confirmed", async ({ provider, status }) => {
    vi.useFakeTimers();
    const currentRepository = { ...repository, provider };
    const publishing = { ...publishingWorker, repository: currentRepository, status, error: status === "failed" ? "Provider confirmation timed out." : undefined };
    const reviewer = { ...reviewWorker, repository: currentRepository };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ repository: currentRepository, workers: [publishing, reviewer] }, hook => hook === "forge.dashboard" ? structuredClone(testFixture.dashboard) : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const message = panel.querySelector<HTMLTextAreaElement>(".forge-change-actions textarea")!;
    const draft = panel.querySelector<HTMLTextAreaElement>(".forge-review textarea")!;
    await fill(message, "Keep this decision.");
    await fill(draft, "Keep this local draft.");
    const guardedActions = ["Review", "Review and post", "Mark as approved", "Mark as request changes", "Submit review"];
    for (const label of guardedActions) {
      expect(button(panel, label).disabled).toBe(true);
      await click(panel, label);
    }
    expect(button(panel, "Save draft").disabled).toBe(false);
    expect(draft.closest("fieldset")!.disabled).toBe(false);
    expect(button(panel.querySelector(".forge-change-toolbar .forge-worker")!, "Retry publication").disabled).toBe(false);
    expect(panel.textContent).not.toContain("work continues automatically");
    expect(testFixture.calls.every(call => call.hook === "forge.dashboard" || call.hook.endsWith(".list") || call.hook.endsWith(".get"))).toBe(true);

    const confirmed: ForgeWorker = { ...publishing, headSha: publishing.pendingPublication!.headSha, pendingPublication: { ...publishing.pendingPublication!, confirmed: true } };
    testFixture.dashboard.workers = [confirmed, reviewer];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    for (const label of guardedActions) expect(button(panel, label).disabled).toBe(false);

    testFixture.dashboard.workers = [{ ...confirmed, headSha: "c".repeat(40) }, reviewer];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    for (const label of guardedActions) expect(button(panel, label).disabled).toBe(false);
    expect(message.value).toBe("Keep this decision.");
    expect(draft.value).toBe("Keep this local draft.");
    expect(panel.querySelector(".forge-change-toolbar .forge-status")?.textContent).toBe(status);
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it.each(["github", "gitlab"] as const)("keeps %s list workers isolated by repository, kind, and linked change number", async provider => {
    const currentRepository = { ...repository, provider };
    const coding = { ...worker, repository: currentRepository, changeNumber: change.number };
    const reviewer = { ...reviewWorker, repository: currentRepository, status: "running" as const, draft: undefined };
    const numberCollision = { ...coding, id: "other-issue", number: change.number, changeNumber: 99, error: "Other issue worker." };
    const reviewCollision = { ...reviewer, id: "other-review", number: issue.number, error: "Other review worker." };
    const foreignRepositories = [
      { ...currentRepository, provider: provider === "github" ? "gitlab" as const : "github" as const },
      { ...currentRepository, apiUrl: "https://another-host.example/api" },
      { ...currentRepository, projectPath: "another/project" }
    ];
    const foreignWorkers = foreignRepositories.flatMap((foreignRepository, index) => [
      { ...coding, id: `foreign-coding-${index}`, repository: foreignRepository, error: "Foreign coding worker." },
      { ...reviewer, id: `foreign-review-${index}`, repository: foreignRepository, error: "Foreign review worker." }
    ]);
    const testFixture = fixture({ repository: currentRepository, workers: [coding, reviewer, numberCollision, reviewCollision, ...foreignWorkers] }, hook => {
      if (hook === "forge.issues.list") return { items: [issue, { ...issue, number: change.number, title: "Another issue" }] };
      if (hook === "forge.changes.list") return { items: [change, { ...change, number: issue.number, title: "Another change" }] };
    });
    const panel = await renderPanel(testFixture);
    const issues = panel.querySelectorAll(".forge-item");
    expect(issues[0].querySelectorAll(".forge-item-worker")).toHaveLength(1);
    expect(issues[0].textContent).toContain("Coding · running");
    expect(issues[0].textContent).not.toMatch(/Other|Foreign|Review ·/);
    expect(issues[1].textContent).toContain("Other issue worker.");
    expect(panel.querySelectorAll(".forge-detail .forge-worker")).toHaveLength(1);

    await click(panel, provider === "github" ? "Pull requests" : "Merge requests");
    const changes = panel.querySelectorAll(".forge-item");
    expect(changes[0].querySelectorAll(".forge-item-worker")).toHaveLength(2);
    expect(changes[0].textContent).toContain("Coding · running");
    expect(changes[0].textContent).toContain("Review · running");
    expect(changes[0].textContent).not.toMatch(/Other|Foreign/);
    expect(changes[1].querySelectorAll(".forge-item-worker")).toHaveLength(1);
    expect(changes[1].textContent).toContain("Other review worker.");
    expect(panel.querySelectorAll(".forge-detail .forge-worker")).toHaveLength(2);
    expect(panel.querySelector('.forge-detail [aria-label="issue worker #7"]')).not.toBeNull();
    expect(panel.querySelector('.forge-detail [aria-label="review worker #12"]')).not.toBeNull();
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it.each(["issues", "changes"] as const)("only an unfinished worker of the matching kind prevents starting work from %s", async kind => {
    const unrelated = kind === "issues"
      ? { ...reviewWorker, number: issue.number, status: "running" as const, draft: undefined }
      : { ...worker, changeNumber: change.number, status: "awaiting_review" as const };
    const completed = kind === "issues" ? { ...worker, status: "completed" as const } : { ...reviewWorker, draft: undefined };
    const started = kind === "issues" ? { ...worker, status: "starting" as const } : { ...reviewWorker, status: "starting" as const, draft: undefined };
    const startHook = kind === "issues" ? "forge.issue.start" : "forge.review.start";
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [unrelated, completed] }, hook => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === startHook) { testFixture.dashboard.workers = [unrelated, started]; return { worker: started }; }
    });
    const panel = await renderPanel(testFixture);
    if (kind === "changes") await click(panel, "Pull requests");
    const action = kind === "issues" ? "Start work" : "Review";
    expect(button(panel, action).disabled).toBe(false);
    if (kind === "changes") expect(button(panel, "Review and post").disabled).toBe(false);
    await click(panel, action);
    expect(button(panel, action).disabled).toBe(true);
    if (kind === "changes") expect(button(panel, "Review and post").disabled).toBe(true);
    expect(panel.querySelector(".forge-item")?.textContent).toContain(`${kind === "issues" ? "Coding" : "Review"} · starting`);
    await click(panel, action);
    expect(testFixture.calls.filter(call => call.hook === startHook)).toHaveLength(1);
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it("shows completed review publication failures while excluding ordinary completion and retaining draft counts", async () => {
    const failedReview = { ...reviewWorker, id: "failed-review", error: "Posting outcome is uncertain.", draft: { ...reviewWorker.draft!, status: "post_failed" as const } };
    const postedReview = { ...reviewWorker, id: "posted-review", draft: { ...reviewWorker.draft!, status: "posted" as const } };
    const panel = await renderPanel(fixture({ workers: [{ ...worker, status: "completed", changeNumber: change.number }, reviewWorker, postedReview, failedReview] }));
    expect(panel.querySelectorAll(".forge-item-worker")).toHaveLength(0);
    await click(panel, "Pull requests");
    const row = panel.querySelector(".forge-item")!;
    expect(row.querySelectorAll(".forge-item-worker")).toHaveLength(1);
    expect(row.querySelector(".forge-item-worker")?.textContent).toContain("Review · post failed");
    expect(row.querySelector(".forge-item-worker-error")?.textContent).toBe("Posting outcome is uncertain.");
    expect(row.textContent).toContain("2 suggested comments · 2 review drafts");
    expect(row.textContent).not.toContain("completed");
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it("keeps Resume and the cleanup failure visible when review publication also failed", async () => {
    const panel = await renderPanel(fixture({ workers: [{ ...reviewWorker, status: "cleanup_failed", error: "Owned worktree cleanup failed.", draft: { ...reviewWorker.draft!, status: "post_failed" } }] }));
    await click(panel, "Pull requests");
    const row = panel.querySelector(".forge-item")!;
    expect(row.querySelector(".forge-item-worker .forge-status")?.textContent).toBe("Review · cleanup failed");
    expect(row.querySelector(".forge-item-worker-error")?.textContent).toBe("Owned worktree cleanup failed.");
    expect(button(panel.querySelector(".forge-detail")!, "Resume").disabled).toBe(false);
    expect(panel.textContent).toContain("Inspect the PR/MR for published comments");
  });

  it.each(["issues", "changes"] as const)("updates %s worker failures and removal through polling without changing selection or opening terminals", async kind => {
    vi.useFakeTimers();
    const first = kind === "issues" ? issue : change;
    const selected = { ...first, number: first.number + 1, title: "Selected item" };
    const liveWorker: ForgeWorker = { ...worker, id: "live-worker", kind: kind === "issues" ? "issue" : "review", number: selected.number, tabId: "live-terminal" };
    const liveTab = { ...workerTab, id: liveWorker.tabId!, pluginMetadata: { "forge-workers": { workerId: liveWorker.id } } };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [liveWorker] }, (hook, input) => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === `forge.${kind}.list`) return { items: [first, selected] };
      if (hook === (kind === "issues" ? "forge.issue.get" : "forge.change.get")) return { [kind === "issues" ? "issue" : "change"]: input.number === selected.number ? selected : first };
    });
    const panel = await renderPanel(testFixture, { workerTabs: [liveTab] });
    if (kind === "changes") await click(panel, "Pull requests");
    const row = panel.querySelectorAll<HTMLButtonElement>(".forge-item")[1];
    await act(async () => { row.querySelector<HTMLElement>(".forge-item-worker")!.click(); });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(panel.querySelector(".forge-detail-heading h3")?.textContent).toContain("Selected item");
    expect(panel.querySelector("dialog")).toBeNull();
    await click(panel.querySelector(".forge-detail")!, "View worker");
    expect(panel.querySelector('[data-terminal-tab="live-terminal"]')).not.toBeNull();
    await click(panel, "Close worker terminal");

    for (const status of ["failed", "completed", "removed"] as const) {
      testFixture.dashboard.workers = status === "removed" ? [] : [{ ...liveWorker, status, error: status === "failed" ? "Provider access denied." : undefined }];
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(row.getAttribute("aria-pressed")).toBe("true");
      expect(panel.querySelector(".forge-detail-heading h3")?.textContent).toContain("Selected item");
      expect(panel.querySelector("dialog")).toBeNull();
      expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
      if (status === "failed") {
        expect(row.textContent).toContain(`${kind === "issues" ? "Coding" : "Review"} · failed`);
        expect(row.querySelector(".forge-item-worker-error")?.textContent).toBe("Provider access denied.");
        expect(panel.querySelector('.forge-detail [role="alert"]')?.textContent).toBe("Provider access denied.");
      } else expect(row.querySelectorAll(".forge-item-worker")).toHaveLength(0);
    }
    expect(panel.querySelectorAll(".forge-detail .forge-worker")).toHaveLength(0);
    expect(testFixture.calls.every(call => call.hook === "forge.dashboard" || call.hook.endsWith(".list") || call.hook.endsWith(".get"))).toBe(true);
  });

  it("allows adding and removing comments and blocks incomplete inline locations", async () => {
    const panel = await renderPanel(fixture({ workers: [reviewWorker] }));
    await click(panel, "Pull requests");
    const editor = panel.querySelector(".forge-review")!;
    await click(editor, "Add comment");
    expect(button(editor, "Submit review").disabled).toBe(true);
    await fill(editor.querySelectorAll("textarea")[2], "Another concern.");
    await fill(editor.querySelector('[aria-label="Comment 2 file"]')!, "worker.ts");
    expect(button(editor, "Submit review").disabled).toBe(true);
    await fill(editor.querySelector('[aria-label="Comment 2 line"]')!, "2");
    expect(button(editor, "Submit review").disabled).toBe(false);
    await click(editor, "Remove comment 1");
    expect(editor.querySelectorAll("textarea")).toHaveLength(2);
    expect(editor.querySelectorAll("textarea")[1].value).toBe("Another concern.");
  });

  it.each(["failed", "paused", "stopped", "awaiting_review", "awaiting_merge"] as const)("syncs a published %s issue and starts a fresh review", async status => {
    const published = { ...worker, status, headSha: change.headSha, changeNumber: change.number };
    const testFixture = fixture({ workers: [published] });
    const panel = await renderPanel(testFixture);
    await click(panel, "Sync and re-review");
    expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker."))).toEqual([
      { hook: "forge.worker.syncAndReview", input: { id: worker.id, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id }
    ]);
  });

  it.each(["github", "gitlab"] as const)("shows the %s conflict blocker and recovery action in issues, requests, and worker tabs", async provider => {
    const displayed = { ...repository, provider };
    const panel = await renderPanel(fixture({ repository: displayed, workers: [{ ...conflictedWorker, repository: displayed }] }));
    for (const section of ["Issues", provider === "github" ? "Pull requests" : "Merge requests", "Workers (1)"]) {
      await click(panel, section);
      const card = panel.querySelector('[aria-label="issue worker #7"]')!;
      expect(card.textContent).toContain("Merge conflicts block this request. Rebase aaaaaaaa onto main (cccccccc) and resolve conflicts.");
      expect(button(card, "Rebase and resolve conflicts").disabled).toBe(false);
    }
  });

  it.each(["failed", "paused", "stopped", "awaiting_review", "awaiting_merge"] as const)("explicitly starts conflict recovery for an idle %s issue in the current pane", async status => {
    const testFixture = fixture({ workers: [{ ...conflictedWorker, status }] });
    const panel = await renderPanel(testFixture);
    await click(panel, "Rebase and resolve conflicts");
    expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker."))).toEqual([
      { hook: "forge.worker.rebaseAndResolve", input: { id: worker.id, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id }
    ]);
  });

  it.each(["paused", "stopped", "failed"] as const)("refreshes the conflict blocker and explicit recovery action while %s", async status => {
    vi.useFakeTimers();
    const idleWorker = { ...conflictedWorker, status, mergeConflict: undefined };
    const testFixture = fixture({ workers: [idleWorker] });
    const panel = await renderPanel(testFixture);
    expect(panel.textContent).not.toContain("Rebase and resolve conflicts");
    for (const hasConflicts of [true, false, true]) {
      testFixture.dashboard.workers = [{ ...idleWorker, mergeConflict: hasConflicts ? conflictedWorker.mergeConflict : undefined }];
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      const card = panel.querySelector('[aria-label="issue worker #7"]')!;
      expect(card.querySelector(".forge-status")?.textContent).toBe(status);
      if (hasConflicts) {
        expect(card.textContent).toContain("Merge conflicts block this request.");
        expect(button(card, "Rebase and resolve conflicts").disabled).toBe(false);
      } else {
        expect(card.textContent).not.toContain("Merge conflicts block this request.");
        expect(card.textContent).not.toContain("Rebase and resolve conflicts");
      }
      expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker."))).toEqual([]);
    }
    await click(panel, "Rebase and resolve conflicts");
    expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker."))).toEqual([
      { hook: "forge.worker.rebaseAndResolve", input: { id: worker.id, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id }
    ]);
  });

  it.each([
    { status: "starting" }, { status: "running" }, { status: "awaiting_publication" },
    { status: "completed" }, { status: "cleanup_failed" }, { kind: "review" },
    { changeNumber: undefined }, { headSha: undefined }, { headSha: "d".repeat(40) }, { mergeConflict: undefined },
    { branch: undefined }, { repositoryPath: undefined }, { worktreePath: undefined },
    { mergeAttempted: true }, { pendingPublication: publishingWorker.pendingPublication },
    { publicationState: "creating" }, { publicationState: "uncertain" },
    { rebaseRecovery: { ...rebaseRecovery, phase: "resolving" } },
    { rebaseRecovery: { ...rebaseRecovery, phase: "publishing" } },
    { rebaseRecovery: { ...rebaseRecovery, targetHeadSha: conflictedWorker.mergeConflict!.targetHeadSha } },
  ] satisfies Partial<ForgeWorker>[])("hides conflict recovery when the worker is unsafe or has no current conflict %#", async unavailable => {
    const panel = await renderPanel(fixture({ workers: [{ ...conflictedWorker, ...unavailable }] }));
    await click(panel, "Workers (1)");
    expect(Array.from(panel.querySelectorAll("button")).some(item => item.textContent?.trim() === "Rebase and resolve conflicts")).toBe(false);
  });

  it("discards a conflict blocker when the worker moves to another head", async () => {
    vi.useFakeTimers();
    const testFixture = fixture({ workers: [conflictedWorker] });
    const panel = await renderPanel(testFixture);
    expect(panel.textContent).toContain("Merge conflicts block this request.");
    testFixture.dashboard.workers = [{ ...conflictedWorker, headSha: "d".repeat(40) }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(panel.textContent).not.toContain("Merge conflicts block this request.");
    expect(panel.textContent).not.toContain("Rebase and resolve conflicts");
  });

  it.each([
    { status: "starting", draft: undefined }, { status: "running", draft: undefined },
    { status: "paused" }, { status: "stopped" }, { status: "failed" }, { status: "cleanup_failed" },
    { status: "awaiting_review" }, { status: "awaiting_merge" }, { status: "awaiting_publication" },
    { status: "completed", draft: { ...reviewWorker.draft!, status: "posting" } },
    { status: "completed", draft: { ...reviewWorker.draft!, status: "post_failed" } },
  ] satisfies Partial<ForgeWorker>[])("retains the conflict blocker but cannot start over an unfinished or uncertain reviewer %#", async reviewState => {
    const panel = await renderPanel(fixture({ workers: [conflictedWorker, { ...reviewWorker, issueWorkerId: worker.id, ...reviewState }] }));
    const card = panel.querySelector('[aria-label="issue worker #7"]')!;
    expect(card.textContent).toContain("Merge conflicts block this request.");
    expect(Array.from(card.querySelectorAll("button")).some(item => item.textContent?.trim() === "Rebase and resolve conflicts")).toBe(false);
  });

  it("allows a new conflict after completed recovery review and ignores other repositories' reviewers", async () => {
    const foreign = { ...reviewWorker, status: "running" as const, repository: { ...repository, projectPath: "another/repo" } };
    const panel = await renderPanel(fixture({ workers: [{ ...conflictedWorker, rebaseRecovery }, reviewWorker, foreign] }));
    await click(panel, "Workers (3)");
    expect(button(panel.querySelector('[aria-label="issue worker #7"]')!, "Rebase and resolve conflicts").disabled).toBe(false);
  });

  it("prevents duplicate recovery and review actions while rebase dispatch is pending", async () => {
    const pending = deferred<unknown>();
    const testFixture = fixture({ workers: [conflictedWorker, reviewWorker] }, hook => hook === "forge.worker.rebaseAndResolve" ? pending.promise : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    await act(async () => { button(panel, "Rebase and resolve conflicts").click(); button(panel, "Rebase and resolve conflicts").click(); });
    expect(button(panel, "Rebase and resolve conflicts").disabled).toBe(true);
    expect(button(panel, "Resume").disabled).toBe(true);
    expect(button(panel, "Sync and re-review").disabled).toBe(true);
    expect(button(panel, "Submit review").closest("fieldset")?.disabled).toBe(true);
    expect(button(panel, "Stop").disabled).toBe(false);
    await click(panel, "Rebase and resolve conflicts");
    await click(panel, "Submit review");
    testFixture.dashboard.workers = [{ ...conflictedWorker, status: "running", rebaseRecovery: { ...rebaseRecovery, phase: "resolving" } }, reviewWorker];
    await act(async () => { pending.resolve({ worker: testFixture.dashboard.workers[0] }); });
    const card = panel.querySelector('[aria-label="issue worker #7"]')!;
    expect(card.querySelector(".forge-status")?.textContent).toBe("running");
    expect(card.textContent).not.toContain("Rebase and resolve conflicts");
    expect(testFixture.calls.filter(call => call.hook === "forge.worker.rebaseAndResolve")).toHaveLength(1);
    expect(testFixture.calls.some(call => ["forge.review.save", "forge.review.submit"].includes(call.hook))).toBe(false);
  });

  it("surfaces recovery failures and requires another explicit action", async () => {
    vi.useFakeTimers();
    const testFixture = fixture({ workers: [conflictedWorker] }, hook => {
      if (hook === "forge.worker.rebaseAndResolve") throw new Error("The request branch changed. Sync and re-review before recovery.");
    });
    const panel = await renderPanel(testFixture);
    await click(panel, "Rebase and resolve conflicts");
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("The request branch changed.");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(testFixture.calls.filter(call => call.hook === "forge.worker.rebaseAndResolve")).toHaveLength(1);
    expect(button(panel, "Rebase and resolve conflicts").disabled).toBe(false);
  });

  it.each([
    { status: "starting" }, { status: "running" }, { status: "awaiting_publication" },
    { status: "completed" }, { status: "cleanup_failed" }, { kind: "review" },
    { changeNumber: undefined }, { headSha: undefined }, { mergeAttempted: true },
    { pendingPublication: publishingWorker.pendingPublication },
  ] satisfies Partial<ForgeWorker>[])("hides branch sync when the issue is not ready for a fresh review %#", async unavailable => {
    const published: ForgeWorker = { ...worker, status: "failed", headSha: change.headSha, changeNumber: change.number, ...unavailable };
    const panel = await renderPanel(fixture({ workers: [published] }));
    await click(panel, "Workers (1)");
    expect(Array.from(panel.querySelectorAll("button")).some(item => item.textContent?.trim() === "Sync and re-review")).toBe(false);
  });

  it.each([
    { status: "starting", draft: undefined }, { status: "running", draft: undefined },
    { status: "completed", draft: { ...reviewWorker.draft!, status: "posting" } },
    { status: "completed", draft: { ...reviewWorker.draft!, status: "post_failed" } },
  ] satisfies Partial<ForgeWorker>[])("does not sync over an active or uncertain review %#", async reviewState => {
    const published: ForgeWorker = { ...worker, status: "awaiting_review", headSha: change.headSha, changeNumber: change.number };
    const child: ForgeWorker = { ...reviewWorker, issueWorkerId: worker.id, ...reviewState };
    const panel = await renderPanel(fixture({ workers: [published, child] }));
    const card = panel.querySelector('[aria-label="issue worker #7"]')!;
    expect(Array.from(card.querySelectorAll("button")).some(item => item.textContent?.trim() === "Sync and re-review")).toBe(false);
  });

  it("keeps recovery local to the displayed repository", async () => {
    const published: ForgeWorker = { ...worker, status: "failed", headSha: change.headSha, changeNumber: change.number };
    const foreign = { ...reviewWorker, status: "running" as const, repository: { ...repository, projectPath: "another/repo" } };
    const panel = await renderPanel(fixture({ workers: [published, foreign] }));
    await click(panel, "Workers (2)");
    expect(button(panel.querySelector('[aria-label="issue worker #7"]')!, "Sync and re-review").disabled).toBe(false);
  });

  it.each(["awaiting_review", "awaiting_merge"] as const)("exposes Resume for an idle automatic loop in %s", async status => {
    const published: ForgeWorker = { ...worker, status, changeNumber: change.number, headSha: change.headSha, autoReview: { enabled: true, phase: status === "awaiting_merge" ? "merging" : "reviewing", placement: { windowId: "old-window", paneId: "old-pane" } } };
    const testFixture = fixture({ workers: [published] });
    const panel = await renderPanel(testFixture);
    await click(panel, "Resume");
    expect(testFixture.calls).toContainEqual({ hook: "forge.worker.resume", input: { id: worker.id, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id });
  });

  it("offers publication retry for a workflow permission rejection before a request exists", async () => {
    const permissionError = "GitHub rejected workflow changes. Grant the worker App Workflows: write permission and approve it for this installation, then retry publishing.";
    const failed: ForgeWorker = { ...worker, status: "failed", tabId: undefined, error: permissionError,
      pendingPublication: { report: publishingWorker.pendingPublication!.report, repliedDiscussionIds: [] } };
    const testFixture = fixture({ workers: [failed] });
    const panel = await renderPanel(testFixture);
    const card = panel.querySelector(".forge-worker")!;
    expect(card.querySelector('[role="alert"]')?.textContent).toBe(permissionError);
    expect(card.textContent).not.toContain("The commit was pushed");
    expect(card.querySelector('a[href*="/pull/"]')).toBeNull();
    expect(button(card, "Retry publication").disabled).toBe(false);

    await click(card, "Retry publication");
    expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker.") || call.hook === "forge.issue.start")).toEqual([
      { hook: "forge.worker.resume", input: { id: worker.id, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id },
    ]);
  });

  it("shows the scheduled provider retry and a manual publication action", async () => {
    vi.useFakeTimers();
    const providerRetryAt = "2026-09-10T18:00:00.000Z";
    const waiting: ForgeWorker = { ...worker, status: "paused", providerRetryAt, error: "Provider rate limit reached.",
      pendingPublication: { report: publishingWorker.pendingPublication!.report, repliedDiscussionIds: [] },
      autoReview: { enabled: true, phase: "implementing", placement: { windowId: "window-1", paneId: "pane-2" } } };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [waiting] }, hook => hook === "forge.dashboard" ? structuredClone(testFixture.dashboard) : undefined);
    const panel = await renderPanel(testFixture);
    const card = panel.querySelector(".forge-worker")!;
    expect(card.querySelector("time")?.dateTime).toBe(providerRetryAt);
    expect(card.querySelector("time")?.textContent).toBe(new Date(providerRetryAt).toLocaleString());
    expect(card.textContent).toContain("Worker will retry automatically at");
    expect(card.textContent).toContain("Provider rate limit reached.");
    expect(card.textContent).not.toContain("The commit was pushed");
    await click(card, "Retry publication");
    expect(testFixture.calls).toContainEqual({ hook: "forge.worker.resume", input: { id: worker.id, windowId: "window-1", paneId: "pane-2" }, tabId: tab.id });
    testFixture.dashboard.workers = [{ ...publishingWorker, status: "awaiting_review", pendingPublication: undefined }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(panel.querySelector(".forge-worker time")).toBeNull();
    expect(panel.querySelector(".forge-worker [role=alert]")).toBeNull();
    expect(panel.textContent).not.toContain("Worker will retry automatically at");
    expect(button(panel, "Resume").disabled).toBe(false);
  });

  it("locks recovery and the obsolete review while sync is pending, then shows the fresh review", async () => {
    const pending = deferred<unknown>();
    const published: ForgeWorker = { ...worker, status: "failed", changeNumber: change.number, headSha: change.headSha, error: "The request head changed outside this worker.", autoReview: { enabled: true, phase: "reviewing", reviewWorkerId: reviewWorker.id, placement: { windowId: "window-1", paneId: "pane-2" } } };
    const oldReview = { ...reviewWorker, issueWorkerId: worker.id };
    const newHead = "c".repeat(40);
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [published, oldReview] }, hook => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === "forge.change.get") return { change: { ...change, headSha: newHead } };
      if (hook === "forge.worker.syncAndReview") return pending.promise;
    });
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    expect(button(panel, "Submit review").disabled).toBe(true);
    await click(panel, "Sync and re-review");
    expect(button(panel, "Sync and re-review").disabled).toBe(true);
    expect(button(panel, "Resume").disabled).toBe(true);
    expect(button(panel, "Submit review").closest("fieldset")?.disabled).toBe(true);
    await click(panel, "Sync and re-review");
    await click(panel, "Submit review");
    const freshReview: ForgeWorker = { ...oldReview, status: "running", draft: undefined, headSha: newHead };
    testFixture.dashboard.workers = [{ ...published, status: "awaiting_review", headSha: newHead, error: undefined }, freshReview];
    await act(async () => { pending.resolve({ worker: testFixture.dashboard.workers[0] }); });
    expect(panel.textContent).not.toContain("The request head changed outside this worker.");
    expect(panel.textContent).not.toContain("Add a timeout.");
    expect(panel.querySelector('[aria-label="review worker #12"] .forge-status')?.textContent).toBe("running");
    expect(testFixture.calls.filter(call => call.hook === "forge.worker.syncAndReview")).toHaveLength(1);
    expect(testFixture.calls.some(call => ["forge.review.save", "forge.review.submit"].includes(call.hook))).toBe(false);
  });

  it.each([
    { status: "running" as const, kind: "issue" as const, action: "Pause", hook: "forge.worker.pause" },
    { status: "paused" as const, kind: "review" as const, action: "Resume", hook: "forge.worker.resume" },
    { status: "awaiting_review" as const, kind: "issue" as const, action: "Resume", hook: "forge.worker.resume" },
    { status: "running" as const, kind: "review" as const, action: "Stop", hook: "forge.worker.stop" },
    { status: "cleanup_failed" as const, kind: "issue" as const, action: "Resume", hook: "forge.worker.resume" },
    { status: "cleanup_failed" as const, kind: "review" as const, action: "Resume", hook: "forge.worker.resume" }
  ])("$action dispatches the $kind worker's $status lifecycle command", async ({ status, kind, action, hook }) => {
    const testFixture = fixture({ workers: [{ ...worker, kind, status }] });
    const panel = await renderPanel(testFixture);
    const workersTab = Array.from(panel.querySelectorAll<HTMLButtonElement>(".forge-tabs button")).find((item) => item.textContent?.startsWith("Workers"))!;
    await act(async () => { workersTab.click(); });
    await click(panel, action);
    expect(testFixture.calls).toContainEqual({ hook, input: hook === "forge.worker.resume" ? { id: worker.id, windowId: "window-1", paneId: "pane-2" } : { id: worker.id }, tabId: "forge-tab" });
  });

  it("keeps Stop available while the worker start request is pending", async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown>();
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({}, hook => hook === "forge.issue.start" ? pending.promise : hook === "forge.dashboard" ? structuredClone(testFixture.dashboard) : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, "Start work");
    testFixture.dashboard.workers = [{ ...worker, status: "starting" }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await click(panel, "Workers (1)");
    expect(button(panel, "Stop").disabled).toBe(false);
    await click(panel, "Stop");
    expect(testFixture.calls).toContainEqual({ hook: "forge.worker.stop", input: { id: worker.id }, tabId: "forge-tab" });
    await act(async () => { pending.resolve({ worker: { ...worker, status: "stopped" } }); });
  });

  it("opens, closes, and reopens the same worker above Issues without a lifecycle action", async () => {
    const testFixture = fixture({ workers: [worker] });
    const panel = await renderPanel(testFixture, { workerTabs: [workerTab], uiScale: 125 });
    const callsBeforeOpening = [...testFixture.calls];
    await click(panel, "View worker");
    expect(panel.querySelector("dialog")?.open).toBe(true);
    expect(panel.querySelector("dialog h2")?.textContent).toBe("Issue #7 · Fix deployment");
    expect(button(panel, "Issues").getAttribute("aria-pressed")).toBe("true");
    expect(panel.textContent).toContain(issue.body);
    expect(panel.querySelector('[role="tablist"][aria-label="Worker tabs"]')).toBeNull();
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')?.getAttribute("data-scale")).toBe("125");
    await click(panel, "Close worker terminal");
    expect(panel.querySelector("dialog")).toBeNull();
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    await click(panel, "View worker");
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')).not.toBeNull();
    expect(testFixture.calls).toEqual(callsBeforeOpening);
  });

  it("keeps terminal Escape and Tab input intact, and dismisses Escape from an overlay control", async () => {
    const panel = await renderPanel(fixture({ workers: [worker] }), { workerTabs: [workerTab] });
    await click(panel, "View worker");
    const dialog = panel.querySelector("dialog")!;
    const input = dialog.querySelector<HTMLTextAreaElement>('[aria-label="Terminal input"]')!;
    input.focus();
    for (const key of ["Escape", "Tab"]) {
      const keydown = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => { input.dispatchEvent(keydown); });
      expect(keydown.defaultPrevented).toBe(false);
    }
    const terminalCancel = new Event("cancel", { cancelable: true });
    await act(async () => { dialog.dispatchEvent(terminalCancel); });
    expect(terminalCancel.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    button(dialog, "Close worker terminal").focus();
    const controlCancel = new Event("cancel", { cancelable: true });
    await act(async () => {
      dialog.dispatchEvent(controlCancel);
      if (!controlCancel.defaultPrevented) dialog.close();
    });
    expect(controlCancel.defaultPrevented).toBe(false);
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it("keeps the dialog open after StrictMode repeats its native setup and cleanup", async () => {
    const testFixture = fixture({ workers: [worker] });
    const panel = document.createElement("div");
    document.body.append(panel);
    const root = createRoot(panel);
    roots.push(root);
    await act(async () => root.render(createElement(StrictMode, {}, createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [workerTab], active: true, uiScale: 100, repositorySettingsKey: "repository:0", repositoryChangePending: false }))));
    await click(panel, "View worker");
    expect(panel.querySelector("dialog")?.open).toBe(true);
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')).not.toBeNull();
    await click(panel, "Close worker terminal");
    expect(panel.querySelector("dialog")).toBeNull();
  });

  it.each([
    { ...workerTab, id: "another-terminal" },
    { ...workerTab, ownerPluginId: undefined },
    { ...workerTab, pluginId: "standard-terminal" },
    { ...workerTab, pluginMetadata: { "forge-workers": { workerId: "another-worker" } } }
  ])("does not attach a terminal without the worker's complete ownership match", async candidate => {
    const panel = await renderPanel(fixture({ workers: [worker] }), { workerTabs: [candidate] });
    await click(panel, "View worker");
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    expect(panel.textContent).toContain("The worker terminal is unavailable.");
  });

  it.each([
    { status: "starting" as const, message: "Preparing the worker terminal…" },
    { status: "completed" as const, message: "No worker terminal is open." }
  ])("shows $status terminal availability without launching work", async ({ status, message }) => {
    const testFixture = fixture({ workers: [{ ...worker, status, tabId: undefined }] });
    const panel = await renderPanel(testFixture, { workerTabs: [workerTab] });
    await click(panel, "View worker");
    expect(panel.querySelector("dialog")?.textContent).toContain(message);
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    expect(testFixture.calls.every(call => !call.hook.startsWith("forge.worker."))).toBe(true);
  });

  it("shows paused worker output only while its Forge pane is active", async () => {
    const testFixture = fixture({ workers: [{ ...worker, status: "paused" }] });
    const panel = await renderPanel(testFixture, { workerTabs: [workerTab], active: false });
    await click(panel, "View worker");
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    expect(panel.querySelector("dialog")).toBeNull();
    await act(async () => roots.at(-1)!.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [workerTab], active: true, uiScale: 100, repositorySettingsKey: "repository:0", repositoryChangePending: false })));
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')?.getAttribute("data-active")).toBe("true");
    expect(button(panel, "Resume")).toBeDefined();
    await act(async () => roots.at(-1)!.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [workerTab], active: false, uiScale: 100, repositorySettingsKey: "repository:0", repositoryChangePending: false })));
    expect(panel.querySelector("dialog")).toBeNull();
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
  });

  it("selects workers without opening a terminal and retains review edits", async () => {
    const testFixture = fixture({ workers: [worker, reviewWorker] });
    const panel = await renderPanel(testFixture, { workerTabs: [workerTab] });
    await click(panel, "Workers (2)");
    expect(panel.querySelector("dialog")).toBeNull();
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    const tabs = panel.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[0].focus();
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    await act(async () => tabs[1].click());
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(panel.querySelector("dialog")).toBeNull();
    const editor = panel.querySelector<HTMLTextAreaElement>('[role="tabpanel"]:not([hidden]) .forge-review textarea')!;
    await fill(editor, "Retain my edits while I inspect issue work.");
    await act(async () => tabs[0].click());
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(panel.querySelector("dialog")).toBeNull();
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    await click(panel.querySelector('[role="tabpanel"]:not([hidden])')!, "View worker");
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')).not.toBeNull();
    await click(panel, "Close worker terminal");
    await act(async () => tabs[0].click());
    expect(panel.querySelector("dialog")).toBeNull();
    await act(async () => tabs[1].click());
    expect(panel.querySelector("dialog")).toBeNull();
    expect(editor.value).toBe("Retain my edits while I inspect issue work.");
    await click(panel.querySelector('[role="tabpanel"]:not([hidden])')!, "View worker");
    expect(panel.querySelector("dialog h2")?.textContent).toContain("Review #12");
    await click(panel, "Close worker terminal");
    await act(async () => tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(tabs[0]);
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(tabs[1]);
    expect(panel.querySelector("dialog")).toBeNull();
    expect(testFixture.calls.every(call => !call.hook.startsWith("forge.worker."))).toBe(true);
  });

  it("keeps the selected worker through Resume replacing its terminal and cleanup removing it", async () => {
    vi.useFakeTimers();
    const second = { ...worker, id: "work-2", number: 8, title: "Fix uploads", tabId: "second-terminal", status: "paused" as const };
    const secondTab = { ...workerTab, id: second.tabId, pluginMetadata: { "forge-workers": { workerId: second.id } } };
    let testFixture: ReturnType<typeof fixture>;
    testFixture = fixture({ workers: [worker, second] }, hook => {
      if (hook === "forge.dashboard") return structuredClone(testFixture.dashboard);
      if (hook === "forge.worker.resume") {
        testFixture.dashboard.workers[1] = { ...second, status: "running", tabId: "resumed-terminal" };
        return { worker: testFixture.dashboard.workers[1] };
      }
    });
    const panel = await renderPanel(testFixture, { workerTabs: [workerTab, secondTab] });
    await click(panel, "Workers (2)");
    await act(async () => panel.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click());
    expect(panel.querySelector("dialog")).toBeNull();
    await click(panel.querySelector('[role="tabpanel"]:not([hidden])')!, "View worker");
    expect(panel.querySelector('[data-terminal-tab="second-terminal"]')).not.toBeNull();
    await click(panel, "Close worker terminal");
    await click(panel.querySelector('[role="tabpanel"]:not([hidden])')!, "Resume");
    expect(panel.querySelector("dialog")).toBeNull();
    await click(panel.querySelector('[role="tabpanel"]:not([hidden])')!, "View worker");
    expect(panel.querySelector("dialog")?.textContent).toContain("The worker terminal is unavailable.");
    await act(async () => roots.at(-1)!.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [workerTab, { ...secondTab, id: "resumed-terminal" }], active: true, uiScale: 100, repositorySettingsKey: "repository:0", repositoryChangePending: false })));
    expect(panel.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Issue #8");
    expect(panel.querySelector('[data-terminal-tab="resumed-terminal"]')).not.toBeNull();
    expect(panel.querySelector('[data-terminal-tab="second-terminal"]')).toBeNull();
    testFixture.dashboard.workers[1] = { ...second, status: "completed", tabId: undefined };
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    expect(panel.querySelector("dialog")?.textContent).toContain("No worker terminal is open.");
    testFixture.dashboard.workers = [worker];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(panel.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Issue #7");
    expect(panel.querySelector("dialog")).toBeNull();
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    expect(testFixture.calls.filter(call => call.hook.startsWith("forge.worker."))).toEqual([{ hook: "forge.worker.resume", input: { id: second.id, windowId: "window-1", paneId: "pane-2" }, tabId: "forge-tab" }]);
  });

  it("preserves the current pull request and its unsaved review while viewing its worker", async () => {
    const panel = await renderPanel(fixture({ workers: [reviewWorker] }));
    await click(panel, "Pull requests");
    const editor = panel.querySelector<HTMLTextAreaElement>(".forge-review textarea")!;
    await fill(editor, "My unsaved review.");
    await click(panel, "View worker");
    expect(panel.querySelector("dialog h2")?.textContent).toContain("Review #12");
    expect(button(panel, "Pull requests").getAttribute("aria-pressed")).toBe("true");
    await click(panel, "Close worker terminal");
    expect(panel.querySelector(".forge-review textarea")).toBe(editor);
    expect(editor.value).toBe("My unsaved review.");
  });

  it("surfaces action failures without automatically repeating publication", async () => {
    const pending = deferred<unknown>();
    const testFixture = fixture({ workers: [reviewWorker] }, (hook) => hook === "forge.review.submit" ? pending.promise : undefined);
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    await click(panel, "Submit review");
    expect(panel.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
    await act(async () => { pending.reject(new Error("Publication failed. Inspect the provider before submitting again.")); });
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Publication failed.");
    expect(panel.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(false);
    expect(testFixture.calls.filter((call) => call.hook === "forge.review.submit")).toHaveLength(1);
  });

  it("shows dashboard and detail errors with an explicit refresh action", async () => {
    let failing = true;
    const testFixture = fixture({}, (hook) => {
      if (hook === "forge.dashboard" && failing) throw new Error("Forge storage unavailable.");
      if (hook === "forge.issue.get") throw new Error("Issue access denied.");
    });
    const panel = await renderPanel(testFixture);
    expect(panel.textContent).toContain("Forge storage unavailable.");
    failing = false;
    await click(panel, "Refresh Forge");
    expect(panel.textContent).toContain("Issue access denied.");
    expect(panel.textContent).not.toContain("Forge storage unavailable.");
  });
});

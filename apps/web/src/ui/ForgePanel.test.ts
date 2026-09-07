// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeDashboard, ForgeIssueDetail, ForgeWorker, WorkspaceTab } from "@cloudx/shared";
import { ForgePanel } from "./ForgePanel.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

vi.mock("./TerminalPanel.js", () => ({
  TerminalPanel: ({ tab, active, uiScale }: { tab: WorkspaceTab; active: boolean; uiScale: number }) => createElement("div", { "data-terminal-tab": tab.id, "data-active": String(active), "data-scale": uiScale })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach((root) => root.unmount()); });
  vi.useRealTimers();
  document.body.replaceChildren();
});

const repository = { provider: "github" as const, apiUrl: "https://api.github.com", projectPath: "cloudx/example" };
const issue: ForgeIssueDetail = { number: 7, title: "Fix deployment", body: "The deployment fails.", url: "https://github.com/cloudx/example/issues/7", state: "open", author: "ari", labels: ["bug"], updatedAt: "2026-09-07", comments: [{ id: "note-1", author: "nia", body: "Reproduced in staging." }] };
const change: ForgeChangeRequest = { ...issue, number: 12, title: "Repair deployment", url: "https://github.com/cloudx/example/pull/12", draft: false, headSha: "abcdef", headBranch: "fix/deploy", baseBranch: "main", merged: false, mergeable: true, approved: false, unresolvedDiscussions: 1, diff: "", comments: [{ id: "note-2", author: "nia", body: "Needs a timeout.", path: "deploy.ts", line: 8, resolved: false }] };
const worker: ForgeWorker = { id: "work-1", kind: "issue", number: 7, title: issue.title, repository, repositoryPath: "/repo", baseBranch: "main", templateId: "worker-template", status: "running", tabId: "codex-worker", autoPost: false, startedAt: "2026-09-07", updatedAt: "2026-09-07" };
const reviewWorker: ForgeWorker = { ...worker, id: "review-1", kind: "review", number: 12, title: change.title, status: "completed", draft: { headSha: "abcdef", body: "Add a timeout.", event: "request_changes", comments: [{ path: "deploy.ts", line: 8, side: "RIGHT", body: "This can wait forever." }], status: "draft" } };
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
      "forge.worker.resume": { worker }
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
  await act(async () => { root.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [], active: true, uiScale: 100, ...extra })); });
  return container;
}

function button(container: Element, text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === text || element.getAttribute("aria-label") === text);
  if (!result) throw new Error(`Button not found: ${text}`);
  return result;
}

async function click(container: Element, text: string) { await act(async () => { button(container, text).click(); }); }
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
    expect(testFixture.calls).toContainEqual({ hook: "forge.issue.start", input: { number: 7, windowId: "window-1", paneId: "pane-2" }, tabId: "forge-tab" });
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
    expect(testFixture.calls).toContainEqual({ hook: "forge.issues.list", input: { filter, page: 2, perPage: 25 }, tabId: "forge-tab" });
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

  it("distinguishes review, automatic posting, approval, and requested changes", async () => {
    const testFixture = fixture();
    const panel = await renderPanel(testFixture);
    await click(panel, "Pull requests");
    expect(panel.textContent).toContain("Needs a timeout.");
    await click(panel, "Review");
    await click(panel, "Review and post");
    await click(panel, "Mark as approved");
    expect(button(panel, "Mark as request changes").disabled).toBe(true);
    await fill(panel.querySelector(".forge-detail > .forge-field textarea")!, "Please add a timeout.");
    await click(panel, "Mark as request changes");
    expect(testFixture.calls.filter((call) => call.hook === "forge.review.start").map((call) => call.input)).toEqual([
      { number: 12, autoPost: false, windowId: "window-1", paneId: "pane-2" },
      { number: 12, autoPost: true, windowId: "window-1", paneId: "pane-2" }
    ]);
    expect(testFixture.calls.filter((call) => call.hook === "forge.change.review").map((call) => call.input)).toEqual([
      { number: 12, event: "approve", body: "" },
      { number: 12, event: "request_changes", body: "Please add a timeout." }
    ]);
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
    expect(publication[1].input).toEqual({ id: "review-1", event: "request_changes", body: "Use a bounded timeout.", comments: [{ path: "deploy.ts", line: 11, side: "LEFT", body: "Cancel after 30 seconds." }] });
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

  it.each([
    { status: "running" as const, kind: "issue" as const, action: "Pause", hook: "forge.worker.pause" },
    { status: "paused" as const, kind: "review" as const, action: "Resume", hook: "forge.worker.resume" },
    { status: "awaiting_review" as const, kind: "issue" as const, action: "Resume", hook: "forge.worker.resume" },
    { status: "running" as const, kind: "review" as const, action: "Stop", hook: "forge.worker.stop" },
    { status: "cleanup_failed" as const, kind: "issue" as const, action: "Resume", hook: "forge.worker.resume" },
    { status: "cleanup_failed" as const, kind: "review" as const, action: "Clean up", hook: "forge.worker.resume" }
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

  it("opens the worker terminal inside Forge without a workspace navigation action", async () => {
    const testFixture = fixture({ workers: [worker] });
    const panel = await renderPanel(testFixture, { workerTabs: [workerTab], uiScale: 125 });
    await click(panel, "View worker");
    expect(panel.querySelector('[role="tablist"][aria-label="Worker tabs"]')).not.toBeNull();
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')?.getAttribute("data-scale")).toBe("125");
    expect(panel.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Issue #7");
    expect(testFixture.calls.every(call => !call.hook.startsWith("forge.worker."))).toBe(true);
    expect(panel.textContent).not.toContain("Open Codex tab");
  });

  it.each([
    { ...workerTab, ownerPluginId: undefined },
    { ...workerTab, pluginId: "standard-terminal" },
    { ...workerTab, pluginMetadata: { "forge-workers": { workerId: "another-worker" } } }
  ])("does not attach a terminal without the worker's complete ownership match", async candidate => {
    const panel = await renderPanel(fixture({ workers: [worker] }), { workerTabs: [candidate] });
    await click(panel, "View worker");
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    expect(panel.textContent).toContain("The worker terminal is unavailable.");
  });

  it("keeps paused worker output available and only attaches it in the focused Forge pane", async () => {
    const testFixture = fixture({ workers: [{ ...worker, status: "paused" }] });
    const panel = await renderPanel(testFixture, { workerTabs: [workerTab], active: false });
    await click(panel, "View worker");
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    expect(panel.textContent).toContain("Select this pane to view the worker terminal.");
    await act(async () => roots.at(-1)!.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [workerTab], active: true, uiScale: 100 })));
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')?.getAttribute("data-active")).toBe("true");
    expect(button(panel, "Resume")).toBeDefined();
  });

  it("selects internal workers with keyboard navigation and retains review edits", async () => {
    const panel = await renderPanel(fixture({ workers: [worker, reviewWorker] }), { workerTabs: [workerTab] });
    await click(panel, "Workers (2)");
    const tabs = panel.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[0].focus();
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    await act(async () => tabs[1].click());
    const editor = panel.querySelector<HTMLTextAreaElement>('[role="tabpanel"]:not([hidden]) .forge-review textarea')!;
    await fill(editor, "Retain my edits while I inspect issue work.");
    await act(async () => tabs[0].click());
    await act(async () => tabs[1].click());
    expect(editor.value).toBe("Retain my edits while I inspect issue work.");
    await act(async () => tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(tabs[0]);
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("keeps the selected worker through Resume replacing its terminal and cleanup removing it", async () => {
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
    await click(panel.querySelector('[role="tabpanel"]:not([hidden])')!, "Resume");
    await act(async () => roots.at(-1)!.render(createElement(ForgePanel, { callHook: testFixture.callHook, tab, windowId: "window-1", paneId: "pane-2", workerTabs: [workerTab, { ...secondTab, id: "resumed-terminal" }], active: true, uiScale: 100 })));
    expect(panel.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Issue #8");
    expect(panel.querySelector('[data-terminal-tab="resumed-terminal"]')).not.toBeNull();
    expect(panel.querySelector('[data-terminal-tab="second-terminal"]')).toBeNull();
    testFixture.dashboard.workers[1] = { ...second, status: "completed", tabId: undefined };
    await click(panel, "Refresh Forge");
    expect(panel.querySelector("[data-terminal-tab]")).toBeNull();
    expect(panel.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain("No worker terminal is open.");
    testFixture.dashboard.workers = [worker];
    await click(panel, "Refresh Forge");
    expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(panel.querySelector('[data-terminal-tab="codex-worker"]')).not.toBeNull();
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

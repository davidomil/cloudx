// @vitest-environment jsdom
import { act, createElement } from "react";
import { pathToFileURL } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexNativeWork, WorkspaceTab } from "@cloudx/shared";

import { CodexNativeWorkPanel } from "./CodexNativeWorkPanel.js";

const { CodexNativeWorkObservation } = await import(pathToFileURL(`${process.cwd()}/apps/server/helpers/codex-native-work.mjs`).href);

const nativeWork: CodexNativeWork = {
  version: 1, tabId: "affected", executionId: "affected-execution", threadId: "exact-conversation",
  updatedAt: "2026-10-12T20:28:20Z", turnId: "failed-turn", turnStatus: "failed", goalStatus: "blocked",
  lastError: { kind: "terminal", message: "Provider stream processing failed after retries.", requestId: "request-after-http-200", httpStatusCode: 200, code: "stream_error" }
};
const tab: WorkspaceTab = {
  id: nativeWork.tabId, pluginId: "codex-terminal", title: "Affected Codex", cwd: "/work/project", status: "running",
  indicator: { color: "green", label: "Running", updatedAt: nativeWork.updatedAt },
  createdAt: nativeWork.updatedAt, updatedAt: nativeWork.updatedAt, nativeWork
};
let root: Root;
let host: HTMLDivElement;
const recover = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  recover.mockReset().mockResolvedValue(undefined);
  sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Codex native work recovery", () => {
  it("shows a native stream failure and blocked goal separately from an HTTP 200 transport response", async () => {
    await show(tab);
    expect(host.textContent).toContain("Goal blocked");
    expect(host.textContent).toContain("Native turn: Failed");
    expect(host.textContent).toContain("Terminal process: Running");
    expect(host.textContent).toContain(nativeWork.lastError!.message);
    expect(host.textContent).toContain("request-after-http-200");
    expect(host.textContent).toContain("HTTP status: 200");
    expect(host.textContent).toContain("stream_error");
    expect(host.textContent).toContain("does not establish native completion");
    expect(host.textContent).not.toContain("Recovery succeeded");
    expect(recover).not.toHaveBeenCalled();
  });

  it("distinguishes a retry notice while a healthy native turn is still running", async () => {
    await show(withWork({ turnStatus: "running", goalStatus: "active", lastError: { kind: "retry", message: "Retrying high demand.", requestId: "retry-request" } }));
    expect(host.textContent).toContain("Provider retry notice");
    expect(host.textContent).not.toContain("Native turn failed");
    expect(restartButton()).toBeUndefined();
  });

  it("describes a running turn and blocked goal independently and hides details without recovery", async () => {
    const current = withWork({ turnStatus: "running" });
    const savedWork = JSON.stringify(current.nativeWork);
    await show(current);
    expect(host.querySelector("h2")?.textContent).toBe("Native turn running · Goal blocked");
    expect(host.textContent).not.toContain("native work stopped");
    expect(host.textContent).toContain("After the running turn finishes, enter /goal resume");
    expect(restartButton().disabled).toBe(true);
    await toggleDetails();
    expect(details().hidden).toBe(true);
    expect(presentationButton().getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".codex-native-status")?.textContent).toContain("Native turn: Running · Goal: Blocked");
    expect(JSON.stringify(current.nativeWork)).toBe(savedWork);
    expect(recover).not.toHaveBeenCalled();
    await toggleDetails();
    expect(details().hidden).toBe(false);
    expect(restartButton().disabled).toBe(true);
  });

  it("retains collapsed details across status refreshes, remounts and selection changes", async () => {
    await show(tab);
    await toggleDetails();
    await show(withWork({ updatedAt: "2026-10-15T23:00:00Z" }));
    expect(details().hidden).toBe(true);
    const sibling = { ...tab, id: "sibling", nativeWork: { ...nativeWork, tabId: "sibling" } };
    await show(sibling);
    expect(details().hidden).toBe(false);
    await show(tab);
    expect(details().hidden).toBe(true);
    await act(async () => root.render(createElement("div")));
    await show(tab);
    expect(details().hidden).toBe(true);
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([
    { executionId: "new-execution" },
    { threadId: "new-conversation" },
    { turnId: "next-failed-turn" },
    { lastError: { kind: "terminal" as const, message: "A new failure", requestId: "new-request" } },
    { recoveryStatus: "failed" as const }
  ])("opens details for a new binding or failure: %j", async change => {
    await show(tab);
    await toggleDetails();
    await show(withWork(change));
    expect(details().hidden).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it("keeps a dismissed failure compact while ordinary turns continue and reopens only for a new failure", async () => {
    await show(tab);
    await toggleDetails();
    await show(withWork({ turnStatus: "running", turnId: "ordinary-turn" }));
    expect(details().hidden).toBe(true);
    await show(withWork({ turnStatus: "completed", turnId: "ordinary-turn" }));
    expect(details().hidden).toBe(true);
    await show(withWork({ turnStatus: "failed", turnId: "next-failed-turn" }));
    expect(details().hidden).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it("keeps terminal presentation usable when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    await show(tab);
    await toggleDetails();
    expect(details().hidden).toBe(true);
    await toggleDetails();
    expect(details().hidden).toBe(false);
    expect(recover).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("shows successful recovery accurately after details were collapsed", async () => {
    await show(tab);
    await toggleDetails();
    await show(withWork({ turnStatus: "completed", goalStatus: "active", recoveryStatus: "succeeded" }));
    expect(host.querySelector("h2")?.textContent).toBe("Codex native work");
    expect(details().hidden).toBe(true);
    await toggleDetails();
    expect(host.textContent).toContain("Recovery succeeded: a subsequent native turn completed");
    expect(restartButton()).toBeUndefined();
    expect(recover).not.toHaveBeenCalled();
  });

  it("requests a restart only for the displayed execution and exact conversation, without claiming success", async () => {
    await show(tab);
    await act(async () => restartButton().click());
    expect(recover).toHaveBeenCalledExactlyOnceWith({ action: "restart-native", executionId: "affected-execution", sessionId: "exact-conversation" });
    expect(host.textContent).toContain("/goal resume");
    expect(host.textContent).toContain("objective, budget and token/time accounting");
    expect(host.textContent).toContain("not a proven fix for provider failures");
    expect(host.textContent).not.toContain("Recovery succeeded");
    expect(restartButton()).toBeUndefined();
  });

  it.each(["awaiting_goal_resume", "awaiting_turn", "running"] as const)("keeps %s recovery pending until a native turn completes", async recoveryStatus => {
    await show(withWork({ recoveryStatus }));
    expect(host.textContent).toContain(recoveryStatus === "awaiting_goal_resume" ? "Waiting for explicit goal resume" : recoveryStatus === "awaiting_turn" ? "Waiting for a native turn" : "Waiting for native completion");
    expect(host.textContent).not.toContain("Recovery succeeded");
    expect(restartButton()).toBeUndefined();
  });

  it("reports observed recovery success only from the native recovery outcome", async () => {
    await show(withWork({ recoveryStatus: "succeeded", turnStatus: "completed", goalStatus: "active" }));
    expect(host.textContent).toContain("Recovery succeeded: a subsequent native turn completed");
    expect(restartButton()).toBeUndefined();
  });

  it("asks for the next native turn when no blocked goal is observed", async () => {
    await show(withWork({ recoveryStatus: "awaiting_turn", goalStatus: undefined }));
    expect(host.textContent).toContain("Send your next message in this terminal");
    expect(host.textContent).not.toContain("/goal resume");
    expect(host.textContent).not.toContain("Recovery succeeded");
  });

  it("stops prompting for goal resume once the recovery turn is running", async () => {
    await show(withWork({ recoveryStatus: "running", goalStatus: "active", turnStatus: "running" }));
    expect(host.textContent).toContain("Waiting for native completion");
    expect(host.textContent).not.toContain("/goal resume");
  });

  it("does not restart a healthy completed turn because a historical terminal error is retained", async () => {
    await show(withWork({ turnStatus: "completed", goalStatus: "active" }));
    expect(host.textContent).toContain("request-after-http-200");
    expect(restartButton()).toBeUndefined();
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not interrupt a running native turn even when an older goal observation is blocked", async () => {
    await show(withWork({ turnStatus: "running" }));
    expect(restartButton().disabled).toBe(true);
    await act(async () => restartButton().click());
    expect(recover).not.toHaveBeenCalled();
  });

  it("retains actionable diagnostics after recovery fails again without automatically restarting", async () => {
    await show(withWork({ recoveryStatus: "failed", lastError: { kind: "terminal", message: "Provider failed again.", requestId: "second-request", code: "second_error" } }));
    expect(host.textContent).toContain("Recovery failed");
    expect(host.textContent).toContain("Goal blocked");
    expect(host.textContent).toContain("second-request");
    expect(host.textContent).toContain("second_error");
    expect(recover).not.toHaveBeenCalled();
    expect(restartButton().disabled).toBe(false);
  });

  it.each([
    { ...tab, ownerPluginId: "forge" },
    withWork({ tabId: "another-tab" }),
    withWork({ executionId: "" }),
    withWork({ threadId: "" }),
    { ...tab, status: "failed" as const }
  ])("disables targeted restart when the displayed tab lacks an available ordinary live binding", async current => {
    await show(current);
    expect(restartButton().disabled).toBe(true);
    await act(async () => restartButton().click());
    expect(recover).not.toHaveBeenCalled();
  });

  it("keeps an in-flight restart bound to the original tab when selection changes", async () => {
    let reject!: (reason: Error) => void;
    recover.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
    await show(tab);
    await act(async () => { restartButton().click(); restartButton().click(); });
    expect(recover).toHaveBeenCalledTimes(1);
    const siblingRecover = vi.fn().mockResolvedValue(undefined);
    const sibling = { ...tab, id: "sibling", title: "Working sibling", nativeWork: { ...nativeWork, tabId: "sibling", executionId: "sibling-execution", threadId: "sibling-conversation", turnStatus: "running" as const, goalStatus: "active" as const, lastError: undefined } };
    await act(async () => root.render(createElement(CodexNativeWorkPanel, { tab: sibling, onRecover: siblingRecover })));
    await act(async () => reject(new Error("Original conversation binding changed.")));
    expect(recover).toHaveBeenCalledExactlyOnceWith({ action: "restart-native", executionId: "affected-execution", sessionId: "exact-conversation" });
    expect(siblingRecover).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Original conversation binding changed.");
    expect(host.textContent).toContain("Native turn: Running");
  });

  it("shows a restart rejection that arrives after the user collapses its pending details", async () => {
    let reject!: (error: Error) => void;
    recover.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
    await show(tab);
    const liveAlert = host.querySelector('[role="alert"]')!;
    expect(liveAlert.textContent).toBe("");
    expect(liveAlert.getAttribute("aria-atomic")).toBe("true");
    await act(async () => restartButton().click());
    await toggleDetails();
    expect(details().hidden).toBe(true);
    await act(async () => reject(new Error("The exact conversation binding became stale.")));
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert).toBe(liveAlert);
    expect(alert.textContent).toContain("exact conversation binding became stale");
    expect(alert.closest("[hidden]")).toBeNull();
    expect(recover).toHaveBeenCalledExactlyOnceWith({ action: "restart-native", executionId: nativeWork.executionId, sessionId: nativeWork.threadId });
  });

  it("reopens identical rejected native turn starts while routine observations stay collapsed", async () => {
    const observed: CodexNativeWork[] = [];
    const threadId = "00000000-0000-4000-8000-000000000002";
    const observer = new CodexNativeWorkObservation({ tabId: tab.id, executionId: "00000000-0000-4000-8000-000000000001", receiptPath: "/work/native-receipt" },
      (work: CodexNativeWork) => observed.push(work), { selectedThreadId: threadId });
    const error = { code: "badRequest", message: "Identical private request rejection" };
    async function rejectStart(id: number) {
      observer.fromClient({ id, method: "turn/start", params: { threadId } });
      observer.fromServer({ id, error });
      await show({ ...tab, nativeWork: observed.at(-1)! });
    }
    await rejectStart(1);
    const firstError = observed.at(-1)!.lastError!;
    expect(firstError.incidentId).toEqual(expect.any(String));
    expect(details().hidden).toBe(false);
    await toggleDetails();
    expect(details().hidden).toBe(true);
    observer.fromServer({ method: "thread/goal/updated", params: { threadId, goal: { threadId, status: "active" } } });
    await show({ ...tab, nativeWork: observed.at(-1)! });
    expect(details().hidden).toBe(true);
    await rejectStart(2);
    const nextError = observed.at(-1)!.lastError!;
    expect(nextError.incidentId).not.toBe(firstError.incidentId);
    expect({ ...nextError, incidentId: undefined }).toEqual({ ...firstError, incidentId: undefined });
    expect(details().hidden).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it("shows a rejected stale binding and permits a deliberate retry without a loop", async () => {
    recover.mockRejectedValueOnce(new Error("The selected conversation changed; inspect the tab again."));
    await show(tab);
    await act(async () => restartButton().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The selected conversation changed");
    expect(restartButton().disabled).toBe(false);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("restores the recorded failure and request ID when the panel remounts", async () => {
    await show(tab);
    await act(async () => root.render(createElement("div")));
    await show(tab);
    expect(host.textContent).toContain("Goal blocked");
    expect(host.textContent).toContain("request-after-http-200");
    expect(recover).not.toHaveBeenCalled();
  });
});

function withWork(overrides: Partial<CodexNativeWork>): WorkspaceTab {
  return { ...tab, nativeWork: { ...nativeWork, ...overrides } };
}

async function show(current: WorkspaceTab) {
  await act(async () => root.render(createElement(CodexNativeWorkPanel, { tab: current, onRecover: recover })));
}

function restartButton() {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Restart this Codex client")!;
}

function presentationButton() {
  return host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
}

function details() {
  return document.getElementById(presentationButton().getAttribute("aria-controls")!)!;
}

async function toggleDetails() {
  await act(async () => presentationButton().click());
}

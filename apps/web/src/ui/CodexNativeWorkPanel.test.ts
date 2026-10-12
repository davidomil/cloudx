// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexNativeWork, WorkspaceTab } from "@cloudx/shared";

import { CodexNativeWorkPanel } from "./CodexNativeWorkPanel.js";

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
    expect(host.querySelector("button")).toBeNull();
  });

  it("requests a restart only for the displayed execution and exact conversation, without claiming success", async () => {
    await show(tab);
    await act(async () => restartButton().click());
    expect(recover).toHaveBeenCalledExactlyOnceWith({ action: "restart-native", executionId: "affected-execution", sessionId: "exact-conversation" });
    expect(host.textContent).toContain("/goal resume");
    expect(host.textContent).toContain("objective, budget and token/time accounting");
    expect(host.textContent).toContain("not a proven fix for provider failures");
    expect(host.textContent).not.toContain("Recovery succeeded");
    expect(host.querySelector("button")).toBeNull();
  });

  it.each(["awaiting_goal_resume", "awaiting_turn", "running"] as const)("keeps %s recovery pending until a native turn completes", async recoveryStatus => {
    await show(withWork({ recoveryStatus }));
    expect(host.textContent).toContain(recoveryStatus === "awaiting_goal_resume" ? "Waiting for explicit goal resume" : recoveryStatus === "awaiting_turn" ? "Waiting for a native turn" : "Waiting for native completion");
    expect(host.textContent).not.toContain("Recovery succeeded");
    expect(host.querySelector("button")).toBeNull();
  });

  it("reports observed recovery success only from the native recovery outcome", async () => {
    await show(withWork({ recoveryStatus: "succeeded", turnStatus: "completed", goalStatus: "active" }));
    expect(host.textContent).toContain("Recovery succeeded: a subsequent native turn completed");
    expect(host.querySelector("button")).toBeNull();
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
    expect(host.querySelector("button")).toBeNull();
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

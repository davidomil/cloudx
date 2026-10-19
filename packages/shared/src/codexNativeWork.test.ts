import { describe, expect, it } from "vitest";
import { isCodexNativeWork, parseCodexNativeWork, type CodexNativeWork } from "./codexNativeWork.js";
import { isCompleteWorkspaceTab } from "./index.js";

const work: CodexNativeWork = {
  version: 1, tabId: "tab-1", executionId: "execution-1", threadId: "conversation-1", updatedAt: "2026-10-12T20:28:20.356Z",
  turnId: "turn-1", turnStatus: "failed", goalStatus: "blocked",
  lastError: { message: "The provider response stream ended before completion.", kind: "terminal", code: "responseStreamDisconnected", httpStatusCode: 200, requestId: "request-1" }
};

describe("native work contracts", () => {
  it("retains structured failure separately from process liveness", () => {
    expect(parseCodexNativeWork(work)).toEqual(work);
    expect(isCompleteWorkspaceTab({ id: work.tabId, pluginId: "codex-terminal", title: "Codex", cwd: "/project", status: "running",
      createdAt: work.updatedAt, updatedAt: work.updatedAt, indicator: { color: "green", label: "OK", updatedAt: work.updatedAt }, nativeWork: work })).toBe(true);
  });

  it("projects diagnostics without leaking unknown native content", () => {
    const projected = parseCodexNativeWork({ ...work, goal: { objective: "private objective" }, lastError: { ...work.lastError, additionalDetails: "private prompt", credentials: "private token" } });
    expect(projected).toEqual(work);
    expect(JSON.stringify(projected)).not.toContain("private");
  });

  it.each(["incident-1", "a".repeat(128)])("retains a bounded incident identity while excluding unknown error content (%s)", incidentId => {
    const incident = { ...work, lastError: { ...work.lastError!, incidentId } };
    expect(isCodexNativeWork(incident)).toBe(true);
    const projected = parseCodexNativeWork({ ...incident, lastError: { ...incident.lastError, transcript: "private content" } });
    expect(projected).toEqual(incident);
    expect(JSON.stringify(projected)).not.toContain("private content");
  });

  it.each(["", "../incident", "incident with spaces", "a".repeat(129), 1, null])("rejects a malformed incident identity: %j", incidentId => {
    const incident = { ...work, lastError: { ...work.lastError!, incidentId } };
    expect(isCodexNativeWork(incident)).toBe(false);
    expect(() => parseCodexNativeWork(incident)).toThrow("Invalid Codex native work");
  });

  it("preserves the native turn that resolved an incident separately from failed recovery history", () => {
    const resolved = { ...work, turnStatus: "completed", goalStatus: "active", recoveryStatus: "failed", incidentResolvedByTurnId: "later-turn" };
    expect(parseCodexNativeWork(resolved)).toEqual(resolved);
  });

  it.each([
    { version: 2 }, { tabId: "../tab" }, { executionId: "" }, { threadId: null }, { updatedAt: "unknown" },
    { turnStatus: "idle" }, { goalStatus: "failed" }, { recoveryStatus: "ready" },
    { incidentResolvedByTurnId: "../turn" }, { incidentResolvedByTurnId: "" }, { incidentResolvedByTurnId: null },
    { lastError: { message: "x".repeat(1025), kind: "terminal" } },
    { lastError: { message: "error", kind: "terminal", httpStatusCode: 200.5 } },
    { lastError: { message: "error", kind: "terminal", code: "private content" } },
    { lastError: { message: "error", kind: "terminal", requestId: "../../credentials" } }
  ])("rejects malformed native observations: %j", patch => {
    expect(isCodexNativeWork({ ...work, ...patch })).toBe(false);
    expect(() => parseCodexNativeWork({ ...work, ...patch })).toThrow("Invalid Codex native work");
  });
});

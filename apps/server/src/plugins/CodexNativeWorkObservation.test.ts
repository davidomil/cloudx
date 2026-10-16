import { expect, it } from "vitest";

const { CodexNativeWorkObservation, nativeWorkError } = await import(new URL("../../helpers/codex-native-work.mjs", import.meta.url).href);
const { CodexConversationSelection } = await import(new URL("../../helpers/codex-conversation-selection.mjs", import.meta.url).href);
const executionId = "01a08470-d118-7b72-b1df-439e72e5c744";
const threadId = "01a08470-d118-7b72-b1df-439e72e5c745";
const otherThreadId = "01a08470-d118-7b72-b1df-439e72e5c746";
const requestId = "e8a8a973-5a9d-412c-8142-d1ca46d61146";
const providerError = {
  message: `An error occurred while processing your request. Request ID: ${requestId}. Authorization: Bearer credential. Conversation: private content`,
  codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 200 } },
  additionalDetails: "provider response body with private user content and credentials"
};

function conversation(recovery = false, id = threadId, previousError?: object, previousGoalStatus?: string) {
  const saved: any[] = [];
  const binding = { tabId: `tab-${id}`, executionId, receiptPath: "/unused", ...(recovery ? { expectedThreadId: id, recovery: true, previousError, previousGoalStatus } : {}) };
  const selection = new CodexConversationSelection(binding, () => {});
  const health = new CodexNativeWorkObservation(binding, (value: object) => saved.push(value), selection);
  const fromClient = (message: any) => { selection.fromClient(message); health.fromClient(message); };
  const fromServer = (message: any) => { selection.fromServer(message); health.fromServer(message); };
  fromClient({ id: 1, method: recovery ? "thread/resume" : "thread/start", params: { threadId: id } });
  fromServer({ id: 1, result: { thread: { id, cwd: "/workspace", path: "/native/history.jsonl" } } });
  return {
    health, saved, fromClient, fromServer,
    last: () => saved.at(-1),
    goal: (status: string) => fromServer({ method: "thread/goal/updated", params: { threadId: id, goal: { threadId: id, status, objective: "private objective", tokensUsed: 50, timeUsedSeconds: 30 } } }),
    start: (turnId = "turn") => fromServer({ method: "turn/started", params: { threadId: id, turn: { id: turnId, status: "inProgress" } } }),
    complete: (status = "completed", error?: object, turnId = "turn") => fromServer({ method: "turn/completed", params: { threadId: id, turn: { id: turnId, status, error, items: [{ text: "private answer" }] } } }),
    resumeGoal: () => {
      fromClient({ id: 8, method: "thread/goal/set", params: { threadId: id, status: "active", objective: null } });
      fromServer({ id: 8, result: { goal: { threadId: id, status: "active", objective: "private objective", tokensUsed: 50, timeUsedSeconds: 30 } } });
    }
  };
}

it("retains HTTP 200 as transport evidence when the provider stream later fails", () => {
  const tab = conversation();
  tab.start();
  tab.fromServer({ method: "error", params: { threadId, turnId: "turn", willRetry: true, error: providerError } });
  expect(tab.last()).toMatchObject({ turnStatus: "running", lastError: { kind: "retry", requestId, httpStatusCode: 200 } });
  tab.complete("failed", providerError);
  expect(tab.last()).toMatchObject({ turnStatus: "failed", lastError: { kind: "terminal", requestId, httpStatusCode: 200, code: "responseTooManyFailedAttempts" } });
  expect(tab.last().goalStatus).toBeUndefined();
  expect(JSON.stringify(tab.saved)).not.toMatch(/credential|private|Authorization|provider response body/);
});

it("retains terminal task_complete error exposed through native turn/completed", () => {
  const tab = conversation();
  tab.start();
  // Codex 0.160.0 bespoke_event_handling.rs maps terminal TaskComplete to v2 turn/completed.
  tab.complete("completed", providerError);
  expect(tab.last()).toMatchObject({ turnStatus: "failed", lastError: { kind: "terminal", code: "responseTooManyFailedAttempts", httpStatusCode: 200, requestId } });
});

it("reports native Blocked separately from terminal turn failure and process liveness", () => {
  const tab = conversation();
  tab.goal("active");
  tab.start();
  tab.complete("failed", providerError);
  expect(tab.last().goalStatus).toBe("active");
  tab.goal("blocked");
  expect(tab.last()).toMatchObject({ turnStatus: "failed", goalStatus: "blocked", tabId: `tab-${threadId}`, executionId, threadId });
  expect(tab.last()).not.toHaveProperty("processStatus");
});

it("requires explicit goal reactivation and a subsequent successful native turn", () => {
  const tab = conversation(true, threadId, { ...nativeWorkError(providerError, "terminal") });
  tab.goal("blocked");
  expect(tab.last()).toMatchObject({ recoveryStatus: "awaiting_goal_resume", lastError: { requestId } });
  tab.start("manual-before-resume");
  tab.complete("completed", undefined, "manual-before-resume");
  expect(tab.last().recoveryStatus).toBe("awaiting_goal_resume");
  tab.resumeGoal();
  expect(tab.last().recoveryStatus).toBe("awaiting_turn");
  tab.start("after-resume");
  tab.complete("completed", undefined, "after-resume");
  expect(tab.last().recoveryStatus).toBe("succeeded");
});

it("observes the goal's automatically started turn before its resume request replies", () => {
  const tab = conversation(true);
  tab.goal("blocked");
  const resume = { id: 8, method: "thread/goal/set", params: { threadId, status: "active", objective: null } };
  const original = structuredClone(resume);
  tab.fromClient(resume);
  tab.start("goal-turn");
  tab.fromServer({ id: 8, result: { goal: { threadId, status: "active", objective: "private objective", tokensUsed: 50, timeUsedSeconds: 30 } } });
  expect(resume).toEqual(original);
  expect(tab.last().recoveryStatus).toBe("running");
  tab.complete("completed", undefined, "goal-turn");
  expect(tab.last()).toMatchObject({ recoveryStatus: "succeeded", goalStatus: "active", turnStatus: "completed" });
  expect(JSON.stringify(tab.saved)).not.toContain("private objective");
  expect(tab.last()).not.toHaveProperty("tokensUsed");
});

it("does not treat an unsolicited active update or a new objective as goal resume", () => {
  const tab = conversation(true);
  tab.goal("blocked");
  tab.goal("active");
  tab.start();
  tab.complete();
  expect(tab.last().recoveryStatus).not.toBe("succeeded");
  tab.fromClient({ id: 7, method: "thread/goal/set", params: { threadId, status: "active", objective: "different objective" } });
  tab.fromServer({ id: 7, result: { goal: { threadId, status: "active" } } });
  expect(tab.last().recoveryStatus).not.toBe("succeeded");
});

it("does not count clearing the token budget as preservation-only goal resume", () => {
  const tab = conversation(true, threadId, undefined, "blocked");
  tab.fromClient({ id: 7, method: "thread/goal/set", params: { threadId, status: "active", objective: null, tokenBudget: null } });
  tab.start();
  tab.fromServer({ id: 7, result: { goal: { threadId, status: "active", tokenBudget: null } } });
  tab.complete();
  expect(tab.last().recoveryStatus).not.toBe("succeeded");
});

it.each(["active", "complete", "none"])("allows recovery with a %s goal only after a native completed turn", status => {
  const tab = conversation(true);
  if (status === "none") tab.fromServer({ method: "thread/goal/cleared", params: { threadId } });
  else tab.goal(status);
  expect(tab.last().recoveryStatus).toBe("awaiting_turn");
  tab.start();
  expect(tab.last().recoveryStatus).toBe("running");
  tab.complete();
  expect(tab.last().recoveryStatus).toBe("succeeded");
});

it("does not accept saved-history completion but supports no-goal clients without goal snapshots", () => {
  const tab = conversation(true);
  tab.complete();
  expect(tab.last().recoveryStatus).toBe("awaiting_turn");
  tab.start("new-turn");
  tab.complete("completed", undefined, "new-turn");
  expect(tab.last().recoveryStatus).toBe("succeeded");
});

it("retains provider diagnostics and confirms no-goal recovery after the resume goal query is rejected", () => {
  const failed = conversation();
  failed.start();
  failed.complete("failed", providerError);
  const savedError = failed.last().lastError;
  const resumed = conversation(true, threadId, savedError);
  resumed.fromClient({ id: 7, method: "thread/goal/get", params: { threadId } });
  resumed.fromServer({ id: 7, error: { code: -32600, message: "goals feature is disabled" } });
  expect(resumed.last()).toMatchObject({ recoveryStatus: "awaiting_turn", lastError: savedError });
  resumed.start("recovery-turn");
  resumed.complete("completed", undefined, "recovery-turn");
  expect(resumed.last()).toMatchObject({ turnStatus: "completed", recoveryStatus: "succeeded", lastError: savedError });
  expect(resumed.last().goalStatus).toBeUndefined();
});

it.each(["thread/goal/get", "thread/goal/set"])("keeps known blocked-goal protection and provider diagnostics after %s is rejected", method => {
  const savedError = nativeWorkError(providerError, "terminal");
  const tab = conversation(true, threadId, savedError, "blocked");
  tab.fromClient({ id: 7, method, params: { threadId, status: "active" } });
  tab.fromServer({ id: 7, error: { code: -32600, message: "goals feature is disabled" } });
  expect(tab.last()).toMatchObject({ recoveryStatus: "awaiting_goal_resume", goalStatus: "blocked", lastError: savedError });
  tab.start();
  tab.complete();
  expect(tab.last()).toMatchObject({ turnStatus: "completed", recoveryStatus: "awaiting_goal_resume", goalStatus: "blocked", lastError: savedError });
});

it("still fails recovery when the native turn start is rejected", () => {
  const tab = conversation(true);
  tab.fromClient({ id: 7, method: "turn/start", params: { threadId } });
  tab.fromServer({ id: 7, error: providerError });
  expect(tab.last()).toMatchObject({ turnStatus: "failed", recoveryStatus: "failed", lastError: { kind: "terminal", requestId } });
});

it("identifies each rejected native start once while keeping routine and duplicate observations stable", () => {
  const tab = conversation();
  const rejected = (id: number) => {
    tab.fromClient({ id, method: "turn/start", params: { threadId } });
    tab.fromServer({ id, error: providerError });
    return tab.last().lastError;
  };
  const first = rejected(71);
  expect(first.incidentId).toMatch(/^[a-f0-9-]{36}$/);
  expect(tab.last().turnId).toBeUndefined();
  tab.goal("blocked");
  expect(tab.last().lastError).toEqual(first);
  const count = tab.saved.length;
  tab.fromServer({ id: 71, error: providerError });
  expect(tab.saved).toHaveLength(count);
  const next = rejected(72);
  expect(next.incidentId).not.toBe(first.incidentId);
  expect({ ...next, incidentId: undefined }).toEqual({ ...first, incidentId: undefined });
  expect(tab.last().turnId).toBeUndefined();
  expect(conversation(true, threadId, next).last().lastError).toEqual(next);
  expect(JSON.stringify(tab.saved)).not.toMatch(/credential|private|Authorization/);
});

it("does not accept native incident identities or restore malformed identities", () => {
  expect(nativeWorkError({ ...providerError, incidentId: "provider-identity" }, "terminal")).not.toHaveProperty("incidentId");
  const restored = conversation(true, threadId, { ...nativeWorkError(providerError, "terminal"), incidentId: "../invalid" });
  expect(restored.last().lastError).not.toHaveProperty("incidentId");
});

it.each(["terminal", "retry"])("preserves the complete saved other processing-error diagnostic on exact resume for %s receipts", kind => {
  const savedError = nativeWorkError({ ...providerError, codexErrorInfo: "other", httpStatusCode: 200 }, kind);
  expect(savedError).toEqual({ message: "The provider reported an internal processing error.", kind, code: "other", requestId, httpStatusCode: 200 });
  const tab = conversation(true, threadId, savedError);
  expect(tab.last().lastError).toEqual(savedError);
  expect(JSON.stringify(tab.saved)).not.toMatch(/credential|private|Authorization|provider response body/);
});

it("restores only accepted safe messages and supported diagnostic fields", () => {
  const safe = nativeWorkError(providerError, "terminal");
  const restored = conversation(true, threadId, { ...safe, credentials: "secret", additionalDetails: "private conversation" });
  expect(restored.last().lastError).toEqual(safe);
  expect(JSON.stringify(restored.saved)).not.toMatch(/secret|private|credentials|additionalDetails/);
  const unsafe = conversation(true, threadId, {
    message: "Authorization: Bearer secret; private conversation", kind: "terminal", code: "other",
    requestId: "secret", httpStatusCode: 900, additionalDetails: "private request body"
  });
  expect(unsafe.last().lastError).toEqual({ message: "Codex reported a native turn error.", kind: "terminal", code: "other" });
  expect(JSON.stringify(unsafe.saved)).not.toMatch(/secret|private|Authorization|additionalDetails/);
});

it("requires reactivation of a previously known blocked goal even before its native snapshot", () => {
  const tab = conversation(true, threadId, undefined, "blocked");
  expect(tab.last()).toMatchObject({ goalStatus: "blocked", recoveryStatus: "awaiting_goal_resume" });
  tab.start();
  tab.complete();
  expect(tab.last().recoveryStatus).toBe("awaiting_goal_resume");
});

it.each(["awaiting_goal_resume", "failed", "succeeded"])("allows deliberate native navigation away from %s recovery after exact initial resume", status => {
  const tab = conversation(true, threadId, undefined, "blocked");
  if (status === "succeeded") tab.resumeGoal();
  if (status !== "awaiting_goal_resume") {
    tab.start();
    tab.complete(status === "failed" ? "failed" : "completed", status === "failed" ? providerError : undefined);
  }
  expect(tab.last().recoveryStatus).toBe(status);
  tab.fromClient({ id: 3, method: "thread/start", params: {} });
  tab.fromServer({ id: 3, result: { thread: { id: otherThreadId, cwd: "/workspace" } } });
  expect(tab.last()).toMatchObject({ threadId: otherThreadId });
  expect(tab.last().recoveryStatus).toBeUndefined();
  expect(tab.last().lastError).toBeUndefined();
});

it("retains repeated recovery failure and native blocked protection without restarting or looping", () => {
  const tab = conversation(true);
  tab.goal("blocked");
  tab.resumeGoal();
  tab.start();
  tab.fromServer({ method: "error", params: { threadId, turnId: "turn", willRetry: false, error: providerError } });
  tab.complete("failed", providerError);
  tab.goal("blocked");
  expect(tab.last()).toMatchObject({ recoveryStatus: "failed", goalStatus: "blocked", turnStatus: "failed", lastError: { kind: "terminal", requestId } });
  tab.resumeGoal();
  tab.start("another-turn");
  tab.complete("completed", undefined, "another-turn");
  expect(tab.last().recoveryStatus).toBe("failed");
});

it("keeps parallel and auxiliary conversations from changing selected-tab health", () => {
  const tab = conversation();
  const parallel = conversation(false, otherThreadId);
  parallel.goal("active");
  parallel.start("healthy");
  tab.start();
  tab.fromServer({ method: "error", params: { threadId: otherThreadId, turnId: "healthy", willRetry: false, error: providerError } });
  tab.fromServer({ method: "thread/goal/updated", params: { threadId: otherThreadId, goal: { threadId: otherThreadId, status: "blocked" } } });
  tab.complete("failed", providerError);
  parallel.complete("completed", undefined, "healthy");
  expect(tab.last()).toMatchObject({ turnStatus: "failed", threadId });
  expect(parallel.last()).toMatchObject({ turnStatus: "completed", goalStatus: "active", threadId: otherThreadId });
  expect(parallel.last().lastError).toBeUndefined();
});

it("rejects stale recovery binding and stops observation after ambiguous foreground navigation", () => {
  const save = () => {};
  const binding = { tabId: "tab", executionId, receiptPath: "/unused", recovery: true, expectedThreadId: threadId };
  expect(() => new CodexNativeWorkObservation({ ...binding, expectedThreadId: undefined }, save, {})).toThrow("binding");
  const stale = new CodexNativeWorkObservation(binding, save, { selectedThreadId: otherThreadId });
  expect(() => stale.fromServer({})).toThrow("different conversation");
  const tab = conversation();
  tab.fromClient({ id: 2, method: "thread/resume", params: { threadId: otherThreadId } });
  tab.fromServer({ id: 2, result: { thread: { id: otherThreadId, cwd: "/workspace" } } });
  expect(tab.last().threadId).toBe(otherThreadId);
  tab.fromClient({ id: 3, method: "thread/read", params: { threadId } });
  const count = tab.saved.length;
  tab.start("ignored");
  expect(tab.saved).toHaveLength(count);
});

it("extracts only supported bounded error classifications and request IDs", () => {
  expect(nativeWorkError({ message: "very high demand; user prompt follows", codexErrorInfo: "serverOverloaded" }, "retry")).toEqual({ message: "The provider is experiencing high demand.", kind: "retry", code: "serverOverloaded" });
  const unsafe = nativeWorkError({ message: "Authorization: Bearer secret\nprivate conversation", additionalDetails: "secret", codexErrorInfo: "private-secret", requestId: "secret", httpStatusCode: 900 }, "terminal");
  expect(unsafe).toEqual({ message: "Codex reported a native turn error. Diagnostic content was omitted.", kind: "terminal" });
  expect(nativeWorkError({ message: `${"x".repeat(4096)} Request ID: ${requestId}` }, "terminal")).not.toHaveProperty("requestId");
});

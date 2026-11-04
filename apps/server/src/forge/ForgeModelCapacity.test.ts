import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FORGE_MODEL_CAPACITY_RETRIES, isForgeTurnCompletion } from "@cloudx/shared";
import type { ForgeChangeRequest, ForgeTurnCompletion, ForgeWorker } from "@cloudx/shared";
import { ForgeWorkflowService, type ForgeWorkflowDependencies } from "./ForgeWorkflowService.js";
import { parseWorkers } from "./ForgeWorkflowValidation.js";

const { CodexWorkerTurn } = await import(new URL("../../helpers/codex-worker-bridge.mjs", import.meta.url).href);
const placement = { windowId: "window", paneId: "pane" };
const repository = { provider: "github" as const, apiUrl: "https://api.github.com", projectPath: "a/b" };
const services: ForgeWorkflowService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  let stored: ForgeWorker[] = [];
  const receipts = new Map<string, ForgeTurnCompletion>();
  const bridges = new Map<string, InstanceType<typeof CodexWorkerTurn>>();
  const activeTabs = new Set<string>();
  const settings = {
    repository, baseBranch: "main", workerTemplateId: "worker", reviewTemplateId: "review",
    workerModel: "gpt-6-astra", workerReasoningEffort: "xhigh" as const, workerAccountId: "selected-account",
    reviewModel: "gpt-6-sol", reviewReasoningEffort: "high" as const, maxRunMinutes: 60,
  };
  const change: ForgeChangeRequest = {
    number: 7, title: "Fix issue", body: "", url: "https://github.com/a/b/pull/7", state: "open", labels: [], author: "bot", updatedAt: "",
    draft: false, headSha: "a".repeat(40), headBranch: "cloudx/forge/test", baseBranch: "main", baseSha: "b".repeat(40),
    targetHeadSha: "b".repeat(40), merged: false, mergeable: true, requiresBaseUpdate: false, reviewReady: true,
    approved: false, unresolvedDiscussions: 0, linkedIssues: [], comments: [],
  };
  const provider = {
    getIssue: vi.fn(async (number: number) => ({ number, title: "Fix issue", body: "Task", url: `https://github.com/a/b/issues/${number}`, state: "open", comments: [] })),
    getChangeRequest: vi.fn(async () => ({ ...change })), getChangeRequestStatus: vi.fn(async () => ({ ...change })),
    findChangeRequestByBranch: vi.fn(async () => undefined),
  };
  const runtime = {
    isActive: vi.fn((tabId: string) => activeTabs.has(tabId)),
    recover: vi.fn(async () => ({ tabIds: [] })),
    prepareWorkspace: vi.fn(async () => ({ repositoryPath: "/repo", worktreePath: "/repo/work", branch: "cloudx/forge/test" })),
    prepareReviewScope: vi.fn(async () => ({ kind: "initial", current: { headSha: change.headSha, baseSha: change.baseSha, mergeBaseSha: change.baseSha } })),
    refreshReviewWorkspace: vi.fn(async () => {}),
    readTurnCompletion: vi.fn(async (_workerId: string, attemptId: string) => structuredClone(receipts.get(attemptId))),
    launch: vi.fn(async (input: Parameters<ForgeWorkflowDependencies["runtime"]["launch"]>[0]) => {
      const tabId = `tab-${input.attemptId}`;
      activeTabs.add(tabId);
      const bridge = new CodexWorkerTurn({ workerId: input.id, attemptId: input.attemptId, executionId: `execution-${input.attemptId}`, expectedThreadId: `conversation-${input.id}` }, (turn: ForgeTurnCompletion) => receipts.set(input.attemptId, structuredClone(turn)));
      bridges.set(input.attemptId, bridge);
      bridge.fromClient({ id: 1, method: "turn/start", params: { threadId: `conversation-${input.id}` } });
      bridge.fromServer({ id: 1, result: { turn: { id: `turn-${input.attemptId}` } } });
      return tabId;
    }),
    close: vi.fn(async (tabId: string) => { activeTabs.delete(tabId); }), pause: vi.fn(async () => {}),
    finish: vi.fn(async () => {}), verifyPublishedWorkspace: vi.fn(async () => {}),
    syncPublishedBranch: vi.fn(async () => {}), cleanup: vi.fn(async () => {}),
  };
  const reports = { prepare: vi.fn(async (_attemptId: string, _context: unknown) => ({ reportPath: "/report.json", contextPath: "/context.json" })), read: vi.fn(async (): Promise<unknown> => undefined), remove: vi.fn(async () => {}) };
  const deps = {
    settings: () => settings, provider: () => provider, runtime, reports,
    refreshPublicationCredentials: vi.fn(async () => {}), notify: vi.fn(),
    store: { read: async () => structuredClone(stored), write: async (workers: ForgeWorker[]) => { stored = parseWorkers(structuredClone(workers)); } },
  } as unknown as ForgeWorkflowDependencies;
  const createService = () => { const service = new ForgeWorkflowService(deps); services.push(service); return service; };
  const service = createService();
  const fail = (worker: ForgeWorker, code = "serverOverloaded") => bridges.get(worker.attemptId!)!.fromServer({
    method: "turn/completed", params: { threadId: `conversation-${worker.id}`, turn: { id: `turn-${worker.attemptId}`, status: "failed",
      error: { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: code } } },
  });
  const current = (id?: string) => stored.find(worker => !id || worker.id === id)!;
  return { service, createService, settings, provider, runtime, reports, receipts, bridges, activeTabs, fail, current, stored: () => stored, seed: (workers: ForgeWorker[]) => { stored = parseWorkers(structuredClone(workers)); }, deps };
}

async function capacityWait(f: ReturnType<typeof fixture>) {
  const worker = await f.service.startIssue(repository, 1, placement);
  f.fail(worker);
  await f.service.poll();
  expect(f.current().status).toBe("paused");
  return worker;
}

async function linkedReviewWait(f: ReturnType<typeof fixture>) {
  const issue = await f.service.startIssue(repository, 1, placement);
  await f.service.pause(issue.id);
  const review = await f.service.startReview(repository, 7, false, placement);
  f.fail(review);
  await f.service.poll();
  await f.service.dispose();
  const workers = structuredClone(f.stored());
  const parent = workers.find(worker => worker.id === issue.id)!;
  Object.assign(parent, { status: "awaiting_review", changeNumber: 7, headSha: "a".repeat(40),
    autoReview: { enabled: true, phase: "reviewing", placement, reviewWorkerId: review.id } });
  workers.find(worker => worker.id === review.id)!.issueWorkerId = issue.id;
  f.seed(workers);
  const service = f.createService();
  await service.dashboard();
  return { service, issue, review };
}

describe("Forge native model capacity recovery", () => {
  it("resumes one new attempt after 30 seconds with the same work, conversation and selected settings", async () => {
    const f = fixture();
    const worker = await capacityWait(f);
    const original = f.runtime.launch.mock.calls[0]![0];
    expect(f.current()).toMatchObject({ attemptId: worker.attemptId, modelCapacityRecovery: { retries: 0, retryAt: "2026-11-04T00:00:30.000Z" } });
    expect(f.reports.remove).not.toHaveBeenCalled();
    f.settings.workerModel = "another-model";
    await vi.advanceTimersByTimeAsync(29_999);
    await f.service.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([f.service.poll(), f.service.poll(), f.service.poll()]);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.launch.mock.calls[1]![0]).toMatchObject({ id: worker.id, worktreePath: original.worktreePath, model: original.model, reasoningEffort: original.reasoningEffort, accountId: original.accountId, preserveConversation: true });
    expect(f.current()).toMatchObject({ status: "running", modelCapacityRecovery: { retries: 1 }, completion: { turn: { threadId: `conversation-${worker.id}`, status: "running" } } });
    expect(f.current().error).toBeUndefined();
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(new Set([...f.receipts.values()].map(receipt => receipt.threadId)).size).toBe(1);
  });

  it("caps repeated backoff at five minutes before exhaustion", async () => {
    const f = fixture();
    let worker = await f.service.startIssue(repository, 1, placement);
    f.fail(worker, "server_overloaded");
    await f.service.poll();
    expect(f.current().modelCapacityRecovery?.retryAt).toBe("2026-11-04T00:00:30.000Z");
    const expectedDelays = [30_000, 60_000, 120_000, 240_000, 300_000];
    for (const delay of expectedDelays) {
      const deadline = Date.parse(f.current().modelCapacityRecovery!.retryAt!);
      expect(deadline - Date.now()).toBe(delay);
      await vi.advanceTimersByTimeAsync(delay);
      await f.service.poll();
      worker = structuredClone(f.current());
      f.fail(worker);
      await f.service.poll();
    }
    expect(f.runtime.launch).toHaveBeenCalledTimes(1 + MAX_FORGE_MODEL_CAPACITY_RETRIES);
    expect(f.current()).toMatchObject({ status: "paused", error: expect.stringContaining("exhausted"), modelCapacityRecovery: { retries: 5 } });
    expect(f.current().modelCapacityRecovery?.retryAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3600_000);
    await f.service.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(6);
    await f.service.resume(worker.id, placement);
    expect(f.runtime.launch).toHaveBeenCalledTimes(7);
    expect(f.current().status).toBe("running");
  });

  it("does not submit another turn while Codex internally retries the owned active turn", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(repository, 1, placement);
    f.bridges.get(worker.attemptId!)!.fromServer({ method: "error", params: { threadId: `conversation-${worker.id}`, turnId: `turn-${worker.attemptId}`, willRetry: true, error: { message: "At capacity", codexErrorInfo: "serverOverloaded" } } });
    await vi.advanceTimersByTimeAsync(60_000);
    await f.service.poll();
    expect(f.current().status).toBe("running");
    expect(f.current().modelCapacityRecovery).toBeUndefined();
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
  });

  it.each(["pause", "stop"] as const)("%s cancels the persisted automatic deadline", async control => {
    const f = fixture();
    const worker = await capacityWait(f);
    await f.service[control](worker.id);
    await vi.advanceTimersByTimeAsync(90_000);
    await f.service.poll();
    expect(f.current().modelCapacityRecovery).toBeUndefined();
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
  });

  it("serializes manual Resume with a due automatic retry", async () => {
    const f = fixture();
    const worker = await capacityWait(f);
    await vi.advanceTimersByTimeAsync(30_000);
    const outcomes = await Promise.allSettled([f.service.resume(worker.id, placement), f.service.poll(), f.service.poll()]);
    expect(outcomes.some(outcome => outcome.status === "fulfilled")).toBe(true);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.current().status).toBe("running");
  });

  it("retains its original deadline on service restart without duplicate launches", async () => {
    const f = fixture();
    await capacityWait(f);
    await vi.advanceTimersByTimeAsync(15_000);
    await f.service.dispose();
    const restarted = f.createService();
    await restarted.poll();
    expect(f.current().modelCapacityRecovery?.retryAt).toBe("2026-11-04T00:00:30.000Z");
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all([restarted.poll(), restarted.poll()]);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.current().status).toBe("running");
  });

  it.each(["workerId", "attemptId", "threadId", "turnId", "executionId"] as const)("rejects a stale %s before automatic resumption", async field => {
    const f = fixture();
    const worker = await capacityWait(f);
    f.receipts.get(worker.attemptId!)![field] = "stale";
    await vi.advanceTimersByTimeAsync(30_000);
    await f.service.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    expect(f.current()).toMatchObject({ status: "failed", error: expect.stringContaining("no longer matches") });
  });

  it.each(["unauthorized", "usageLimitExceeded", "sessionBudgetExceeded", "badRequest", "cyberPolicy", "other"])("keeps %s errors on the existing failure path", async code => {
    const f = fixture();
    const worker = await f.service.startIssue(repository, 1, placement);
    f.fail(worker, code);
    await f.service.poll();
    expect(f.current().status).toBe("failed");
    expect(f.current().modelCapacityRecovery).toBeUndefined();
  });

  it("requires structured classification even when arbitrary terminal text says capacity", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(repository, 1, placement);
    f.fail(worker);
    delete f.receipts.get(worker.attemptId!)!.nativeError;
    await f.service.poll();
    expect(f.current().status).toBe("failed");
    expect(f.current().modelCapacityRecovery).toBeUndefined();
  });

  it("keeps invalid reports and ownership holds on the existing failure path", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(repository, 1, placement);
    f.fail(worker);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Invalid" });
    await f.service.poll();
    expect(f.current()).toMatchObject({ status: "failed", completion: { reportError: expect.stringContaining("Invalid completion report") } });
    expect(f.current().modelCapacityRecovery).toBeUndefined();
    expect(f.reports.remove).not.toHaveBeenCalled();
  });

  it("cancels a due retry while its terminal evidence is being confirmed", async () => {
    const f = fixture();
    const worker = await capacityWait(f);
    let release!: (receipt: ForgeTurnCompletion) => void;
    f.runtime.readTurnCompletion.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(30_000);
    const polling = f.service.poll();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stopping = f.service.stop(worker.id);
    release(structuredClone(f.receipts.get(worker.attemptId!)!));
    await Promise.all([polling, stopping]);
    expect(f.current()).toMatchObject({ status: "stopped" });
    expect(f.current().modelCapacityRecovery).toBeUndefined();
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
  });

  it("keeps cleanup ownership failures as a deliberate hold", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(repository, 1, placement);
    f.fail(worker);
    f.runtime.recover.mockRejectedValue(new Error("Owned execution identity changed"));
    await f.service.poll();
    expect(f.current().status).toBe("cleanup_failed");
    expect(f.current().modelCapacityRecovery).toBeUndefined();
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
  });

  it.each([10_000, 30_000])("retires a closed issue before a pending retry at %s ms can launch", async elapsed => {
    const f = fixture();
    await capacityWait(f);
    f.provider.getIssue.mockImplementation(async number => ({ number, title: "Fix issue", body: "Task", url: "https://github.com/a/b/issues/1", state: "closed", comments: [] }));
    await vi.advanceTimersByTimeAsync(elapsed);
    await f.service.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    if (elapsed === 10_000) {
      // Completion observations run every thirty seconds.
      await vi.advanceTimersByTimeAsync(20_000);
      await f.service.poll();
    }
    expect(f.stored()).toHaveLength(0);
  });

  it("keeps an unrelated worker when a due retry retires a closed issue", async () => {
    const f = fixture();
    const worker = await capacityWait(f);
    const unrelated = await f.service.startIssue(repository, 2, placement);
    f.provider.getIssue.mockImplementation(async number => ({ number, title: "Fix issue", body: "Task", url: `https://github.com/a/b/issues/${number}`, state: number === 1 ? "closed" : "open", comments: [] }));
    await vi.advanceTimersByTimeAsync(30_000);
    await f.service.poll();
    expect(f.stored().find(saved => saved.id === worker.id)).toBeUndefined();
    expect(f.current(unrelated.id)).toMatchObject({ id: unrelated.id, status: "running", attemptId: unrelated.attemptId });
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("uses its regular two-second scheduler to recover without a manual poll", async () => {
    const f = fixture();
    await capacityWait(f);
    f.service.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("retains the due deadline until a new native launch intent is saved", async () => {
    const f = fixture();
    await capacityWait(f);
    let release!: () => void;
    const originalIssue = f.provider.getIssue.getMockImplementation()!;
    let calls = 0;
    f.provider.getIssue.mockImplementation(async number => {
      calls++;
      if (calls === 2) await new Promise<void>(resolve => { release = resolve; });
      return originalIssue(number);
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const polling = f.service.poll();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const checkpoint = structuredClone(f.stored());
    expect(checkpoint[0]).toMatchObject({ status: "starting", modelCapacityRecovery: { retries: 0, retryAt: "2026-11-04T00:00:30.000Z" } });
    const disposing = f.service.dispose();
    release();
    await Promise.all([polling, disposing]);
    f.seed(checkpoint);
    const restarted = f.createService();
    await restarted.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.current()).toMatchObject({ status: "running", modelCapacityRecovery: { retries: 1 } });
  });

  it.each([false, true])("keeps manual Resume available after a saved new launch intent with late native success=%s", async lateSuccess => {
    const f = fixture();
    const worker = await capacityWait(f);
    let release!: () => void;
    f.reports.prepare.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { reportPath: "/report.json", contextPath: "/context.json" };
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const polling = f.service.poll();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const checkpoint = structuredClone(f.stored());
    expect(checkpoint[0]?.attemptId).not.toBe(worker.attemptId);
    expect(checkpoint[0]?.modelCapacityRecovery?.retries).toBe(1);
    const disposing = f.service.dispose();
    release();
    await Promise.all([polling, disposing]);
    f.seed(checkpoint);
    const restarted = f.createService();
    await restarted.poll();
    expect(f.current().status).toBe("paused");
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    if (lateSuccess) {
      const pending = checkpoint[0]!;
      f.receipts.set(pending.attemptId!, { workerId: pending.id, attemptId: pending.attemptId!, executionId: `execution-${pending.attemptId}`, threadId: `conversation-${pending.id}`, turnId: `turn-${pending.attemptId}`, status: "completed" });
      await vi.advanceTimersByTimeAsync(61 * 60_000);
    }
    await restarted.resume(worker.id, placement);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.current().status).toBe("running");
    if (lateSuccess) expect(f.current().modelCapacityRecovery).toBeUndefined();
    else expect(f.current().modelCapacityRecovery?.retries).toBe(1);
    expect(f.runtime.launch.mock.calls.at(-1)?.[0].model).toBe("gpt-6-astra");
  });

  it("does not consume another CI code-repair attempt during capacity recovery", async () => {
    const f = fixture();
    const worker = await capacityWait(f);
    await f.service.dispose();
    const saved = structuredClone(f.current());
    saved.changeNumber = 7;
    saved.headSha = "a".repeat(40);
    saved.ciRepair = {
      phase: "repairing", attempts: 1, attemptedHeads: [saved.headSha], attemptId: worker.attemptId,
      diagnostic: { repository, changeNumber: 7, sourceHeadSha: saved.headSha, targetHeadSha: "b".repeat(40), testedSha: saved.headSha, failureKey: "code-failure", state: "actionable", jobs: [
        { runId: "run", runAttempt: 1, jobId: "job", name: "test", url: "https://github.com/a/b/actions/runs/1", conclusion: "failure", classification: "code", log: "A regression failed", testedSha: saved.headSha },
      ] },
    };
    f.seed([saved]);
    const restarted = f.createService();
    await vi.advanceTimersByTimeAsync(30_000);
    await restarted.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.current().ciRepair).toMatchObject({ phase: "repairing", attempts: 1, attemptedHeads: [saved.headSha], attemptId: f.current().attemptId });
    expect(f.reports.prepare.mock.calls.at(-1)?.[1]).toMatchObject({ ciRepair: { attempts: 1 } });
  });

  it("restores the linked issue loop when a person resumes an exhausted reviewer", async () => {
    const f = fixture();
    const { service, issue, review } = await linkedReviewWait(f);
    for (let retry = 0; retry < MAX_FORGE_MODEL_CAPACITY_RETRIES; retry++) {
      await vi.advanceTimersByTimeAsync(Date.parse(f.current(review.id).modelCapacityRecovery!.retryAt!) - Date.now());
      await service.poll();
      f.fail(f.current(review.id));
      await service.poll();
    }
    expect(f.current(review.id).modelCapacityRecovery?.retries).toBe(5);
    await vi.advanceTimersByTimeAsync(5000);
    await service.poll();
    expect(f.current(issue.id).status).toBe("failed");
    await service.resume(issue.id, placement);
    expect(f.current(review.id)).toMatchObject({ status: "running", modelCapacityRecovery: { retries: 0 } });
    expect(f.current(issue.id)).toMatchObject({ status: "awaiting_review" });
    expect(f.current(issue.id).error).toBeUndefined();
  });

  it("cancels a capacity wait when syncing supersedes the linked review", async () => {
    const f = fixture();
    const { service, issue, review } = await linkedReviewWait(f);
    const launches = f.runtime.launch.mock.calls.length;
    await service.syncAndReview(issue.id, placement);
    expect(f.runtime.syncPublishedBranch).toHaveBeenCalledTimes(1);
    expect(f.current(review.id).modelCapacityRecovery).toBeUndefined();
    expect(f.runtime.launch).toHaveBeenCalledTimes(launches + 1);
    await vi.advanceTimersByTimeAsync(30_000);
    await service.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(launches + 1);
  });

  it("restores the linked loop when restart first discovers the reviewer's terminal capacity failure", async () => {
    const f = fixture();
    const { service, issue, review } = await linkedReviewWait(f);
    await service.dispose();
    const workers = structuredClone(f.stored());
    const parent = workers.find(worker => worker.id === issue.id)!;
    parent.status = "awaiting_review";
    const reviewer = workers.find(worker => worker.id === review.id)!;
    reviewer.status = "running";
    reviewer.modelCapacityRecovery = undefined;
    f.seed(workers);
    const restarted = f.createService();
    await restarted.dashboard();
    expect(f.current(issue.id).status).toBe("awaiting_review");
    expect(f.current(review.id)).toMatchObject({ status: "paused", modelCapacityRecovery: { retries: 0, retryAt: "2026-11-04T00:00:30.000Z" } });
  });

  it("cancels a capacity deadline after the request merges while its issue is still open", async () => {
    const f = fixture();
    await capacityWait(f);
    await f.service.dispose();
    const saved = structuredClone(f.current());
    saved.changeNumber = 7;
    saved.headSha = "a".repeat(40);
    f.seed([saved]);
    const change = await f.provider.getChangeRequest();
    f.provider.getChangeRequestStatus.mockResolvedValue({ ...change, merged: true, state: "merged" });
    const restarted = f.createService();
    await restarted.poll();
    expect(f.current().status).toBe("paused");
    expect(f.current().error).toContain("Waiting for linked issues to close");
    expect(f.current().modelCapacityRecovery).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    await restarted.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
  });

  it("keeps the old receipt identity valid while a resumed reviewer prepares its comparison", async () => {
    const f = fixture();
    const { service, review } = await linkedReviewWait(f);
    let release!: () => void;
    f.runtime.prepareReviewScope.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { kind: "initial", current: { headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeBaseSha: "b".repeat(40) } };
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const polling = service.poll();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const unrelated = await service.startIssue(repository, 2, placement);
    expect(f.current(review.id)).toMatchObject({ status: "starting", attemptId: review.attemptId, modelCapacityRecovery: { retryAt: "2026-11-04T00:00:30.000Z" } });
    expect(f.current(unrelated.id)).toBeDefined();
    release();
    await polling;
    expect(f.current(review.id).status).toBe("running");
  });

  it("checks assigned issue closure before retrying a linked reviewer", async () => {
    const f = fixture();
    const { service, issue, review } = await linkedReviewWait(f);
    const launches = f.runtime.launch.mock.calls.length;
    f.provider.getIssue.mockImplementation(async number => ({ number, title: "Fix issue", body: "Task", url: "https://github.com/a/b/issues/1", state: "closed", comments: [] }));
    await vi.advanceTimersByTimeAsync(30_000);
    await service.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(launches);
    expect(f.stored().find(worker => worker.id === issue.id)).toBeUndefined();
    expect(f.current(review.id)).toMatchObject({ status: "stopped" });
    expect(f.current(review.id).modelCapacityRecovery).toBeUndefined();
  });

  it("clears recovery durably on native success before a completion report arrives", async () => {
    const f = fixture();
    const worker = await capacityWait(f);
    await vi.advanceTimersByTimeAsync(30_000);
    await f.service.poll();
    const next = f.current();
    f.bridges.get(next.attemptId!)!.fromServer({ method: "turn/completed", params: { threadId: `conversation-${worker.id}`, turn: { id: `turn-${next.attemptId}`, status: "completed" } } });
    await f.service.poll();
    expect(f.current().modelCapacityRecovery).toBeUndefined();
    expect(f.current().error).toBeUndefined();
  });
});

it("validates structured native errors and persisted recovery boundaries", () => {
  const turn = { workerId: "worker", attemptId: "attempt", threadId: "thread", turnId: "turn", status: "failed", nativeError: { code: "serverOverloaded" } };
  expect(isForgeTurnCompletion(turn)).toBe(true);
  expect(isForgeTurnCompletion({ ...turn, nativeError: { code: 1 } })).toBe(false);
  expect(isForgeTurnCompletion({ ...turn, executionId: "" })).toBe(false);
});

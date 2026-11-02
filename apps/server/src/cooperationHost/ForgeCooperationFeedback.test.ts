import { describe, expect, it, vi } from "vitest";
import type { ForgeWorker } from "@cloudx/shared";
import type { CooperationAgentBinding } from "../cooperationAgent/AgentCooperationContext.js";
import type { AgentFeedbackEnvelope } from "../cooperationAgent/NativeAgentFeedbackPort.js";
import type { ForgeWorkflowService } from "../forge/ForgeWorkflowService.js";
import { ForgeCooperationFeedback } from "./ForgeCooperationFeedback.js";

function fixture() {
  const worker = { id: "worker", kind: "issue", number: 12, status: "paused", tabId: "tab", attemptId: "attempt",
    repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "org/project" },
    placement: { windowId: "window", paneId: "pane" } } as ForgeWorker;
  let listener: ((workers: ForgeWorker[]) => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const continueWorker = vi.fn(async () => worker);
  const forge = { dashboard: async () => ({ workers: [worker] }), continueWorker,
    onStateChange: (next: (workers: ForgeWorker[]) => void) => { listener = next; return unsubscribe; }
  } as unknown as ForgeWorkflowService;
  const onReady = vi.fn();
  const onError = vi.fn();
  const delivery = new ForgeCooperationFeedback({ forge, onReady, onError });
  const binding: CooperationAgentBinding = { tabId: worker.tabId!, boardId: "board", assignmentGeneration: 1,
    providerId: "codex", ownerPluginId: "forge", logicalRunId: worker.id, attemptId: worker.attemptId };
  const envelope: AgentFeedbackEnvelope = { recipientTabId: binding.tabId, boardId: "board", assignmentGeneration: 1,
    boardRevision: 2, eventIds: ["question"], text: "Answer this board question." };
  return { worker, binding, envelope, delivery, continueWorker, onReady, onError, unsubscribe, changed: () => listener?.([worker]) };
}

describe("managed blackboard feedback", () => {
  it("uses the original workflow and placement for one tracked continuation", async () => {
    const f = fixture();
    expect(await f.delivery.deliver(f.envelope, f.binding)).toMatchObject({ state: "queued" });
    expect(f.continueWorker).toHaveBeenCalledExactlyOnceWith("worker", "Answer this board question.\nCLOUDX_COOPERATION_EVENTS:question", f.worker.placement);
  });

  it("leaves busy feedback queued and wakes once when owner admission becomes ready", async () => {
    const f = fixture();
    f.worker.status = "running";
    await f.delivery.start();
    expect(await f.delivery.deliver(f.envelope, f.binding)).toMatchObject({ state: "queued" });
    expect(f.continueWorker).not.toHaveBeenCalled();
    f.worker.status = "paused";
    f.changed();
    f.changed();
    expect(f.onReady).toHaveBeenCalledExactlyOnceWith("tab");
    f.delivery.dispose();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects another owner, changed attempt and missing placement before starting work", async () => {
    const f = fixture();
    expect((await f.delivery.deliver(f.envelope, { ...f.binding, ownerPluginId: "other" })).state).toBe("unavailable");
    expect((await f.delivery.deliver(f.envelope, { ...f.binding, attemptId: "stale" })).state).toBe("unavailable");
    f.worker.placement = undefined;
    expect((await f.delivery.deliver(f.envelope, f.binding)).state).toBe("unavailable");
    expect(f.continueWorker).not.toHaveBeenCalled();
  });

  it("keeps a failed handoff uncertain instead of launching another attempt", async () => {
    const f = fixture();
    f.continueWorker.mockRejectedValueOnce(new Error("Native launch acknowledgment lost"));
    expect((await f.delivery.deliver(f.envelope, f.binding)).state).toBe("unknown");
    expect(f.continueWorker).toHaveBeenCalledOnce();
    expect(f.onError).toHaveBeenCalledOnce();
  });
});

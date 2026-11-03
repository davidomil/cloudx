import { forgeWorkerContinuationBlocker, type ForgeWorker } from "@cloudx/shared";

import type { CooperationAgentBinding } from "../cooperationAgent/AgentCooperationContext.js";
import type { AgentFeedbackDelivery, AgentFeedbackEnvelope } from "../cooperationAgent/NativeAgentFeedbackPort.js";
import type { ForgeWorkflowService } from "../forge/ForgeWorkflowService.js";

interface Options {
  forge: ForgeWorkflowService;
  onReady: (tabId: string) => void;
  onError: (error: unknown) => void;
}

/** An owned tab can wake only through its existing workflow's continuation gates. */
export class ForgeCooperationFeedback {
  private readonly admissions = new Map<string, boolean>();
  private unsubscribe?: () => void;

  constructor(private readonly options: Options) {}

  async start(): Promise<void> {
    this.observe((await this.options.forge.dashboard()).workers);
    this.unsubscribe = this.options.forge.onStateChange(workers => this.observe(workers));
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.admissions.clear(); }

  async deliver(envelope: AgentFeedbackEnvelope, binding: CooperationAgentBinding): Promise<AgentFeedbackDelivery> {
    if (binding.ownerPluginId !== "forge" || !binding.logicalRunId)
      return { state: "unavailable", reason: "This owner has no tracked blackboard continuation adapter." };
    const { workers } = await this.options.forge.dashboard();
    const worker = workers.find(candidate => candidate.id === binding.logicalRunId);
    if (!worker || worker.tabId !== binding.tabId || worker.attemptId !== binding.attemptId)
      return { state: "unavailable", reason: "The owning workflow's native attempt changed before delivery." };
    const blocker = forgeWorkerContinuationBlocker(worker, workers);
    if (blocker) return { state: "queued", reason: blocker };
    if (!worker.placement) return { state: "unavailable", reason: "Choose a workspace placement in the owning workflow before continuing." };
    try {
      await this.options.forge.continueWorker(worker.id,
        `${envelope.text}\nCLOUDX_COOPERATION_EVENTS:${envelope.eventIds.join(",")}`, worker.placement);
      return { state: "queued", reason: "The tracked continuation started. Awaiting native acceptance or an explicit feedback claim." };
    } catch (error) {
      this.options.onError(error);
      return { state: "unknown", reason: "The owning workflow did not confirm continuation. Inspect its saved attempt before redirecting feedback." };
    }
  }

  private observe(workers: ForgeWorker[]): void {
    const next = new Map<string, boolean>();
    for (const worker of workers) {
      if (!worker.tabId) continue;
      const ready = Boolean(worker.placement) && !forgeWorkerContinuationBlocker(worker, workers);
      next.set(worker.tabId, ready);
      if (ready && this.admissions.get(worker.tabId) === false) this.options.onReady(worker.tabId);
    }
    this.admissions.clear();
    for (const [tabId, ready] of next) this.admissions.set(tabId, ready);
  }
}

import type { VoiceActionPlan, VoiceExecutionResult } from "@cloudx/shared";

import type { SessionStore } from "../sessionStore.js";
import type { VoicePlanner } from "./VoicePlanner.js";
import type { VoiceContextProvider } from "../appServer/AppServerContextProvider.js";

export class VoiceController {
  constructor(
    private readonly sessions: SessionStore,
    private readonly planner: VoicePlanner,
    private readonly contextProvider?: VoiceContextProvider
  ) {}

  async handleTranscript(transcript: string, activeTabId?: string, clientContext?: Record<string, unknown>): Promise<VoiceExecutionResult> {
    const trimmedTranscript = transcript.trim();
    if (!trimmedTranscript) {
      throw new Error("Transcript is empty.");
    }

    const baseContext = this.contextProvider ? await this.contextProvider.context(activeTabId) : await this.sessions.buildVoiceContext(activeTabId);
    const context = attachClientVoiceContext(baseContext, clientContext);
    const plan = await this.planner.plan({ transcript: trimmedTranscript, context });
    return this.executePlan(plan, activeTabId);
  }

  private async executePlan(plan: VoiceActionPlan, activeTabId?: string): Promise<VoiceExecutionResult> {
    const results: VoiceExecutionResult["results"] = [];

    for (const action of plan.actions) {
      try {
        const result = await this.sessions.executeVoiceAction(action, activeTabId);
        results.push({ action: action.action, targetTabId: action.targetTabId ?? activeTabId, ok: true, result });
      } catch (error) {
        results.push({
          action: action.action,
          targetTabId: action.targetTabId ?? activeTabId,
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      accepted: results.every((result) => result.ok),
      plan,
      results
    };
  }
}

export function attachClientVoiceContext(context: Record<string, unknown>, clientContext?: Record<string, unknown>): Record<string, unknown> {
  if (!clientContext) {
    return context;
  }
  return {
    ...context,
    client: clientContext,
    workspace:
      typeof context.workspace === "object" && context.workspace !== null && !Array.isArray(context.workspace)
        ? { ...context.workspace, client: clientContext }
        : context.workspace
  };
}

import type { VoiceExecutionResult } from "@cloudx/shared";

import type { SessionStore } from "../sessionStore.js";
import type { VoicePlanner } from "./VoicePlanner.js";
import type { VoiceContextProvider } from "../appServer/AppServerContextProvider.js";

export class VoiceController {
  constructor(
    private readonly sessions: SessionStore,
    private readonly planner: VoicePlanner,
    private readonly contextProvider?: VoiceContextProvider
  ) {}

  async handleTranscript(transcript: string, activeTabId?: string): Promise<VoiceExecutionResult> {
    if (!transcript.trim()) {
      throw new Error("Transcript is empty.");
    }
    const context = this.contextProvider ? await this.contextProvider.context(activeTabId) : await this.sessions.buildVoiceContext(activeTabId);
    const plan = await this.planner.plan({ transcript, context });
    const results: VoiceExecutionResult["results"] = [];

    for (const action of plan.actions) {
      try {
        await this.sessions.executeVoiceAction(action, activeTabId);
        results.push({ action: action.action, targetTabId: action.targetTabId ?? activeTabId, ok: true });
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

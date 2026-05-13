import type { VoiceActionPlan, VoiceExecutionResult } from "@cloudx/shared";

import type { SessionStore } from "../sessionStore.js";
import type { VoicePlanner } from "./VoicePlanner.js";
import type { VoiceContextProvider } from "../appServer/AppServerContextProvider.js";
import {
  actionLogFields,
  planLogFields,
  serializeError,
  summarizeClientContext,
  summarizeRecordForLog,
  summarizeVoiceContext,
  transcriptLogFields,
  type StructuredVoiceLogger,
  type VoiceDebugLogOptions,
  type VoiceTrace
} from "./VoiceDebugLog.js";

export class VoiceController {
  constructor(
    private readonly sessions: SessionStore,
    private readonly planner: VoicePlanner,
    private readonly contextProvider?: VoiceContextProvider,
    private readonly logger?: StructuredVoiceLogger,
    private readonly logOptions: VoiceDebugLogOptions = {}
  ) {}

  async handleTranscript(
    transcript: string,
    activeTabId?: string,
    clientContext?: Record<string, unknown>,
    trace: VoiceTrace = {}
  ): Promise<VoiceExecutionResult> {
    const trimmedTranscript = transcript.trim();
    if (!trimmedTranscript) {
      throw new Error("Transcript is empty.");
    }

    this.logger?.info(
      {
        event: "voice_transcript_received",
        voiceRequestId: trace.voiceRequestId,
        source: trace.source,
        activeTabId,
        clientContext: summarizeClientContext(clientContext),
        ...transcriptLogFields(trimmedTranscript, this.logOptions.includeText)
      },
      "voice transcript received"
    );

    const baseContext = this.contextProvider ? await this.contextProvider.context(activeTabId) : await this.sessions.buildVoiceContext(activeTabId);
    const context = attachClientVoiceContext(baseContext, clientContext);
    this.logger?.info(
      {
        event: "voice_context_built",
        voiceRequestId: trace.voiceRequestId,
        source: trace.source,
        ...summarizeVoiceContext(context)
      },
      "voice context built"
    );

    const plannerStartedAt = Date.now();
    let plan: VoiceActionPlan;
    try {
      plan = await this.planner.plan({ transcript: trimmedTranscript, context, voiceRequestId: trace.voiceRequestId, source: trace.source });
    } catch (error) {
      this.logger?.error(
        {
          event: "voice_planner_failed",
          voiceRequestId: trace.voiceRequestId,
          source: trace.source,
          durationMs: Date.now() - plannerStartedAt,
          err: serializeError(error)
        },
        "voice planner failed"
      );
      throw error;
    }
    this.logger?.info(
      {
        event: "voice_plan_received",
        voiceRequestId: trace.voiceRequestId,
        source: trace.source,
        durationMs: Date.now() - plannerStartedAt,
        ...planLogFields(plan, this.logOptions.includeText)
      },
      "voice plan received"
    );
    return this.executePlan(plan, activeTabId, trace);
  }

  private async executePlan(plan: VoiceActionPlan, activeTabId?: string, trace: VoiceTrace = {}): Promise<VoiceExecutionResult> {
    const results: VoiceExecutionResult["results"] = [];
    let fallbackTabId = activeTabId;

    for (const [index, action] of plan.actions.entries()) {
      const startedAt = Date.now();
      this.logger?.info(
        {
          event: "voice_action_started",
          voiceRequestId: trace.voiceRequestId,
          source: trace.source,
          fallbackTabId,
          ...actionLogFields(action, this.logOptions.includeText, index)
        },
        "voice action started"
      );
      try {
        const result = await this.sessions.executeVoiceAction(action, fallbackTabId);
        const resultTargetTabId = action.targetTabId ?? fallbackTabId;
        results.push({ action: action.action, targetTabId: resultTargetTabId, ok: true, result });
        fallbackTabId = nextFallbackTabId(result, fallbackTabId);
        this.logger?.info(
          {
            event: "voice_action_completed",
            voiceRequestId: trace.voiceRequestId,
            source: trace.source,
            durationMs: Date.now() - startedAt,
            actionIndex: index,
            action: action.action,
            targetTabId: resultTargetTabId,
            nextFallbackTabId: fallbackTabId,
            ok: true,
            result: summarizeRecordForLog(result, this.logOptions.includeText)
          },
          "voice action completed"
        );
      } catch (error) {
        results.push({
          action: action.action,
          targetTabId: action.targetTabId ?? fallbackTabId,
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
        this.logger?.error(
          {
            event: "voice_action_failed",
            voiceRequestId: trace.voiceRequestId,
            source: trace.source,
            durationMs: Date.now() - startedAt,
            actionIndex: index,
            action: action.action,
            targetTabId: action.targetTabId ?? fallbackTabId,
            ok: false,
            err: serializeError(error)
          },
          "voice action failed"
        );
      }
    }

    this.logger?.info(
      {
        event: "voice_execution_completed",
        voiceRequestId: trace.voiceRequestId,
        source: trace.source,
        accepted: results.every((result) => result.ok),
        actionCount: plan.actions.length,
        resultCount: results.length,
        failedCount: results.filter((result) => !result.ok).length
      },
      "voice execution completed"
    );

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

function nextFallbackTabId(result: Record<string, unknown>, currentFallbackTabId: string | undefined): string | undefined {
  if (typeof result.activeTabId === "string" && result.activeTabId.trim()) {
    return result.activeTabId;
  }
  if (isRecord(result.tab) && typeof result.tab.id === "string" && result.tab.id.trim()) {
    return result.tab.id;
  }
  return currentFallbackTabId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  MODEL_ID_PATTERN,
  agentProviderLabel,
  isAgentProviderId,
  readAgentSelection,
  type AgentProviderId,
  type AgentSwitchRequest
} from "@cloudx/shared";

import type { AgentAccountStore } from "./AgentAccountStore.js";
import { readAgentTranscript, writeAgentHandoff } from "./AgentHandoff.js";
import { isClaudeModel } from "./claude/ClaudeLaunch.js";
import { resumeSessionId } from "./resumeInput.js";

export interface AgentSwitchContext {
  cwd: string;
  // The tab's current startup input, as saved for restore.
  initialInput: Record<string, unknown> | undefined;
  accounts: AgentAccountStore;
  transcriptPath(providerId: AgentProviderId, sessionId: string): Promise<string>;
}

// Per-launch bookkeeping that must not carry over to the next runner.
const LAUNCH_ONLY_KEYS = ["prompt", "resume", "model", "reasoningEffort", "agent", "agentHandoff", "codexExecutionId", "codexIdentityError", "codexRecovered"];

// Returns the startup input that relaunches a tab on the requested account.
// The caller checks that no turn is running before switching.
// The same provider resumes its native conversation; another provider starts
// from a handoff file written from the current conversation.
export async function prepareAgentSwitch(context: AgentSwitchContext, request: AgentSwitchRequest): Promise<Record<string, unknown>> {
  if (!isAgentProviderId(request.providerId)) throw new Error("Choose Codex or Claude.");
  const validModel = request.providerId === "claude" ? isClaudeModel : (model: string) => MODEL_ID_PATTERN.test(model);
  if (request.model !== undefined && !validModel(request.model))
    throw new Error(`The model is not valid for ${agentProviderLabel(request.providerId)}.`);
  const current = readAgentSelection(context.initialInput?.agent) ?? { providerId: "codex" as const };
  const target = await context.accounts.resolve(request.providerId, request.accountId);
  const sessionId = resumeSessionId(context.initialInput);
  const previous = context.initialInput ?? {};
  const next: Record<string, unknown> = Object.fromEntries(Object.entries(previous).filter(([key]) => !LAUNCH_ONLY_KEYS.includes(key)));
  next.agent = { providerId: target.providerId, accountId: target.id };

  if (current.providerId === target.providerId) {
    const model = request.model ?? previous.model;
    if (model !== undefined) next.model = model;
    if (previous.reasoningEffort !== undefined) next.reasoningEffort = previous.reasoningEffort;
    if (sessionId) next.resume = { mode: "session", sessionId };
    return next;
  }
  if (request.model) next.model = request.model;
  if (!sessionId) return next;
  const fromAccount = current.accountId ? (await context.accounts.list()).find(account => account.id === current.accountId) : undefined;
  const handoff = await writeAgentHandoff({
    cwd: context.cwd,
    from: { providerId: current.providerId, accountLabel: fromAccount?.label, sessionId },
    to: { providerId: target.providerId, accountLabel: target.label },
    entries: await readAgentTranscript(current.providerId, await context.transcriptPath(current.providerId, sessionId))
  });
  return { ...next, prompt: handoff.prompt, agentHandoff: handoff.path };
}

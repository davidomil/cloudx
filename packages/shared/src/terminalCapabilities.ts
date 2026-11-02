import { isAgentProviderId, type AgentProviderId } from "./agents.js";

export interface TerminalCapabilities {
  tabId: string;
  providerId?: AgentProviderId;
  executionId?: string;
  commandCapture: boolean;
}

export function parseTerminalCapabilities(value: unknown): TerminalCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid terminal capabilities.");
  const v = value as Record<string, unknown>;
  if (typeof v.tabId !== "string" || !v.tabId || typeof v.commandCapture !== "boolean" || v.providerId !== undefined && !isAgentProviderId(v.providerId) || v.executionId !== undefined && (typeof v.executionId !== "string" || !v.executionId)) throw new Error("Invalid terminal capabilities.");
  return { tabId: v.tabId, commandCapture: v.commandCapture, ...(v.providerId === undefined ? {} : { providerId: v.providerId as AgentProviderId }), ...(v.executionId === undefined ? {} : { executionId: v.executionId as string }) };
}

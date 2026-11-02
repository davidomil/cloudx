import type { AgentProviderId } from "./agents.js";

/** Launch-time observations. These do not describe a running client's later state. */
export interface AgentLaunchRecord {
  providerId: AgentProviderId;
  tabId: string;
  executionId: string;
  recordedAt: string;
  command: string;
  version: string | null;
  accountId: string | null;
  cwd: string;
  arguments: string[];
  environmentKeys: string[];
  enforcedEnvironmentKeys: string[];
  claudeLaunchPolicy?: import("./claudeLaunchPolicy.js").ClaudeResolvedLaunchPolicy;
  claudeLaunchModeSource?: "launch" | "saved" | "default" | "conversation";
  historicalClaudeConversation?: true;
  skillSelections: { name: string; source: "personal" | "synced"; selected: boolean; available: boolean }[];
  configurationSources: {
    path: string;
    state: "file" | "missing" | "unobserved";
    sha256?: string;
  }[];
}

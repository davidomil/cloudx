import { CLAUDE_LAUNCH_MODES, parseClaudeResolvedLaunchPolicy as parsePolicy, resolveClaudeLaunchMode as resolveMode } from "../claude-launch-policy.mjs";
export { CLAUDE_LAUNCH_MODES };
export type ClaudeLaunchMode = typeof CLAUDE_LAUNCH_MODES[number];

export interface ClaudeLaunchModeSelection {
  mode: ClaudeLaunchMode;
  source: "launch" | "saved" | "default";
}

export function resolveClaudeLaunchMode(requested: unknown, saved?: ClaudeLaunchMode | null): ClaudeLaunchModeSelection {
  return resolveMode(requested, saved);
}

export interface ClaudeLaunchSkillSource {
  name: string;
  origin: "cloudx-system" | "selected-template" | "personal" | "synced";
  sourcePath: string;
  sha256: string;
  account?: string;
  nativeSource?: "user";
}

// An observation of the generated launch policy and supplied source snapshot,
// not a claim that every later native runtime setting has been inspected.
export interface ClaudeResolvedLaunchPolicy {
  mode: ClaudeLaunchMode;
  contractVersion: 1;
  nativeVersion: string;
  exclusiveSkills: boolean;
  activation: "next-launch";
  settingSources: string[];
  includedSources: string[];
  excludedSources: string[];
  skills: ClaudeLaunchSkillSource[];
  sourceFiles?: { path: string; state: "file" | "missing"; sha256?: string }[];
}

export function parseClaudeResolvedLaunchPolicy(value: unknown): ClaudeResolvedLaunchPolicy {
  return parsePolicy(value) as ClaudeResolvedLaunchPolicy;
}

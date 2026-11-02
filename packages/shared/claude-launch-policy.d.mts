export const CLAUDE_LAUNCH_MODES: readonly ["native-project", "cloudx-managed"];
export function resolveClaudeLaunchMode(requested: unknown, saved?: "native-project" | "cloudx-managed" | null): { mode: "native-project" | "cloudx-managed"; source: "launch" | "saved" | "default" };
export function parseClaudeResolvedLaunchPolicy(value: unknown): unknown;

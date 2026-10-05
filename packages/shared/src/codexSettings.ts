export interface CodexGlobalSettings {
  revision: string;
  model: string | null;
  serviceTier: string | null;
  fastModeEnabled: boolean | null;
  yoloMode: boolean;
  autoTrustWorkspace: boolean;
  defaultSkills: { id: string; enabled: boolean; available: boolean }[];
  reasoningEffort: string | null;
  webSearch: string | null;
  personality: string | null;
}

export interface CodexGlobalSettingsUpdate {
  expectedRevision: string;
  model?: string | null;
  serviceTier?: "priority" | "default" | "flex" | null;
  yoloMode?: boolean;
  autoTrustWorkspace?: boolean;
  defaultSkills?: Record<string, boolean>;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null;
  webSearch?: "disabled" | "cached" | "indexed" | "live" | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
}

export interface CodexConfigRepairPreview {
  revision: string;
  sourceConfigPath: string;
  selectedCommand: string;
  selectedVersion: string;
  changes: string[];
  canApply: boolean;
  blockedReason: string | null;
}

export function parseCodexConfigRepairPreview(value: unknown): CodexConfigRepairPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex configuration repair preview.");
  const repair = value as Record<string, unknown>;
  if (typeof repair.revision !== "string" || !/^[a-f0-9]{64}$/.test(repair.revision)
    || typeof repair.sourceConfigPath !== "string" || !repair.sourceConfigPath
    || typeof repair.selectedCommand !== "string" || !repair.selectedCommand
    || typeof repair.selectedVersion !== "string" || !repair.selectedVersion
    || !Array.isArray(repair.changes) || !repair.changes.every(change => typeof change === "string")
    || typeof repair.canApply !== "boolean" || (repair.blockedReason !== null && typeof repair.blockedReason !== "string")
    || (repair.canApply && (!repair.changes.length || repair.blockedReason !== null)))
    throw new Error("Invalid Codex configuration repair preview.");
  return repair as unknown as CodexConfigRepairPreview;
}

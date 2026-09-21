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

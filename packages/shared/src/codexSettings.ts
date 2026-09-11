export interface CodexGlobalSettings {
  revision: string;
  model: string | null;
  serviceTier: string | null;
  fastModeEnabled: boolean | null;
}

export interface CodexGlobalSettingsUpdate {
  expectedRevision: string;
  model?: string | null;
  serviceTier?: "priority" | "default" | "flex" | null;
}

// Claude Code settings shown in Settings → Claude. Native settings live in the
// user's ~/.claude/settings.json and also apply to plain `claude`; launch
// preferences apply only to CloudX tabs.
export const CLAUDE_SETTINGS_PLUGIN_ID = "claude-settings";
export const CLAUDE_SETTINGS_HOOKS = {
  read: "claude-settings.read",
  update: "claude-settings.update",
  acceptBypass: "claude-settings.accept-bypass",
  updateCli: "claude-settings.update-cli"
} as const;

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type ClaudeEffortLevel = typeof CLAUDE_EFFORT_LEVELS[number];
export const CLAUDE_UPDATE_CHANNELS = ["latest", "stable", "rc"] as const;
export type ClaudeUpdateChannel = typeof CLAUDE_UPDATE_CHANNELS[number];
export const CLAUDE_LAUNCH_PERMISSION_MODES = ["bypassPermissions", "acceptEdits", "auto", "manual", "plan"] as const;
export type ClaudeLaunchPermissionMode = typeof CLAUDE_LAUNCH_PERMISSION_MODES[number];

export interface ClaudeGlobalSettings {
  revision: string;
  settingsPath: string;
  // Native settings. Null means the key is absent and Claude Code decides.
  model: string | null;
  effortLevel: string | null;
  alwaysThinkingEnabled: boolean | null;
  fastMode: boolean | null;
  outputStyle: string | null;
  language: string | null;
  autoUpdatesChannel: string | null;
  // CloudX launch preferences.
  permissionMode: ClaudeLaunchPermissionMode;
  autoTrustWorkspace: boolean;
  // Bypass consent state from the native settings.
  bypassAccepted: boolean;
  bypassDisabled: boolean;
}

export interface ClaudeGlobalSettingsUpdate {
  expectedRevision: string;
  model?: string | null;
  effortLevel?: ClaudeEffortLevel | null;
  alwaysThinkingEnabled?: boolean | null;
  fastMode?: boolean | null;
  outputStyle?: string | null;
  language?: string | null;
  autoUpdatesChannel?: ClaudeUpdateChannel | null;
  permissionMode?: ClaudeLaunchPermissionMode;
  autoTrustWorkspace?: boolean;
}

export interface ClaudeCliStatus {
  installed: boolean;
  command: string;
  version?: string;
  output?: string;
}

export const CLAUDE_MODEL_ID_PATTERN = /^(?:claude-[a-z0-9.-]{1,96}|opus|sonnet|haiku|fable|default|opusplan)(?:\[1m\])?$/u;
export const CLAUDE_TEXT_SETTING_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._:-]{0,63}$/u;

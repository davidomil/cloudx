import inventory from "./claudeConfigurationInventory.json" with { type: "json" };
import { CLAUDE_BOOLEAN_SETTINGS } from "./claudeSettings.js";

export type ClaudeConfigurationFamily = "settings" | "environment" | "cli";
export type ClaudeConfigurationDisposition = "editable" | "launch-policy" | "managed" | "account" | "native-only" | "session-only" | "unsupported" | "legacy";

export interface ClaudeConfigurationEntry {
  family: ClaudeConfigurationFamily;
  name: string;
  topic: string;
  scope: string;
  source: number;
  anchor: string;
  type: string;
  defaultKind: string;
  nativeDefault: unknown;
  minimumVersion: string | null;
  versionMentions: string[];
  lifecycle: string;
  referenceRows: number;
}

export const CLAUDE_CONFIGURATION_REFERENCE = inventory;
export const CLAUDE_SETTINGS_NATIVE_REVIEW = {
  version: "2.1.316",
  reviewedAt: "2026-11-01",
  settings: [...CLAUDE_BOOLEAN_SETTINGS, "modelSettings", "language", "autoUpdatesChannel"],
  scope: "Saved user values, native source merging, launch precedence and unset; no model work or full runtime-default certification",
} as const;
const entries = inventory.entries as ClaudeConfigurationEntry[];
const curated = new Set(["model", "modelSettings", "alwaysThinkingEnabled", "fastMode", "outputStyle", "language", "autoUpdatesChannel", ...CLAUDE_BOOLEAN_SETTINGS]);
const launchPolicy = new Set(["permissions.defaultMode", "disableBundledSkills", "autoMemoryEnabled", "syncClaudeAiSkills", "syncClaudeAiPlugins", "skillOverrides", "enabledPlugins", "hooks", "disableAllHooks"]);
const launchFlags = new Set(["--settings", "--add-dir", "--permission-mode", "--dangerously-skip-permissions", "--model", "--effort", "--resume", "--continue", "--session-id"]);
const nativeOwnerReasons: Record<string, string> = {
  "Sandbox settings": "Native platform isolation and protected-path policy need a reviewed host boundary before CloudX can edit them. Use the native sandbox owner; existing policy is preserved.",
  "Permission settings": "Native permission rules and scope merging are security policy. CloudX exposes its starting-mode choice above; edit other rules through the native permission owner.",
  MCP: "Native MCP configuration owns server execution, credentials and managed restrictions. This catalog does not create a managed CloudX MCP lifecycle or expose server secrets.",
  "Hooks and automation": "Native hooks can execute commands and affect receipt delivery. CloudX checks known receipt conflicts; custom hook editing stays with the native hook owner.",
  "Plugins and skills": "Plugin installation and mutable skill-source enforcement need their own reviewed lifecycle. CloudX shows its launch selection above and preserves other native configuration.",
  "Memory and context": "Complex native memory and context values can depend on the model or contain host paths. Only explicitly typed controls are editable here; use the native owner for other values.",
  "Privacy and telemetry": "Privacy and telemetry settings can route data or invoke credential helpers. They remain native-owned until their scope and data boundary have a reviewed CloudX editor.",
  "Remote, desktop, and notifications": "Remote and desktop integrations do not establish a CloudX session, notification or host lifecycle. Configure them in the native surface that owns them."
};

export function claudeConfigurationDisposition(entry: ClaudeConfigurationEntry): { kind: ClaudeConfigurationDisposition; reason: string } {
  if (entry.lifecycle === "removed" || entry.lifecycle === "deprecated" || entry.name === "effortLevel")
    return { kind: "legacy", reason: "Legacy or removed native contract. Kept discoverable; existing native values are preserved. Use the referenced replacement where applicable." };
  if (entry.family === "settings" && entry.scope === "Managed")
    return { kind: "managed", reason: "Organization policy. Read-only in CloudX; this panel does not observe remote, MDM or registry effective policy." };
  if (/auth|credential|api.?key|token|headers|login|provider|base.?url|AWS_|GOOGLE_|GCLOUD_|AZURE_|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_(?:MANTLE|VERTEX|BEDROCK|FOUNDRY|ANTHROPIC_AWS)/iu.test(entry.name) || entry.topic === "Authentication and providers")
    return { kind: "account", reason: "Account, credential or provider configuration. Use the account owner or native organization configuration; values are excluded from this catalog." };
  if (entry.family === "settings" && curated.has(entry.name))
    return { kind: "editable", reason: entry.name === "modelSettings" ? "The model effort control edits effort only and preserves caps, compaction and other model fields." : "Typed saved user setting. Higher-precedence policy and launch sources can override it; open-session effective values are not observed." };
  if (entry.family === "settings" && launchPolicy.has(entry.name))
    return { kind: "launch-policy", reason: entry.name === "disableAllHooks" ? "CloudX requires receipt hooks and rejects detected conflicting file-backed policy before launching; it never changes this native hook policy." : "CloudX supplies launch policy for this family. Inspect Defaults and launch policy; saved native files remain separate and unchanged." };
  if (entry.family === "cli" && launchFlags.has(entry.name.split(/[ ,]/u)[0]!))
    return { kind: "launch-policy", reason: "CloudX owns this launch flag for account selection, hooks, skills, permission mode, or explicit per-run model/effort/conversation choices. It does not change running clients." };
  if (/agent.?view|background|worktree|teammate|remote.?control|--(?:bg|background|worktree|tmux)\b/iu.test(entry.name) || entry.topic === "Agents, sessions, and worktrees")
    return { kind: "unsupported", reason: "Native lifecycle is not owned, recovered or cleaned up by CloudX. Not supported as a managed CloudX session." };
  if (entry.family === "cli")
    return { kind: "session-only", reason: "Native command or session flag, not a persistent setting. Only explicitly supported CloudX launch controls manage sessions." };
  return { kind: "native-only", reason: entry.scope === "Global config"
    ? "Native global configuration, not settings.json. Only the documented clipboard/editor preferences are inherited; other global keys remain native-owned."
    : nativeOwnerReasons[entry.topic] ?? "No reviewed typed CloudX control is provided for this structured or native-specific option. Use its documented native owner at the allowed scope; unknown and unrelated native keys survive CloudX edits." };
}

export function claudeConfigurationCatalog(query = "", family?: ClaudeConfigurationFamily): ClaudeConfigurationEntry[] {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return entries.filter(entry => (!family || entry.family === family) && terms.every(term =>
    `${entry.name} ${entry.topic} ${entry.scope} ${claudeConfigurationDisposition(entry).kind}`.toLocaleLowerCase().includes(term)));
}

export function claudeConfigurationAvailability(entry: ClaudeConfigurationEntry, installedVersion?: string): string {
  const version = installedVersion?.match(/\b\d+\.\d+\.\d+\b/u)?.[0];
  if (!version) return "Native version/effective behavior unverified";
  if (entry.minimumVersion && compareVersions(version, entry.minimumVersion) < 0) return `Requires native ${entry.minimumVersion}+; selected ${version} is older`;
  if (version === CLAUDE_SETTINGS_NATIVE_REVIEW.version && entry.family === "settings"
    && CLAUDE_SETTINGS_NATIVE_REVIEW.settings.some(name => name === entry.name))
    return `Saved user value, source merging and unset verified with native ${version}; running-session behavior remains setting-dependent`;
  return entry.minimumVersion ? `Documented since ${entry.minimumVersion}; selected ${version} runtime unverified` : `Minimum version not established; selected ${version} runtime unverified`;
}

export function claudeConfigurationRequiresNewerVersion(entry: ClaudeConfigurationEntry, installedVersion?: string): boolean {
  const version = installedVersion?.match(/\b\d+\.\d+\.\d+\b/u)?.[0];
  return Boolean(version && entry.minimumVersion && compareVersions(version, entry.minimumVersion) < 0);
}

function compareVersions(left: string, right: string): number {
  const first = left.split(".").map(Number);
  const second = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (first[index] !== second[index]) return first[index]! - second[index]!;
  return 0;
}

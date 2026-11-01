import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_BOOLEAN_SETTINGS,
  CLAUDE_LAUNCH_PERMISSION_MODES,
  CLAUDE_MODEL_ID_PATTERN,
  CLAUDE_SKILL_NAME_PATTERN,
  CLAUDE_TEXT_SETTING_PATTERN,
  CLAUDE_UPDATE_CHANNELS,
  claudeModelEffort,
  claudeConfigurationCatalog,
  claudeConfigurationRequiresNewerVersion,
  isRecord,
  type ClaudeCliStatus,
  type ClaudeGlobalSettings,
  type ClaudeGlobalSettingsUpdate,
  type ClaudeLaunchPermissionMode,
  type ClaudeSkillChoice
} from "@cloudx/shared";

import { JsonStateFile, writeTextFileAtomic } from "../../jsonStateFile.js";
import { agentCommand, claudeLaunchEnv, readAgentProviderStatus, runAgentCli } from "../agentCli.js";
import { discoverClaudeUserSkills, type ClaudeUserSkill } from "./claudeSkillPolicy.js";

const MAX_SETTINGS_BYTES = 1024 * 1024;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const NATIVE_KEYS = ["model", "alwaysThinkingEnabled", "fastMode", "outputStyle", "language", "autoUpdatesChannel"] as const;
// Claude Code records acceptance of its bypass-permissions warning under this key.
const BYPASS_CONSENT_KEY = "skipDangerousModePermissionPrompt";

export const CLAUDE_BYPASS_WARNING =
  "In bypass permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands. " +
  "Use it only where the working directory and machine can be restored if damaged. " +
  "By accepting, you accept responsibility for actions taken in this mode, the same as accepting the warning inside Claude Code.";

export interface ClaudeLaunchPreferences {
  permissionMode: ClaudeLaunchPermissionMode;
  autoTrustWorkspace: boolean;
  // Personal or synced skills CloudX tabs may use. All others are hidden.
  allowedSkills: string[];
}

const DEFAULT_CLAUDE_LAUNCH_PREFERENCES: ClaudeLaunchPreferences = { permissionMode: "bypassPermissions", autoTrustWorkspace: true, allowedSkills: [] };

function claudeSettingsPath(providerHome: string): string {
  return path.join(providerHome, "settings.json");
}

// Overlays link the user's settings.json. It has to exist first, or Claude
// would write an acceptance into a per-tab file that is discarded.
export async function ensureClaudeSettingsFile(providerHome: string): Promise<void> {
  await fs.mkdir(providerHome, { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(claudeSettingsPath(providerHome), "wx", 0o600);
    try { await handle.writeFile("{}\n"); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

// Single authority for Claude settings: the user's settings.json, shared with
// plain `claude`, and CloudX's own launch preferences. Native keys are edited
// in place and every other key is kept.
export class ClaudeSettingsService {
  private readonly preferences: JsonStateFile;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly providerHome: () => string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.preferences = new JsonStateFile(dataDir, "claude-launch-preferences.json", "Claude launch preferences", 0o600);
  }

  async launchPreferences(): Promise<ClaudeLaunchPreferences> {
    return parsePreferences(await this.preferences.read<unknown>());
  }

  async read(): Promise<ClaudeGlobalSettings> {
    const target = claudeSettingsPath(this.providerHome());
    return { ...settingsFrom(target, await readText(target), await this.launchPreferences(), await discoverClaudeUserSkills(this.providerHome())), effortEnvironmentOverride: Boolean(this.env.CLAUDE_CODE_EFFORT_LEVEL) };
  }

  update(input: ClaudeGlobalSettingsUpdate): Promise<ClaudeGlobalSettings> {
    return this.serialize(() => this.updateNow(input));
  }

  // Records the same acceptance Claude Code writes when the user accepts its
  // bypass warning inside a session.
  acceptBypass(): Promise<ClaudeGlobalSettings> {
    return this.serialize(async () => {
      const target = claudeSettingsPath(this.providerHome());
      await ensureClaudeSettingsFile(this.providerHome());
      const native = parseSettings(target, await readText(target));
      if (native[BYPASS_CONSENT_KEY] !== true) await writeThroughLink(target, { ...native, [BYPASS_CONSENT_KEY]: true });
      return this.read();
    });
  }

  async cliStatus(): Promise<ClaudeCliStatus> {
    const status = await readAgentProviderStatus("claude", this.env);
    return { installed: status.installed, command: status.command ?? agentCommand("claude", this.env), ...(status.version ? { version: status.version } : {}) };
  }

  // Runs Claude Code's own updater, which follows autoUpdatesChannel.
  async updateCli(signal?: AbortSignal): Promise<ClaudeCliStatus> {
    const channel = (await this.read()).autoUpdatesChannel;
    if (channel !== null && !CLAUDE_UPDATE_CHANNELS.some(value => value === channel))
      throw new Error(`Saved Claude update channel ${JSON.stringify(channel)} is unsupported. Select latest, stable, or unset it in Settings → Claude before updating.`);
    const env = claudeLaunchEnv(this.env, this.providerHome(), {});
    const result = await runAgentCli(agentCommand("claude", this.env), ["update"], { env, timeoutMs: UPDATE_TIMEOUT_MS, signal, maxOutputBytes: 256 * 1024 });
    const output = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "").trim().slice(-4_000);
    if (result.code !== 0) throw new Error(`Claude Code update failed${output ? `: ${output}` : "."}`);
    return { ...await this.cliStatus(), output };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async updateNow(input: ClaudeGlobalSettingsUpdate): Promise<ClaudeGlobalSettings> {
    validateUpdate(input);
    const home = this.providerHome();
    const target = claudeSettingsPath(home);
    const original = await readText(target);
    const preferences = await this.launchPreferences();
    const installed = await discoverClaudeUserSkills(home);
    if (input.expectedRevision !== settingsFrom(target, original, preferences, installed).revision) throw new Error("Claude settings changed. Reload before saving again.");

    // Every check runs before either file is written.
    const next: ClaudeLaunchPreferences = {
      permissionMode: input.permissionMode ?? preferences.permissionMode,
      autoTrustWorkspace: input.autoTrustWorkspace ?? preferences.autoTrustWorkspace,
      allowedSkills: input.allowedSkills ? [...new Set(input.allowedSkills)].sort() : preferences.allowedSkills
    };
    for (const name of next.allowedSkills)
      if (!preferences.allowedSkills.includes(name) && !installed.some(skill => skill.name === name)) throw new Error(`Claude skill ${name} is not installed.`);
    const native = parseSettings(target, original);
    const effortChanged = await this.updateModelEffort(native, input);
    const changedKeys = NATIVE_KEYS.filter(key => input[key] !== undefined && input[key] !== (native[key] ?? null));
    const changedOptions = CLAUDE_BOOLEAN_SETTINGS.filter(key => input.nativeOptions?.[key] !== undefined && input.nativeOptions[key] !== (native[key] ?? null));
    if (changedOptions.length) {
      const cli = await this.cliStatus();
      for (const key of changedOptions) {
        const entry = claudeConfigurationCatalog("", "settings").find(entry => entry.name === key)!;
        if (input.nativeOptions![key] !== null && cli.installed && claudeConfigurationRequiresNewerVersion(entry, cli.version))
          throw new Error(`Claude ${key} requires native ${entry.minimumVersion} or later. The selected executable is older; no settings were changed.`);
        if (input.nativeOptions![key] !== null && cli.installed && entry.minimumVersion && !cli.version?.match(/\b\d+\.\d+\.\d+\b/u))
          throw new Error(`Cannot establish the selected Claude version for ${key}. Verify native ${entry.minimumVersion} or later before saving; no settings were changed.`);
      }
    }
    for (const key of changedKeys) {
      if (input[key] === null) delete native[key];
      else native[key] = input[key];
    }
    for (const key of changedOptions) {
      if (input.nativeOptions![key] === null) delete native[key];
      else native[key] = input.nativeOptions![key];
    }
    if (changedKeys.length || effortChanged || changedOptions.length) {
      await ensureClaudeSettingsFile(home);
      // A missing file was just created as {}; anything else means another writer.
      if (await readText(target) !== (original ?? "{}\n")) throw new Error("Claude settings changed. Reload before saving again.");
      await writeThroughLink(target, native);
    }
    if (JSON.stringify(next) !== JSON.stringify(preferences)) await this.preferences.write(next);
    return this.read();
  }

  private async updateModelEffort(native: Record<string, unknown>, input: ClaudeGlobalSettingsUpdate): Promise<boolean> {
    if (input.effortLevel === undefined) return false;
    const requested = input.effortModel ?? input.model ?? native.model;
    if (typeof requested !== "string" || !requested.startsWith("claude-") || !CLAUDE_MODEL_ID_PATTERN.test(requested))
      throw new Error("Choose a full Claude model ID for saved effort. A model alias or account default does not establish which model receives the preference.");
    const capability = claudeModelEffort(requested);
    if (!capability && input.effortLevel !== null) throw new Error("Saved effort is not supported for this model by the reviewed Claude model catalog. Choose a supported full model ID; no settings were changed.");
    if (input.effortLevel !== null && capability && !capability.levels.includes(input.effortLevel))
      throw new Error(`Claude ${capability.model} does not support saved ${input.effortLevel} effort. Choose ${capability.levels.join(", ")}; no settings were changed.`);
    const model = capability?.model ?? requested;
    const cli = await this.cliStatus();
    const version = cli.version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/u)?.slice(1).map(Number);
    if (cli.installed && (!version || version[0]! < 2 || (version[0] === 2 && (version[1]! < 1 || (version[1] === 1 && version[2]! < 251)))))
      throw new Error("Per-model saved effort requires Claude Code 2.1.251 or later. The current executable is unsupported; no settings were changed.");
    if (native.modelSettings !== undefined && !isRecord(native.modelSettings)) throw new Error("Claude modelSettings must be an object before editing effort.");
    const models = { ...(native.modelSettings as Record<string, unknown> | undefined) };
    if (models[model] !== undefined && !isRecord(models[model])) throw new Error(`Claude modelSettings entry for ${model} must be an object before editing effort.`);
    const current = isRecord(models[model]) ? models[model] : {};
    if ((current.effortLevel ?? null) === input.effortLevel) return false;
    const next = { ...current };
    if (input.effortLevel === null) delete next.effortLevel;
    else next.effortLevel = input.effortLevel;
    if (Object.keys(next).length) models[model] = next;
    else delete models[model];
    if (Object.keys(models).length) native.modelSettings = models;
    else delete native.modelSettings;
    return true;
  }
}

function settingsFrom(settingsPath: string, text: string | undefined, preferences: ClaudeLaunchPreferences, installed: ClaudeUserSkill[]): ClaudeGlobalSettings {
  const native = parseSettings(settingsPath, text);
  const skills = skillChoices(installed, preferences.allowedSkills);
  const string = (key: string) => typeof native[key] === "string" ? native[key] as string : null;
  const boolean = (key: string) => typeof native[key] === "boolean" ? native[key] as boolean : null;
  const modelEffortLevels = Object.fromEntries(Object.entries(isRecord(native.modelSettings) ? native.modelSettings : {})
    .filter((entry): entry is [string, Record<string, unknown> & { effortLevel: string }] => isRecord(entry[1]) && typeof entry[1].effortLevel === "string")
    .map(([model, settings]) => [model, settings.effortLevel]));
  const modelEffortLimits = Object.fromEntries(Object.entries(isRecord(native.modelSettings) ? native.modelSettings : {})
    .filter((entry): entry is [string, Record<string, unknown> & { maxEffortLevel: string }] => isRecord(entry[1]) && typeof entry[1].maxEffortLevel === "string")
    .map(([model, settings]) => [model, settings.maxEffortLevel]));
  return {
    revision: createHash("sha256").update(JSON.stringify([settingsPath, text ?? null, preferences, skills])).digest("hex"),
    settingsPath,
    model: string("model"),
    effortLevel: modelEffortLevels[claudeModelEffort(string("model") ?? "")?.model ?? string("model") ?? ""] ?? null,
    modelEffortLevels,
    modelEffortLimits,
    nativeOptions: Object.fromEntries(CLAUDE_BOOLEAN_SETTINGS.map(key => [key, boolean(key)])),
    legacyEffortLevel: string("effortLevel"),
    alwaysThinkingEnabled: boolean("alwaysThinkingEnabled"),
    fastMode: boolean("fastMode"),
    outputStyle: string("outputStyle"),
    language: string("language"),
    autoUpdatesChannel: string("autoUpdatesChannel"),
    permissionMode: preferences.permissionMode,
    autoTrustWorkspace: preferences.autoTrustWorkspace,
    skills,
    bypassAccepted: native[BYPASS_CONSENT_KEY] === true,
    bypassDisabled: isRecord(native.permissions) && native.permissions.disableBypassPermissionsMode === "disable"
  };
}

// Installed skills by name, plus allowed skills that are no longer installed so
// the user can see and remove them.
function skillChoices(installed: ClaudeUserSkill[], allowedSkills: string[]): ClaudeSkillChoice[] {
  const choices = new Map<string, ClaudeSkillChoice>();
  for (const skill of installed)
    if (!choices.has(skill.name)) choices.set(skill.name, { name: skill.name, origin: skill.origin, allowed: allowedSkills.includes(skill.name), available: true });
  for (const name of allowedSkills)
    if (!choices.has(name)) choices.set(name, { name, origin: "personal", allowed: true, available: false });
  return [...choices.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name));
}

function parseSettings(settingsPath: string, text: string | undefined): Record<string, unknown> {
  if (!text?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`${settingsPath} is not valid JSON. Fix it before editing Claude settings.`); }
  if (!isRecord(parsed)) throw new Error(`${settingsPath} must contain a JSON object.`);
  return parsed;
}

function parsePreferences(value: unknown): ClaudeLaunchPreferences {
  if (value === undefined) return { ...DEFAULT_CLAUDE_LAUNCH_PREFERENCES };
  const allowedSkills = isRecord(value) && value.allowedSkills === undefined ? [] : isRecord(value) ? value.allowedSkills : undefined;
  if (!isRecord(value) || !CLAUDE_LAUNCH_PERMISSION_MODES.some(mode => mode === value.permissionMode) || typeof value.autoTrustWorkspace !== "boolean" || !validSkillNames(allowedSkills))
    throw new Error("Claude launch preferences are invalid. Fix or remove claude-launch-preferences.json in the CloudX data directory.");
  return { permissionMode: value.permissionMode as ClaudeLaunchPermissionMode, autoTrustWorkspace: value.autoTrustWorkspace, allowedSkills };
}

function validSkillNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1_000 && value.every(name => typeof name === "string" && CLAUDE_SKILL_NAME_PATTERN.test(name));
}

function validateUpdate(input: ClaudeGlobalSettingsUpdate): void {
  const allowed = ["expectedRevision", ...NATIVE_KEYS, "effortLevel", "effortModel", "nativeOptions", "permissionMode", "autoTrustWorkspace", "allowedSkills"];
  if (!isRecord(input) || Object.keys(input).some(key => !allowed.includes(key)) ||
      typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(input.expectedRevision))
    throw new Error("Invalid Claude settings update.");
  const nullable = <T>(value: T | null | undefined, valid: (value: T) => boolean, message: string) => {
    if (value !== undefined && value !== null && !valid(value)) throw new Error(message);
  };
  nullable(input.model, value => typeof value === "string" && CLAUDE_MODEL_ID_PATTERN.test(value), "Claude model must be a Claude model id or alias such as opus or claude-sonnet-5-5.");
  nullable(input.effortLevel, value => CLAUDE_EFFORT_LEVELS.includes(value), "Invalid Claude effort level.");
  if (input.effortModel !== undefined && (typeof input.effortModel !== "string" || !input.effortModel.startsWith("claude-") || !CLAUDE_MODEL_ID_PATTERN.test(input.effortModel)))
    throw new Error("Claude effortModel must be a full Claude model ID.");
  if (input.effortModel !== undefined && input.effortLevel === undefined) throw new Error("Claude effortModel requires an effort change.");
  nullable(input.autoUpdatesChannel, value => CLAUDE_UPDATE_CHANNELS.includes(value), "Invalid Claude update channel.");
  for (const key of ["alwaysThinkingEnabled", "fastMode"] as const) nullable(input[key], value => typeof value === "boolean", `Claude ${key} must be true or false.`);
  for (const key of ["outputStyle", "language"] as const)
    nullable(input[key], value => typeof value === "string" && CLAUDE_TEXT_SETTING_PATTERN.test(value), `Claude ${key} must be a short name of letters, numbers and spaces.`);
  if (input.permissionMode !== undefined && !CLAUDE_LAUNCH_PERMISSION_MODES.includes(input.permissionMode)) throw new Error("Invalid Claude permission mode.");
  if (input.autoTrustWorkspace !== undefined && typeof input.autoTrustWorkspace !== "boolean") throw new Error("Claude autoTrustWorkspace must be true or false.");
  if (input.allowedSkills !== undefined && !validSkillNames(input.allowedSkills)) throw new Error("Claude allowedSkills must be a list of skill names.");
  if (input.nativeOptions !== undefined && (!isRecord(input.nativeOptions) || Object.entries(input.nativeOptions).some(([key, value]) =>
    !CLAUDE_BOOLEAN_SETTINGS.some(name => name === key) || (value !== null && typeof value !== "boolean"))))
    throw new Error("Claude nativeOptions must contain only supported Boolean user settings or null to unset.");
}

async function readText(target: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error(`${target} is not a readable Claude settings file.`);
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Writes through a settings.json symlink to its target, as Claude Code does,
// so a linked settings file stays linked.
async function writeThroughLink(target: string, settings: Record<string, unknown>): Promise<void> {
  const resolved = await fs.realpath(target);
  const mode = (await fs.stat(resolved)).mode & 0o777;
  await writeTextFileAtomic(path.dirname(resolved), resolved, `${JSON.stringify(settings, null, 2)}\n`, "Claude settings", mode);
}

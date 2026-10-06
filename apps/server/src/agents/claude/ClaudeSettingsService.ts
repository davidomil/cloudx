import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_LAUNCH_PERMISSION_MODES,
  CLAUDE_MODEL_ID_PATTERN,
  CLAUDE_SKILL_NAME_PATTERN,
  CLAUDE_TEXT_SETTING_PATTERN,
  CLAUDE_UPDATE_CHANNELS,
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
const NATIVE_KEYS = ["model", "effortLevel", "alwaysThinkingEnabled", "fastMode", "outputStyle", "language", "autoUpdatesChannel"] as const;
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
    return settingsFrom(target, await readText(target), await this.launchPreferences(), await discoverClaudeUserSkills(this.providerHome()));
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

    const native = parseSettings(target, original);
    const changedKeys = NATIVE_KEYS.filter(key => input[key] !== undefined && input[key] !== (native[key] ?? null));
    for (const key of changedKeys) {
      if (input[key] === null) delete native[key];
      else native[key] = input[key];
    }
    if (changedKeys.length) {
      await ensureClaudeSettingsFile(home);
      // A missing file was just created as {}; anything else means another writer.
      if (await readText(target) !== (original ?? "{}\n")) throw new Error("Claude settings changed. Reload before saving again.");
      await writeThroughLink(target, native);
    }
    const next: ClaudeLaunchPreferences = {
      permissionMode: input.permissionMode ?? preferences.permissionMode,
      autoTrustWorkspace: input.autoTrustWorkspace ?? preferences.autoTrustWorkspace,
      allowedSkills: input.allowedSkills ? [...new Set(input.allowedSkills)].sort() : preferences.allowedSkills
    };
    for (const name of next.allowedSkills)
      if (!preferences.allowedSkills.includes(name) && !installed.some(skill => skill.name === name)) throw new Error(`Claude skill ${name} is not installed.`);
    if (JSON.stringify(next) !== JSON.stringify(preferences)) await this.preferences.write(next);
    return this.read();
  }
}

function settingsFrom(settingsPath: string, text: string | undefined, preferences: ClaudeLaunchPreferences, installed: ClaudeUserSkill[]): ClaudeGlobalSettings {
  const native = parseSettings(settingsPath, text);
  const skills = skillChoices(installed, preferences.allowedSkills);
  const string = (key: string) => typeof native[key] === "string" ? native[key] as string : null;
  const boolean = (key: string) => typeof native[key] === "boolean" ? native[key] as boolean : null;
  return {
    revision: createHash("sha256").update(JSON.stringify([settingsPath, text ?? null, preferences, skills])).digest("hex"),
    settingsPath,
    model: string("model"),
    effortLevel: string("effortLevel"),
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
  const allowed = ["expectedRevision", ...NATIVE_KEYS, "permissionMode", "autoTrustWorkspace", "allowedSkills"];
  if (!isRecord(input) || Object.keys(input).some(key => !allowed.includes(key)) ||
      typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(input.expectedRevision))
    throw new Error("Invalid Claude settings update.");
  const nullable = <T>(value: T | null | undefined, valid: (value: T) => boolean, message: string) => {
    if (value !== undefined && value !== null && !valid(value)) throw new Error(message);
  };
  nullable(input.model, value => typeof value === "string" && CLAUDE_MODEL_ID_PATTERN.test(value), "Claude model must be a Claude model id or alias such as opus or claude-sonnet-5-5.");
  nullable(input.effortLevel, value => CLAUDE_EFFORT_LEVELS.includes(value), "Invalid Claude effort level.");
  nullable(input.autoUpdatesChannel, value => CLAUDE_UPDATE_CHANNELS.includes(value), "Invalid Claude update channel.");
  for (const key of ["alwaysThinkingEnabled", "fastMode"] as const) nullable(input[key], value => typeof value === "boolean", `Claude ${key} must be true or false.`);
  for (const key of ["outputStyle", "language"] as const)
    nullable(input[key], value => typeof value === "string" && CLAUDE_TEXT_SETTING_PATTERN.test(value), `Claude ${key} must be a short name of letters, numbers and spaces.`);
  if (input.permissionMode !== undefined && !CLAUDE_LAUNCH_PERMISSION_MODES.includes(input.permissionMode)) throw new Error("Invalid Claude permission mode.");
  if (input.autoTrustWorkspace !== undefined && typeof input.autoTrustWorkspace !== "boolean") throw new Error("Claude autoTrustWorkspace must be true or false.");
  if (input.allowedSkills !== undefined && !validSkillNames(input.allowedSkills)) throw new Error("Claude allowedSkills must be a list of skill names.");
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

import fs from "node:fs/promises";
import path from "node:path";

import { isRecord, type ClaudeLaunchMode } from "@cloudx/shared";
import { defaultManagedFiles, managedSettingsFiles, readPolicy } from "./ClaudeHookPolicy.js";
import { claudeLoadedSettingsFiles, worktreeLocalSettings } from "./ClaudeSettingsSources.js";

export const CLAUDE_MANAGED_VERSION = "2.1.316";
export const CLAUDE_MANAGED_SETTING_SOURCES = ["user"];
const PLUGIN_KEYS = ["extraKnownMarketplaces", "prependPlugins", "appendPlugins"];
export const CLAUDE_MANAGED_SOURCE_ENV_KEYS = [
  "CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_PLUGIN_DIRS", "CLAUDE_CODE_PLUGIN_SEED_DIR", "CLAUDE_CODE_PLUGIN_ARCHIVE_URL",
  "CLAUDE_CODE_HOST_SKILL_CATALOG", "CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR", "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_MCP_SERVE_ENABLED_PLUGINS", "CLAUDE_AI_PLUGINS_SCOPE", "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG", "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_CODE_SYNC_PLUGINS", "CLAUDE_CODE_SYNC_SKILLS"
] as const;
const INJECTED_SOURCES = /^(?:CLAUDE_CODE_(?:PLUGIN(?:_|$)|HOST_SKILL_CATALOG$|DESKTOP_SKILLS_PLUGIN_DIR$|MCP_SERVE_ENABLED_PLUGINS$|USE_COWORK_PLUGINS$|RESTRICT_PERSONAL_CONFIG$|PROJECT_DIR_NAME$)|CLAUDE_AI_PLUGINS_SCOPE$)/u;

export async function assertClaudeCatalogOwnership(providerHome: string, names: string[], managedFiles = defaultManagedFiles(), launch: { cwd?: string; mode: ClaudeLaunchMode } = { mode: "native-project" }): Promise<void> {
  const assertAvailable = (settings: Record<string, unknown>, file: string) => {
    if (isRecord(settings.skillOverrides)) for (const name of names) if (settings.skillOverrides[name] === "off")
      throw new Error(`Claude skillOverrides in ${file} disables required CloudX skill ${name}. Ask the policy owner to permit the CloudX catalog before launching; CloudX has not changed policy.`);
  };
  for (const file of await claudeLoadedSettingsFiles(providerHome, launch.cwd, launch.mode)) assertAvailable(await readPolicy(file), file);
  for (const file of await managedSettingsFiles(managedFiles)) {
    const policy = await readPolicy(file);
    assertAvailable(policy, file);
    if (policy.strictPluginOnlyCustomization === true || Array.isArray(policy.strictPluginOnlyCustomization) && policy.strictPluginOnlyCustomization.includes("skills"))
      throw new Error(`Claude strictPluginOnlyCustomization in ${file} prevents required CloudX skills. Ask the policy owner to permit the CloudX catalog before launching. CloudX has not changed managed policy.`);
  }
  for (const base of managedFiles) for (const name of names) {
    const source = path.join(path.dirname(base), ".claude", "skills", name, "SKILL.md");
    try {
      if ((await fs.stat(source)).isFile()) throw new Error(`Claude managed skill ${source} conflicts with the required CloudX skill ${name}. Ask the policy owner to resolve the name collision before launching; administrator policy has not been changed.`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function assertClaudeManagedCompatibility(input: {
  providerHome: string; cwd?: string; nativeVersion?: string; env?: NodeJS.ProcessEnv; skillNames: string[]; userSettings?: Record<string, unknown>;
}, managedFiles = defaultManagedFiles()): Promise<void> {
  if (input.nativeVersion?.replace(/ \(Claude Code\)$/u, "") !== CLAUDE_MANAGED_VERSION)
    throw new Error(`CloudX-managed Claude launches are verified only with Claude Code ${CLAUDE_MANAGED_VERSION}. Install that version or choose Native project; no session has started.`);
  if (process.platform !== "linux")
    throw new Error("CloudX-managed Claude policy is verified on Linux only. Choose Native project on this platform; saved preferences are unchanged.");
  assertNoInjectedSources(input.env ?? {}, "launch environment");
  const userFile = path.join(input.providerHome, "settings.json");
  const user = input.userSettings ?? await readPolicy(userFile);
  assertNoPluginSettings(user, userFile);
  assertNoSkillSuppression(user, userFile, input.skillNames);
  if (isRecord(user.env)) assertNoInjectedSources(user.env, userFile);
  for (const file of await managedSettingsFiles(managedFiles)) {
    const settings = await readPolicy(file);
    assertNoPluginSettings(settings, file);
    assertNoSkillSuppression(settings, file, input.skillNames);
    if (settings.disableBundledSkills === false) incompatible(file, "disableBundledSkills enables an unselected bundled source");
    if (isRecord(settings.skillOverrides)) for (const name of ["doctor", "checkup", "design"])
      if (settings.skillOverrides[name] !== undefined && settings.skillOverrides[name] !== "off" && !input.skillNames.includes(name))
        incompatible(file, `skillOverrides enables unselected bundled skill ${name}`);
    if (settings.strictPluginOnlyCustomization === true || Array.isArray(settings.strictPluginOnlyCustomization) && settings.strictPluginOnlyCustomization.includes("skills"))
      incompatible(file, "strictPluginOnlyCustomization prevents selected personal and CloudX skills");
    if (settings.policyHelper) incompatible(file, "policyHelper can supply an unverified skill/plugin source policy");
    if (isRecord(settings.env)) {
      assertNoInjectedSources(settings.env, file);
      if (settings.env.DISABLE_DOCTOR_COMMAND !== undefined && (typeof settings.env.DISABLE_DOCTOR_COMMAND !== "string" || !settings.env.DISABLE_DOCTOR_COMMAND))
        incompatible(file, "env.DISABLE_DOCTOR_COMMAND enables an unselected bundled source");
    }
  }
  for (const base of managedFiles) for (const category of ["skills", "commands"]) {
    const directory = path.join(path.dirname(base), ".claude", category);
    try { if ((await fs.readdir(directory)).length) incompatible(directory, "managed skills/commands are outside the selected source snapshot"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const localFiles = new Set<string>();
  if (input.cwd) for (let directory = path.resolve(input.cwd); ; directory = path.dirname(directory)) {
    localFiles.add(path.join(directory, ".claude", "settings.local.json"));
    localFiles.add(path.join(directory, "CLAUDE.local.md"));
    const canonicalLocal = await worktreeLocalSettings(directory);
    if (canonicalLocal) localFiles.add(canonicalLocal);
    if (path.dirname(directory) === directory) break;
  }
  for (const file of localFiles) {
    try {
      const empty = file.endsWith(".json") ? Object.keys(await readPolicy(file)).length === 0 : (await fs.stat(file)).size === 0;
      if (!empty) incompatible(file, "this version's controlled source boundary excludes local settings and CLAUDE.local.md");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function assertNoPluginSettings(settings: Record<string, unknown>, file: string): void {
  for (const key of PLUGIN_KEYS) {
    const value = settings[key];
    if (value !== undefined && (Array.isArray(value) ? value.length > 0 : !isRecord(value) || Object.keys(value).length > 0)) incompatible(file, `${key} supplies plugins outside the selected skill snapshot`);
  }
  if (isRecord(settings.enabledPlugins) && Object.values(settings.enabledPlugins).some(value => value !== false))
    incompatible(file, "enabledPlugins enables plugins outside the selected skill snapshot");
}

function assertNoSkillSuppression(settings: Record<string, unknown>, file: string, names: string[]): void {
  if (isRecord(settings.skillOverrides)) for (const name of names)
    if (settings.skillOverrides[name] !== undefined && !["on", "name-only", "user-invocable-only"].includes(settings.skillOverrides[name] as string)) incompatible(file, `skillOverrides disables selected skill ${name}`);
}

function assertNoInjectedSources(env: Record<string, unknown>, source: string): void {
  for (const [key, value] of Object.entries(env)) if ((INJECTED_SOURCES.test(key) || (CLAUDE_MANAGED_SOURCE_ENV_KEYS as readonly string[]).includes(key)) && value !== undefined && value !== "")
    incompatible(source, `${key} injects an unsupported native source`);
}

function incompatible(source: string, reason: string): never {
  throw new Error(`CloudX-managed Claude cannot use ${source}: ${reason}. Choose Native project to preserve that native configuration, or ask its owner to remove the conflict before a managed launch. CloudX has not changed policy, trust, account choices or saved selections.`);
}

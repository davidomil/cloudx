import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { isRecord, type CloudxRule, type CloudxSkill, type ClaudeLaunchMode, type ClaudeResolvedLaunchPolicy, type ClaudeLaunchSkillSource } from "@cloudx/shared";

import {
  cloudxSkillFilePath,
  cloudxSystemSkillFilePath,
  listCloudxSystemRules,
  listCloudxSystemSkills,
  rulesSkillsRootPath,
  type ResolvedPersonalityTemplate
} from "../../rulesSkills/RulesSkillsCatalogService.js";
import { SOURCE_GROUNDED_WRITING } from "../../rulesSkills/sourceGroundedWriting.js";
import { replaceLink } from "../replaceLink.js";
import { writeTextFileAtomic } from "../../jsonStateFile.js";
import { shellQuote } from "../../terminal/ShellLaunch.js";
import { ensureClaudeSettingsFile } from "./ClaudeSettingsService.js";
import { claudeSkillPolicy, type ClaudeSkillPolicy } from "./claudeSkillPolicy.js";
import { resolveClaudeAccountPolicy, type ClaudeAccountPolicy } from "./claudeAccountPolicy.js";
import { assertClaudeAccountCompatibility } from "./ClaudeAccountPreflight.js";
import { assertClaudeHookCompatibility } from "./ClaudeHookPolicy.js";
import { assertClaudeInstructionSourceCompatibility } from "./ClaudeInstructionPolicy.js";
import { ClaudeGlobalPreferences } from "./ClaudeGlobalPreferences.js";
import { assertClaudeCatalogOwnership, assertClaudeManagedCompatibility, CLAUDE_MANAGED_SETTING_SOURCES, CLAUDE_MANAGED_SOURCE_ENV_KEYS } from "./ClaudeManagedPolicy.js";
import { readClaudeSkillSnapshot, writeClaudeSkillSnapshot, type ClaudeSkillSnapshot } from "./ClaudeSkillSnapshot.js";
import { assertClaudeConversationNavigationCompatibility, ClaudeConversationPolicies } from "./ClaudeConversationPolicies.js";

export const CLAUDE_FORGE_TURN_BINDING = ".cloudx-forge-turn.json";

// Shared user configuration that every Claude tab sees through its overlay.
// Credentials are linked separately from the tab's account home. Personal
// skills and commands are copied into the selected launch snapshot.
const SHARED_ENTRIES = ["settings.json", "agents", "plugins", "output-styles", "keybindings.json", "rules"] as const;
const GENERATED_SKILL_GROUPS = ["cloudx", "cloudx-system"] as const;

interface ClaudeSkillSource {
  directory: string;
  source: string;
  catalogResources?: boolean;
}

// Variables that choose the credentials or the API endpoint. Claude Code
// applies the env block of each settings file over the process environment,
// so a value there would replace the selected account.

export interface ClaudeHomeOverlayOptions {
  dataDir: string;
  tabId: string;
  // Home holding the account's credentials.
  accountHome: string;
  // The user's own Claude home. Its projects/ directory is the shared session
  // store, so conversations survive account switches and show up in `claude --resume`.
  providerHome: string;
  executionId: string;
  resolved?: ResolvedPersonalityTemplate;
  cwd?: string;
  trustProject?: boolean;
  // The user's own Claude state file. Folders trusted there stay trusted.
  userStatePath?: string;
  // Personal or synced skills the user allowed in Settings → Claude.
  allowedSkills?: readonly string[];
  // The environment Claude is launched with, whose account variables win over
  // settings files.
  launchEnv?: NodeJS.ProcessEnv;
  accountPolicy?: ClaudeAccountPolicy;
  launchMode?: ClaudeLaunchMode;
  nativeVersion?: string;
  trackPreferences?: boolean;
  conversationPolicy?: { accountId: string; sessionId?: string; historical?: boolean };
}

export interface ClaudeHomeOverlay {
  configDir: string;
  rulesSkillsRoot: string;
  // CloudX hook settings, passed with --settings.
  settingsPath: string;
  // CloudX additions use a separate native prompt input so personal imports
  // keep their source file and native import-depth budget.
  instructionsPath: string;
  systemRules: CloudxRule[];
  launchPolicy: ClaudeResolvedLaunchPolicy;
  settingSources: string[];
  configurationArgs: string[];
}

// Claude Code keeps folder trust in .claude.json: inside CLAUDE_CONFIG_DIR when
// that is set, else in the home directory next to ~/.claude.
export function claudeUserStatePath(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured && path.isAbsolute(configured)) return path.join(configured, ".claude.json");
  return path.join(env.HOME?.trim() || os.homedir(), ".claude.json");
}

const PROJECT_TRUST_KEYS = ["hasTrustDialogAccepted", "hasClaudeMdExternalIncludesApproved", "hasClaudeMdExternalIncludesWarningShown"] as const;
type ProjectTrust = Partial<Record<typeof PROJECT_TRUST_KEYS[number], boolean>>;

async function userProjectTrust(statePath: string, cwd: string): Promise<ProjectTrust> {
  try {
    const stat = await fsp.stat(statePath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return {};
    const state: unknown = JSON.parse(await fsp.readFile(statePath, "utf8"));
    if (!state || typeof state !== "object") return {};
    const projects = (state as Record<string, unknown>).projects;
    const project = projects && typeof projects === "object" ? (projects as Record<string, unknown>)[cwd] : undefined;
    if (!project || typeof project !== "object" || Array.isArray(project)) return {};
    return Object.fromEntries(PROJECT_TRUST_KEYS.filter(key => typeof (project as Record<string, unknown>)[key] === "boolean").map(key => [key, (project as Record<string, unknown>)[key]]));
  } catch {
    return {};
  }
}

export function claudeOverlayPath(dataDir: string, tabId: string): string {
  return path.join(dataDir, "claude-launches", safeSegment(tabId));
}

export async function materializeClaudeHomeOverlay(options: ClaudeHomeOverlayOptions): Promise<ClaudeHomeOverlay> {
  await assertClaudeInstructionSourceCompatibility(options.providerHome, options.cwd);
  await assertClaudeHookCompatibility(options.providerHome, options.cwd);
  const configDir = claudeOverlayPath(options.dataDir, options.tabId);
  const accountPolicy = options.accountPolicy ?? resolveClaudeAccountPolicy(options.launchEnv ?? {}, configDir, options.launchEnv?.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: options.launchEnv.ANTHROPIC_API_KEY } : {});
  await assertClaudeAccountCompatibility(accountPolicy);
  const rulesSkillsRoot = rulesSkillsRootPath(options.dataDir);
  const systemRules = await listCloudxSystemRules(rulesSkillsRoot);
  const systemSkills = await listCloudxSystemSkills(rulesSkillsRoot);
  const generated = generatedSkills(rulesSkillsRoot, options.resolved, systemSkills);
  await assertClaudeCatalogOwnership(options.providerHome, generated.map(skill => skill.directory));
  const mode = options.launchMode ?? "native-project";
  if (options.conversationPolicy) await assertClaudeConversationNavigationCompatibility({ providerHome: options.providerHome, cwd: options.cwd, env: options.launchEnv, mode });
  const policy = await claudeSkillPolicy({
    providerHome: options.providerHome,
    cwd: options.cwd,
    allowedSkills: options.allowedSkills ?? [],
    cloudxSkillNames: generated.map(skill => skill.directory),
    launchMode: mode
  });
  const userSettings = await settingsSnapshot(options.providerHome);
  if (mode === "cloudx-managed") await assertClaudeManagedCompatibility({ providerHome: options.providerHome, cwd: options.cwd,
    nativeVersion: options.nativeVersion, env: options.launchEnv, userSettings: userSettings.settings,
    skillNames: [...generated.map(skill => skill.directory), ...policy.selected.map(skill => skill.name)] });
  const snapshots = await selectedSkillSnapshots(options.providerHome, generated, policy, mode);
  await fsp.mkdir(path.dirname(configDir), { recursive: true, mode: 0o700 });
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
  const projectsDir = path.join(options.providerHome, "projects");
  await fsp.mkdir(projectsDir, { recursive: true, mode: 0o700 });
  await replaceLink(projectsDir, path.join(configDir, "projects"));
  await replaceLink(path.join(options.accountHome, ".credentials.json"), path.join(configDir, ".credentials.json"));
  await ensureClaudeSettingsFile(options.providerHome);
  for (const name of SHARED_ENTRIES) {
    if (mode === "cloudx-managed" && name === "plugins") await blockPluginDirectory(configDir);
    else if (mode === "cloudx-managed" && name === "settings.json") {
      const target = path.join(configDir, name);
      if ((await optionalLstat(target))?.isSymbolicLink()) await fsp.unlink(target);
      await writeAtomic(target, userSettings.content ?? "{}\n");
    } else await replaceLink(path.join(options.providerHome, name), path.join(configDir, name));
  }
  const projectTrust = options.cwd && options.userStatePath ? await userProjectTrust(options.userStatePath, options.cwd) : {};
  const trusted = options.trustProject === true || projectTrust.hasTrustDialogAccepted === true;
  await new ClaudeGlobalPreferences(options.dataDir).seed(configDir, options.userStatePath, state => seedClaudeState(state, options.cwd, trusted, projectTrust), options.trackPreferences);

  await materializeSkills(configDir, snapshots);
  await replaceLink(path.join(options.providerHome, "CLAUDE.md"), path.join(configDir, "CLAUDE.md"));
  const instructionsPath = await writeInstructions(configDir, options.resolved, systemRules);
  const settingsPath = path.join(configDir, ".cloudx-settings.json");
  const launchSettings = { ...policy.settings, ...accountPolicy.settings, ...hookSettings(configDir, options.tabId, options.executionId),
    ...(mode === "cloudx-managed" ? { env: { ...accountPolicy.settings.env as Record<string, unknown>, ...Object.fromEntries(CLAUDE_MANAGED_SOURCE_ENV_KEYS.map(key => [key, ""])), DISABLE_DOCTOR_COMMAND: "1" } } : {}) };
  await writeAtomic(settingsPath, `${JSON.stringify(launchSettings, null, 2)}\n`);
  const settingSources = mode === "cloudx-managed" ? [...CLAUDE_MANAGED_SETTING_SOURCES] : ["user", "project", "local"];
  const launchPolicy: ClaudeResolvedLaunchPolicy = {
    contractVersion: 1, mode, nativeVersion: options.nativeVersion?.replace(/ \(Claude Code\)$/u, "") ?? "unobserved", exclusiveSkills: mode === "cloudx-managed", activation: "next-launch",
    settingSources, includedSources: mode === "cloudx-managed" ? ["personal instructions and rules", "managed policy", "CloudX skill snapshots", "selected external skill snapshots"] : ["native project discovery", "personal/local/project instructions and rules", "managed policy", "CloudX skill snapshots", "selected external skill additions"],
    excludedSources: mode === "cloudx-managed" ? ["shared project settings", "project CLAUDE.md and rules", "local settings and CLAUDE.local.md", "native project/nested/add-dir skills and commands", "native plugins", "bundled skills", "background skill/plugin sync", "unselected external skill sources"] : ["unselected personal skill additions", "background skill/plugin sync"],
    skills: snapshots.map(snapshot => snapshot.provenance), sourceFiles: [userSettings.provenance]
  };
  await writeAtomic(path.join(configDir, ".cloudx-launch-policy.json"), `${JSON.stringify(launchPolicy, null, 2)}\n`);
  if (options.conversationPolicy) {
    if (!options.cwd) throw new Error("An exact workspace is required for Claude conversation policy.");
    await new ClaudeConversationPolicies(options.dataDir).prepareExecution(configDir, {
      ...options.conversationPolicy, tabId: options.tabId, executionId: options.executionId, cwd: options.cwd, policy: launchPolicy,
    });
  }
  return { configDir, rulesSkillsRoot, settingsPath, instructionsPath, systemRules, launchPolicy, settingSources,
    configurationArgs: mode === "cloudx-managed" ? ["--setting-sources", settingSources.join(",")] : [] };
}

// CloudX passes its hooks and skill policy with --settings. The hooks are
// added to the user's own settings.json hooks.
function hookSettings(configDir: string, tabId: string, executionId: string): Record<string, unknown> {
  const helper = fileURLToPath(new URL("../../../helpers/claude-hook-receipt.mjs", import.meta.url));
  const hook = (event: string) => [{
    hooks: [{ type: "command", command: [process.execPath, helper, configDir, tabId, executionId, event].map(shellQuote).join(" "), timeout: 5 }]
  }];
  return {
    hooks: {
      SessionStart: hook("SessionStart"),
      UserPromptSubmit: hook("UserPromptSubmit"),
      Stop: hook("Stop"),
      StopFailure: hook("StopFailure")
    }
  };
}

// The launch environment's value for every account variable, or empty, which
// Claude Code treats as unset. Sent with --settings, it outranks the env block
// of every user, project and local settings file.
function seedClaudeState(state: Record<string, unknown>, cwd: string | undefined, trustProject: boolean, projectTrust: ProjectTrust): void {
  state.hasCompletedOnboarding = true;
  if (cwd && (trustProject || Object.keys(projectTrust).length)) {
    const projects = state.projects && typeof state.projects === "object" && !Array.isArray(state.projects) ? state.projects as Record<string, unknown> : {};
    const current = projects[cwd] && typeof projects[cwd] === "object" ? projects[cwd] as Record<string, unknown> : {};
    projects[cwd] = { ...projectTrust, ...current, ...(trustProject ? { hasTrustDialogAccepted: true } : {}) };
    state.projects = projects;
  }
}

// Claude Code discovers skills one level below skills/, so CloudX skills use
// a group prefix instead of nested group directories.
function generatedSkills(
  rulesSkillsRoot: string,
  resolved: ResolvedPersonalityTemplate | undefined,
  systemSkills: CloudxSkill[]
): ClaudeSkillSource[] {
  return [
    ...(resolved?.skills ?? []).map(skill => ({ directory: `${GENERATED_SKILL_GROUPS[0]}-${safeSegment(skill.id)}`, source: path.dirname(cloudxSkillFilePath(rulesSkillsRoot, skill.id)) })),
    ...systemSkills.map(skill => ({
      directory: `${GENERATED_SKILL_GROUPS[1]}-${safeSegment(skill.id)}`,
      source: path.dirname(cloudxSystemSkillFilePath(rulesSkillsRoot, skill.id)),
      catalogResources: skill.id === SOURCE_GROUNDED_WRITING.id
    }))
  ];
}

async function materializeSkills(
  configDir: string,
  snapshots: SkillSnapshot[]
): Promise<void> {
  const skillsDir = path.join(configDir, "skills");
  const existing = await optionalLstat(skillsDir);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`Unexpected Claude skills entry at ${skillsDir}.`);
  await fsp.rm(skillsDir, { recursive: true, force: true });
  await fsp.mkdir(skillsDir, { mode: 0o700 });
  // Earlier versions linked the whole commands/ directory.
  const commandsDir = path.join(configDir, "commands");
  if ((await optionalLstat(commandsDir))?.isSymbolicLink()) await fsp.unlink(commandsDir);
  else await fsp.rm(commandsDir, { recursive: true, force: true });
  for (const snapshot of snapshots) {
    const target = path.join(configDir, snapshot.target);
    if (snapshot.catalogResources) await writeCatalogSkillEntrypoint(snapshot.provenance.sourcePath, target);
    else await writeClaudeSkillSnapshot(snapshot.content, target);
  }
}

interface SkillSnapshot { catalogResources?: boolean; target: string; content: ClaudeSkillSnapshot; provenance: ClaudeLaunchSkillSource }

async function selectedSkillSnapshots(providerHome: string, generated: ClaudeSkillSource[], policy: ClaudeSkillPolicy, mode: ClaudeLaunchMode): Promise<SkillSnapshot[]> {
  const entries = [
    ...generated.map(skill => ({ catalogResources: mode === "native-project" && skill.catalogResources, name: skill.directory, source: skill.source, target: `skills/${skill.directory}`,
      origin: skill.directory.startsWith("cloudx-system-") ? "cloudx-system" as const : "selected-template" as const })),
    ...policy.selected.map(skill => ({ name: skill.name, source: path.join(providerHome, skill.source), target: skill.source.startsWith("commands/") ? skill.source : `skills/${skill.name}`,
      origin: skill.origin, ...(skill.origin === "synced" ? { account: skill.source.split("/")[2] } : {}) }))
  ];
  const snapshots: SkillSnapshot[] = [];
  const remaining = { bytes: 128 * 1024 * 1024, entries: 5_000 };
  for (const entry of entries) {
    const catalogResources = "catalogResources" in entry && entry.catalogResources === true;
    const content = await readClaudeSkillSnapshot(catalogResources ? path.join(entry.source, "SKILL.md") : entry.source, remaining);
    remaining.bytes -= content.files.reduce((total, file) => total + file.content.length, 0);
    remaining.entries -= content.entries;
    if (content.files.some(file => file.relative.split(path.sep).includes(".claude-plugin")))
      throw new Error(`Selected Claude skill ${entry.name} is also a native plugin. Choose a standalone skill source; CloudX has not changed the selection.`);
    snapshots.push({ target: entry.target, content, ...(catalogResources ? { catalogResources: true } : {}), provenance: { name: entry.name, origin: entry.origin, sourcePath: entry.source, sha256: content.sha256,
      nativeSource: "user", ...("account" in entry ? { account: entry.account } : {}) } });
  }
  return snapshots;
}

async function settingsSnapshot(providerHome: string): Promise<{ content?: string; settings: Record<string, unknown>; provenance: NonNullable<ClaudeResolvedLaunchPolicy["sourceFiles"]>[number] }> {
  const file = path.join(providerHome, "settings.json");
  try {
    const snapshot = await readClaudeSkillSnapshot(file, { bytes: 1024 * 1024, entries: 1 });
    if (snapshot.directory) throw new Error();
    const content = snapshot.files[0]!.content.toString("utf8");
    const settings: unknown = JSON.parse(content.trim() || "{}");
    if (!isRecord(settings)) throw new Error();
    return { content, settings, provenance: { path: file, state: "file", sha256: createHash("sha256").update(content).digest("hex") } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, provenance: { path: file, state: "missing" } };
    throw new Error(`Cannot prepare the bounded Claude user settings snapshot at ${file}. Make the source a valid, stable JSON settings file before launching; no configuration values were included in this diagnostic.`);
  }
}

async function writeCatalogSkillEntrypoint(source: string, target: string): Promise<void> {
  const original = await fsp.realpath(path.join(source, "SKILL.md"));
  const instructions = await fsp.readFile(original, "utf8");
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(instructions)?.[0];
  if (!frontmatter) throw new Error(`CloudX skill ${original} must contain YAML frontmatter.`);
  await fsp.mkdir(target, { recursive: true });
  await writeAtomic(path.join(target, "SKILL.md"), [
    frontmatter.trimEnd(), "", "# Skill source", "",
    `Read the original instructions at ${JSON.stringify(original)} before using this skill.`,
    `Resolve relative paths to skill-owned scripts, assets, references, and dependencies against ${JSON.stringify(path.dirname(original))}.`,
    "Resolve task input and output paths from the task working directory, following any explicit working-directory instructions in the original skill. The original instructions and resources are authoritative.", ""
  ].join("\n"));
}

async function blockPluginDirectory(configDir: string): Promise<void> {
  const target = path.join(configDir, "plugins");
  const existing = await optionalLstat(target);
  if (existing?.isDirectory()) throw new Error("CloudX-managed Claude requires a fresh tab without native plugin state. Open a new managed tab, or keep this tab in Native project mode; its plugin state has been preserved.");
  if (existing?.isSymbolicLink()) await fsp.unlink(target);
  await writeAtomic(target, "CloudX-managed Claude does not load or install native plugins. Choose Native project for plugin support.\n");
}

async function writeInstructions(
  configDir: string,
  resolved: ResolvedPersonalityTemplate | undefined,
  systemRules: CloudxRule[]
): Promise<string> {
  const target = path.join(configDir, ".cloudx-instructions.md");
  const rules = resolved?.rules ?? [];
  const sections = ["# CloudX Claude Session Instructions"];
  if (systemRules.length) sections.push("", "## CloudX System Rules", "", ...systemRules.map(rule => `- ${rule.text}`));
  if (resolved && rules.length) sections.push("", `## CloudX Template: ${resolved.template.name}`, "", ...rules.map(rule => `- ${rule.text}`));
  await writeAtomic(target, `${sections.join("\n").trimEnd()}\n`);
  return target;
}

function writeAtomic(target: string, content: string): Promise<void> {
  return writeTextFileAtomic(path.dirname(target), target, content, "Claude overlay file", 0o600);
}

async function optionalLstat(target: string): Promise<fs.Stats | undefined> {
  try { return await fsp.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/gu, "_") || "tab";
}

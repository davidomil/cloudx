import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CloudxRule, CloudxSkill } from "@cloudx/shared";

import {
  cloudxSkillFilePath,
  cloudxSystemSkillFilePath,
  listCloudxSystemRules,
  listCloudxSystemSkills,
  rulesSkillsRootPath,
  type ResolvedPersonalityTemplate
} from "../../rulesSkills/RulesSkillsCatalogService.js";
import { replaceLink } from "../replaceLink.js";
import { writeTextFileAtomic } from "../../jsonStateFile.js";
import { shellQuote } from "../../terminal/ShellLaunch.js";
import { ensureClaudeSettingsFile } from "./ClaudeSettingsService.js";
import { claudeSkillPolicy, type ClaudeSkillPolicy } from "./claudeSkillPolicy.js";

export const CLAUDE_FORGE_TURN_BINDING = ".cloudx-forge-turn.json";

// Shared user configuration that every Claude tab sees through its overlay.
// Credentials are linked separately from the tab's account home. Personal
// skills and commands are linked one by one when the user allows them.
const SHARED_ENTRIES = ["settings.json", "agents", "plugins", "output-styles"] as const;
const GENERATED_SKILL_GROUPS = ["cloudx", "cloudx-system"] as const;
// Variables that choose the credentials or the API endpoint. Claude Code
// applies the shared settings.json env block over the process environment,
// so a value there would replace the selected account.
const ACCOUNT_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CONFIG_DIR"
] as const;
const MAX_SHARED_SETTINGS_BYTES = 1024 * 1024;

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
  // The selected account's credential variables, such as ANTHROPIC_API_KEY.
  accountEnv?: Record<string, string>;
}

export interface ClaudeHomeOverlay {
  configDir: string;
  rulesSkillsRoot: string;
  // CloudX hook settings, passed with --settings.
  settingsPath: string;
  systemRules: CloudxRule[];
}

// Claude Code keeps folder trust in .claude.json: inside CLAUDE_CONFIG_DIR when
// that is set, else in the home directory next to ~/.claude.
export function claudeUserStatePath(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured && path.isAbsolute(configured)) return path.join(configured, ".claude.json");
  return path.join(env.HOME?.trim() || os.homedir(), ".claude.json");
}

async function isTrustedByUser(statePath: string, cwd: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(statePath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return false;
    const state: unknown = JSON.parse(await fsp.readFile(statePath, "utf8"));
    if (!state || typeof state !== "object") return false;
    const projects = (state as Record<string, unknown>).projects;
    const project = projects && typeof projects === "object" ? (projects as Record<string, unknown>)[cwd] : undefined;
    return Boolean(project && typeof project === "object" && (project as Record<string, unknown>).hasTrustDialogAccepted === true);
  } catch {
    return false;
  }
}

export function claudeOverlayPath(dataDir: string, tabId: string): string {
  return path.join(dataDir, "claude-launches", safeSegment(tabId));
}

export async function materializeClaudeHomeOverlay(options: ClaudeHomeOverlayOptions): Promise<ClaudeHomeOverlay> {
  const configDir = claudeOverlayPath(options.dataDir, options.tabId);
  await fsp.mkdir(path.dirname(configDir), { recursive: true, mode: 0o700 });
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
  const projectsDir = path.join(options.providerHome, "projects");
  await fsp.mkdir(projectsDir, { recursive: true, mode: 0o700 });
  await replaceLink(projectsDir, path.join(configDir, "projects"));
  await replaceLink(path.join(options.accountHome, ".credentials.json"), path.join(configDir, ".credentials.json"));
  await ensureClaudeSettingsFile(options.providerHome);
  for (const name of SHARED_ENTRIES) await replaceLink(path.join(options.providerHome, name), path.join(configDir, name));
  const trusted = options.trustProject === true || Boolean(options.cwd && options.userStatePath && await isTrustedByUser(options.userStatePath, options.cwd));
  await seedClaudeState(path.join(configDir, ".claude.json"), options.cwd, trusted);

  const rulesSkillsRoot = rulesSkillsRootPath(options.dataDir);
  const systemRules = await listCloudxSystemRules(rulesSkillsRoot);
  const systemSkills = await listCloudxSystemSkills(rulesSkillsRoot);
  const generated = generatedSkills(rulesSkillsRoot, options.resolved, systemSkills);
  const policy = await claudeSkillPolicy({
    providerHome: options.providerHome,
    cwd: options.cwd,
    allowedSkills: options.allowedSkills ?? [],
    cloudxSkillNames: generated.map(skill => skill.directory)
  });
  await materializeSkills(configDir, options.providerHome, generated, policy);
  await writeInstructions(configDir, options.providerHome, options.resolved, systemRules);
  const settingsPath = path.join(configDir, ".cloudx-settings.json");
  const accountEnv = await accountEnvOverrides(path.join(options.providerHome, "settings.json"), configDir, options.accountEnv ?? {});
  const launchSettings = { ...policy.settings, ...(accountEnv ? { env: accountEnv } : {}), ...hookSettings(configDir, options.tabId, options.executionId) };
  await writeAtomic(settingsPath, `${JSON.stringify(launchSettings, null, 2)}\n`);
  return { configDir, rulesSkillsRoot, settingsPath, systemRules };
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

// Overrides for the account variables the shared settings.json env sets: the
// selected account's value, or empty, which Claude Code treats as unset.
async function accountEnvOverrides(sharedSettings: string, configDir: string, accountEnv: Record<string, string>): Promise<Record<string, string> | undefined> {
  let shared: unknown;
  try {
    const stat = await fsp.stat(sharedSettings);
    if (!stat.isFile() || stat.size > MAX_SHARED_SETTINGS_BYTES) return undefined;
    shared = JSON.parse(await fsp.readFile(sharedSettings, "utf8"));
  } catch {
    return undefined;
  }
  const env = shared && typeof shared === "object" && !Array.isArray(shared) ? (shared as Record<string, unknown>).env : undefined;
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
  const keys = ACCOUNT_ENV_KEYS.filter(key => key in env);
  if (!keys.length) return undefined;
  const selected: Record<string, string> = { ...accountEnv, CLAUDE_CONFIG_DIR: configDir };
  return Object.fromEntries(keys.map(key => [key, selected[key] ?? ""]));
}

async function seedClaudeState(statePath: string, cwd: string | undefined, trustProject: boolean): Promise<void> {
  let state: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(statePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  state.hasCompletedOnboarding = true;
  if (trustProject && cwd) {
    const projects = state.projects && typeof state.projects === "object" && !Array.isArray(state.projects) ? state.projects as Record<string, unknown> : {};
    const current = projects[cwd] && typeof projects[cwd] === "object" ? projects[cwd] as Record<string, unknown> : {};
    projects[cwd] = { ...current, hasTrustDialogAccepted: true };
    state.projects = projects;
  }
  await writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

// Claude Code discovers skills one level below skills/, so CloudX skills use
// a group prefix instead of nested group directories.
function generatedSkills(
  rulesSkillsRoot: string,
  resolved: ResolvedPersonalityTemplate | undefined,
  systemSkills: CloudxSkill[]
): { directory: string; source: string }[] {
  return [
    ...(resolved?.skills ?? []).map(skill => ({ directory: `${GENERATED_SKILL_GROUPS[0]}-${safeSegment(skill.id)}`, source: path.dirname(cloudxSkillFilePath(rulesSkillsRoot, skill.id)) })),
    ...systemSkills.map(skill => ({ directory: `${GENERATED_SKILL_GROUPS[1]}-${safeSegment(skill.id)}`, source: path.dirname(cloudxSystemSkillFilePath(rulesSkillsRoot, skill.id)) }))
  ];
}

async function materializeSkills(
  configDir: string,
  providerHome: string,
  generated: { directory: string; source: string }[],
  policy: ClaudeSkillPolicy
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
  for (const skill of generated) {
    await fsp.cp(skill.source, path.join(skillsDir, skill.directory), { recursive: true, dereference: false, verbatimSymlinks: true });
  }
  for (const source of [...policy.personalLinks, ...(policy.linkSynced ? ["skills/synced"] : [])]) {
    const target = path.join(configDir, ...source.split("/"));
    if (await optionalLstat(target)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.symlink(path.join(providerHome, ...source.split("/")), target);
  }
}

async function writeInstructions(
  configDir: string,
  providerHome: string,
  resolved: ResolvedPersonalityTemplate | undefined,
  systemRules: CloudxRule[]
): Promise<void> {
  const target = path.join(configDir, "CLAUDE.md");
  let base: string | undefined;
  try { base = await fsp.readFile(path.join(providerHome, "CLAUDE.md"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const rules = resolved?.rules ?? [];
  if (!base?.trim() && systemRules.length === 0 && rules.length === 0) {
    await fsp.rm(target, { force: true });
    return;
  }
  const sections = ["# CloudX Claude Session Instructions"];
  if (base?.trim()) sections.push("", "## Base Claude Home Instructions", "", base.trim());
  if (systemRules.length) sections.push("", "## CloudX System Rules", "", ...systemRules.map(rule => `- ${rule.text}`));
  if (resolved && rules.length) sections.push("", `## CloudX Template: ${resolved.template.name}`, "", ...rules.map(rule => `- ${rule.text}`));
  await writeAtomic(target, `${sections.join("\n").trimEnd()}\n`);
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

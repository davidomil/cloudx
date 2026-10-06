import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { CLAUDE_SKILL_NAME_PATTERN, isRecord, type ClaudeSkillOrigin } from "@cloudx/shared";

const MAX_SETTINGS_BYTES = 1024 * 1024;
// Claude Code keeps skills synced from claude.ai under skills/synced/<account>/.
const SYNCED_DIRECTORY = "synced";
// Skills of Claude Code's built-in plugins that disableBundledSkills leaves on
// (verified on 2.1.290). Built-in plugins themselves stay enabled: one of
// them loads the project's AGENTS.md.
const BUILT_IN_PLUGIN_SKILLS = ["plugin-authoring"];

// Claude Code names a skill after its directory, not its frontmatter name.
export interface ClaudeUserSkill {
  name: string;
  origin: ClaudeSkillOrigin;
}

export interface ClaudeSkillPolicy {
  // Merged into the launch settings passed with --settings.
  settings: Record<string, unknown>;
  // Personal skill directories to link into the tab's skills/.
  personalDirectories: string[];
  linkSynced: boolean;
}

export interface ClaudeSkillPolicyInput {
  providerHome: string;
  cwd?: string;
  allowedSkills: readonly string[];
  // Directory names of the skills CloudX itself provides. They stay on.
  cloudxSkillNames: readonly string[];
}

// Claude tabs get the skills CloudX chooses, as Codex tabs do: CloudX skills
// plus personal or synced skills the user allowed in Settings → Claude.
// Bundled skills, plugins, project skills and auto-memory are turned off for
// the launch only; the user's own Claude settings are not changed.
export async function claudeSkillPolicy(input: ClaudeSkillPolicyInput): Promise<ClaudeSkillPolicy> {
  const allowed = new Set(input.allowedSkills);
  const user = await discoverClaudeUserSkills(input.providerHome);
  const projectDirectories = input.cwd ? await projectDirectoriesFor(input.cwd) : [];
  const project = (await Promise.all(projectDirectories.map(directory => skillsIn(path.join(directory, ".claude", "skills"), "personal")))).flat();
  const kept = new Set([...input.cloudxSkillNames, ...allowed]);
  const hidden = [...new Set([...user, ...project].map(skill => skill.name).concat(BUILT_IN_PLUGIN_SKILLS).filter(name => !kept.has(name)))].sort();
  const plugins = await enabledPlugins([
    path.join(input.providerHome, "settings.json"),
    ...projectDirectories.flatMap(directory => ["settings.json", "settings.local.json"].map(name => path.join(directory, ".claude", name)))
  ]);
  const linkSynced = user.some(skill => skill.origin === "synced" && allowed.has(skill.name));
  return {
    settings: {
      disableBundledSkills: true,
      autoMemoryEnabled: false,
      syncClaudeAiPlugins: false,
      ...(linkSynced ? {} : { syncClaudeAiSkills: false }),
      ...(hidden.length ? { skillOverrides: Object.fromEntries(hidden.map(name => [name, "off"])) } : {}),
      ...(plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map(plugin => [plugin, false])) } : {})
    },
    personalDirectories: user.filter(skill => skill.origin === "personal" && allowed.has(skill.name)).map(skill => skill.name),
    linkSynced
  };
}

// Personal skills in <home>/skills/<dir>/ and synced skills in
// <home>/skills/synced/<account>/<dir>/.
export async function discoverClaudeUserSkills(providerHome: string): Promise<ClaudeUserSkill[]> {
  const root = path.join(providerHome, "skills");
  const personal = await skillsIn(root, "personal", [SYNCED_DIRECTORY]);
  const synced: ClaudeUserSkill[] = [];
  for (const account of await directoryEntries(path.join(root, SYNCED_DIRECTORY)))
    synced.push(...await skillsIn(path.join(root, SYNCED_DIRECTORY, account), "synced"));
  return [...personal, ...synced];
}

async function skillsIn(root: string, origin: ClaudeSkillOrigin, skip: string[] = []): Promise<ClaudeUserSkill[]> {
  const skills: ClaudeUserSkill[] = [];
  for (const name of await directoryEntries(root)) {
    if (!skip.includes(name) && CLAUDE_SKILL_NAME_PATTERN.test(name) && await isFile(path.join(root, name, "SKILL.md"))) skills.push({ name, origin });
  }
  return skills;
}

async function isFile(target: string): Promise<boolean> {
  try { return (await fsp.stat(target)).isFile(); } catch { return false; }
}

async function directoryEntries(root: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
  const directories: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(path.join(root, entry.name)))) directories.push(entry.name);
  }
  return directories.sort();
}

async function isDirectory(target: string): Promise<boolean> {
  try { return (await fsp.stat(target)).isDirectory(); } catch { return false; }
}

// The working directory and its ancestors up to the repository root, where
// Claude Code looks for project .claude/ configuration.
async function projectDirectoriesFor(cwd: string): Promise<string[]> {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    directories.push(current);
    if (fs.existsSync(path.join(current, ".git"))) return directories;
    const parent = path.dirname(current);
    if (parent === current) return [path.resolve(cwd)];
    current = parent;
  }
}

async function enabledPlugins(files: string[]): Promise<string[]> {
  const plugins = new Set<string>();
  for (const file of files) {
    let parsed: unknown;
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) continue;
      parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      // Claude Code reports unreadable settings itself; nothing here is enabled.
      continue;
    }
    if (isRecord(parsed) && isRecord(parsed.enabledPlugins))
      for (const [plugin, enabled] of Object.entries(parsed.enabledPlugins)) if (enabled === true) plugins.add(plugin);
  }
  return [...plugins].sort();
}

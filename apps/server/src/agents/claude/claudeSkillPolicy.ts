import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { CLAUDE_SKILL_NAME_PATTERN, isRecord, type ClaudeSkillOrigin } from "@cloudx/shared";

const run = promisify(execFile);
const MAX_SETTINGS_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Claude Code keeps skills synced from claude.ai under skills/synced/<account>/.
const SYNCED_DIRECTORY = "synced";
// Skills of Claude Code's built-in plugins that disableBundledSkills leaves on
// (verified on 2.1.290). Built-in plugins themselves stay enabled: one of
// them loads the project's AGENTS.md.
const BUILT_IN_PLUGIN_SKILLS = ["plugin-authoring"];

// A skill or command Claude Code loads from the user's own Claude home.
// Claude names a skill after its directory and a command after its path below
// commands/, with ":" for "/" (frontend/component.md is frontend:component).
export interface ClaudeUserSkill {
  name: string;
  origin: ClaudeSkillOrigin;
  // Path below the Claude home, linked into a tab when the skill is allowed.
  source: string;
}

export interface ClaudeSkillPolicy {
  // Merged into the launch settings passed with --settings.
  settings: Record<string, unknown>;
  // Personal skills and commands to link into the tab, as paths below the home.
  personalLinks: string[];
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
// Bundled skills, plugins, project skills and commands, and auto-memory are
// turned off for the launch only; the user's own Claude settings are not
// changed. skillOverrides matches plain names, so one entry also hides nested
// skills of that name that Claude loads later in the session.
export async function claudeSkillPolicy(input: ClaudeSkillPolicyInput): Promise<ClaudeSkillPolicy> {
  const allowed = new Set(input.allowedSkills);
  const user = await discoverClaudeUserSkills(input.providerHome);
  const project = input.cwd ? await discoverProjectSkills(input.cwd) : { names: [], settingsDirectories: [] };
  const kept = new Set([...input.cloudxSkillNames, ...allowed]);
  const hidden = [...new Set([...user.map(skill => skill.name), ...project.names, ...BUILT_IN_PLUGIN_SKILLS].filter(name => !kept.has(name)))].sort();
  const plugins = await enabledPlugins([
    path.join(input.providerHome, "settings.json"),
    ...project.settingsDirectories.flatMap(directory => ["settings.json", "settings.local.json"].map(name => path.join(directory, ".claude", name)))
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
    personalLinks: user.filter(skill => skill.origin === "personal" && allowed.has(skill.name)).map(skill => skill.source),
    linkSynced
  };
}

// Personal skills in <home>/skills/<dir>/, personal commands in
// <home>/commands/, and synced skills in <home>/skills/synced/<account>/<dir>/.
export async function discoverClaudeUserSkills(providerHome: string): Promise<ClaudeUserSkill[]> {
  const root = path.join(providerHome, "skills");
  const personal = (await skillsIn(root, [SYNCED_DIRECTORY])).map(name => ({ name, origin: "personal" as const, source: `skills/${name}` }));
  const commands = (await commandsIn(path.join(providerHome, "commands"))).map(command => ({ name: command.name, origin: "personal" as const, source: `commands/${command.file}` }));
  const synced: ClaudeUserSkill[] = [];
  for (const account of await directoryEntries(path.join(root, SYNCED_DIRECTORY)))
    for (const name of await skillsIn(path.join(root, SYNCED_DIRECTORY, account))) synced.push({ name, origin: "synced", source: `skills/${SYNCED_DIRECTORY}/${account}/${name}` });
  return [...personal, ...commands, ...synced];
}

// Names of the project skills and commands Claude Code can load in this
// session. At startup it reads .claude/ from the working directory up to the
// repository root, and, in a linked worktree without root skills, the main
// checkout's skills (Claude Code 2.1.277 and later); those directories are read
// from the filesystem, so ignored and symlinked skills count. Nested ones load
// once Claude works in their directory; Git lists those, ignored ones included.
async function discoverProjectSkills(cwd: string): Promise<{ names: string[]; settingsDirectories: string[] }> {
  const start = path.resolve(cwd);
  const root = (await git(start, ["rev-parse", "--show-toplevel"]))?.trim();
  const startup = root ? directoriesUpTo(start, root) : [start];
  if (root) {
    const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const main = common ? path.dirname(common.trim()) : root;
    if (main !== root && !fs.existsSync(path.join(root, ".claude", "skills"))) startup.push(main);
  }
  const names: string[] = [];
  for (const directory of startup) {
    names.push(...await skillsIn(path.join(directory, ".claude", "skills")));
    names.push(...(await commandsIn(path.join(directory, ".claude", "commands"))).map(command => command.name));
  }
  if (root) {
    const patterns = ["--", ":(glob)**/.claude/skills/*", ":(glob)**/.claude/skills/*/SKILL.md", ":(glob)**/.claude/commands/**/*.md"];
    const listed = [
      await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...patterns]),
      await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", ...patterns])
    ].join("\0");
    for (const file of new Set(listed.split("\0").filter(Boolean))) names.push(...await projectSkillName(root, file));
  }
  return { names, settingsDirectories: root ? directoriesUpTo(start, root) : [start] };
}

async function projectSkillName(root: string, file: string): Promise<string[]> {
  const parts = file.split("/");
  const at = parts.lastIndexOf(".claude");
  if (at < 0) return [];
  const [kind, ...rest] = parts.slice(at + 1);
  let name: string | undefined;
  // A direct entry of skills/ is a skill when it holds a SKILL.md, as a
  // symlinked skill directory does; Git does not list files behind the link.
  if (kind === "skills" && (rest.length > 1 || await isFile(path.join(root, file, "SKILL.md")))) name = rest[0];
  else if (kind === "commands") name = rest.join(":").replace(/\.md$/u, "");
  return name && CLAUDE_SKILL_NAME_PATTERN.test(name) ? [name] : [];
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args, {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT_BYTES, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    });
    return stdout;
  } catch {
    return undefined;
  }
}

function directoriesUpTo(start: string, root: string): string[] {
  const directories: string[] = [];
  for (let current = start; ; current = path.dirname(current)) {
    directories.push(current);
    if (current === root || path.dirname(current) === current) return directories;
  }
}

async function skillsIn(root: string, skip: string[] = []): Promise<string[]> {
  const names: string[] = [];
  for (const name of await directoryEntries(root))
    if (!skip.includes(name) && CLAUDE_SKILL_NAME_PATTERN.test(name) && await isFile(path.join(root, name, "SKILL.md"))) names.push(name);
  return names;
}

async function commandsIn(root: string, prefix: string[] = []): Promise<{ name: string; file: string }[]> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(path.join(root, ...prefix), { withFileTypes: true }); }
  catch { return []; }
  const commands: { name: string; file: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const target = path.join(root, ...prefix, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(target))) commands.push(...await commandsIn(root, [...prefix, entry.name]));
    else if (entry.name.endsWith(".md") && await isFile(target)) {
      const name = [...prefix, entry.name.slice(0, -3)].join(":");
      if (CLAUDE_SKILL_NAME_PATTERN.test(name)) commands.push({ name, file: [...prefix, entry.name].join("/") });
    }
  }
  return commands;
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

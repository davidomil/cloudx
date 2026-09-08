import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";

import {
  cloudxSkillFilePath,
  cloudxSystemSkillFilePath,
  ensureCloudxSystemRules,
  ensureCloudxSystemSkills,
  listCloudxSystemRules,
  listCloudxSystemSkills,
  rulesSkillsRootPath,
  type ResolvedPersonalityTemplate
} from "./RulesSkillsCatalogService.js";
import type { CloudxRule, CloudxSkill } from "@cloudx/shared";
import type { CodexStateSources, ResolvedCodexStateSource } from "../plugins/CodexStateSources.js";

export interface CodexHomeOverlayOptions {
  dataDir: string;
  tabId: string;
  resolved?: ResolvedPersonalityTemplate;
  baseEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  trustedProjectPath?: string;
  resetCodexHome?: boolean;
  sources: CodexStateSources;
  source: ResolvedCodexStateSource;
}

export interface CodexHomeOverlay {
  codexHome: string;
  rulesSkillsRoot: string;
  configPath: string;
  instructionsPath?: string;
  skillPaths: string[];
  disabledSkillPaths: string[];
  systemRules: CloudxRule[];
  systemSkills: CloudxSkill[];
}

interface SkillMaterializationSource {
  sourceDir: string;
  targetDir: string;
}

const GENERATED_CONFIG_MARKER = "# CloudX managed Codex defaults for this tab.";
const IMAGEGEN_SKILL_RELATIVE_PATH = path.join("skills", ".system", "imagegen");

export async function materializeCodexHomeOverlay(options: CodexHomeOverlayOptions): Promise<CodexHomeOverlay> {
  const baseEnv = options.baseEnv ?? process.env;
  const sourceCodexHome = options.sources.originalHome;
  const sourceConfig = await options.sources.readConfig(options.source);
  const config = prepareOverlayConfig(sourceConfig, options.source.home);
  if (options.trustedProjectPath !== undefined) {
    const projectPath = options.trustedProjectPath;
    if (!path.isAbsolute(projectPath) || projectPath !== options.cwd || await fsp.realpath(projectPath) !== projectPath) {
      throw new Error("Project trust authorization must match the canonical working directory.");
    }
    trustProject(config, projectPath);
  }
  const imagegen = await optionalLstat(path.join(sourceCodexHome, IMAGEGEN_SKILL_RELATIVE_PATH, "SKILL.md"));
  if (!imagegen?.isFile()) throw new Error("Required Codex imagegen skill is missing.");
  const codexHome = await options.sources.bind(options.tabId, options.source);
  const rulesSkillsRoot = rulesSkillsRootPath(options.dataDir);
  if (options.resetCodexHome !== false) {
    await prepareDurableView(codexHome, options.source.home);
  }
  // Only attempt-owned generated material is disposable. The bound view persists.
  const staging = await fsp.mkdtemp(path.join(codexHome, ".cloudx-generated-"));
  try {
  await ensureCloudxSystemRules(rulesSkillsRoot);
  await ensureCloudxSystemSkills(rulesSkillsRoot);
  const systemRules = await listCloudxSystemRules(rulesSkillsRoot);
  const systemSkills = await listCloudxSystemSkills(rulesSkillsRoot);

  await linkOrCopyIfExists(path.join(sourceCodexHome, "auth.json"), path.join(codexHome, "auth.json"));
  await linkOrCopyIfExists(path.join(sourceCodexHome, ".credentials.json"), path.join(codexHome, ".credentials.json"));
  await linkOrCopyIfExists(path.join(sourceCodexHome, "rules"), path.join(codexHome, "rules"));
  const stagedSkillPaths = await materializeSelectedSkills(sourceCodexHome, staging, rulesSkillsRoot, options.resolved, systemSkills);
  const skillPaths = stagedSkillPaths.map((skillPath) => path.join(codexHome, path.relative(staging, skillPath)));
  const disabledSkillPaths = await discoverDisabledSkillPaths(options.cwd, baseEnv.HOME?.trim() || os.homedir());
  const configPath = path.join(codexHome, "config.toml");
  await writeOverlayConfig(config, path.join(staging, "config.toml"), skillPaths, disabledSkillPaths);
  const stagedInstructions = await writeOverlayInstructions(sourceCodexHome, staging, options.resolved, systemRules);
  await options.sources.assertCurrent(options.source);
  await publishGenerated(staging, codexHome, Boolean(stagedInstructions));
  const instructionsPath = stagedInstructions ? path.join(codexHome, "AGENTS.override.md") : undefined;

  return {
    codexHome,
    rulesSkillsRoot,
    configPath,
    instructionsPath,
    skillPaths,
    disabledSkillPaths,
    systemRules,
    systemSkills
  };
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
}

async function publishGenerated(staging: string, home: string, hasInstructions: boolean): Promise<void> {
  for (const name of ["config.toml", "AGENTS.override.md"]) {
    const target = path.join(home, name);
    const existing = await optionalLstat(target);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unexpected generated Codex file type.");
    if (name === "AGENTS.override.md" && !hasInstructions) {
      if (existing) await fsp.unlink(target);
    } else {
      await fsp.rename(path.join(staging, name), target);
    }
  }
  const skills = path.join(home, "skills");
  await ensureStateObject(skills, "directory");
  for (const name of ["cloudx", "cloudx-system", "cloudx-exceptions"]) {
    const target = path.join(skills, name);
    const existing = await optionalLstat(target);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Unexpected generated Codex skills type.");
    if (existing) await fsp.rm(target, { recursive: true });
    const staged = path.join(staging, "skills", name);
    if (await optionalLstat(staged)) await fsp.rename(staged, target);
  }
}

async function prepareDurableView(home: string, shared: string): Promise<void> {
  // Validate every existing view path before creating any missing source objects.
  for (const name of ["config.toml", "AGENTS.override.md", "skills", ".tmp"]) {
    const existing = await optionalLstat(path.join(home, name));
    if (existing && (existing.isSymbolicLink() || ((name === "skills" || name === ".tmp") ? !existing.isDirectory() : !existing.isFile()))) throw new Error("Unexpected generated Codex view type.");
  }
  const links = ["sessions", "archived_sessions", "session_index.jsonl", "thread-writer-locks", ".tmp/rollout-maintenance.lock"];
  for (const name of links) {
    const target = path.join(home, name);
    const existing = await optionalLstat(target);
    if (!existing) continue;
    if (name === "session_index.jsonl" && existing.isFile() && !existing.isSymbolicLink()) { await validateStateObject(target, "file"); continue; }
    if (!existing.isSymbolicLink() || await fsp.realpath(target) !== await fsp.realpath(path.join(shared, name))) throw new Error("Unexpected Codex durable view link.");
  }
  for (const name of ["sessions", "archived_sessions", "session_index.jsonl"]) {
    const kind = name.endsWith(".jsonl") ? "file" : "directory";
    const source = path.join(shared, name);
    await ensureStateObject(source, kind);
    await strictStateLink(source, path.join(home, name), kind, name === "session_index.jsonl");
  }
  const writers = path.join(shared, "thread-writer-locks");
  await ensureStateObject(writers, "directory");
  await strictStateLink(writers, path.join(home, "thread-writer-locks"), "directory");
  await ensureStateObject(path.join(shared, ".tmp"), "directory");
  await ensureStateObject(path.join(home, ".tmp"), "directory");
  const maintenance = path.join(shared, ".tmp", "rollout-maintenance.lock");
  await ensureStateObject(maintenance, "file");
  await strictStateLink(maintenance, path.join(home, ".tmp", "rollout-maintenance.lock"), "file");
}

async function optionalLstat(target: string) {
  try { return await fsp.lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateStateObject(target: string, kind: "file" | "directory"): Promise<void> {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory()) || stat.uid !== process.getuid!()) throw new Error("Unexpected Codex state type or owner.");
  await fsp.access(target, fs.constants.R_OK | fs.constants.W_OK | (kind === "directory" ? fs.constants.X_OK : 0));
}

async function ensureStateObject(target: string, kind: "file" | "directory"): Promise<void> {
  try {
    if (kind === "directory") await fsp.mkdir(target, { mode: 0o700 });
    else { const handle = await fsp.open(target, "wx", 0o600); await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await validateStateObject(target, kind);
}

async function strictStateLink(source: string, target: string, kind: "file" | "directory", nativeIndex = false): Promise<void> {
  const canonical = await fsp.realpath(source);
  let existing = await optionalLstat(target);
  if (!existing) {
    try { await fsp.symlink(canonical, target, kind === "directory" ? "dir" : "file"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    existing = await fsp.lstat(target);
  }
  // Native name removal atomically renames a regular file over this one link.
  if (nativeIndex && existing.isFile() && !existing.isSymbolicLink()) {
    await validateStateObject(target, "file");
    return;
  }
  if (!existing.isSymbolicLink() || await fsp.realpath(target) !== canonical) throw new Error("Unexpected Codex durable view link.");
  const [left, right] = await Promise.all([fsp.stat(source), fsp.stat(target)]);
  if (left.dev !== right.dev || left.ino !== right.ino) throw new Error("Codex durable view identity changed.");
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".codex");
}

async function materializeSelectedSkills(
  sourceCodexHome: string,
  codexHome: string,
  rulesSkillsRoot: string,
  resolved: ResolvedPersonalityTemplate | undefined,
  systemSkills: CloudxSkill[]
): Promise<string[]> {
  await fsp.rm(path.join(codexHome, "skills", "cloudx"), { recursive: true, force: true });
  await fsp.rm(path.join(codexHome, "skills", "cloudx-system"), { recursive: true, force: true });
  await fsp.rm(path.join(codexHome, "skills", "cloudx-exceptions"), { recursive: true, force: true });
  const imagegenSourceDir = path.join(sourceCodexHome, IMAGEGEN_SKILL_RELATIVE_PATH);
  const imagegenTargetDir = path.join(codexHome, "skills", "cloudx-exceptions", "imagegen");
  const sources = [
    ...(resolved?.skills ?? []).map((skill) => ({
      sourceDir: path.dirname(cloudxSkillFilePath(rulesSkillsRoot, skill.id)),
      targetDir: path.join(codexHome, "skills", "cloudx", safePathSegment(skill.id))
    })),
    ...systemSkills.map((skill) => ({
      sourceDir: path.dirname(cloudxSystemSkillFilePath(rulesSkillsRoot, skill.id)),
      targetDir: path.join(codexHome, "skills", "cloudx-system", safePathSegment(skill.id))
    }))
  ];
  const uniqueSources = dedupeSkillSources(sources);
  for (const source of uniqueSources) {
    const sourceSkillPath = path.join(source.sourceDir, "SKILL.md");
    if (!fs.existsSync(sourceSkillPath)) {
      throw new Error(`Codex skill does not contain SKILL.md: ${sourceSkillPath}`);
    }
    await fsp.mkdir(path.dirname(source.targetDir), { recursive: true });
    await linkOrCopyIfExists(source.sourceDir, source.targetDir);
  }
  await copyRequiredSkill(imagegenSourceDir, imagegenTargetDir, "imagegen");
  return [
    ...uniqueSources.map((source) => path.join(source.targetDir, "SKILL.md")),
    path.join(imagegenTargetDir, "SKILL.md")
  ];
}

function prepareOverlayConfig(sourceConfig: string | undefined, sourceHome: string): TomlTable {
  let config: TomlTable;
  try { config = sourceConfig?.trim() ? parse(sourceConfig) : {}; } catch { throw new Error("Codex source config contains invalid TOML."); }
  if (config.sqlite_home !== undefined && typeof config.sqlite_home !== "string") throw new Error("Codex config sqlite_home must be a string.");
  if (typeof config.sqlite_home === "string" && !path.isAbsolute(config.sqlite_home) && config.sqlite_home !== "~" && !config.sqlite_home.startsWith("~/")) {
    config.sqlite_home = path.resolve(sourceHome, config.sqlite_home);
  }
  for (const name of ["features", "memories", "skills"]) tomlTable(config[name], name);
  return config;
}

function trustProject(config: TomlTable, projectPath: string): void {
  const projects = tomlTable(config.projects, "projects");
  const project = tomlTable(projects[projectPath], `projects.${projectPath}`);
  if (project.trust_level === "untrusted") throw new Error("Codex source config explicitly marks this project as untrusted.");
  if (project.trust_level !== undefined && project.trust_level !== "trusted") throw new Error("Codex project trust_level must be trusted or untrusted.");
  projects[projectPath] = { ...project, trust_level: "trusted" };
  config.projects = projects;
}

async function writeOverlayConfig(
  config: TomlTable,
  targetConfigPath: string,
  skillPaths: string[],
  disabledSkillPaths: string[]
): Promise<void> {
  if (config.model === undefined) {
    config.model = "gpt-6-astra";
  }
  const features = tomlTable(config.features, "features");
  features.apps = false;
  features.memories = false;
  features.plugins = false;
  config.features = features;

  const memories = tomlTable(config.memories, "memories");
  memories.generate_memories = false;
  memories.use_memories = false;
  config.memories = memories;

  const skills = tomlTable(config.skills, "skills");
  skills.bundled = { enabled: false };
  skills.config = [
    ...disabledSkillPaths.map((skillPath) => ({ path: skillPath, enabled: false })),
    ...skillPaths.map((skillPath) => ({ path: skillPath, enabled: true }))
  ];
  config.skills = skills;

  const rendered = stringify(config);
  await fsp.writeFile(targetConfigPath, `${GENERATED_CONFIG_MARKER}\n${rendered.trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
}

function tomlTable(value: TomlValue | undefined, name: string): TomlTable {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex config ${name} must be a TOML table.`);
  }
  return { ...(value as TomlTable) };
}

async function discoverDisabledSkillPaths(cwd: string | undefined, homeDir: string): Promise<string[]> {
  const roots = [path.join(homeDir, ".agents", "skills"), "/etc/codex/skills"];
  if (cwd) {
    const resolvedCwd = path.resolve(cwd);
    const projectRoot = await findProjectRoot(resolvedCwd);
    for (const directory of directoriesBetween(projectRoot, resolvedCwd)) {
      roots.push(path.join(directory, ".agents", "skills"), path.join(directory, ".codex", "skills"));
    }
  }
  const discovered = (await Promise.all(roots.map(discoverSkillFiles))).flat();
  return Array.from(new Set(discovered)).sort();
}

async function findProjectRoot(cwd: string): Promise<string> {
  for (const directory of ancestors(cwd)) {
    if (fs.existsSync(path.join(directory, ".git"))) {
      return directory;
    }
  }
  return cwd;
}

function directoriesBetween(root: string, cwd: string): string[] {
  const directories: string[] = [];
  for (const directory of ancestors(cwd)) {
    directories.push(directory);
    if (directory === root) {
      break;
    }
  }
  return directories.reverse();
}

function ancestors(start: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(start);
  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

async function discoverSkillFiles(root: string): Promise<string[]> {
  if (!fs.existsSync(root)) {
    return [];
  }
  const skillPaths: string[] = [];
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const canonicalDirectory = await fsp.realpath(directory);
    if (visited.has(canonicalDirectory)) {
      continue;
    }
    visited.add(canonicalDirectory);
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink())) {
        skillPaths.push(await fsp.realpath(entryPath));
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isSymbolicLink() && (await fsp.stat(entryPath)).isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
  return skillPaths;
}

async function copyRequiredSkill(sourceDir: string, targetDir: string, skillName: string): Promise<void> {
  const sourceSkillPath = path.join(sourceDir, "SKILL.md");
  if (!fs.existsSync(sourceSkillPath)) {
    throw new Error(`Required Codex ${skillName} skill is missing: ${sourceSkillPath}`);
  }
  await fsp.mkdir(path.dirname(targetDir), { recursive: true });
  await fsp.cp(sourceDir, targetDir, { recursive: true });
}

async function writeOverlayInstructions(
  sourceCodexHome: string,
  targetCodexHome: string,
  resolved: ResolvedPersonalityTemplate | undefined,
  systemRules: CloudxRule[]
): Promise<string | undefined> {
  const baseInstructions = stripGeneratedCloudxSections(await readFirstExisting([
    path.join(sourceCodexHome, "AGENTS.override.md"),
    path.join(sourceCodexHome, "AGENTS.md")
  ]));
  const cloudxRules = resolved?.rules ?? [];
  const instructionsPath = path.join(targetCodexHome, "AGENTS.override.md");
  if (!baseInstructions && systemRules.length === 0 && cloudxRules.length === 0) {
    await fsp.rm(instructionsPath, { force: true });
    return undefined;
  }

  const sections = ["# CloudX Codex Session Instructions"];
  if (baseInstructions?.trim()) {
    sections.push("", "## Base Codex Home Instructions", "", baseInstructions.trim());
  }
  if (systemRules.length > 0) {
    sections.push("", "## CloudX System Rules", "", ...systemRules.map((rule) => `- ${rule.text}`));
  }
  if (resolved && cloudxRules.length > 0) {
    sections.push("", `## CloudX Template: ${resolved.template.name}`, "", ...cloudxRules.map((rule) => `- ${rule.text}`));
  }
  await fsp.writeFile(instructionsPath, `${sections.join("\n").trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
  return instructionsPath;
}

function stripGeneratedCloudxSections(instructions: string | undefined): string | undefined {
  if (!instructions) {
    return undefined;
  }
  const lines = instructions.split(/\r?\n/u);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^## CloudX System Rules\s*$/u.test(line) || /^## CloudX Template:/u.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^## /u.test(line)) {
      skipping = false;
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  const stripped = kept.join("\n").trim();
  return stripped || undefined;
}

async function linkOrCopyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  if (fs.existsSync(targetPath)) {
    return;
  }
  const stat = await fsp.stat(sourcePath);
  try {
    await fsp.symlink(sourcePath, targetPath, stat.isDirectory() ? "dir" : "file");
  } catch {
    if (stat.isDirectory()) {
      await fsp.cp(sourcePath, targetPath, { recursive: true });
    } else {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

async function readFirstExisting(filePaths: string[]): Promise<string | undefined> {
  for (const filePath of filePaths) {
    const text = await readOptionalText(filePath);
    if (text?.trim()) {
      return text;
    }
  }
  return undefined;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/gu, "_") || "tab";
}

function dedupeSkillSources(sources: SkillMaterializationSource[]): SkillMaterializationSource[] {
  return Array.from(new Map(sources.map((source) => [source.targetDir, source])).values());
}

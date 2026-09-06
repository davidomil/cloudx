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

export interface CodexHomeOverlayOptions {
  dataDir: string;
  tabId: string;
  resolved?: ResolvedPersonalityTemplate;
  baseEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  resetCodexHome?: boolean;
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
  const sourceCodexHome = resolveCodexHome(baseEnv);
  const codexHome = path.join(options.dataDir, "codex-homes", safePathSegment(options.tabId));
  const rulesSkillsRoot = rulesSkillsRootPath(options.dataDir);
  if (options.resetCodexHome ?? true) {
    await fsp.rm(codexHome, { recursive: true, force: true });
  }
  await fsp.mkdir(codexHome, { recursive: true });
  await ensureCloudxSystemRules(rulesSkillsRoot);
  await ensureCloudxSystemSkills(rulesSkillsRoot);
  const systemRules = await listCloudxSystemRules(rulesSkillsRoot);
  const systemSkills = await listCloudxSystemSkills(rulesSkillsRoot);

  await linkOrCopyIfExists(path.join(sourceCodexHome, "auth.json"), path.join(codexHome, "auth.json"));
  await linkOrCopyIfExists(path.join(sourceCodexHome, ".credentials.json"), path.join(codexHome, ".credentials.json"));
  await linkOrCopyIfExists(path.join(sourceCodexHome, "rules"), path.join(codexHome, "rules"));
  await linkOrCopyIfExists(path.join(sourceCodexHome, "sessions"), path.join(codexHome, "sessions"));

  const skillPaths = await materializeSelectedSkills(sourceCodexHome, codexHome, rulesSkillsRoot, options.resolved, systemSkills);
  const disabledSkillPaths = await discoverDisabledSkillPaths(options.cwd, baseEnv.HOME?.trim() || os.homedir());
  const configPath = path.join(codexHome, "config.toml");
  await writeOverlayConfig(path.join(sourceCodexHome, "config.toml"), configPath, skillPaths, disabledSkillPaths);
  const instructionsPath = await writeOverlayInstructions(sourceCodexHome, codexHome, options.resolved, systemRules);

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

async function writeOverlayConfig(
  sourceConfigPath: string,
  targetConfigPath: string,
  skillPaths: string[],
  disabledSkillPaths: string[]
): Promise<void> {
  const sourceConfig = await readOptionalText(sourceConfigPath);
  const config = sourceConfig?.trim() ? parse(sourceConfig) : {};
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
  await fsp.writeFile(targetConfigPath, `${GENERATED_CONFIG_MARKER}\n${rendered.trimEnd()}\n`, "utf8");
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
  await fsp.writeFile(instructionsPath, `${sections.join("\n").trimEnd()}\n`, "utf8");
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

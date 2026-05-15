import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLOUDX_SYSTEM_SKILLS,
  cloudxSkillFilePath,
  cloudxSystemSkillFilePath,
  ensureCloudxSystemSkills,
  rulesSkillsRootPath,
  type ResolvedPersonalityTemplate
} from "./RulesSkillsCatalogService.js";

export interface CodexHomeOverlayOptions {
  dataDir: string;
  tabId: string;
  resolved?: ResolvedPersonalityTemplate;
  baseEnv?: NodeJS.ProcessEnv;
  resetCodexHome?: boolean;
}

export interface CodexHomeOverlay {
  codexHome: string;
  rulesSkillsRoot: string;
  configPath: string;
  instructionsPath?: string;
  skillPaths: string[];
}

interface SkillMaterializationSource {
  sourceDir: string;
  targetDir: string;
}

export async function materializeCodexHomeOverlay(options: CodexHomeOverlayOptions): Promise<CodexHomeOverlay> {
  const baseEnv = options.baseEnv ?? process.env;
  const sourceCodexHome = resolveCodexHome(baseEnv);
  const codexHome = path.join(options.dataDir, "codex-homes", safePathSegment(options.tabId));
  const rulesSkillsRoot = rulesSkillsRootPath(options.dataDir);
  if (options.resetCodexHome ?? true) {
    await fsp.rm(codexHome, { recursive: true, force: true });
  }
  await fsp.mkdir(codexHome, { recursive: true });
  await ensureCloudxSystemSkills(rulesSkillsRoot);

  await linkOrCopyIfExists(path.join(sourceCodexHome, "auth.json"), path.join(codexHome, "auth.json"));
  await linkOrCopyIfExists(path.join(sourceCodexHome, "rules"), path.join(codexHome, "rules"));
  await linkOrCopyIfExists(path.join(sourceCodexHome, "sessions"), path.join(codexHome, "sessions"));

  const skillPaths = await materializeSelectedSkills(codexHome, rulesSkillsRoot, options.resolved);
  const configPath = path.join(codexHome, "config.toml");
  await writeOverlayConfig(path.join(sourceCodexHome, "config.toml"), configPath, skillPaths);
  const instructionsPath = await writeOverlayInstructions(sourceCodexHome, codexHome, options.resolved);

  return {
    codexHome,
    rulesSkillsRoot,
    configPath,
    instructionsPath,
    skillPaths
  };
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".codex");
}

async function materializeSelectedSkills(codexHome: string, rulesSkillsRoot: string, resolved: ResolvedPersonalityTemplate | undefined): Promise<string[]> {
  await fsp.rm(path.join(codexHome, "skills", "cloudx"), { recursive: true, force: true });
  await fsp.rm(path.join(codexHome, "skills", "cloudx-system"), { recursive: true, force: true });
  const sources = [
    ...(resolved?.skills ?? []).map((skill) => ({
      sourceDir: path.dirname(cloudxSkillFilePath(rulesSkillsRoot, skill.id)),
      targetDir: path.join(codexHome, "skills", "cloudx", safePathSegment(skill.id))
    })),
    ...CLOUDX_SYSTEM_SKILLS.map((skill) => ({
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
  return uniqueSources.map((source) => path.join(source.targetDir, "SKILL.md"));
}

async function writeOverlayConfig(sourceConfigPath: string, targetConfigPath: string, skillPaths: string[]): Promise<void> {
  const baseConfig = await readOptionalText(sourceConfigPath);
  const generated = [
    "# CloudX generated skill enablement for this Codex tab.",
    ...skillPaths.flatMap((skillPath) => [
      "",
      "[[skills.config]]",
      `path = ${tomlString(skillPath)}`,
      "enabled = true"
    ])
  ].join("\n");
  const config = [baseConfig?.trimEnd(), generated].filter(Boolean).join("\n\n");
  await fsp.writeFile(targetConfigPath, `${config.trimEnd()}\n`, "utf8");
}

async function writeOverlayInstructions(sourceCodexHome: string, targetCodexHome: string, resolved: ResolvedPersonalityTemplate | undefined): Promise<string | undefined> {
  const baseInstructions = await readFirstExisting([
    path.join(sourceCodexHome, "AGENTS.override.md"),
    path.join(sourceCodexHome, "AGENTS.md")
  ]);
  const cloudxRules = resolved?.rules ?? [];
  const instructionsPath = path.join(targetCodexHome, "AGENTS.override.md");
  if (!baseInstructions && cloudxRules.length === 0) {
    await fsp.rm(instructionsPath, { force: true });
    return undefined;
  }

  const sections = ["# CloudX Codex Session Instructions"];
  if (baseInstructions?.trim()) {
    sections.push("", "## Base Codex Home Instructions", "", baseInstructions.trim());
  }
  if (resolved && cloudxRules.length > 0) {
    sections.push("", `## CloudX Template: ${resolved.template.name}`, "", ...cloudxRules.map((rule) => `- ${rule.text}`));
  }
  await fsp.writeFile(instructionsPath, `${sections.join("\n").trimEnd()}\n`, "utf8");
  return instructionsPath;
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function dedupeSkillSources(sources: SkillMaterializationSource[]): SkillMaterializationSource[] {
  return Array.from(new Map(sources.map((source) => [source.targetDir, source])).values());
}

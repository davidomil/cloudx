import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RULES_SKILLS_PLUGIN_ID,
  isRecord,
  type CloudxRule,
  type CloudxSkill,
  type PluginMetadata,
  type RulesSkillsStore,
  type TabIndicatorUpdate,
  type WorkspaceRuntimeContext,
  type WorkspaceTab,
  type WorkspaceWindow,
  type PersonalityTemplate
} from "@cloudx/shared";

export const DEFAULT_PERSONALITY_TEMPLATE_ID = "default-codex";
export const TEMPLATE_METADATA_KEY = "selectedTemplateId";

export interface ResolvedPersonalityTemplate {
  source: "default" | "window" | "tab";
  template: PersonalityTemplate;
  rules: CloudxRule[];
  skills: CloudxSkill[];
}

export interface MigrateCloudxSkillInput {
  sourcePath?: string;
  skillId?: string;
  id?: string;
  name?: string;
  description?: string;
}

const DEFAULT_RULE: CloudxRule = {
  id: "keep-changes-focused",
  description: "Keep changes focused and reviewable.",
  text: "Keep changes focused on the user's requested outcome."
};

const DEFAULT_TEMPLATE: PersonalityTemplate = {
  id: DEFAULT_PERSONALITY_TEMPLATE_ID,
  name: "Default Codex",
  color: "green",
  ruleIds: [DEFAULT_RULE.id],
  skillIds: []
};

export const CLOUDX_SYSTEM_SKILLS: CloudxSkill[] = [
  {
    id: "create-cloudx-skill",
    name: "Create CloudX Skill",
    description: "Create a new CloudX skill in the folder-backed CloudX rules/skills catalog.",
    scope: "system"
  },
  {
    id: "migrate-skill-to-cloudx",
    name: "Migrate Skill To CloudX",
    description: "Import an existing local Codex skill into the CloudX rules/skills catalog.",
    scope: "system"
  }
];

const SYSTEM_SKILL_INSTRUCTIONS: Record<string, string> = {
  "create-cloudx-skill": [
    "# Create CloudX Skill",
    "",
    "Create a new CloudX skill in the CloudX rules/skills catalog.",
    "",
    "## Procedure",
    "",
    "1. Read `CLOUDX_RULES_SKILLS_DIR` from the environment. If it is missing, stop and explain that CloudX did not expose the catalog path.",
    "2. Create a folder at `$CLOUDX_RULES_SKILLS_DIR/skills/<skill-id>` using a lowercase dash-separated id.",
    "3. Write `SKILL.md` in that folder with YAML frontmatter containing `name`, `description`, and `cloudx_name`.",
    "4. Put only the reusable workflow instructions in the body. Add `scripts/`, `references/`, or `assets/` folders only when they materially improve the skill.",
    "5. Keep the skill focused on one repeatable job."
  ].join("\n"),
  "migrate-skill-to-cloudx": [
    "# Migrate Skill To CloudX",
    "",
    "Migrate an existing Codex skill into the CloudX rules/skills catalog.",
    "",
    "## Procedure",
    "",
    "1. Read `CLOUDX_RULES_SKILLS_DIR` from the environment. If it is missing, stop and explain that CloudX did not expose the catalog path.",
    "2. Locate the source skill folder or `SKILL.md` requested by the user.",
    "3. Copy the skill into `$CLOUDX_RULES_SKILLS_DIR/skills/<skill-id>`.",
    "4. Ensure the migrated `SKILL.md` has YAML frontmatter with `name`, `description`, and `cloudx_name`.",
    "5. Preserve useful `scripts/`, `references/`, and `assets/` folders from the source skill."
  ].join("\n")
};

export class RulesSkillsCatalogService {
  private readonly listeners = new Set<() => void>();
  private readonly rootPath: string;

  constructor(dataDir: string) {
    this.rootPath = rulesSkillsRootPath(dataDir);
  }

  catalogRoot(): string {
    return this.rootPath;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(): Promise<RulesSkillsStore> {
    await this.ensureSeeded();
    return this.readStore();
  }

  async saveTemplate(input: Record<string, unknown>): Promise<RulesSkillsStore> {
    const store = await this.list();
    const template = normalizeTemplate(input);
    validateTemplateReferences(template, store);
    await writeJson(this.templatePath(template.id), template);
    await this.ensureSettings(store.defaultTemplateId ?? template.id);
    this.emitChange();
    return this.readStore();
  }

  async deleteTemplate(templateId: string): Promise<RulesSkillsStore> {
    await this.ensureSeeded();
    const id = assertSafeId(templateId, "template id");
    await fsp.rm(this.templatePath(id), { force: true });
    const store = await this.readStore();
    if (store.templates.length === 0) {
      const defaultRuleExists = fs.existsSync(this.rulePath(DEFAULT_RULE.id));
      await writeJson(this.templatePath(DEFAULT_TEMPLATE.id), defaultRuleExists ? DEFAULT_TEMPLATE : { ...DEFAULT_TEMPLATE, ruleIds: [] });
      await this.ensureSettings(DEFAULT_TEMPLATE.id);
    } else if (store.defaultTemplateId === id) {
      await writeJson(this.settingsPath(), { defaultTemplateId: store.templates[0]?.id });
    }
    this.emitChange();
    return this.readStore();
  }

  async setDefaultTemplate(templateId: string | undefined): Promise<RulesSkillsStore> {
    const store = await this.list();
    if (templateId !== undefined && !store.templates.some((template) => template.id === templateId)) {
      throw new Error(`Unknown personality template: ${templateId}`);
    }
    await writeJson(this.settingsPath(), { defaultTemplateId: templateId ?? store.templates[0]?.id });
    this.emitChange();
    return this.readStore();
  }

  async saveRule(input: Record<string, unknown>): Promise<RulesSkillsStore> {
    const rule = normalizeRule(input);
    await this.ensureSeeded();
    await fsp.writeFile(this.rulePath(rule.id), formatRule(rule), "utf8");
    this.emitChange();
    return this.readStore();
  }

  async deleteRule(ruleId: string): Promise<RulesSkillsStore> {
    const id = assertSafeId(ruleId, "rule id");
    const store = await this.list();
    await fsp.rm(this.rulePath(id), { force: true });
    for (const template of store.templates) {
      if (template.ruleIds.includes(id)) {
        await writeJson(this.templatePath(template.id), { ...template, ruleIds: template.ruleIds.filter((candidate) => candidate !== id) });
      }
    }
    this.emitChange();
    return this.readStore();
  }

  async saveSkill(input: Record<string, unknown>, options: { failIfExists?: boolean } = {}): Promise<RulesSkillsStore> {
    const skill = normalizeSkill(input);
    const skillDir = this.skillPath(skill.id);
    await this.ensureSeeded();
    if (options.failIfExists && (fs.existsSync(skillDir) || CLOUDX_SYSTEM_SKILLS.some((systemSkill) => systemSkill.id === skill.id))) {
      throw new Error(`CloudX skill already exists: ${skill.id}`);
    }
    await fsp.mkdir(skillDir, { recursive: true });
    await writeSkillFile(skillDir, skill);
    this.emitChange();
    return this.readStore();
  }

  async migrateSkill(input: MigrateCloudxSkillInput): Promise<RulesSkillsStore> {
    const source = resolveSourceSkill(input);
    const instructions = await fsp.readFile(source.skillFile, "utf8");
    const id = assertSafeId(input.id?.trim() || source.id, "skill id");
    const skill = normalizeSkill({
      id,
      name: input.name?.trim() || titleFromId(id),
      description: input.description?.trim() || summarizeSkill(instructions, source.skillFile),
      instructions
    });
    const skillDir = this.skillPath(skill.id);
    await this.ensureSeeded();
    if (fs.existsSync(skillDir) || CLOUDX_SYSTEM_SKILLS.some((systemSkill) => systemSkill.id === skill.id)) {
      throw new Error(`CloudX skill already exists: ${skill.id}`);
    }
    await fsp.mkdir(skillDir, { recursive: true });
    if (source.skillDir) {
      await copySkillResources(source.skillDir, skillDir);
    }
    await writeSkillFile(skillDir, skill);
    this.emitChange();
    return this.readStore();
  }

  async resolveFor(tab: WorkspaceTab, window?: WorkspaceWindow): Promise<ResolvedPersonalityTemplate | undefined> {
    if (tab.pluginId !== "codex-terminal") {
      return undefined;
    }
    const store = await this.list();
    const templates = new Map(store.templates.map((template) => [template.id, template]));
    let template = store.defaultTemplateId ? templates.get(store.defaultTemplateId) : undefined;
    let source: ResolvedPersonalityTemplate["source"] = "default";

    const windowTemplate = selectedTemplateId(window?.pluginMetadata?.[RULES_SKILLS_PLUGIN_ID]);
    if (windowTemplate && templates.has(windowTemplate)) {
      template = templates.get(windowTemplate);
      source = "window";
    }

    const tabTemplate = selectedTemplateId(tab.pluginMetadata?.[RULES_SKILLS_PLUGIN_ID]);
    if (tabTemplate && templates.has(tabTemplate)) {
      template = templates.get(tabTemplate);
      source = "tab";
    }

    return template ? resolveTemplate(template, store, source) : undefined;
  }

  async runtimeContextFor(tab: WorkspaceTab, window?: WorkspaceWindow): Promise<WorkspaceRuntimeContext> {
    const resolved = await this.resolveFor(tab, window);
    return {
      activeWindowId: window?.id,
      windowPluginMetadata: window?.pluginMetadata,
      tabPluginMetadata: tab.pluginMetadata,
      pluginRuntime: resolved ? { [RULES_SKILLS_PLUGIN_ID]: { personalityTemplate: resolved } } : undefined
    };
  }

  async tabIndicatorFor(tab: WorkspaceTab, window?: WorkspaceWindow): Promise<TabIndicatorUpdate | undefined> {
    const resolved = await this.resolveFor(tab, window);
    if (!resolved) {
      return undefined;
    }
    return {
      color: resolved.template.color,
      label: resolved.template.name,
      message: `Personality template: ${resolved.template.name}`
    };
  }

  private async readStore(): Promise<RulesSkillsStore> {
    const settings = await readJson(this.settingsPath());
    const rules = await readRules(this.rulesPath());
    const skills = await readSkills(this.skillsPath());
    const templates = await readTemplates(this.templatesPath());
    const defaultTemplateId = typeof settings.defaultTemplateId === "string" && templates.some((template) => template.id === settings.defaultTemplateId)
      ? settings.defaultTemplateId
      : templates[0]?.id;
    return {
      defaultTemplateId,
      rules,
      skills,
      systemSkills: CLOUDX_SYSTEM_SKILLS,
      templates
    };
  }

  private async ensureSeeded(): Promise<void> {
    await fsp.mkdir(this.rulesPath(), { recursive: true });
    await fsp.mkdir(this.skillsPath(), { recursive: true });
    await fsp.mkdir(this.templatesPath(), { recursive: true });
    await ensureCloudxSystemSkills(this.rootPath);
    const templateFiles = (await readDirectoryEntries(this.templatesPath())).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
    const hasTemplates = templateFiles.length > 0;
    if (!hasTemplates) {
      await fsp.writeFile(this.rulePath(DEFAULT_RULE.id), formatRule(DEFAULT_RULE), "utf8");
      await writeJson(this.templatePath(DEFAULT_TEMPLATE.id), DEFAULT_TEMPLATE);
    }
    if (!fs.existsSync(this.settingsPath())) {
      const defaultTemplateId = hasTemplates ? path.basename(templateFiles[0]?.name ?? "", ".json") : DEFAULT_TEMPLATE.id;
      await writeJson(this.settingsPath(), { defaultTemplateId });
    }
  }

  private async ensureSettings(defaultTemplateId: string): Promise<void> {
    if (!fs.existsSync(this.settingsPath())) {
      await writeJson(this.settingsPath(), { defaultTemplateId });
    }
  }

  private settingsPath(): string {
    return path.join(this.rootPath, "settings.json");
  }

  private rulesPath(): string {
    return path.join(this.rootPath, "rules");
  }

  private skillsPath(): string {
    return path.join(this.rootPath, "skills");
  }

  private templatesPath(): string {
    return path.join(this.rootPath, "templates");
  }

  private rulePath(ruleId: string): string {
    return path.join(this.rulesPath(), `${assertSafeId(ruleId, "rule id")}.md`);
  }

  private skillPath(skillId: string): string {
    return path.join(this.skillsPath(), assertSafeId(skillId, "skill id"));
  }

  private templatePath(templateId: string): string {
    return path.join(this.templatesPath(), `${assertSafeId(templateId, "template id")}.json`);
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function rulesSkillsRootPath(dataDir: string): string {
  return path.join(dataDir, "rules-skills");
}

export function cloudxSkillFilePath(rulesSkillsRoot: string, skillId: string): string {
  return path.join(rulesSkillsRoot, "skills", assertSafeId(skillId, "skill id"), "SKILL.md");
}

export function cloudxSystemSkillFilePath(rulesSkillsRoot: string, skillId: string): string {
  return path.join(rulesSkillsRoot, "system-skills", assertSafeId(skillId, "skill id"), "SKILL.md");
}

export async function ensureCloudxSystemSkills(rulesSkillsRoot: string): Promise<void> {
  for (const skill of CLOUDX_SYSTEM_SKILLS) {
    await writeSkillFile(path.dirname(cloudxSystemSkillFilePath(rulesSkillsRoot, skill.id)), {
      ...skill,
      instructions: SYSTEM_SKILL_INSTRUCTIONS[skill.id] ?? `# ${skill.name}\n\n${skill.description}`
    });
  }
}

export function templateMetadata(templateId: string | undefined): PluginMetadata | null {
  return templateId ? { [TEMPLATE_METADATA_KEY]: templateId } : null;
}

export function selectedTemplateId(metadata: unknown): string | undefined {
  return isRecord(metadata) && typeof metadata[TEMPLATE_METADATA_KEY] === "string" && metadata[TEMPLATE_METADATA_KEY].trim()
    ? metadata[TEMPLATE_METADATA_KEY].trim()
    : undefined;
}

function resolveTemplate(template: PersonalityTemplate, store: RulesSkillsStore, source: ResolvedPersonalityTemplate["source"]): ResolvedPersonalityTemplate {
  const rules = byIds(template.ruleIds, store.rules, "rule", template.id);
  const skills = byIds(template.skillIds, store.skills, "skill", template.id);
  return { source, template, rules, skills };
}

function byIds<T extends { id: string }>(ids: string[], values: T[], itemName: string, templateId: string): T[] {
  const map = new Map(values.map((value) => [value.id, value]));
  return ids.map((id) => {
    const value = map.get(id);
    if (!value) {
      throw new Error(`Template ${templateId} references missing ${itemName}: ${id}`);
    }
    return value;
  });
}

function validateTemplateReferences(template: PersonalityTemplate, store: RulesSkillsStore): void {
  byIds(template.ruleIds, store.rules, "rule", template.id);
  byIds(template.skillIds, store.skills, "skill", template.id);
}

async function readRules(rulesPath: string): Promise<CloudxRule[]> {
  const files = await readDirectoryEntries(rulesPath);
  const rules = await Promise.all(files.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => readRule(path.join(rulesPath, entry.name))));
  return rules.sort(byId);
}

async function readRule(filePath: string): Promise<CloudxRule> {
  const content = await fsp.readFile(filePath, "utf8");
  const parsed = parseMarkdownWithFrontmatter(content);
  const id = assertSafeId(parsed.frontmatter.id || path.basename(filePath, ".md"), "rule id");
  const text = ruleSentence(parsed.body, filePath);
  if (!text) {
    throw new Error(`Rule ${filePath} must contain a single-line rule sentence.`);
  }
  return {
    id,
    description: parsed.frontmatter.description || text,
    text
  };
}

async function readSkills(skillsPath: string): Promise<CloudxSkill[]> {
  const entries = await readDirectoryEntries(skillsPath);
  const skills = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readSkill(path.join(skillsPath, entry.name))));
  return skills.sort(byId);
}

async function readSkill(skillPath: string): Promise<CloudxSkill> {
  const instructionsPath = path.join(skillPath, "SKILL.md");
  if (!fs.existsSync(instructionsPath)) {
    throw new Error(`CloudX skill ${skillPath} must contain SKILL.md.`);
  }
  const instructions = await fsp.readFile(instructionsPath, "utf8");
  const parsed = parseMarkdownWithFrontmatter(instructions);
  const id = assertSafeId(path.basename(skillPath), "skill id");
  if (!parsed.frontmatter.name || !parsed.frontmatter.description) {
    throw new Error(`CloudX skill ${instructionsPath} must contain SKILL.md frontmatter with name and description.`);
  }
  return normalizeSkill({
    id,
    name: parsed.frontmatter.cloudx_name || parsed.frontmatter.name || titleFromId(id),
    description: parsed.frontmatter.description,
    instructions
  });
}

async function readTemplates(templatesPath: string): Promise<PersonalityTemplate[]> {
  const files = await readDirectoryEntries(templatesPath);
  const templates = await Promise.all(files.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => readJson(path.join(templatesPath, entry.name)).then(normalizeTemplate)));
  return templates.sort(byId);
}

async function readDirectoryEntries(directoryPath: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(directoryPath, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function parseMarkdownWithFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(content);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const frontmatterText = match[1]?.trim() ?? "";
  const body = match[2]?.trim() ?? "";
  const frontmatter = Object.fromEntries(
    frontmatterText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        return separator === -1 ? undefined : [line.slice(0, separator).trim(), parseFrontmatterValue(line.slice(separator + 1).trim())];
      })
      .filter((entry): entry is [string, string] => Boolean(entry?.[0]))
  );
  return { frontmatter, body };
}

function parseFrontmatterValue(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function formatRule(rule: CloudxRule): string {
  return `---\nid: ${rule.id}\ndescription: ${rule.description}\n---\n${rule.text}\n`;
}

async function writeSkillFile(skillDir: string, skill: CloudxSkill): Promise<void> {
  await fsp.mkdir(skillDir, { recursive: true });
  await fsp.writeFile(path.join(skillDir, "SKILL.md"), formatSkill(skill), "utf8");
}

function formatSkill(skill: CloudxSkill): string {
  const body = stripSkillFrontmatter(skill.instructions?.trim() || `# ${skill.name}\n\n${skill.description}`).trim();
  return [
    "---",
    `name: ${frontmatterString(skill.id)}`,
    `description: ${frontmatterString(singleLine(skill.description))}`,
    `cloudx_name: ${frontmatterString(singleLine(skill.name))}`,
    "---",
    "",
    body,
    ""
  ].join("\n");
}

function stripSkillFrontmatter(content: string): string {
  return parseMarkdownWithFrontmatter(content).body || content;
}

function frontmatterString(value: string): string {
  return JSON.stringify(value);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeTemplate(value: unknown): PersonalityTemplate {
  const source = isRecord(value) ? value : {};
  const template: PersonalityTemplate = {
    id: assertSafeId(typeof source.id === "string" ? source.id.trim() : "", "template id"),
    name: requiredString(source.name, "name"),
    color: source.color === "yellow" || source.color === "red" ? source.color : "green",
    ruleIds: stringArray(source.ruleIds).map((id) => assertSafeId(id, "rule id")),
    skillIds: stringArray(source.skillIds).map((id) => assertSafeId(id, "skill id"))
  };
  return template;
}

function normalizeRule(value: unknown): CloudxRule {
  const source = isRecord(value) ? value : {};
  const text = ruleSentence(requiredString(source.text, "text"), "rule text");
  return {
    id: assertSafeId(typeof source.id === "string" ? source.id.trim() : slugFromText(text), "rule id"),
    description: typeof source.description === "string" && source.description.trim() ? singleLine(source.description) : text,
    text
  };
}

function normalizeSkill(value: unknown): CloudxSkill {
  const source = isRecord(value) ? value : {};
  return {
    id: assertSafeId(typeof source.id === "string" ? source.id.trim() : "", "skill id"),
    name: requiredString(source.name, "name"),
    description: requiredString(source.description, "description"),
    instructions: typeof source.instructions === "string" ? source.instructions : undefined,
    scope: source.scope === "system" ? "system" : "user"
  };
}

function resolveSourceSkill(input: MigrateCloudxSkillInput): { id: string; skillFile: string; skillDir?: string } {
  if (input.sourcePath?.trim()) {
    const sourcePath = path.resolve(input.sourcePath.trim());
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source skill does not exist: ${sourcePath}`);
    }
    const sourceStat = fs.statSync(sourcePath);
    const skillFile = sourceStat.isDirectory() ? path.join(sourcePath, "SKILL.md") : sourcePath;
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Source skill does not contain SKILL.md: ${sourcePath}`);
    }
    return { id: path.basename(path.dirname(skillFile)), skillFile, skillDir: sourceStat.isDirectory() ? sourcePath : undefined };
  }
  if (input.skillId?.trim()) {
    const id = assertSafeId(input.skillId.trim(), "skill id");
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(process.env.HOME?.trim() || os.homedir(), ".codex");
    const skillFile = path.join(codexHome, "skills", id, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Codex skill does not contain SKILL.md: ${skillFile}`);
    }
    return { id, skillFile, skillDir: path.dirname(skillFile) };
  }
  throw new Error("migrate skill requires sourcePath or skillId.");
}

async function copySkillResources(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readDirectoryEntries(sourceDir);
  for (const entry of entries) {
    if (entry.name === "SKILL.md" || entry.name === "skill.json") {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await fsp.cp(sourcePath, targetPath, { recursive: true });
    } else if (entry.isFile()) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

function summarizeSkill(content: string, sourcePath: string): string {
  const parsed = parseMarkdownWithFrontmatter(content);
  if (parsed.frontmatter.description) {
    return parsed.frontmatter.description;
  }
  const firstText = parsed.body
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .find(Boolean);
  return firstText || `Migrated from ${sourcePath}.`;
}

function titleFromId(id: string): string {
  return id.split(/[-_]+/u).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function ruleSentence(value: string, source: string): string {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`Rule ${source} must contain exactly one non-empty line.`);
  }
  return singleLine(lines[0] ?? "");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function assertSafeId(value: string, name: string): string {
  if (!/^(?=.*[A-Za-z0-9])[A-Za-z0-9_.:-]+$/u.test(value) || value.includes("..")) {
    throw new Error(`${name} must contain at least one letter or number and only letters, numbers, dots, colons, underscores, or dashes.`);
  }
  return value;
}

function slugFromText(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48);
  return assertSafeId(slug || `rule-${Date.now()}`, "rule id");
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

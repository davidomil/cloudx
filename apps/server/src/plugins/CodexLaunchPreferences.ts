import fs from "node:fs/promises";
import path from "node:path";

import { parseTOML } from "toml-eslint-parser";

export interface CodexLaunchPreferences {
  yoloMode: boolean;
  autoTrustWorkspace: boolean;
  defaultSkills: Record<string, boolean>;
}

const PREFERENCES_COMMENT = " CloudX launch preferences:";

export function readCodexLaunchPreferences(text: string | undefined): CodexLaunchPreferences {
  const comment = preferencesComment(text ?? "");
  let value: unknown = {};
  if (comment) {
    try { value = JSON.parse(comment.value.slice(PREFERENCES_COMMENT.length)); }
    catch { throw new Error("CloudX launch preferences contain invalid JSON."); }
  }
  return validatePreferences(value);
}

export function writeCodexLaunchPreferences(text: string, preferences: CodexLaunchPreferences): string {
  const comment = preferencesComment(text);
  readCodexLaunchPreferences(text);
  const rendered = `#${PREFERENCES_COMMENT} ${JSON.stringify(validatePreferences(preferences))}`;
  return comment ? text.slice(0, comment.range[0]) + rendered + text.slice(comment.range[1]) : `${rendered}\n${text}`;
}

function validatePreferences(value: unknown): CodexLaunchPreferences {
  if (!isRecord(value) || Object.keys(value).some((key) => !["yoloMode", "autoTrustWorkspace", "defaultSkills"].includes(key)))
    throw new Error("CloudX launch preferences must contain only supported settings.");
  for (const key of ["yoloMode", "autoTrustWorkspace"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`CloudX launch preference ${key} must be a boolean.`);
  }
  const skills = value.defaultSkills === undefined ? {} : value.defaultSkills;
  if (!isRecord(skills) || Object.entries(skills).some(([id, enabled]) => !validSkillId(id) || typeof enabled !== "boolean"))
    throw new Error("CloudX default skill preferences must map skill identifiers to booleans.");
  return {
    yoloMode: value.yoloMode as boolean | undefined ?? true,
    autoTrustWorkspace: value.autoTrustWorkspace as boolean | undefined ?? false,
    defaultSkills: Object.assign(Object.create(null) as Record<string, boolean>, { imagegen: true }, skills)
  };
}

function preferencesComment(text: string) {
  let document;
  try { document = parseTOML(text, { tomlVersion: "1.1" }); }
  catch { throw new Error("Codex configuration contains unsupported TOML. No changes were saved."); }
  const comments = document.comments.filter((comment) => comment.value.startsWith(PREFERENCES_COMMENT));
  if (comments.length > 1) throw new Error("Codex configuration contains duplicate CloudX launch preference comments.");
  return comments[0];
}

export async function discoverCodexDefaultSkills(home: string): Promise<Array<{ id: string }>> {
  const root = path.join(home, "skills", ".system");
  let entries;
  try {
    if (!(await fs.lstat(root)).isDirectory()) throw new Error("Codex default skills must be a directory.");
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills: Array<{ id: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validSkillId(entry.name)) continue;
    try {
      if ((await fs.lstat(path.join(root, entry.name, "SKILL.md"))).isFile()) skills.push({ id: entry.name });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return skills.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function validSkillId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

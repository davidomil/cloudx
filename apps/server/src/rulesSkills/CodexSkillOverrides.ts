import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parse, type TomlTable } from "smol-toml";

export type CodexSkillOverride =
  | { path: string; enabled: boolean }
  | { generatedPath: string; enabled: boolean }
  | { name: string; enabled: boolean };

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_OVERRIDES = 20_000;

export function parseCodexSkillOverrides(value: unknown): CodexSkillOverride[] {
  if (!Array.isArray(value) || value.length > MAX_OVERRIDES) throw new Error("Invalid native Codex skill overrides.");
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || typeof entry.enabled !== "boolean") throw new Error("Invalid native Codex skill override.");
    const selectors = ["path", "generatedPath", "name"].filter(key => key in entry);
    if (selectors.length !== 1) throw new Error("A native Codex skill override requires exactly one selector.");
    if ("path" in entry && typeof entry.path === "string" && path.isAbsolute(entry.path) && !entry.path.includes("\0")) return { path: entry.path, enabled: entry.enabled };
    if ("generatedPath" in entry && typeof entry.generatedPath === "string" && isGeneratedSkillPath(entry.generatedPath)) return { generatedPath: entry.generatedPath, enabled: entry.enabled };
    if ("name" in entry && typeof entry.name === "string" && entry.name.trim() && !entry.name.includes("\0")) return { name: entry.name.trim(), enabled: entry.enabled };
    throw new Error("Invalid native Codex skill selector.");
  });
}

/** Native enable removes a config entry; recover that choice against CloudX's disabled defaults. */
export async function captureCodexSkillOverrides(codexHome: string, defaultDisabledPaths: string[]): Promise<CodexSkillOverride[]> {
  const file = await fs.open(path.join(codexHome, "config.toml"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let config: TomlTable;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error("Native Codex skill configuration exceeds its size limit or is not a regular file.");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error("Native Codex skill configuration exceeds its size limit.");
    config = parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
  const skills = config.skills;
  if (skills !== undefined && (!skills || typeof skills !== "object" || Array.isArray(skills) || skills instanceof Date)) throw new Error("Native Codex skills must be a TOML table.");
  const entries = parseCodexSkillOverrides(skills?.config ?? []);
  const overriddenPaths = new Set(entries.flatMap(entry => "path" in entry ? [entry.path] : []));
  const canonicalHome = await fs.realpath(codexHome);
  return parseCodexSkillOverrides([
    ...entries.map(entry => {
      if (!("path" in entry)) return entry;
      const relative = path.relative(canonicalHome, entry.path);
      return isGeneratedSkillPath(relative) ? { generatedPath: relative, enabled: entry.enabled } : entry;
    }),
    ...defaultDisabledPaths.filter(skillPath => !overriddenPaths.has(skillPath)).map(skillPath => ({ path: skillPath, enabled: true }))
  ]);
}

/** Map only selected generated skills into this view; no source overlay paths escape the handoff. */
export function resolveCodexSkillOverrides(value: unknown, codexHome: string, selectedSkillPaths: string[]): TomlTable[] {
  return parseCodexSkillOverrides(value).flatMap(entry => {
    if (!("generatedPath" in entry)) return [entry];
    const target = path.join(codexHome, entry.generatedPath);
    return selectedSkillPaths.includes(target) ? [{ path: target, enabled: entry.enabled }] : [];
  });
}

function isGeneratedSkillPath(value: string): boolean {
  const parts = value.split(path.sep);
  return parts.length === 4 && parts[0] === "skills" && ["cloudx", "cloudx-system", "cloudx-exceptions"].includes(parts[1]!) &&
    Boolean(parts[2]) && parts[2] !== "." && parts[2] !== ".." && /^[A-Za-z0-9_.:-]+$/u.test(parts[2]!) && parts[3] === "SKILL.md";
}

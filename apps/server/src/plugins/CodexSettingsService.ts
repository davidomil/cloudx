import { createHash } from "node:crypto";

import type { CodexGlobalSettings, CodexGlobalSettingsUpdate } from "@cloudx/shared";
import { parse } from "smol-toml";
import { parseTOML, type AST } from "toml-eslint-parser";

import { discoverCodexDefaultSkills, readCodexLaunchPreferences, writeCodexLaunchPreferences } from "./CodexLaunchPreferences.js";
import type { CodexStateSources, ResolvedCodexStateSource } from "./CodexStateSources.js";

export class CodexSettingsService {
  constructor(private readonly sources: CodexStateSources) {}

  async read(signal?: AbortSignal): Promise<CodexGlobalSettings> {
    const source = await this.sources.resolve(signal);
    const text = await this.sources.readConfig(source, signal);
    return settingsFromConfig(source, text, await discoverCodexDefaultSkills(this.sources.originalHome));
  }

  async update(input: CodexGlobalSettingsUpdate, signal?: AbortSignal): Promise<CodexGlobalSettings> {
    validateUpdate(input);
    const source = await this.sources.resolve(signal);
    const original = await this.sources.readConfig(source, signal);
    const defaultSkills = await discoverCodexDefaultSkills(this.sources.originalHome);
    const current = settingsFromConfig(source, original, defaultSkills);
    if (input.expectedRevision !== current.revision)
      throw new Error("Shared Codex settings changed. Reload before saving again.");

    let text = original ?? "";
    if (input.model !== undefined) text = editRootSetting(text, "model", input.model);
    if (input.serviceTier !== undefined) {
      text = editRootSetting(text, "service_tier", input.serviceTier);
      if (input.serviceTier !== null) text = enableServiceTiers(text);
    }
    for (const [field, key] of Object.entries(nativeSettings)) {
      const value = input[field as keyof typeof nativeSettings];
      if (value !== undefined) text = editRootSetting(text, key, value);
    }
    if (input.yoloMode !== undefined || input.autoTrustWorkspace !== undefined || input.defaultSkills !== undefined) {
      const preferences = readCodexLaunchPreferences(text);
      if (input.yoloMode !== undefined) preferences.yoloMode = input.yoloMode;
      if (input.autoTrustWorkspace !== undefined) preferences.autoTrustWorkspace = input.autoTrustWorkspace;
      for (const [id, enabled] of Object.entries(input.defaultSkills ?? {})) {
        if (!defaultSkills.some(skill => skill.id === id) && (enabled || !current.defaultSkills.some(skill => skill.id === id)))
          throw new Error("Selected Codex default skill is no longer installed. Reload before saving again.");
        preferences.defaultSkills[id] = enabled;
      }
      text = writeCodexLaunchPreferences(text, preferences);
    }
    if (text === (original ?? "")) return current;
    const settings = settingsFromConfig(source, text, defaultSkills);
    await this.sources.replaceConfig(source, original, text, signal);
    return settings;
  }
}

const nativeSettings = {
  reasoningEffort: "model_reasoning_effort",
  webSearch: "web_search",
  personality: "personality",
} as const;

function validateUpdate(input: CodexGlobalSettingsUpdate): void {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["expectedRevision", "model", "serviceTier", "yoloMode", "autoTrustWorkspace", "defaultSkills", ...Object.keys(nativeSettings)].includes(key))
    || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision))
    throw new Error("Invalid shared Codex settings update.");
  if (input.model !== undefined && input.model !== null
    && (typeof input.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.model)))
    throw new Error("Codex model must be a model identifier of at most 128 characters.");
  if (input.serviceTier !== undefined && input.serviceTier !== null
    && !["priority", "default", "flex"].includes(input.serviceTier))
    throw new Error("Invalid Codex service tier.");
  for (const key of ["yoloMode", "autoTrustWorkspace"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`Codex ${key} must be a boolean.`);
  }
  const choices = {
    reasoningEffort: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    webSearch: ["disabled", "cached", "indexed", "live"],
    personality: ["none", "friendly", "pragmatic"],
  };
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
    if (input[key] !== undefined && input[key] !== null && !choices[key].includes(input[key])) throw new Error(`Invalid Codex ${key}.`);
  }
  if (input.defaultSkills !== undefined && (!input.defaultSkills || typeof input.defaultSkills !== "object" || Array.isArray(input.defaultSkills)
    || Object.entries(input.defaultSkills).some(([id, enabled]) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || typeof enabled !== "boolean")))
    throw new Error("Invalid Codex default skills selection.");
}

function settingsFromConfig(source: ResolvedCodexStateSource, text: string | undefined, defaultSkills: { id: string }[]): CodexGlobalSettings {
  let config;
  try { config = parse(text ?? ""); }
  catch { throw new Error("Shared Codex configuration contains invalid TOML. Fix config.toml before editing settings."); }
  for (const key of ["model", "service_tier", ...Object.values(nativeSettings)]) {
    if (config[key] !== undefined && typeof config[key] !== "string")
      throw new Error(`Codex configuration ${key} must be a string.`);
  }
  const features = config.features;
  if (features !== undefined && (!features || typeof features !== "object" || Array.isArray(features) || features instanceof Date))
    throw new Error("Codex configuration features must be a table.");
  const fastMode = (features as Record<string, unknown> | undefined)?.fast_mode;
  if (fastMode !== undefined && typeof fastMode !== "boolean")
    throw new Error("Codex configuration features.fast_mode must be a boolean.");
  const preferences = readCodexLaunchPreferences(text);
  return {
    yoloMode: preferences.yoloMode,
    autoTrustWorkspace: preferences.autoTrustWorkspace,
    defaultSkills: [...new Set([...defaultSkills.map(skill => skill.id), ...Object.keys(preferences.defaultSkills)])].sort().map(id => ({
      id, enabled: preferences.defaultSkills[id] ?? false, available: defaultSkills.some(skill => skill.id === id),
    })),
    reasoningEffort: config.model_reasoning_effort as string | undefined ?? null,
    webSearch: config.web_search as string | undefined ?? null,
    personality: config.personality as string | undefined ?? null,
    revision: createHash("sha256").update(JSON.stringify([source.home, source.dev, source.ino, text ?? null])).digest("hex"),
    model: config.model as string | undefined ?? null,
    serviceTier: config.service_tier as string | undefined ?? null,
    fastModeEnabled: fastMode as boolean | undefined ?? null,
  };
}

function parseDocument(text: string): AST.TOMLProgram {
  try { return parseTOML(text, { tomlVersion: "1.1" }); }
  catch { throw new Error("Shared Codex configuration contains unsupported TOML. No changes were saved."); }
}

function keyParts(key: AST.TOMLKey): string[] {
  return key.keys.map((part) => part.type === "TOMLBare" ? part.name : part.value);
}

function hasKey(entry: AST.TOMLKeyValue | AST.TOMLTable, ...parts: string[]): boolean {
  const actual = keyParts(entry.key);
  return actual.length === parts.length && actual.every((part, index) => part === parts[index]);
}

function replaceRange(text: string, range: [number, number], value: string): string {
  return text.slice(0, range[0]) + value + text.slice(range[1]);
}

function editRootSetting(text: string, key: string, value: string | null): string {
  const entry = parseDocument(text).body[0].body.find((item) => item.type === "TOMLKeyValue" && hasKey(item, key));
  if (entry?.type === "TOMLKeyValue") {
    return value === null ? replaceRange(text, entry.range, "") : replaceRange(text, entry.value.range, JSON.stringify(value));
  }
  return value === null ? text : `${key} = ${JSON.stringify(value)}\n${text}`;
}

function enableServiceTiers(text: string): string {
  const entries = parseDocument(text).body[0].body;
  const dotted = entries.find((entry) => entry.type === "TOMLKeyValue" && hasKey(entry, "features", "fast_mode"));
  if (dotted?.type === "TOMLKeyValue") return replaceRange(text, dotted.value.range, "true");
  const features = entries.find((entry) => hasKey(entry, "features"));
  if (features?.type === "TOMLTable") {
    const flag = features.body.find((entry) => hasKey(entry, "fast_mode"));
    if (flag) return replaceRange(text, flag.value.range, "true");
    const lineEnd = text.indexOf("\n", features.key.range[1]);
    const insertion = lineEnd === -1 ? text.length : lineEnd + 1;
    return replaceRange(text, [insertion, insertion], `${lineEnd === -1 ? "\n" : ""}fast_mode = true\n`);
  }
  if (features?.type === "TOMLKeyValue" && features.value.type === "TOMLInlineTable") {
    const flag = features.value.body.find((entry) => hasKey(entry, "fast_mode"));
    if (flag) return replaceRange(text, flag.value.range, "true");
    const insertion = features.value.range[0] + 1;
    return replaceRange(text, [insertion, insertion], ` fast_mode = true${features.value.body.length ? "," : ""} `);
  }
  // A dotted key can join other dotted feature keys or an implicit parent table.
  return `features.fast_mode = true\n${text}`;
}

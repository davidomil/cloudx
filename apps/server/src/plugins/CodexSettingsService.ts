import { createHash } from "node:crypto";
import path from "node:path";

import type { CodexGlobalSettings, CodexGlobalSettingsUpdate } from "@cloudx/shared";
import { parse, stringify } from "smol-toml";
import { parseTOML, type AST } from "toml-eslint-parser";

import { discoverCodexDefaultSkills, readCodexLaunchPreferences, writeCodexLaunchPreferences } from "./CodexLaunchPreferences.js";
import { codexConfigurationFilename, type CodexStateSources, type ResolvedCodexStateSource } from "./CodexStateSources.js";
import { readCodexVersion } from "../../../../scripts/codex-updater.mjs";
import { buildToolEnv, resolveAssistantCommand } from "../terminal/ShellLaunch.js";
import { readCodexConfiguration, validateCodexNativeOptions } from "./CodexConfigurationSettings.js";
import { validateNativeCodexConfiguration } from "./CodexConfigurationProbe.js";
import { editCodexConfiguration, mergeCodexConfigurationLayers, parseCodexConfiguration, preserveHiddenCodexValues, withCodexLaunchModelDefault } from "./CodexConfigurationDocument.js";
import { resolveCodexConfigurationPaths } from "./CodexConfigurationPaths.js";

export class CodexSettingsService {
  constructor(private readonly sources: CodexStateSources, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async read(signal?: AbortSignal, targetProfile?: string): Promise<CodexGlobalSettings> {
    codexConfigurationFilename(targetProfile);
    const source = await this.sources.resolve(signal);
    const text = await this.sources.readConfig(source, signal, targetProfile);
    return this.settings(source, text, await discoverCodexDefaultSkills(this.sources.originalHome), signal, targetProfile);
  }

  async update(input: CodexGlobalSettingsUpdate, signal?: AbortSignal): Promise<CodexGlobalSettings> {
    validateUpdate(input);
    const source = await this.sources.resolve(signal);
    codexConfigurationFilename(input.targetProfile);
    if (input.targetProfile && [input.yoloMode, input.autoTrustWorkspace, input.defaultSkills, input.configProfile].some(value => value !== undefined)) throw new Error("CloudX launch preferences must be edited in the base user configuration.");
    const original = await this.sources.readConfig(source, signal, input.targetProfile);
    const baseOriginal = input.targetProfile ? await this.sources.readConfig(source, signal) : original;
    const expectedLayers: { profile?: string; content: string | undefined }[] = input.targetProfile ? [{ content: baseOriginal }] : [];
    const originalProfile = readCodexLaunchPreferences(baseOriginal).configProfile;
    if (originalProfile && originalProfile !== input.targetProfile)
      expectedLayers.push({ profile: originalProfile, content: await this.sources.readConfig(source, signal, originalProfile) });
    const defaultSkills = await discoverCodexDefaultSkills(this.sources.originalHome);
    const current = await this.settings(source, original, defaultSkills, signal, input.targetProfile);
    if (input.expectedRevision !== current.revision)
      throw new Error("Shared Codex settings changed. Reload before saving again.");

    let text = original ?? "";
    if (input.nativeOptions !== undefined) {
      validateCodexNativeOptions(input.nativeOptions, current.configuration!, original ?? "");
      const stored = parseCodexConfiguration(text);
      for (const [family, value] of Object.entries(input.nativeOptions)) {
        const replacement = value === null ? null : preserveHiddenCodexValues(stored[family], current.configuration!.values[family], value);
        text = editCodexConfiguration(text, family, stored[family], replacement);
      }
    }
    if (input.model !== undefined) text = editRootSetting(text, "model", input.model);
    if (input.serviceTier !== undefined) {
      text = editRootSetting(text, "service_tier", input.serviceTier);
      if (input.serviceTier !== null) text = enableServiceTiers(text);
    }
    for (const [field, key] of Object.entries(nativeSettings)) {
      const value = input[field as keyof typeof nativeSettings];
      if (value !== undefined) text = editRootSetting(text, key, value);
    }
    if (input.yoloMode !== undefined || input.autoTrustWorkspace !== undefined || input.defaultSkills !== undefined || input.configProfile !== undefined) {
      const preferences = readCodexLaunchPreferences(text);
      if (input.yoloMode !== undefined) preferences.yoloMode = input.yoloMode;
      if (input.autoTrustWorkspace !== undefined) preferences.autoTrustWorkspace = input.autoTrustWorkspace;
      if (input.configProfile !== undefined) {
        if (input.configProfile !== null && !(await this.sources.listConfigProfiles(source, signal)).includes(input.configProfile)) throw new Error("Selected native Codex profile file does not exist. Create it before selecting it for launch.");
        if (input.configProfile === null) delete preferences.configProfile;
        else preferences.configProfile = input.configProfile;
      }
      for (const [id, enabled] of Object.entries(input.defaultSkills ?? {})) {
        if (!defaultSkills.some(skill => skill.id === id) && (enabled || !current.defaultSkills.some(skill => skill.id === id)))
          throw new Error("Selected Codex default skill is no longer installed. Reload before saving again.");
        preferences.defaultSkills[id] = enabled;
      }
      text = writeCodexLaunchPreferences(text, preferences);
    }
    if (text === (original ?? "")) return current;
    const settings = await this.settings(source, text, defaultSkills, signal, input.targetProfile);
    const nativeChanged = [input.model, input.serviceTier, input.reasoningEffort, input.webSearch, input.personality].some(value => value !== undefined);
    if (input.nativeOptions !== undefined || input.configProfile !== undefined || nativeChanged) {
      const name = input.targetProfile ?? settings.configProfile;
      const profileText = name ? (input.targetProfile ? text : await this.sources.readConfig(source, signal, name)) : undefined;
      if (name && name !== input.targetProfile && !expectedLayers.some(layer => layer.profile === name)) expectedLayers.push({ profile: name, content: profileText });
      const baseCandidate = input.targetProfile ? baseOriginal ?? "" : text;
      const origin = (value: string) => stringify(resolveCodexConfigurationPaths(parseCodexConfiguration(value), source.home, this.env.HOME));
      const checkPersonality = [input.personality, input.nativeOptions?.personality].some(value => value !== undefined && value !== null && value !== "none");
      await validateNativeCodexConfiguration(current.configuration!.selectedCommand, origin(baseCandidate), buildToolEnv(this.env), signal, name && profileText !== undefined ? { name, text: origin(profileText) } : undefined, resolveCodexConfigurationPaths(current.configuration!.effectiveValues, source.home, this.env.HOME), checkPersonality);
      const verified = await this.settings(source, original, defaultSkills, signal, input.targetProfile);
      if (verified.revision !== current.revision)
        throw new Error("Codex configuration layers or selected executable changed. Reload before saving settings.");
    }
    await this.sources.replaceConfig(source, original, text, signal, input.targetProfile, expectedLayers);
    return this.settings(source, text, defaultSkills, signal, input.targetProfile);
  }

  private async settings(source: ResolvedCodexStateSource, text: string | undefined, skills: { id: string }[], signal?: AbortSignal, targetProfile?: string): Promise<CodexGlobalSettings> {
    const settings = settingsFromConfig(source, text, skills);
    const baseText = targetProfile ? await this.sources.readConfig(source, signal) : text;
    const preferences = readCodexLaunchPreferences(baseText);
    if (targetProfile) Object.assign(settings, { yoloMode: preferences.yoloMode, autoTrustWorkspace: preferences.autoTrustWorkspace, defaultSkills: settingsFromConfig(source, baseText, skills).defaultSkills });
    if (preferences.configProfile) settings.configProfile = preferences.configProfile;
    const env = buildToolEnv(this.env);
    const command = resolveAssistantCommand(env);
    let version: string;
    try { version = await readCodexVersion(command, { env, signal }); }
    catch { version = "unavailable"; }
    if (signal?.aborted) throw new Error("Codex settings read cancelled.");
    settings.configuration = readCodexConfiguration(text ?? "", version, command, path.join(source.home, codexConfigurationFilename(targetProfile)), settings.yoloMode);
    settings.configuration.targetProfile = targetProfile ?? null;
    settings.configuration.profileFiles = await this.sources.listConfigProfiles(source, signal);
    if (targetProfile) {
      const base = readCodexConfiguration(baseText ?? "", version, command, path.join(source.home, "config.toml"), settings.yoloMode);
      settings.configuration.effectiveValues = mergeCodexConfigurationLayers(base.values, settings.configuration.values);
      settings.configuration.overrides.push(`Editing separate native profile: ${targetProfile}.config.toml; base values are inherited where unset.`);
    }
    let selectedProfileText: string | undefined;
    if (!targetProfile && preferences.configProfile) {
      const profile = await this.sources.readConfig(source, signal, preferences.configProfile);
      selectedProfileText = profile;
      if (profile === undefined) settings.configuration.blockedReason = "The selected native Codex profile file is missing.";
      else {
        const selected = readCodexConfiguration(profile, version, command, path.join(source.home, codexConfigurationFilename(preferences.configProfile)), settings.yoloMode);
        settings.configuration.effectiveValues = mergeCodexConfigurationLayers(settings.configuration.values, selected.values);
        settings.configuration.overrides.push(`Selected native profile: ${preferences.configProfile}.config.toml`);
      }
    }
    if (settings.configuration.effectiveValues.model === undefined) {
      settings.configuration.effectiveValues = withCodexLaunchModelDefault(settings.configuration.effectiveValues);
      settings.configuration.overrides.push(`model: CloudX launch default ${settings.configuration.effectiveValues.model} applies when no user/profile model is set.`);
    }
    settings.revision = createHash("sha256").update(JSON.stringify([settings.revision, baseText, targetProfile, settings.configuration.profileFiles, selectedProfileText, command, version])).digest("hex");
    return settings;
  }
}

const nativeSettings = {
  reasoningEffort: "model_reasoning_effort",
  webSearch: "web_search",
  personality: "personality",
} as const;

const nativeAliases = { model: "model", serviceTier: "service_tier", ...nativeSettings } as const;

function validateUpdate(input: CodexGlobalSettingsUpdate): void {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["expectedRevision", "model", "serviceTier", "yoloMode", "autoTrustWorkspace", "defaultSkills", "nativeOptions", "targetProfile", "configProfile", ...Object.keys(nativeSettings)].includes(key))
    || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision))
    throw new Error("Invalid shared Codex settings update.");
  for (const [field, key] of Object.entries(nativeAliases)) {
    const quick = input[field as keyof typeof nativeAliases];
    if (quick !== undefined && input.nativeOptions && Object.hasOwn(input.nativeOptions, key) && quick !== input.nativeOptions[key])
      throw new Error(`Conflicting Codex ${key} values. Submit one value before saving.`);
  }
  for (const profile of [input.targetProfile, input.configProfile]) if (profile !== undefined && profile !== null) codexConfigurationFilename(profile);
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

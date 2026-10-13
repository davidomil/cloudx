import schema01600 from "./codexConfigurationSchema-0.160.0.json" with { type: "json" };
import schema01621 from "./codexConfigurationSchema-0.162.1.json" with { type: "json" };
import mapping from "./codexConfigurationMapping.json" with { type: "json" };
import versions from "./codexConfigurationVersions.json" with { type: "json" };
import featureDefaults from "./codexConfigurationFeatures.json" with { type: "json" };
import cliOptions from "./codexConfigurationCliOptions.json" with { type: "json" };
import cliMapping from "./codexConfigurationCliMapping.json" with { type: "json" };
import type { CodexConfigurationValue } from "./codexSettings.js";

export type CodexConfigurationVersion = "0.160.0" | "0.162.1";
export type CodexConfigurationStatus = "stable" | "experimental" | "deprecated";
export type CodexConfigurationPlatform = "all" | "linux" | "macos" | "windows";
export type CodexConfigurationScope = "user" | "user/project" | "profile" | "secret";
export type CodexConfigurationType = "string" | "boolean" | "integer" | "number" | "object" | "array" | "mixed";

export interface CodexConfigurationEntry {
  path: string;
  family: string;
  group: string;
  description: string;
  status: CodexConfigurationStatus;
  platform: CodexConfigurationPlatform;
  scope: CodexConfigurationScope;
  editable: boolean;
  reason?: string;
  type: CodexConfigurationType;
  enum?: CodexConfigurationValue[];
  default?: CodexConfigurationValue | null;
  defaultSource: "schema" | "native-feature" | "runtime";
  defaultDescription: string;
}

export interface CodexConfigurationCliEntry {
  path: string;
  command: string;
  flag: string;
  scope: "launch";
  description: string;
  reason: string;
  aliases?: string[];
  aliasOf?: string;
  internal?: boolean;
}

export interface CodexConfigurationSchema {
  [key: string]: unknown;
  $ref?: string;
  type?: string | string[];
  description?: string;
  default?: CodexConfigurationValue | null;
  enum?: CodexConfigurationValue[];
  properties?: Record<string, CodexConfigurationSchema | boolean>;
  definitions?: Record<string, CodexConfigurationSchema>;
  additionalProperties?: CodexConfigurationSchema | boolean;
  items?: CodexConfigurationSchema | (CodexConfigurationSchema | boolean)[] | boolean;
  allOf?: (CodexConfigurationSchema | boolean)[];
  anyOf?: (CodexConfigurationSchema | boolean)[];
  oneOf?: (CodexConfigurationSchema | boolean)[];
}

export const CODEX_CONFIGURATION_BASELINE_VERSION: CodexConfigurationVersion = "0.162.1";
export const CODEX_CONFIGURATION_VERSIONS = versions;
export const CODEX_CONFIGURATION_CLI_OPTIONS = cliOptions;
export const CODEX_CONFIGURATION_SCHEMAS: Record<CodexConfigurationVersion, CodexConfigurationSchema> = {
  "0.160.0": schema01600 as unknown as CodexConfigurationSchema,
  "0.162.1": schema01621 as unknown as CodexConfigurationSchema,
};

export const CODEX_PERMISSIONS_SCHEMA_SOURCE = "https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/config/src/permissions_toml.rs";
export const CODEX_RUNTIME_CONSTRAINTS_SOURCE = "https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/config/mod.rs";

/** The native schema drops serde(flatten) map values. These map types are identical in both pinned tags. */
export function codexConfigurationValidationSchema(version: string): CodexConfigurationSchema {
  const schema = structuredClone(codexConfigurationSchema(version));
  const maps: Record<string, CodexConfigurationSchema> = {
    PermissionsToml: { $ref: "#/definitions/PermissionProfileToml" },
    WorkspaceRootsToml: { type: "boolean" },
    FilesystemPermissionsToml: { $ref: "#/definitions/FilesystemPermissionToml" },
    NetworkDomainPermissionsToml: { type: "string", enum: ["allow", "deny"] },
    NetworkUnixSocketPermissionsToml: { type: "string", enum: ["allow", "deny"] },
  };
  for (const [definition, values] of Object.entries(maps)) {
    const target = schema.definitions?.[definition];
    if (!target) throw new Error(`Codex ${version} has no ${definition} schema.`);
    target.additionalProperties = values;
  }
  const compactPercent = schema.properties?.model_post_turn_compact_threshold_percent;
  if (compactPercent && typeof compactPercent === "object") compactPercent.maximum = 100;
  return schema;
}

export function codexConfigurationSchema(version: string): CodexConfigurationSchema {
  if (!Object.hasOwn(CODEX_CONFIGURATION_SCHEMAS, version))
    throw new Error(`Codex ${version} has no reviewed configuration catalog. Supported versions: ${Object.keys(CODEX_CONFIGURATION_SCHEMAS).join(", ")}.`);
  return CODEX_CONFIGURATION_SCHEMAS[version as CodexConfigurationVersion];
}

/** Maps use *, array items use []; alternatives contribute all supported child paths. */
export function inventoryCodexConfiguration(schema: CodexConfigurationSchema): Map<string, CodexConfigurationSchema[]> {
  const paths = new Map<string, CodexConfigurationSchema[]>();
  const visit = (value: CodexConfigurationSchema | boolean, path: string, references: ReadonlySet<string>): void => {
    const node = typeof value === "boolean" ? {} : value;
    if (path) {
      const nodes = paths.get(path) ?? [];
      nodes.push(node);
      paths.set(path, nodes);
    }
    if (node.$ref && !references.has(node.$ref)) {
      if (!node.$ref.startsWith("#/")) throw new Error(`Unsupported external Codex schema reference: ${node.$ref}`);
      let target: unknown = schema;
      for (const part of node.$ref.slice(2).split("/"))
        target = (target as Record<string, unknown>)?.[part.replaceAll("~1", "/").replaceAll("~0", "~")];
      if (!target || typeof target !== "object") throw new Error(`Missing Codex schema reference: ${node.$ref}`);
      visit(target as CodexConfigurationSchema, path, new Set([...references, node.$ref]));
    }
    for (const alternatives of [node.allOf, node.anyOf, node.oneOf])
      for (const alternative of alternatives ?? []) visit(alternative, path, references);
    for (const [name, child] of Object.entries(node.properties ?? {})) visit(child, path ? `${path}.${name}` : name, references);
    if (node.additionalProperties && typeof node.additionalProperties === "object") visit(node.additionalProperties, `${path}.*`, references);
    else if (node.additionalProperties === true || (node.type === "object" && !node.properties && node.additionalProperties !== false))
      visit({}, `${path}.*`, references);
    if (Array.isArray(node.items)) node.items.forEach((item, index) => visit(item, `${path}.[${index}]`, references));
    else if (node.items !== undefined) visit(node.items, `${path}.[]`, references);
  };
  visit(schema, "", new Set());
  return paths;
}

export function codexConfigurationCoverage(schema: CodexConfigurationSchema, entries: readonly Pick<CodexConfigurationEntry, "path">[]): string[] {
  const mapped = new Set(entries.map(entry => entry.path));
  return [...inventoryCodexConfiguration(schema).keys()].filter(path => !mapped.has(path)).sort();
}

export function codexConfigurationCliCatalog(version: string = CODEX_CONFIGURATION_BASELINE_VERSION): CodexConfigurationCliEntry[] {
  codexConfigurationSchema(version);
  const reviewed = new Map((cliMapping as CodexConfigurationCliEntry[]).map(entry => [entry.path, entry]));
  return Object.entries(cliOptions[version as CodexConfigurationVersion]).flatMap(([command, flags]) => flags.map(flag => {
    const path = `${command} --${flag}`;
    const entry = reviewed.get(path);
    if (!entry) throw new Error(`Unmapped Codex ${version} launch option: ${path}`);
    return entry;
  }));
}

export function codexConfigurationCliCoverage(help: string, command: string, entries: readonly Pick<CodexConfigurationCliEntry, "path">[]): string[] {
  const mapped = new Set(entries.map(entry => entry.path));
  const options = [...help.matchAll(/^\s*(?:-[A-Za-z],\s*)?(--[a-z0-9-]+)/gm)].map(match => `${command} ${match[1]}`);
  return [...new Set(options.filter(path => !mapped.has(path)))].sort();
}

type MappingRow = [string, string, CodexConfigurationStatus, CodexConfigurationPlatform, CodexConfigurationScope, boolean, string?];
const reviewedMapping = new Map((mapping as MappingRow[]).map(row => [row[0], row]));

export function codexConfigurationCatalog(version: string = CODEX_CONFIGURATION_BASELINE_VERSION): CodexConfigurationEntry[] {
  const nativeFeatures = featureDefaults[version as CodexConfigurationVersion];
  return [...inventoryCodexConfiguration(codexConfigurationValidationSchema(version))].map<CodexConfigurationEntry>(([path, nodes]) => {
    const row = reviewedMapping.get(path);
    if (!row) throw new Error(`Unmapped Codex ${version} configuration path: ${path}`);
    const [, group, status, platform, scope, mappedEditable, mappedReason] = row;
    const described = nodes.find(node => node.description)?.description;
    const schemaDefault = nodes.find(node => Object.hasOwn(node, "default"));
    const localPath = path.replace(/^profiles\.\*\./, "");
    const featureMetadata = /^features\.([^.]+)/.exec(localPath)?.[1];
    const nativeFeature = featureMetadata ? (nativeFeatures as Record<string, { stage: string }>)[featureMetadata] : undefined;
    const removedFeatureReason = "Removed native feature retained only for parsing old configuration; changing it has no supported effect.";
    const reason = nativeFeature?.stage === "Removed" ? removedFeatureReason : mappedReason === removedFeatureReason ? undefined : mappedReason;
    const editable = nativeFeature && mappedReason === removedFeatureReason
      ? nativeFeature.stage !== "Removed" : mappedEditable && nativeFeature?.stage !== "Removed";
    const feature = /^features\.([^.]+)$/.exec(localPath)?.[1];
    const nativeDefault = feature ? (nativeFeatures as Record<string, { default: boolean | null; defaultDescription: string; stage: string }>)[feature] : undefined;
    const types = [...new Set(nodes.flatMap(node => typeof node.type === "string" ? [node.type] : node.type ?? []))];
    const choices = nodes.flatMap(node => node.enum ?? []);
    const uniqueChoices = choices.filter((value, index) => choices.findIndex(other => JSON.stringify(value) === JSON.stringify(other)) === index);
    const defaultSource: CodexConfigurationEntry["defaultSource"] = schemaDefault && schemaDefault.default !== null ? "schema" : nativeDefault ? "native-feature" : "runtime";
    return {
      path, family: path.split(".")[0]!, group,
      description: described ?? `Native ${path.replaceAll(".", " ").replaceAll("_", " ")} configuration.`,
      status: path === "profile" || path.startsWith("profiles") || status === "deprecated" && mappedReason !== removedFeatureReason
        ? "deprecated" : nativeFeature ? featureStatus(nativeFeature.stage) : status,
      platform, scope, editable, ...(reason ? { reason } : {}),
      type: types.length === 1 ? types[0] as CodexConfigurationType : "mixed",
      ...(uniqueChoices.length ? { enum: uniqueChoices } : {}),
      ...(defaultSource === "schema" ? { default: schemaDefault!.default } : nativeDefault?.default !== null && nativeDefault?.default !== undefined ? { default: nativeDefault.default } : {}),
      defaultSource,
      defaultDescription: defaultSource === "schema" ? `Schema default: ${JSON.stringify(schemaDefault!.default)}.`
        : nativeDefault?.defaultDescription ?? runtimeDefaultDescription(localPath, described),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function featureStatus(stage: string): CodexConfigurationStatus {
  return stage === "Stable" ? "stable" : stage === "Deprecated" || stage === "Removed" ? "deprecated" : "experimental";
}

function runtimeDefaultDescription(path: string, description: string | undefined): string {
  if (path === "model" || path.startsWith("model_reasoning") || path === "model_verbosity" || path === "model_context_window" || path.startsWith("model_auto_compact"))
    return "Unset/inherit: Codex resolves this from the selected model/provider and higher-priority layers; only model-advertised capabilities are effective.";
  if (description && /default|when unset|when omitted/i.test(description))
    return `Unset/inherit: ${description}`;
  return "Unset/inherit: no literal default is declared in the pinned schema; Codex resolves the native value from runtime context and configuration layers.";
}

const protectedPatterns = (mapping as MappingRow[]).filter(row => row[4] === "secret").map(row => row[0].split("."));
const knownPatterns = new Map<string, readonly { parts: string[]; arbitraryValues: boolean }[]>();

export function isCodexKnownPath(parts: readonly string[], version: string = CODEX_CONFIGURATION_BASELINE_VERSION): boolean {
  let patterns = knownPatterns.get(version);
  if (!patterns) {
    const inventory = inventoryCodexConfiguration(codexConfigurationValidationSchema(version));
    patterns = [...inventory.keys()].map(path => ({
      parts: path.split("."),
      arbitraryValues: path.endsWith(".*") && Boolean(inventory.get(path.slice(0, -2))?.some(node =>
        node.additionalProperties === true || node.additionalProperties && typeof node.additionalProperties === "object" && !Object.keys(node.additionalProperties).length)),
    }));
    knownPatterns.set(version, patterns);
  }
  return patterns.some(pattern => (pattern.parts.length === parts.length || pattern.arbitraryValues) && pathMatches(pattern.parts, parts));
}

export function isCodexProtectedPath(parts: readonly string[]): boolean {
  return protectedPatterns.some(pattern => pattern.length <= parts.length && pattern.every((part, index) =>
    part === "*" || part === "[]" && /^\d+$/.test(parts[index]!) || part === parts[index]));
}

export function isCodexReadOnlyPath(parts: readonly string[], version: string = CODEX_CONFIGURATION_BASELINE_VERSION): boolean {
  codexConfigurationSchema(version);
  const local = parts[0] === "profiles" ? parts.slice(2) : parts;
  if (local[0] === "features" && local[1]) {
    const feature = (featureDefaults[version as CodexConfigurationVersion] as Record<string, { stage: string }>)[local[1]];
    if (feature?.stage === "Removed") return true;
  }
  return (mapping as MappingRow[]).some(row => !row[5] && !row[6]?.startsWith("Removed native feature") && pathMatches(row[0].split("."), parts));
}

function pathMatches(pattern: readonly string[], parts: readonly string[]): boolean {
  return pattern.length <= parts.length && pattern.every((part, index) =>
    part === "*" || part === "[]" && /^\d+$/.test(parts[index]!) || part === parts[index]);
}

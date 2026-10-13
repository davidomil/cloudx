import { Ajv } from "ajv";
import {
  CODEX_CONFIGURATION_BASELINE_VERSION, codexConfigurationCatalog, codexConfigurationValidationSchema,
  isCodexProtectedPath, isCodexReadOnlyPath, isCodexKnownPath, type CodexConfigurationSnapshot, type CodexConfigurationValue,
} from "@cloudx/shared";
import { parseCodexConfiguration } from "./CodexConfigurationDocument.js";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

function publicValue(value: unknown, parts: string[], version: string): CodexConfigurationValue | undefined {
  const known = isCodexKnownPath(parts, version);
  if (!known || isCodexProtectedPath(parts) || isCodexReadOnlyPath(parts, version)) return undefined;
  if (Array.isArray(value)) return value.map((item, index) => publicValue(item, [...parts, String(index)], version)).filter(item => item !== undefined);
  if (record(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const safe = publicValue(item, [...parts, key], version);
    return safe === undefined ? [] : [[key, safe]];
  }));
  if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
}

export function readCodexConfiguration(text: string, version: string, command: string, sourcePath: string, yolo: boolean): CodexConfigurationSnapshot {
  const config = parseCodexConfiguration(text);
  const baseline = codexConfigurationCatalog(CODEX_CONFIGURATION_BASELINE_VERSION);
  const reviewedVersion = ["0.160.0", "0.162.1"].includes(version) ? version : CODEX_CONFIGURATION_BASELINE_VERSION;
  const families = new Set(baseline.map(entry => entry.family));
  const values: Record<string, CodexConfigurationValue> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!families.has(key)) continue;
    const safe = publicValue(value, [key], reviewedVersion);
    if (safe !== undefined) values[key] = safe;
  }
  const effectiveValues = { ...values };
  const overrides: string[] = [];
  if (config.profile !== undefined) overrides.push("Legacy config.toml profile selector is rejected by native Codex; use a separate profile file and launch selection.");
  if (yolo) overrides.push("approval_policy and sandbox_mode: CloudX YOLO launch preference");
  overrides.push("skills.bundled and generated CloudX skill paths: CloudX overlay", "model and reasoning effort: explicit tab or Forge launch selections take precedence");
  overrides.push("tui.resume_cwd: scoped CloudX resume passes the requested workspace directory with --cd");
  let blockedReason: string | null = null;
  try { codexConfigurationValidationSchema(version); }
  catch { blockedReason = `Native editor has no reviewed schema for selected Codex ${version}. Select a reviewed version before saving native options.`; }
  return {
    selectedVersion: version, baselineVersion: CODEX_CONFIGURATION_BASELINE_VERSION, selectedCommand: command, sourcePath,
    blockedReason, values, effectiveValues, overrides,
    layers: ["Native defaults", "Machine configuration and enforced administrator requirements (read-only; evaluated by Codex)", `User configuration: ${sourcePath}`, "Selected profile", "Trusted project configuration (evaluated for the launch directory)", "CloudX generated skills and launch preferences", "Explicit tab or Forge launch arguments"],
  };
}

export function validateCodexNativeOptions(options: unknown, snapshot: CodexConfigurationSnapshot, text: string): void {
  if (snapshot.blockedReason) throw new Error(snapshot.blockedReason);
  if (!record(options) || Object.keys(options).length > 128 || JSON.stringify(options).length > 524_288) throw new Error("Invalid or oversized native Codex options.");
  const schema = codexConfigurationValidationSchema(snapshot.selectedVersion) as { properties: Record<string, unknown>; definitions: Record<string, unknown> };
  const catalog = codexConfigurationCatalog(snapshot.selectedVersion);
  const current = parseCodexConfiguration(text);
  const checkProtected = (value: unknown, parts: string[]): void => {
    if (!isCodexKnownPath(parts, snapshot.selectedVersion)) throw new Error(`Codex ${parts.join(".")} is not a reviewed configuration path.`);
    if (isCodexProtectedPath(parts) || isCodexReadOnlyPath(parts, snapshot.selectedVersion)) throw new Error(`Codex ${parts.join(".")} is managed or contains authentication values; use its native configuration flow.`);
    if (record(value)) Object.entries(value).forEach(([key, child]) => checkProtected(child, [...parts, key]));
    if (Array.isArray(value)) value.forEach((child, index) => checkProtected(child, [...parts, String(index)]));
  };
  const mergeProtected = (original: unknown, replacement: unknown, parts: string[]): unknown => {
    if (isCodexProtectedPath(parts) || isCodexReadOnlyPath(parts, snapshot.selectedVersion)) return original;
    if (record(original) && record(replacement)) return Object.fromEntries([...new Set([...Object.keys(original), ...Object.keys(replacement)])].flatMap(key => {
      const value = mergeProtected(original[key], replacement[key], [...parts, key]);
      return value === undefined ? [] : [[key, value]];
    }));
    return replacement;
  };
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  for (const [family, value] of Object.entries(options)) {
    const entry = catalog.find(entry => entry.path === family);
    if (!entry?.editable || !(family in schema.properties)) throw new Error(`Codex ${family} is not an editable option for ${snapshot.selectedVersion}.`);
    checkProtected(value, [family]);
    if (value === null) continue;
    const validate = ajv.compile({ $schema: "http://json-schema.org/draft-07/schema#", definitions: schema.definitions, ...schema.properties[family] as object });
    if (!validate(mergeProtected(current[family], value, [family]))) {
      const error = validate.errors?.[0];
      throw new Error(`Invalid Codex ${family}${error?.instancePath ?? ""}: ${error?.keyword ?? "schema"} constraint failed.`);
    }
  }
}

import os from "node:os";
import path from "node:path";
import type { TomlTable } from "smol-toml";
import { codexConfigurationValidationSchema, inventoryCodexConfiguration } from "@cloudx/shared";

// Native loader resolves typed path fields before merging layers, preserving the original shape:
// https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/config/src/loader/mod.rs#L1438
const pathPatterns = [...inventoryCodexConfiguration(codexConfigurationValidationSchema("0.162.1"))]
  .filter(([, nodes]) => nodes.some(node => node.$ref === "#/definitions/AbsolutePathBuf" || node.$ref === "#/definitions/LegacyAppPathString"))
  .map(([key]) => key.split("."));

/** Keep source-file path meaning when config is copied into a probe or launch home. */
export function resolveCodexConfigurationPaths(config: TomlTable, sourceHome: string, userHome = os.homedir()): TomlTable {
  if (!path.isAbsolute(sourceHome) || !path.isAbsolute(userHome)) throw new Error("Codex configuration path origins must be absolute directories.");
  const resolve = (value: unknown, parts: string[]): unknown => {
    if (typeof value === "string" && pathPatterns.some(pattern => matches(pattern, parts))) {
      if (value === "~") return path.normalize(userHome);
      if (value.startsWith("~/") || process.platform === "win32" && value.startsWith("~\\"))
        return path.resolve(userHome, value.slice(2).replace(process.platform === "win32" ? /^[\\/]+/ : /^\/+/, ""));
      return path.resolve(sourceHome, value);
    }
    if (Array.isArray(value)) return value.map((item, index) => resolve(item, [...parts, String(index)]));
    if (value && typeof value === "object" && !(value instanceof Date))
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child, [...parts, key])]));
    return value;
  };
  return resolve(config, []) as TomlTable;
}

function matches(pattern: readonly string[], parts: readonly string[]): boolean {
  return pattern.length === parts.length && pattern.every((part, index) =>
    part === "*" || part === "[]" && /^\d+$/.test(parts[index]!) || part === parts[index]);
}

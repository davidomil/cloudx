import fs from "node:fs/promises";
import path from "node:path";

import { claudeLoadedSettingsFiles } from "./ClaudeSettingsSources.js";
import { isRecord, type ClaudeLaunchMode } from "@cloudx/shared";

const MAX_SETTINGS_BYTES = 1024 * 1024;

// File-backed policy preflight. Remote/MDM/registry policy and changes after
// launch still require native capability verification; this never rewrites policy.
export async function assertClaudeHookCompatibility(providerHome: string, cwd?: string, managedFiles = defaultManagedFiles(), mode: ClaudeLaunchMode = "native-project"): Promise<void> {
  const files = [
    ...(await claudeLoadedSettingsFiles(providerHome, cwd, mode)).map(file => ({ file, managed: false })),
    ...(await managedSettingsFiles(managedFiles)).map(file => ({ file, managed: true }))
  ];
  let disabledBy: string | undefined;
  let managedOnlyBy: string | undefined;
  for (const { file, managed } of files) {
    const settings = await readPolicy(file);
    if (typeof settings.disableAllHooks === "boolean") disabledBy = settings.disableAllHooks ? file : undefined;
    if (managed && typeof settings.allowManagedHooksOnly === "boolean") managedOnlyBy = settings.allowManagedHooksOnly ? file : undefined;
  }
  if (disabledBy || managedOnlyBy) {
    const setting = disabledBy ? "disableAllHooks" : "allowManagedHooksOnly";
    throw new Error(`Claude ${setting} in ${disabledBy ?? managedOnlyBy} prevents CloudX conversation, turn and Forge receipt hooks. CloudX cannot track this session. Ask the policy owner to permit CloudX hooks, or change the conflicting setting before launching. CloudX has not changed the hook policy.`);
  }
}

export function defaultManagedFiles(): string[] {
  const directory = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode") : "/etc/claude-code";
  return [path.join(directory, "managed-settings.json")];
}

// The native file tier merges its base file, then visible *.json fragments
// alphabetically. File policy is only one native managed source.
export async function managedSettingsFiles(baseFiles: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const base of baseFiles) {
    result.push(base);
    const directory = path.join(path.dirname(base), "managed-settings.d");
    try {
      const names = await fs.readdir(directory);
      result.push(...names.filter(name => !name.startsWith(".") && name.endsWith(".json")).sort().map(name => path.join(directory, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot verify Claude receipt hook policy in ${directory}. Ask the policy owner to make the managed settings directory readable.`);
    }
  }
  return result;
}

export async function readPolicy(file: string): Promise<Record<string, unknown>> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error("expected a settings file no larger than 1 MiB");
    const text = await fs.readFile(file, "utf8");
    const value: unknown = text.trim() ? JSON.parse(text) : {};
    if (!isRecord(value)) throw new Error("expected a JSON object");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Never include file contents or parse errors, which may contain credentials.
    throw new Error(`Cannot verify Claude receipt hook policy in ${file}. Fix the unreadable or invalid settings file before launching.`);
  }
}

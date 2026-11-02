import fs from "node:fs/promises";
import path from "node:path";

import { defaultManagedFiles, managedSettingsFiles, readPolicy } from "./ClaudeHookPolicy.js";

import { worktreeLocalSettings } from "./ClaudeSettingsSources.js";

// Native 2.1.316 checks root exclusions before resolving a CLAUDE.md symlink.
// Imports and rules keep their native loader; CloudX does not emulate its globs.
export async function assertClaudeInstructionSourceCompatibility(providerHome: string, cwd?: string, managedFiles = defaultManagedFiles()): Promise<void> {
  const personalRoot = path.join(providerHome, "CLAUDE.md");
  try {
    if (!(await fs.stat(personalRoot)).isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Cannot verify the Claude personal instruction source at ${personalRoot}. Make the source readable before launching.`);
  }

  const files = [path.join(providerHome, "settings.json")];
  if (cwd) {
    for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
      files.push(path.join(directory, ".claude", "settings.json"), path.join(directory, ".claude", "settings.local.json"));
      const canonicalLocal = await worktreeLocalSettings(directory);
      if (canonicalLocal) files.push(canonicalLocal);
      if (path.dirname(directory) === directory) break;
    }
  }
  for (const base of managedFiles) {
    try { files.push(...await managedSettingsFiles([base])); }
    catch { throw new Error(`Cannot verify Claude claudeMdExcludes in ${path.join(path.dirname(base), "managed-settings.d")}. Make the managed settings directory readable before launching.`); }
  }
  for (const file of files) {
    let excludes: unknown;
    try { excludes = (await readPolicy(file)).claudeMdExcludes; }
    catch { throw new Error(`Cannot verify Claude claudeMdExcludes in ${file}. Fix the unreadable or invalid settings file before launching; CloudX has not changed it.`); }
    if (excludes === undefined || Array.isArray(excludes) && excludes.every(value => value === "")) continue;
    throw new Error(`Claude claudeMdExcludes in ${file} cannot be safely combined with CloudX's linked personal CLAUDE.md: native root exclusions are checked before resolving the original source. Launch Claude directly with the original personal configuration, or ask the policy owner to remove this unsupported combination before a CloudX launch. CloudX has not changed instructions, exclusions or trust.`);
  }
}

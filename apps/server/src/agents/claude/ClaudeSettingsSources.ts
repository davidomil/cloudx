import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ClaudeLaunchMode } from "@cloudx/shared";

const run = promisify(execFile);

// Settings sources must match the flags used for the actual native launch.
export async function claudeLoadedSettingsFiles(
  providerHome: string,
  cwd?: string,
  mode: ClaudeLaunchMode = "native-project",
): Promise<string[]> {
  const files = [path.join(providerHome, "settings.json")];
  if (cwd && mode === "native-project") {
    const directories: string[] = [];
    for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
      directories.unshift(current);
      if (path.dirname(current) === current) break;
    }
    for (const directory of directories) {
      files.push(
        path.join(directory, ".claude", "settings.json"),
        path.join(directory, ".claude", "settings.local.json"),
      );
      const canonicalLocal = await worktreeLocalSettings(directory);
      if (canonicalLocal) files.push(canonicalLocal);
    }
  }
  return [...new Set(files)];
}

export async function worktreeLocalSettings(
  directory: string,
): Promise<string | undefined> {
  const gitEntry = path.join(directory, ".git");
  try {
    if (!(await fs.stat(gitEntry)).isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `Cannot verify Claude claudeMdExcludes sources through ${gitEntry}. Make the project metadata readable before launching.`,
    );
  }
  try {
    const { stdout } = await run(
      "git",
      [
        "-C",
        directory,
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
      ],
      {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    const [gitDir, commonDir] = stdout.trimEnd().split("\n");
    if (
      !gitDir ||
      !commonDir ||
      path.dirname(gitDir) !== path.join(commonDir, "worktrees")
    )
      return;
    const main =
      path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
    return path.join(main, ".claude", "settings.local.json");
  } catch {
    throw new Error(
      `Cannot verify Claude claudeMdExcludes sources through ${gitEntry}. Repair the linked project metadata before launching; CloudX has not changed it.`,
    );
  }
}

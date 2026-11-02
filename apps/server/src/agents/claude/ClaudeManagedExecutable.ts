import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveClaudeCommand } from "../../terminal/ShellLaunch.js";

// Native policy guarantees belong to the verified executable, even when a
// login profile changes PATH or an updater replaces its launcher symlink.
export async function pinClaudeExecutable(env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const command = resolveClaudeCommand(env);
  const candidates = command.includes(path.sep) ? [path.resolve(cwd, command)]
    : (env.PATH ?? "").split(path.delimiter).map(directory => path.resolve(cwd, directory, command));
  for (const candidate of candidates) {
    try {
      const executable = await fs.realpath(candidate);
      await fs.access(executable, constants.X_OK);
      if (!(await fs.stat(executable)).isFile()) continue;
      env.CLOUDX_CLAUDE_BIN = executable;
      return;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("Claude launches require an executable on the configured launch PATH. Set its absolute path in CLOUDX_CLAUDE_BIN; no session has started.");
}

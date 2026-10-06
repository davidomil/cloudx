import fs from "node:fs/promises";

// Points target at source, replacing whatever link or file is there. When the
// source is missing the old entry is removed, so an overlay never keeps a link
// to a file it is no longer meant to use, such as another account's credentials.
// A real directory at target is never removed.
export async function replaceLink(source: string, target: string): Promise<void> {
  const existing = await fs.lstat(target).catch(ignoreMissing);
  if (existing?.isDirectory()) throw new Error(`Unexpected directory at ${target}; expected a link.`);
  const sourceStat = await fs.stat(source).catch(ignoreMissing);
  if (existing) {
    if (existing.isSymbolicLink() && sourceStat && await fs.readlink(target) === source) return;
    await fs.unlink(target);
  }
  if (sourceStat) await fs.symlink(source, target, sourceStat.isDirectory() ? "dir" : "file");
}

function ignoreMissing(error: NodeJS.ErrnoException): undefined {
  if (error.code === "ENOENT") return undefined;
  throw error;
}

import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { DirectoryIdentity } from "../directoryIdentity.js";
import { openOwnedDirectoryNoFollow } from "../jsonStateFile.js";
import { isGeneratedForgePath } from "./ForgeGeneratedArtifacts.js";

/** Remove generated contents through owned directory descriptors, preserving named evidence. */
export async function cleanupIgnoredForgePath(identity: DirectoryIdentity, relative: string, protectedPaths: string[], signal?: AbortSignal): Promise<string[]> {
  if (!relative || relative.split("/").some(part => !part || part === "." || part === ".." || part === ".git") || relative.includes("\\") || relative.includes("\0"))
    throw new Error("Ignored cleanup requires a safe repository-relative path.");
  const root = await openOwnedDirectoryNoFollow(path.dirname(identity.path), identity.path, "Generated cleanup checkout", identity);
  const parents: FileHandle[] = [];
  const checks: Array<() => Promise<void>> = [() => root.assertCurrent()];
  const assertParents = async () => { for (const check of checks) await check(); signal?.throwIfAborted(); };
  const openDirectory = async (target: string) => {
    const before = await fs.lstat(target, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Generated tree parent changed; its replacement was preserved.");
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error("Generated tree parent changed; its replacement was preserved.");
      const check = async () => {
        const current = await fs.lstat(target, { bigint: true });
        if (!current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino)
          throw new Error("Generated tree parent changed; its replacement was preserved.");
      };
      return { handle, check };
    } catch (error) { await handle.close(); throw error; }
  };
  const removeGenerated = async (target: string, file: string): Promise<{ paths: string[]; unknown: boolean }> => {
    await assertParents();
    const explicitlyProtected = protectedPaths.some(protectedPath => file === protectedPath || file.startsWith(`${protectedPath}/`));
    if (explicitlyProtected) return { paths: [file], unknown: false };
    if (path.basename(file) === ".git") return { paths: [file], unknown: true };
    const generated = isGeneratedForgePath(file);
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      if (!generated) return { paths: [file], unknown: true };
      await assertParents();
      await fs.unlink(target);
      return { paths: [], unknown: false };
    }
    const directory = await openDirectory(target);
    checks.push(directory.check);
    try {
      const children = await fs.readdir(`/proc/self/fd/${directory.handle.fd}`);
      if (children.includes(".git") || ["HEAD", "objects", "refs"].every(name => children.includes(name)))
        return { paths: [file], unknown: true };
      const retained: string[] = [];
      let unknown = false;
      for (const child of children.sort()) {
        const result = await removeGenerated(`/proc/self/fd/${directory.handle.fd}/${child}`, `${file}/${child}`);
        retained.push(...result.paths);
        unknown ||= result.unknown;
      }
      if (retained.length) return { paths: unknown && !generated ? [file] : retained, unknown };
      await assertParents();
      await fs.rmdir(target);
      return { paths: [], unknown: false };
    } finally { checks.pop(); await directory.handle.close(); }
  };
  try {
    const parts = relative.split("/");
    let parentChildPath = (name: string) => root.childPath(name);
    for (const part of parts.slice(0, -1)) {
      const directory = await openDirectory(parentChildPath(part));
      parents.push(directory.handle);
      checks.push(directory.check);
      parentChildPath = name => `/proc/self/fd/${directory.handle.fd}/${name}`;
    }
    return (await removeGenerated(parentChildPath(parts.at(-1)!), relative)).paths;
  } finally { for (const parent of parents.reverse()) await parent.close(); await root.close(); }
}

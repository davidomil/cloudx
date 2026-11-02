import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export interface ClaudeSkillSnapshot {
  files: { relative: string; content: Buffer; mode: number }[];
  sha256: string;
  directory: boolean;
  entries: number;
}

export async function readClaudeSkillSnapshot(source: string, limits = { bytes: 128 * 1024 * 1024, entries: 5_000 }, manifest?: readonly string[]): Promise<ClaudeSkillSnapshot> {
  if (manifest && (!manifest.length || new Set(manifest).size !== manifest.length || manifest.some(file =>
    file.includes("\\") || /^[A-Za-z]:/u.test(file) || file.split("/").some(part => !part || part === "." || part === ".."))))
    throw new Error(`Claude skill source manifest must contain unique, relative file paths: ${source}.`);
  const root = await fs.realpath(source);
  const directory = (await fs.stat(root)).isDirectory();
  if (manifest && !directory) throw new Error(`Claude skill source manifest requires a directory: ${source}.`);
  const files: ClaudeSkillSnapshot["files"] = [];
  let bytes = 0;
  let entries = 0;
  const visited = new Set<string>();
  async function read(current: string, relative: string): Promise<void> {
    if (++entries > limits.entries) throw new Error(`Claude skill source exceeds the bounded snapshot entry count: ${source}.`);
    const real = await fs.realpath(current);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`Claude skill snapshot is not self-contained: ${current}. Keep supporting files inside the selected source before launching.`);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) {
      if (manifest && relative) throw new Error(`Claude skill source manifest must identify regular files: ${current}.`);
      if (visited.has(real)) throw new Error(`Claude skill source contains a cyclic directory link: ${current}.`);
      visited.add(real);
      if (manifest) {
        for (const file of [...manifest].sort()) await read(path.join(root, file), file);
        return;
      }
      const names: string[] = [];
      for await (const entry of await fs.opendir(real)) {
        if (entries + names.length >= limits.entries) throw new Error(`Claude skill source exceeds the bounded snapshot entry count: ${source}.`);
        names.push(entry.name);
      }
      for (const name of names.sort()) await read(path.join(real, name), path.join(relative, name));
    } else if (stat.isFile()) {
      if (bytes + stat.size > limits.bytes) throw new Error(`Claude skill source exceeds the bounded snapshot size: ${source}.`);
      const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error(`Claude skill source changed while preparing its snapshot: ${source}. Try a new launch after the source update finishes.`);
        const bounded = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < bounded.length) {
          const result = await handle.read(bounded, offset, bounded.length - offset, offset);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        const final = await handle.stat();
        if (offset !== stat.size || final.size !== stat.size || final.mode !== opened.mode || final.mtimeMs !== opened.mtimeMs || await fs.realpath(current) !== real)
          throw new Error(`Claude skill source changed while preparing its snapshot: ${source}. Try a new launch after the source update finishes.`);
        content = bounded.subarray(0, offset);
      } finally { await handle.close(); }
      bytes += content.length;
      files.push({ relative, content, mode: stat.mode & 0o777 });
    } else throw new Error(`Claude skill source contains an unsupported filesystem entry: ${current}.`);
  }
  await read(root, "");
  const digest = createHash("sha256");
  for (const file of files) digest.update(JSON.stringify([file.relative, file.mode, file.content.length])).update(file.content);
  return { files, sha256: digest.digest("hex"), directory, entries };
}

export async function writeClaudeSkillSnapshot(snapshot: ClaudeSkillSnapshot, target: string): Promise<void> {
  if (snapshot.directory) await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const file of snapshot.files) {
    const destination = snapshot.directory ? path.join(target, file.relative) : target;
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, file.content, { mode: file.mode });
  }
}

import type { Readable } from "node:stream";
import { JsonStateFile } from "../jsonStateFile.js";

const readers = new Map<string, number>();
const retiring = new Set<string>();

export async function retiredForgeArchivePaths(dataDir: string): Promise<Set<string>> {
  const journal = await new JsonStateFile(dataDir, "forge-archive-retirement.json", "Forge archive retirement").read<{
    payloads?: Array<{ path: string; state: string }>;
  }>();
  return new Set((journal?.payloads ?? []).filter(payload => payload.state === "retired").map(payload => payload.path));
}

/** Open downloads keep their payload until the final stream closes. */
export function retainForgeArchive(archive: string): () => void {
  if (retiring.has(archive)) throw new Error("Forge archive retirement is in progress.");
  readers.set(archive, (readers.get(archive) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = readers.get(archive)! - 1;
    if (count) readers.set(archive, count); else readers.delete(archive);
  };
}

export function retainForgeArchiveStream<T extends Readable>(stream: T, release: () => void): T {
  stream.once("close", release);
  return stream;
}

export async function retireForgeArchive<T>(archive: string, remove: () => Promise<T>): Promise<T> {
  if (readers.has(archive) || retiring.has(archive)) throw new Error("An active reader still needs this Forge archive.");
  retiring.add(archive);
  try { return await remove(); }
  finally { retiring.delete(archive); }
}

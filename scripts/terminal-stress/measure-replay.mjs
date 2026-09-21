import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { TerminalReplayBuffer } from "../../apps/server/src/terminal/TerminalReplayBuffer.ts";

export function measureReplay() {
  const bytes = 32 * 1024 * 1024;
  const chunk = "\r".repeat(4096);
  const history = new TerminalReplayBuffer(bytes);
  const started = performance.now();
  for (let written = 0; written < bytes; written += chunk.length)
    history.append(chunk);
  const appended = performance.now();
  const retainedBytes = Buffer.byteLength(history.snapshot());
  const finished = performance.now();
  return {
    kind: "terminal-replay-throughput",
    node: process.version,
    bytes,
    chunk_bytes: chunk.length,
    retained_bytes: retainedBytes,
    append_ms: appended - started,
    snapshot_ms: finished - appended,
    append_mib_per_second: 32_000 / (appended - started),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const output = process.argv[2];
  if (!output) throw new Error("A throughput output file is required.");
  await fs.writeFile(output, `${JSON.stringify(measureReplay(), null, 2)}\n`);
}

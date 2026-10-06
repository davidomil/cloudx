import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

interface Entry<State, Result> {
  ino: number;
  offset: number;
  pending: string;
  // Keeps a multi-byte character split across two chunks whole.
  decoder: StringDecoder;
  state: State;
  results: Result[];
}

// Parses append-only JSONL transcripts incrementally. Each file is read from
// where the last read stopped; a replaced or truncated file is read again.
// Reads of one file run one at a time, because they share its parse state.
export class JsonlCache<State, Result> {
  private readonly entries = new Map<string, Entry<State, Result>>();
  private readonly reads = new Map<string, Promise<unknown>>();

  constructor(
    private readonly initialState: () => State,
    private readonly parse: (line: unknown, state: State) => Result | undefined
  ) {}

  read(filePath: string): Promise<Result[]> {
    const run = (this.reads.get(filePath) ?? Promise.resolve()).then(() => this.readNow(filePath));
    const settled = run.catch(() => undefined);
    this.reads.set(filePath, settled);
    void settled.then(() => { if (this.reads.get(filePath) === settled) this.reads.delete(filePath); });
    return run;
  }

  private async readNow(filePath: string): Promise<Result[]> {
    let info;
    try { info = await stat(filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.entries.delete(filePath); return []; }
      throw error;
    }
    let entry = this.entries.get(filePath);
    if (!entry || entry.ino !== info.ino || info.size < entry.offset) {
      entry = { ino: info.ino, offset: 0, pending: "", decoder: new StringDecoder("utf8"), state: this.initialState(), results: [] };
      this.entries.set(filePath, entry);
    }
    if (info.size === entry.offset) return [...entry.results];
    const file = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(CHUNK_BYTES);
      while (entry.offset < info.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK_BYTES, info.size - entry.offset), entry.offset);
        if (!bytesRead) break;
        entry.offset += bytesRead;
        const lines = (entry.pending + entry.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
        entry.pending = lines.pop() ?? "";
        // A line that never ends is not a transcript record; drop it.
        if (entry.pending.length > MAX_LINE_BYTES) entry.pending = "";
        for (const line of lines) this.consume(line, entry);
      }
    } finally {
      await file.close();
    }
    return [...entry.results];
  }

  private consume(line: string, entry: Entry<State, Result>): void {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    const result = this.parse(value, entry.state);
    if (result !== undefined) entry.results.push(result);
  }
}

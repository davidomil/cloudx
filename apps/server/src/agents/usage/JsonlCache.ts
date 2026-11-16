import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import path from "node:path";

import { requireRegularFile, requireSafeDirectory } from "../../jsonStateFile.js";
import { UsageScanScheduler } from "./UsageScanScheduler.js";

const MAX_LINE_BYTES = 16 * 1024 * 1024;

export type UsageIndexingStatus = "backfilling" | "error";

export interface JsonlCacheOptions<State, Result> {
  directory?: string;
  scheduler?: UsageScanScheduler;
  validateState?: (value: unknown) => boolean;
  validateResult?: (value: unknown) => boolean;
  onRead?: (filePath: string, offset: number, bytes: number) => void;
  onError?: (filePath: string, error: unknown) => void;
}

interface Checkpoint<State, Result> {
  version: 1;
  generation: string;
  source: string;
  identity: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  offset: number;
  pending: string;
  dropping: boolean;
  state: State;
  results: Result[];
}

interface JournalFrame<State, Result> extends Checkpoint<State, Result> {
  // The frame stores only results added since the previous transaction.
  sequence: number;
  totalResults: number;
}

interface JournalPosition {
  generation: string;
  sequence: number;
  results: number;
  offset: number;
  bytes: number;
  fileBytes: number;
  signature: string;
}

interface JournalFile {
  rootPath: string;
  filePath: string;
}

interface FileIndex<State, Result> {
  checkpoint?: Checkpoint<State, Result>;
  loaded: boolean;
  inspecting?: Promise<void>;
  running: boolean;
  indexing: boolean;
  error?: unknown;
  journal?: JournalPosition;
}

// Requests inspect metadata and return an indexed snapshot. Transcript payload
// belongs to the shared background queue, never to a refresh request.
export class JsonlCache<State, Result> {
  private readonly entries = new Map<string, FileIndex<State, Result>>();
  private readonly scheduler: UsageScanScheduler;
  private disposed = false;

  constructor(
    private readonly initialState: () => State,
    private readonly parse: (line: unknown, state: State) => Result | undefined,
    private readonly options: JsonlCacheOptions<State, Result> = {}
  ) {
    this.scheduler = options.scheduler ?? new UsageScanScheduler();
  }

  async read(filePath: string): Promise<Result[]> {
    return (await this.readWithStatus(filePath)).results;
  }

  async readWithStatus(filePath: string): Promise<{ results: Result[]; indexing?: UsageIndexingStatus }> {
    if (this.disposed) throw new Error("Usage index is disposed.");
    let index = this.entries.get(filePath);
    if (!index) {
      index = { loaded: false, running: false, indexing: false };
      this.entries.set(filePath, index);
    }
    if (!index.error) {
      if (!index.inspecting) {
        index.inspecting = this.inspect(filePath, index).catch(error => {
          index.error = error;
          index.indexing = false;
          this.options.onError?.(filePath, error);
        }).finally(() => { index.inspecting = undefined; });
      }
      await index.inspecting;
    }
    return { results: [...(index.checkpoint?.results ?? [])], indexing: this.indexStatus(index) };
  }

  status(filePaths: Iterable<string>): UsageIndexingStatus | undefined {
    let status: UsageIndexingStatus | undefined;
    for (const filePath of filePaths) {
      const index = this.entries.get(filePath);
      if (index?.error) return "error";
      if (index?.indexing) status = "backfilling";
    }
    return status;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.entries.values()].map(index => index.inspecting));
    await this.scheduler.idle(this);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.entries.values()].map(index => index.inspecting));
    await this.scheduler.cancel(this);
    if (!this.options.scheduler) await this.scheduler.dispose();
  }

  private indexStatus(index: FileIndex<State, Result>): UsageIndexingStatus | undefined {
    return index.error ? "error" : index.indexing ? "backfilling" : undefined;
  }

  private async inspect(filePath: string, index: FileIndex<State, Result>): Promise<void> {
    if (!index.loaded) {
      await this.loadJournal(filePath, index);
      index.loaded = true;
    }
    const info = await sourceStat(filePath);
    if (!info) {
      if (index.checkpoint) throw new Error("Indexed usage transcript is unavailable.");
      index.indexing = false;
      return;
    }
    if (!index.running && (!index.checkpoint || this.changed(index.checkpoint, info)))
      index.checkpoint = this.fresh(filePath, info);
    const checkpoint = index.checkpoint;
    if (!checkpoint || this.changed(checkpoint, info) || checkpoint.offset < info.size) {
      index.indexing = true;
      if (!this.disposed) this.scheduler.schedule(this, filePath, budget => this.scan(filePath, index, budget));
    } else if (!index.running) index.indexing = false;
  }

  private async scan(filePath: string, index: FileIndex<State, Result>, byteBudget: number): Promise<boolean> {
    if (this.disposed || index.error) return false;
    index.running = true;
    try {
      let file;
      try { file = await open(filePath, "r"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (index.checkpoint) throw new Error("Indexed usage transcript is unavailable.");
        index.indexing = false;
        return false;
      }
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error("Usage transcript must be a regular file.");
        const previous = index.checkpoint;
        const checkpoint = !previous || this.changed(previous, info) ? this.fresh(filePath, info) : {
          ...previous, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
          state: structuredClone(previous.state), results: [...previous.results]
        };
        const length = Math.min(byteBudget, Math.max(0, info.size - checkpoint.offset));
        if (length) {
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await file.read(buffer, 0, length, checkpoint.offset);
          this.options.onRead?.(filePath, checkpoint.offset, bytesRead);
          if (!bytesRead) throw new Error("Usage transcript changed while indexing.");
          this.consume(buffer.subarray(0, bytesRead), checkpoint);
          checkpoint.offset += bytesRead;
        }
        const current = await sourceStat(filePath);
        if (!current) throw new Error("Indexed usage transcript is unavailable.");
        if (identity(current) !== identity(info) || current.size < info.size ||
            current.size === info.size && (current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs)) {
          // Do not publish a slice assembled while its source was rewritten.
          index.checkpoint = this.fresh(filePath, current);
          index.indexing = current.size > 0;
          return index.indexing;
        }
        await this.persist(filePath, checkpoint, index);
        index.checkpoint = checkpoint;
        index.indexing = checkpoint.offset < info.size;
        return index.indexing;
      } finally {
        await file.close();
      }
    } catch (error) {
      index.error = error;
      index.indexing = false;
      this.options.onError?.(filePath, error);
      return false;
    } finally {
      index.running = false;
    }
  }

  private fresh(source: string, info: Stats): Checkpoint<State, Result> {
    return {
      version: 1, generation: randomUUID(), source, identity: identity(info), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
      offset: 0, pending: "", dropping: false, state: this.initialState(), results: []
    };
  }

  private changed(checkpoint: Checkpoint<State, Result>, info: Stats): boolean {
    // Native transcripts append. A rewrite that also grows beyond the old size
    // entirely between samples is indistinguishable from append using metadata.
    return checkpoint.identity !== identity(info) || info.size < checkpoint.size ||
      (info.size === checkpoint.size && (info.mtimeMs !== checkpoint.mtimeMs || info.ctimeMs !== checkpoint.ctimeMs));
  }

  private consume(buffer: Buffer, checkpoint: Checkpoint<State, Result>): void {
    let pending = Buffer.from(checkpoint.pending, "base64");
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start);
      const end = newline === -1 ? buffer.length : newline;
      if (!checkpoint.dropping) {
        const part = buffer.subarray(start, end);
        if (pending.length + part.length > MAX_LINE_BYTES) {
          pending = Buffer.alloc(0);
          checkpoint.dropping = true;
        } else pending = Buffer.concat([pending, part]);
      }
      if (newline === -1) break;
      if (!checkpoint.dropping && pending.length) {
        let value: unknown;
        try { value = JSON.parse(pending.toString("utf8")); } catch { value = undefined; }
        if (value !== undefined) {
          const result = this.parse(value, checkpoint.state);
          if (result !== undefined) checkpoint.results.push(result);
        }
      }
      pending = Buffer.alloc(0);
      checkpoint.dropping = false;
      start = newline + 1;
    }
    checkpoint.pending = pending.toString("base64");
  }

  private journalFile(filePath: string): JournalFile | undefined {
    if (!this.options.directory) return undefined;
    const rootPath = path.resolve(this.options.directory);
    const name = `${createHash("sha256").update(filePath).digest("hex")}.jsonl`;
    return { rootPath, filePath: path.join(rootPath, name) };
  }

  private async loadJournal(filePath: string, index: FileIndex<State, Result>): Promise<void> {
    const journal = this.journalFile(filePath);
    if (!journal || !await requireSafeDirectory(journal.rootPath, journal.rootPath, { create: false, label: "Usage index directory" }) ||
        !await requireRegularFile(journal.filePath, "Usage index journal")) return;
    const file = await open(journal.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: Buffer;
    try { content = await file.readFile(); } finally { await file.close(); }
    const completeBytes = content.lastIndexOf(10) + 1;
    if (!completeBytes) throw new Error("Usage index journal has no complete checkpoint.");
    const results: Result[] = [];
    let previous: JournalFrame<State, Result> | undefined;
    for (const line of content.subarray(0, completeBytes - 1).toString("utf8").split("\n")) {
      const value: unknown = JSON.parse(line);
      const frame = this.validateFrame(value, filePath);
      if (frame.sequence !== (previous ? previous.sequence + 1 : 0) || frame.totalResults !== results.length + frame.results.length ||
          previous && (frame.generation !== previous.generation || frame.identity !== previous.identity ||
            frame.offset < previous.offset || frame.size < previous.size))
        throw new Error("Usage index journal checkpoint sequence is invalid.");
      for (const result of frame.results) results.push(result);
      previous = frame;
    }
    if (!previous) throw new Error("Usage index journal has no complete checkpoint.");
    const checkpoint = { ...previous, results };
    index.checkpoint = checkpoint;
    index.journal = {
      generation: previous.generation, sequence: previous.sequence, results: results.length, offset: previous.offset,
      bytes: completeBytes, fileBytes: content.length, signature: this.signature(checkpoint)
    };
  }

  private async persist(filePath: string, checkpoint: Checkpoint<State, Result>, index: FileIndex<State, Result>): Promise<void> {
    const journalFile = this.journalFile(filePath);
    if (!journalFile) return;
    // Rewriting a growing 16 MiB partial record every 256 KiB would amplify
    // checkpoint writes. During backfill, commit through the last newline and
    // retain the unfinished record in memory. At EOF, persist its bytes once.
    const durable = checkpoint.offset === checkpoint.size || checkpoint.dropping ? checkpoint : {
      ...checkpoint, offset: checkpoint.offset - Buffer.byteLength(checkpoint.pending, "base64"), pending: ""
    };
    const previous = index.journal?.generation === durable.generation ? index.journal : undefined;
    const signature = this.signature(durable);
    // An earlier EOF checkpoint may already contain this unfinished prefix.
    // Keep it until a newline or the new EOF advances the durable position.
    if (previous && (previous.signature === signature || durable.offset < previous.offset)) return;
    const frame: JournalFrame<State, Result> = {
      ...durable, results: durable.results.slice(previous?.results ?? 0),
      sequence: previous ? previous.sequence + 1 : 0, totalResults: durable.results.length
    };
    const content = `${JSON.stringify(frame)}\n`;
    await mkdir(journalFile.rootPath, { recursive: true, mode: 0o700 });
    await requireSafeDirectory(journalFile.rootPath, journalFile.rootPath, { create: true, label: "Usage index directory" });
    await requireRegularFile(journalFile.filePath, "Usage index journal");
    if (previous) await this.appendFrame(journalFile, content, previous);
    else await this.replaceJournal(journalFile, content);
    const bytes = (previous?.bytes ?? 0) + Buffer.byteLength(content);
    index.journal = {
      generation: durable.generation, sequence: frame.sequence, results: durable.results.length, offset: durable.offset,
      bytes, fileBytes: bytes, signature
    };
  }

  private async appendFrame(journal: JournalFile, content: string, previous: JournalPosition): Promise<void> {
    const file = await open(journal.filePath, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size !== previous.fileBytes) throw new Error("Usage index journal changed during indexing.");
      // A crash can leave an incomplete final append. Keep every complete
      // transaction, then replace only that uncommitted suffix.
      if (previous.fileBytes !== previous.bytes) await file.truncate(previous.bytes);
      await file.appendFile(content, "utf8");
      await file.sync();
    } finally { await file.close(); }
  }

  private async replaceJournal(journal: JournalFile, content: string): Promise<void> {
    const temporary = `${journal.filePath}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, journal.filePath);
    const directory = await open(journal.rootPath, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private signature(checkpoint: Checkpoint<State, Result>): string {
    return [checkpoint.generation, checkpoint.identity, checkpoint.size, checkpoint.mtimeMs, checkpoint.ctimeMs,
      checkpoint.offset, checkpoint.pending.length, checkpoint.dropping].join(":");
  }

  private validateFrame(value: unknown, source: string): JournalFrame<State, Result> {
    const frame = this.validateCheckpoint(value, source) as Partial<JournalFrame<State, Result>>;
    if (!nonnegativeInteger(frame.sequence) || !nonnegativeInteger(frame.totalResults) || frame.totalResults < frame.results!.length)
      throw new Error("Usage index journal checkpoint counts are invalid.");
    return frame as JournalFrame<State, Result>;
  }

  private validateCheckpoint(value: unknown, source: string): Checkpoint<State, Result> {
    const checkpoint = value as Partial<Checkpoint<State, Result>> | null;
    if (!checkpoint || checkpoint.version !== 1 || typeof checkpoint.generation !== "string" || !checkpoint.generation ||
        checkpoint.source !== source || typeof checkpoint.identity !== "string" ||
        !nonnegativeInteger(checkpoint.size) || !nonnegativeInteger(checkpoint.offset) || checkpoint.offset! > checkpoint.size! ||
        typeof checkpoint.mtimeMs !== "number" || !Number.isFinite(checkpoint.mtimeMs) ||
        typeof checkpoint.ctimeMs !== "number" || !Number.isFinite(checkpoint.ctimeMs) ||
        typeof checkpoint.pending !== "string" || Buffer.byteLength(checkpoint.pending, "base64") > MAX_LINE_BYTES ||
        Buffer.from(checkpoint.pending, "base64").toString("base64") !== checkpoint.pending || typeof checkpoint.dropping !== "boolean" ||
        Buffer.byteLength(checkpoint.pending, "base64") > checkpoint.offset! || checkpoint.dropping && checkpoint.pending !== "" ||
        !Array.isArray(checkpoint.results) || this.options.validateState && !this.options.validateState(checkpoint.state) ||
        this.options.validateResult && !checkpoint.results.every(this.options.validateResult))
      throw new Error("Usage index checkpoint is invalid.");
    return checkpoint as Checkpoint<State, Result>;
  }
}

function identity(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function sourceStat(filePath: string): Promise<Stats | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Usage transcript must be a regular file.");
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

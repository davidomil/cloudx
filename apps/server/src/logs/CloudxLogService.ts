import { execFile } from "node:child_process";
import type { CloudxLogsResponse, CloudxLogSource } from "@cloudx/shared";

export const LOG_MAX_ENTRIES = 1_000;
export const LOG_MAX_BYTES = 1024 * 1024;
const JOURNAL_UNITS = {
  server: "cloudx.service",
  terminals: "cloudx-terminal.service",
  asr: "cloudx-asr.service",
  documentation: "cloudx-documentation.service"
} as const;

export type JournalReader = (units: string[], signal: AbortSignal) => Promise<string>;

export class LogReadError extends Error {
  constructor(message: string, readonly statusCode = 503) {
    super(message);
  }
}

export function readServiceJournal(units: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("journalctl", [
      "--user", "--no-pager", "--quiet", "--output=short-iso-precise",
      `--lines=${LOG_MAX_ENTRIES + 1}`,
      ...units.map(unit => `--unit=${unit}`)
    ], { encoding: "utf8", timeout: 5_000, maxBuffer: LOG_MAX_BYTES, killSignal: "SIGKILL", signal }, (error, stdout) => {
      if (error) reject(new LogReadError("Could not read the service journal. It requires journalctl and access to the CloudX user service logs. Reads are limited to 5 seconds and 1 MiB."));
      else resolve(stdout);
    });
  });
}

export class CloudxLogService {
  private entries: { text: string; bytes: number }[] = [];
  private bytes = 0;
  private truncated = false;
  private journalReadActive = false;

  constructor(private readonly readJournal: JournalReader = readServiceJournal) {}

  recordServerLog(text: string): void {
    let bytes = Buffer.byteLength(text);
    if (bytes > LOG_MAX_BYTES) {
      text = "[Log entry omitted: exceeds the 1 MiB viewer limit.]\n";
      bytes = Buffer.byteLength(text);
      this.truncated = true;
    }
    this.entries.push({ text, bytes });
    this.bytes += bytes;
    while (this.entries.length > LOG_MAX_ENTRIES || this.bytes > LOG_MAX_BYTES) {
      this.bytes -= this.entries.shift()!.bytes;
      this.truncated = true;
    }
  }

  async read(source: CloudxLogSource, signal: AbortSignal): Promise<CloudxLogsResponse> {
    if (source === "current") {
      return { source, capturedAt: new Date().toISOString(), content: this.entries.map(entry => entry.text).join(""), truncated: this.truncated };
    }
    if (this.journalReadActive) throw new LogReadError("A service journal read is already running. Refresh again when it finishes.", 429);
    this.journalReadActive = true;
    try {
      const units = source === "services" ? Object.values(JOURNAL_UNITS) : [JOURNAL_UNITS[source]];
      const output = await this.readJournal(units, signal);
      const lines = output.trimEnd().split("\n");
      return { source, capturedAt: new Date().toISOString(), content: lines.slice(-LOG_MAX_ENTRIES).join("\n"), truncated: lines.length > LOG_MAX_ENTRIES };
    } finally {
      this.journalReadActive = false;
    }
  }
}

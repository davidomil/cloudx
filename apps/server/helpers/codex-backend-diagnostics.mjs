import {
  constants,
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export const MAX_BACKEND_DIAGNOSTIC_BYTES = 256 * 1024;

/** A private, bounded tail owned by the tab's launch directory. */
export class CodexBackendDiagnostics {
  constructor(receiptPath) {
    const directory = path.dirname(path.resolve(receiptPath));
    const owner = lstatSync(directory);
    if (
      !owner.isDirectory() ||
      realpathSync(directory) !== directory ||
      owner.mode & 0o077 ||
      (process.getuid && owner.uid !== process.getuid())
    )
      throw new Error(
        "Codex backend diagnostics require an owned private launch directory.",
      );
    this.path = path.join(directory, "cloudx-codex-backend.log");
    this.file = openSync(
      this.path,
      constants.O_CREAT |
        constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      const stat = fstatSync(this.file);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error(
          "Codex backend diagnostics require an owned private file.",
        );
      this.tail = Buffer.alloc(
        Math.min(stat.size, MAX_BACKEND_DIAGNOSTIC_BYTES),
      );
      readSync(
        this.file,
        this.tail,
        0,
        this.tail.length,
        stat.size - this.tail.length,
      );
      this.flush();
    } catch (error) {
      closeSync(this.file);
      throw error;
    }
  }

  append(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.tail =
      incoming.length >= MAX_BACKEND_DIAGNOSTIC_BYTES
        ? Buffer.from(incoming.subarray(-MAX_BACKEND_DIAGNOSTIC_BYTES))
        : Buffer.concat([
            this.tail.subarray(
              Math.max(
                0,
                this.tail.length +
                  incoming.length -
                  MAX_BACKEND_DIAGNOSTIC_BYTES,
              ),
            ),
            incoming,
          ]);
    this.flush();
  }

  flush() {
    // Keep the retained UTF-8 tail readable when the byte bound splits a character.
    while (this.tail.length && (this.tail[0] & 0xc0) === 0x80)
      this.tail = this.tail.subarray(1);
    let written = 0;
    while (written < this.tail.length)
      written += writeSync(
        this.file,
        this.tail,
        written,
        this.tail.length - written,
        written,
      );
    ftruncateSync(this.file, this.tail.length);
  }

  close() {
    closeSync(this.file);
  }
}

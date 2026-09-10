import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const diagnosticLimits = Object.freeze({
  outputTailBytes: 64 * 1024,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  files: 64,
  entries: 1024,
  depth: 8,
});

export class CommandOutputTail {
  constructor(limit = diagnosticLimits.outputTailBytes) {
    this.limit = limit;
    this.bytes = 0;
    this.tail = Buffer.alloc(0);
  }

  append(chunk) {
    this.bytes += chunk.length;
    this.tail = Buffer.from(
      chunk.length >= this.limit
        ? chunk.subarray(-this.limit)
        : Buffer.concat([this.tail, chunk]).subarray(-this.limit),
    );
  }

  snapshot() {
    return {
      text: this.tail.toString("utf8"),
      total_bytes: this.bytes,
      omitted_bytes: this.bytes - this.tail.length,
    };
  }
}

// The supervisor calls this only after the candidate UID has no live processes.
// Artifact bytes are opaque candidate output and never affect verification.
export async function collectBrowserDiagnostics(
  root,
  uid,
  limits = diagnosticLimits,
) {
  const browserRoot = "test-results/browser";
  const report = {
    root: browserRoot,
    files: [],
    skipped: [],
    limits,
    scanned_entries: 0,
    truncated: false,
  };
  const candidates = [];
  let stopped = false;
  let retainedBytes = 0;
  const skip = (relative, reason, truncated = false) => {
    report.skipped.push({ path: relative, reason });
    report.truncated ||= truncated;
  };

  try {
    if ((await fs.realpath(root)) !== root)
      throw new Error("noncanonical-root");
    for (const relative of ["", "test-results", browserRoot]) {
      const stat = await fs.lstat(path.join(root, relative));
      if (!stat.isDirectory() || stat.uid !== uid) {
        skip(relative || ".", "not-candidate-directory");
        return report;
      }
    }
  } catch (error) {
    skip(browserRoot, error.code === "ENOENT" ? "not-produced" : "unsafe-root");
    return report;
  }

  await visit(browserRoot, 0);
  candidates.sort(
    (left, right) =>
      priority(left.relative) - priority(right.relative) ||
      left.relative.localeCompare(right.relative),
  );
  for (const { relative, stat } of candidates) {
    if (report.files.length >= limits.files) {
      skip(relative, "file-count-limit", true);
      continue;
    }
    if (
      stat.size > limits.fileBytes ||
      stat.size > limits.totalBytes - retainedBytes
    ) {
      skip(
        relative,
        stat.size > limits.fileBytes ? "file-size-limit" : "total-size-limit",
        true,
      );
      continue;
    }
    let handle;
    try {
      handle = await fs.open(
        path.join(root, relative),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      if (!sameFile(stat, await handle.stat(), uid))
        throw new Error("changed-file");
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== stat.size || !sameFile(stat, await handle.stat(), uid))
        throw new Error("changed-file");
      const contents = bytes.subarray(0, length);
      report.files.push({
        path: relative,
        bytes: length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        base64: contents.toString("base64"),
      });
      retainedBytes += length;
    } catch {
      skip(relative, "unreadable-or-changed-file");
    } finally {
      await handle?.close();
    }
  }
  return report;

  async function visit(relative, depth) {
    let directory;
    try {
      directory = await fs.opendir(path.join(root, relative), {
        bufferSize: 16,
      });
    } catch {
      skip(relative, "unreadable-directory");
      return;
    }
    for await (const entry of directory) {
      if (stopped) break;
      if (report.scanned_entries >= limits.entries) {
        skip(relative, "entry-count-limit", true);
        stopped = true;
        break;
      }
      report.scanned_entries += 1;
      const child = path.join(relative, entry.name);
      if (!safeName(entry.name) || Buffer.byteLength(child) > 1024) {
        skip(relative, "invalid-entry-name");
        continue;
      }
      let stat;
      try {
        stat = await fs.lstat(path.join(root, child));
      } catch {
        skip(child, "unreadable-entry");
        continue;
      }
      if (stat.uid !== uid || stat.isSymbolicLink()) {
        skip(child, "not-candidate-entry");
      } else if (stat.isDirectory()) {
        if (depth >= limits.depth) skip(child, "depth-limit", true);
        else await visit(child, depth + 1);
      } else if (!stat.isFile() || stat.nlink !== 1) {
        skip(child, "not-single-regular-file");
      } else if (isBrowserArtifact(entry.name)) {
        candidates.push({ relative: child, stat });
      }
    }
  }
}

function safeName(name) {
  return (
    name !== "." &&
    name !== ".." &&
    !name.includes("\\") &&
    !name.includes("/") &&
    ![...name].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

function isBrowserArtifact(name) {
  return (
    name === "trace.zip" ||
    name === "error-context.md" ||
    /\.(png|webm|log|txt)$/u.test(name)
  );
}

function priority(relative) {
  const name = path.basename(relative);
  return name === "trace.zip"
    ? 0
    : name === "error-context.md"
      ? 1
      : /\.(log|txt)$/u.test(name)
        ? 2
        : 3;
}

function sameFile(expected, actual, uid) {
  return (
    actual.isFile() &&
    actual.uid === uid &&
    actual.nlink === 1 &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs
  );
}

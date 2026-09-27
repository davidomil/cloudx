import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const maximumReportBytes = 128 * 1024 * 1024;

export async function readReport(
  root,
  relative,
  maximumBytes = maximumReportBytes,
) {
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid report path.");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (!(await fs.lstat(current)).isDirectory())
      throw new Error("Report directory must not be a symlink.");
  }
  const handle = await fs.open(
    path.join(root, relative),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumBytes)
      throw new Error("Report must be a bounded regular file.");
    const data = await handle.readFile();
    if (data.length !== stat.size)
      throw new Error("Report changed while being read.");
    return {
      name: path.basename(relative),
      sha256: createHash("sha256").update(data).digest("hex"),
      base64: data.toString("base64"),
    };
  } finally {
    await handle.close();
  }
}

export async function fixtureReports(root) {
  const directory = path.join(root, "test-results/fixtures");
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isDirectory())
    throw new Error("Fixture reports must be a real directory.");
  const names = await fs.readdir(directory);
  if (names.length > 64) throw new Error("Too many fixture reports.");
  const reports = [];
  for (const name of names) {
    if (!/^[a-f0-9-]+\.json$/.test(name))
      throw new Error("Invalid fixture report name.");
    reports.push(
      await readReport(root, `test-results/fixtures/${name}`, 64 * 1024),
    );
  }
  return reports;
}

export async function lifecycleReports(root) {
  const limits = {
    files: 128,
    fileBytes: 64 * 1024,
    totalBytes: 8 * 1024 * 1024,
    entries: 512,
  };
  const report = { files: [], unavailable: [], truncated: false, limits };
  let entries = 0;
  let bytes = 0;
  const omit = (relative, reason, truncated = false) => {
    if (report.unavailable.length < limits.entries)
      report.unavailable.push({ path: relative, reason });
    else if (truncated)
      report.unavailable[limits.entries - 1] = { path: relative, reason };
    report.truncated ||= truncated;
  };
  for (const [directory, prefix] of [
    ["test-results/gate-b", "cloudx-gate-b-failure-"],
    ["test-results/terminal", "supervisor-"],
  ]) {
    if (!(await reportDirectoryExists(root, directory))) {
      omit(directory, "not-produced");
      continue;
    }
    const children = await fs.opendir(path.join(root, directory));
    const candidates = [];
    for await (const child of children) {
      entries += 1;
      if (entries > limits.entries) {
        omit(directory, "entry-count-limit", true);
        break;
      }
      if (!child.name.startsWith(prefix)) {
        omit(directory, "not-lifecycle-report");
        continue;
      }
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(child.name))
        throw new Error("Invalid lifecycle diagnostic directory name.");
      const relative = `${directory}/${child.name}/lifecycle.json`;
      if (!(await reportDirectoryExists(root, `${directory}/${child.name}`))) {
        omit(relative, "not-produced");
        continue;
      }
      let stat;
      try {
        stat = await fs.lstat(path.join(root, relative));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        omit(relative, "not-produced");
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("Lifecycle diagnostics must be single regular files.");
      if (stat.size > limits.fileBytes) {
        omit(relative, "file-size-limit", true);
        continue;
      }
      candidates.push({ relative, stat });
    }
    candidates.sort(
      (left, right) =>
        right.stat.mtimeMs - left.stat.mtimeMs ||
        left.relative.localeCompare(right.relative),
    );
    for (const { relative, stat } of candidates) {
      if (report.files.length >= limits.files) {
        omit(relative, "file-count-limit", true);
        continue;
      }
      if (stat.size > limits.totalBytes - bytes) {
        omit(relative, "total-size-limit", true);
        continue;
      }
      report.files.push({
        path: relative,
        ...(await readReport(root, relative, limits.fileBytes)),
      });
      bytes += stat.size;
    }
  }
  return report;
}

async function reportDirectoryExists(root, relative) {
  let current = root;
  for (const part of ["", ...relative.split("/")]) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory())
      throw new Error("Report directory must not be a symlink.");
  }
  return true;
}

export function reportBytes(report) {
  if (
    !report ||
    typeof report.base64 !== "string" ||
    report.base64.length > (maximumReportBytes * 4) / 3 + 4
  )
    throw new Error("Missing or oversized report.");
  const data = Buffer.from(report.base64, "base64");
  if (
    data.toString("base64") !== report.base64 ||
    createHash("sha256").update(data).digest("hex") !== report.sha256
  )
    throw new Error("Report digest mismatch.");
  return data;
}

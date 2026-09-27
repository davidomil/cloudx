import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { lifecycleReports, reportBytes } from "../../containers/ci/reports.mjs";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-lifecycle-reports-"),
  );
  directories.push(root);
  return root;
}

async function diagnostic(root, relative, content = "{}") {
  const filename = path.join(root, relative, "lifecycle.json");
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
  return filename;
}

it("retains process lifecycle evidence and explicitly reports diagnostics not produced", async () => {
  const root = await fixture();
  expect((await lifecycleReports(root)).unavailable).toEqual([
    { path: "test-results/gate-b", reason: "not-produced" },
    { path: "test-results/terminal", reason: "not-produced" },
  ]);
  const content = JSON.stringify({
    pid: 42,
    started: "12345",
    events: [{ phase: "exhausted", elapsedMs: 50 }],
  });
  await diagnostic(
    root,
    "test-results/gate-b/cloudx-gate-b-failure-abcdef",
    content,
  );
  await diagnostic(root, "test-results/terminal/supervisor-abcdef", content);
  await fs.mkdir(
    path.join(root, "test-results/terminal/supervisor-incomplete"),
  );

  const report = await lifecycleReports(root);
  expect(report.files).toHaveLength(2);
  expect(report.files.map((file) => JSON.parse(reportBytes(file)))).toEqual([
    JSON.parse(content),
    JSON.parse(content),
  ]);
  expect(report.unavailable).toEqual([
    {
      path: "test-results/terminal/supervisor-incomplete/lifecycle.json",
      reason: "not-produced",
    },
  ]);
  expect(report.truncated).toBe(false);
});

it("bounds diagnostic size and retained file count while exposing truncation", async () => {
  const root = await fixture();
  await diagnostic(
    root,
    "test-results/gate-b/cloudx-gate-b-failure-large",
    "x".repeat(64 * 1024 + 1),
  );
  for (let index = 0; index < 129; index += 1)
    await diagnostic(root, `test-results/terminal/supervisor-${index}`);

  const report = await lifecycleReports(root);
  expect(report.files).toHaveLength(128);
  expect(report.truncated).toBe(true);
  expect(report.unavailable).toContainEqual(
    expect.objectContaining({ reason: "file-size-limit" }),
  );
  expect(report.unavailable).toContainEqual(
    expect.objectContaining({ reason: "file-count-limit" }),
  );
  expect(
    report.files.reduce((sum, file) => sum + reportBytes(file).length, 0),
  ).toBeLessThanOrEqual(report.limits.totalBytes);
});

it("bounds directory enumeration even when no lifecycle files were produced", async () => {
  const root = await fixture();
  const directory = path.join(root, "test-results/terminal");
  await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < 513; index += 1)
    await fs.mkdir(path.join(directory, `supervisor-${index}`));
  const report = await lifecycleReports(root);
  expect(report.files).toHaveLength(0);
  expect(report.unavailable.length).toBeLessThanOrEqual(report.limits.entries);
  expect(report.truncated).toBe(true);
});

it("retains Gate B failures first and the newest supervisor evidence after exceeding the file cap", async () => {
  const root = await fixture();
  const gate = await diagnostic(
    root,
    "test-results/gate-b/cloudx-gate-b-failure-early",
  );
  await fs.utimes(gate, 1, 1);
  for (let index = 0; index < 129; index += 1) {
    const success = await diagnostic(
      root,
      `test-results/terminal/supervisor-success-${index}`,
    );
    await fs.utimes(success, 2, 2);
  }
  const failure = await diagnostic(
    root,
    "test-results/terminal/supervisor-late-failure",
    JSON.stringify({
      events: [{ phase: "error", errorType: "PermissionError" }],
    }),
  );
  await fs.utimes(failure, 3, 3);

  const report = await lifecycleReports(root);
  expect(report.files).toHaveLength(128);
  expect(report.files[0].path).toBe(path.relative(root, gate));
  expect(report.files[1].path).toBe(path.relative(root, failure));
  expect(JSON.parse(reportBytes(report.files[1])).events[0].phase).toBe(
    "error",
  );
  expect(report.truncated).toBe(true);
});

it.each(["ancestor", "directory", "file", "hardlink", "fifo"])(
  "rejects unsafe %s lifecycle paths",
  async (kind) => {
    const root = await fixture();
    const outside = await fixture();
    const relative = "test-results/terminal/supervisor-abcdef";
    const filename = await diagnostic(root, relative);
    if (kind === "ancestor") {
      await fs.rename(
        path.join(root, "test-results"),
        path.join(outside, "moved"),
      );
      await fs.symlink(
        path.join(outside, "moved"),
        path.join(root, "test-results"),
      );
    } else if (kind === "directory") {
      await fs.rename(path.dirname(filename), path.join(outside, "moved"));
      await fs.symlink(path.join(outside, "moved"), path.dirname(filename));
    } else {
      await fs.unlink(filename);
      const target = path.join(outside, "private");
      await fs.writeFile(target, "must not be exported");
      if (kind === "file") await fs.symlink(target, filename);
      if (kind === "hardlink") await fs.link(target, filename);
      if (kind === "fifo") execFileSync("mkfifo", [filename]);
    }
    await expect(lifecycleReports(root)).rejects.toThrow(/directory|regular/);
  },
);

it("ignores unrelated terminal reports without reading them", async () => {
  const root = await fixture();
  await diagnostic(root, "test-results/terminal/arbitrary-data");
  const report = await lifecycleReports(root);
  expect(report.files).toHaveLength(0);
  expect(report.unavailable).toContainEqual({
    path: "test-results/terminal",
    reason: "not-lifecycle-report",
  });
});

it("rejects malformed lifecycle names", async () => {
  const root = await fixture();
  await diagnostic(root, "test-results/terminal/supervisor-bad name");
  await expect(lifecycleReports(root)).rejects.toThrow("Invalid lifecycle");
});

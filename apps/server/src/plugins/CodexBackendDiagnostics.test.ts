import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const { CodexBackendDiagnostics, MAX_BACKEND_DIAGNOSTIC_BYTES } = await import(
  new URL("../../helpers/codex-backend-diagnostics.mjs", import.meta.url).href
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function launchDirectory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-backend-diagnostics-"),
  );
  directories.push(directory);
  return directory;
}

it("retains the most recent backend diagnostics within a private byte bound across recovery", async () => {
  const directory = await launchDirectory();
  const receipt = path.join(directory, "selection.json");
  const first = new CodexBackendDiagnostics(receipt);
  first.append("old diagnostic\n");
  first.append("界".repeat(MAX_BACKEND_DIAGNOSTIC_BYTES));
  first.append("\x1b[31mrecent diagnostic\x1b[0m\n");
  first.close();
  const retained = await fs.readFile(first.path, "utf8");
  expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(
    MAX_BACKEND_DIAGNOSTIC_BYTES,
  );
  expect(retained).not.toContain("old diagnostic");
  expect(retained).not.toContain("�");
  expect(retained).toContain("\x1b[31mrecent diagnostic\x1b[0m\n");
  expect((await fs.stat(first.path)).mode & 0o777).toBe(0o600);
  const recovered = new CodexBackendDiagnostics(receipt);
  recovered.append("recovered launch\n");
  recovered.close();
  expect(await fs.readFile(first.path, "utf8")).toContain(
    "recent diagnostic\x1b[0m\nrecovered launch\n",
  );
  expect((await fs.stat(first.path)).size).toBeLessThanOrEqual(
    MAX_BACKEND_DIAGNOSTIC_BYTES,
  );
});

it.each([
  "public-directory",
  "directory-link",
  "file-link",
  "public-file",
  "hard-link",
  "fifo",
])("rejects an unowned diagnostic sink: %s", async (scenario) => {
  const directory = await launchDirectory();
  let launch = directory;
  const log = path.join(directory, "cloudx-codex-backend.log");
  const original = path.join(directory, "original.log");
  await fs.writeFile(original, "preserve original", { mode: 0o600 });
  if (scenario === "public-directory") await fs.chmod(directory, 0o755);
  if (scenario === "directory-link") {
    launch = path.join(directory, "linked");
    await fs.symlink(directory, launch);
  }
  if (scenario === "file-link") await fs.symlink(original, log);
  if (scenario === "public-file")
    await fs.writeFile(log, "preserve public file", { mode: 0o644 });
  if (scenario === "hard-link") await fs.link(original, log);
  if (scenario === "fifo") {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", ["-m", "600", log]);
  }
  expect(
    () => new CodexBackendDiagnostics(path.join(launch, "selection.json")),
  ).toThrow();
  expect(await fs.readFile(original, "utf8")).toBe("preserve original");
  if (scenario === "public-file")
    expect(await fs.readFile(log, "utf8")).toBe("preserve public file");
});

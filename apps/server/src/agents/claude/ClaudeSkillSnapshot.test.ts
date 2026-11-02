import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { readClaudeSkillSnapshot, writeClaudeSkillSnapshot } from "./ClaudeSkillSnapshot.js";

it("snapshots only declared source files while ignored runtime trees stay outside the snapshot", async ({ onTestFinished }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-skill-manifest-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "Original source.");
  await fs.writeFile(path.join(source, "scripts", "run.sh"), "echo original");
  await fs.chmod(path.join(source, "scripts", "run.sh"), 0o751);
  await fs.writeFile(path.join(root, "outside"), "Unselected runtime.");
  await fs.symlink(path.join(root, "outside"), path.join(source, "installed-tool"));
  await fs.symlink(source, path.join(source, "runtime-cycle"));
  const manifest = ["scripts/run.sh", "SKILL.md"];
  const limits = { bytes: 100, entries: 3 };
  const snapshot = await readClaudeSkillSnapshot(source, limits, manifest);
  expect(snapshot.files.map(file => file.relative)).toEqual(["SKILL.md", "scripts/run.sh"]);
  expect(snapshot.entries).toBe(3);
  await fs.writeFile(path.join(source, "SKILL.md"), "Updated source.");
  const next = await readClaudeSkillSnapshot(source, limits, manifest);
  expect(next.sha256).not.toBe(snapshot.sha256);
  expect(snapshot.files[0]!.content.toString()).toBe("Original source.");

  const target = path.join(root, "snapshot");
  await writeClaudeSkillSnapshot(snapshot, target);
  expect((await readClaudeSkillSnapshot(target)).sha256).toBe(snapshot.sha256);
  expect((await fs.stat(path.join(target, "scripts", "run.sh"))).mode & 0o777).toBe(0o751);
  await expect(readClaudeSkillSnapshot(source)).rejects.toThrow("not self-contained");
  await fs.unlink(path.join(source, "installed-tool"));
  await expect(readClaudeSkillSnapshot(source)).rejects.toThrow("cyclic directory link");
  await expect(readClaudeSkillSnapshot(source, { bytes: 1, entries: 10 }, manifest)).rejects.toThrow("bounded snapshot size");
  await expect(readClaudeSkillSnapshot(source, { bytes: 100, entries: 2 }, manifest)).rejects.toThrow("bounded snapshot entry count");
  await expect(readClaudeSkillSnapshot(source, limits, ["scripts"])).rejects.toThrow("must identify regular files");
  await expect(readClaudeSkillSnapshot(path.join(source, "SKILL.md"), limits, manifest)).rejects.toThrow("requires a directory");

  await fs.unlink(path.join(source, "scripts", "run.sh"));
  await fs.symlink(path.join(root, "outside"), path.join(source, "scripts", "run.sh"));
  await expect(readClaudeSkillSnapshot(source, limits, manifest)).rejects.toThrow("not self-contained");
});

it.each([
  [], ["SKILL.md", "SKILL.md"], ["../outside"], ["scripts/../SKILL.md"], ["/absolute"],
  ["scripts\\run.sh"], ["scripts//run.sh"], ["C:/absolute"], ["."], [""]
].map(manifest => ({ manifest })))("rejects ambiguous or escaping source manifests before reading files: $manifest", async ({ manifest }) => {
  await expect(readClaudeSkillSnapshot("unread source", undefined, manifest)).rejects.toThrow("unique, relative file paths");
});

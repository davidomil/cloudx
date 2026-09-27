import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PreparedTestCheckout } from "./prepared-test-checkout.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function sourceRepository({ failingBuild = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-prepared-source-"));
  roots.push(root);
  const source = path.join(root, "source");
  await fs.mkdir(source);
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture preparation test");
  git("config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "prepared-fixture", version: "1.0.0", scripts: { build: "node build.mjs" } }));
  await fs.writeFile(path.join(source, "package-lock.json"), JSON.stringify({ name: "prepared-fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "prepared-fixture", version: "1.0.0" } } }));
  await fs.writeFile(path.join(source, "build.mjs"), failingBuild ? "process.exit(9);" : `
import fs from 'node:fs';
fs.mkdirSync('lib'); fs.writeFileSync('lib/built.txt', 'original');
fs.mkdirSync('node_modules', { recursive: true }); fs.symlinkSync('../lib', 'node_modules/workspace');
`);
  await fs.writeFile(path.join(source, "version.txt"), "older");
  git("add", ".");
  git("commit", "-m", "fixture");
  const previousCommit = git("rev-parse", "HEAD");
  await fs.writeFile(path.join(source, "version.txt"), "current");
  git("add", "version.txt");
  git("commit", "-m", "current fixture");
  return { root, source, previousCommit, commit: git("rev-parse", "HEAD"), diagnostics: path.join(root, "diagnostics") };
}

it("builds once and gives every historical installation independently writable files, Git state, and workspace links", async () => {
  const fixture = await sourceRepository();
  const prepared = await PreparedTestCheckout.create(fixture.source, { diagnostics: fixture.diagnostics });
  const templateRoot = prepared.owner.root;
  try {
    const first = path.join(fixture.root, "first"), second = path.join(fixture.root, "second");
    await prepared.copyTo(first);
    await prepared.copyTo(second);
    expect(() => execFileSync("git", ["-C", second, "read-tree", "--dry-run", "-m", "-u", fixture.commit, fixture.previousCommit], { stdio: "pipe" })).not.toThrow();
    expect(await fs.readlink(path.join(first, "node_modules/workspace"))).toBe("../lib");
    await fs.writeFile(path.join(first, "node_modules/workspace/built.txt"), "first case changed");
    await fs.writeFile(path.join(first, ".git/HEAD"), "ref: refs/heads/case-one\n");
    expect(await fs.readFile(path.join(second, "lib/built.txt"), "utf8")).toBe("original");
    expect(await fs.readFile(path.join(prepared.source, "lib/built.txt"), "utf8")).toBe("original");
    expect(execFileSync("git", ["-C", second, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(fixture.commit);
    await expect(prepared.copyTo(first)).rejects.toMatchObject({ code: "EEXIST" });
  } finally { await prepared.close(); }
  const lateCopy = path.join(fixture.root, "late-copy");
  await expect(prepared.copyTo(lateCopy)).rejects.toThrow("closed");
  await expect(fs.access(lateCopy)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.access(templateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  const [report] = await fs.readdir(fixture.diagnostics);
  const diagnostic = JSON.parse(await fs.readFile(path.join(fixture.diagnostics, report), "utf8"));
  expect(diagnostic.phases.filter(phase => phase.phase === "build-current-source")).toHaveLength(1);
  expect(diagnostic.phases.filter(phase => phase.phase === "copy-prepared-checkout").map(phase => phase.state)).toEqual(["passed", "passed"]);
  expect(diagnostic.cleanup.state).toBe("passed");
});

it("fails preparation once and cleans the owned input before any case can run", async () => {
  const fixture = await sourceRepository({ failingBuild: true });
  await expect(PreparedTestCheckout.create(fixture.source, { diagnostics: fixture.diagnostics })).rejects.toThrow("build-current-source exited 9");
  const [report] = await fs.readdir(fixture.diagnostics);
  const diagnostic = JSON.parse(await fs.readFile(path.join(fixture.diagnostics, report), "utf8"));
  expect(diagnostic).toMatchObject({ bodyState: "failed", cleanup: { state: "passed" } });
  expect(diagnostic.phases.filter(phase => phase.phase === "build-current-source")).toHaveLength(1);
});

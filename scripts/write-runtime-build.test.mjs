import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { RuntimeBuild } from "../apps/server/src/system/RuntimeBuild.ts";
import { writeRuntimeBuild } from "./write-runtime-build.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("reports the running build independently of later checkout and artifact replacement", () => {
  const repoRoot = installation();
  const receipt = writeRuntimeBuild({ repoRoot });
  const directory = path.join(repoRoot, "apps/server/dist");
  const running = new RuntimeBuild(directory);
  expect(running.identity).toMatchObject({ verification: "verified", build: { commit: receipt.commit, sourceDirty: false }, pid: process.pid });
  fs.writeFileSync(path.join(repoRoot, "tracked"), "new checkout source");
  fs.writeFileSync(path.join(directory, "index.js"), "new build");
  expect(running.identity.build).toMatchObject({ commit: receipt.commit, artifactSha256: receipt.artifactSha256 });
  expect(new RuntimeBuild(directory).identity).toMatchObject({ verification: "unverified", build: null, reason: expect.stringContaining("no longer match") });
  const replacement = writeRuntimeBuild({ repoRoot });
  expect(replacement.sourceDirty).toBe(true);
  expect(replacement.artifactSha256).not.toBe(receipt.artifactSha256);
});

it("keeps a real process's startup evidence while its on-disk build is replaced", async () => {
  const repoRoot = installation();
  const receipt = writeRuntimeBuild({ repoRoot });
  const directory = path.join(repoRoot, "apps/server/dist");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { RuntimeBuild } from ${JSON.stringify(new URL("../apps/server/src/system/RuntimeBuild.ts", import.meta.url).href)};
    const runtime = new RuntimeBuild(${JSON.stringify(directory)});
    process.on('message', () => process.send(runtime.identity));
    process.send(runtime.identity);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const [original] = await once(child, "message");
    expect(original).toMatchObject({ pid: child.pid, verification: "verified", build: { commit: receipt.commit } });
    if (process.platform === "linux") expect(original).toMatchObject({ processStarted: expect.stringMatching(/^\d+$/), bootId: expect.any(String) });
    fs.writeFileSync(path.join(directory, "index.js"), "replacement");
    writeRuntimeBuild({ repoRoot });
    const next = once(child, "message");
    child.send("read runtime identity");
    expect((await next)[0]).toEqual(original);
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});

it.each(["missing", "invalid", "changed-manifest", "escaped-path"])("does not assert a build version with %s build evidence", kind => {
  const repoRoot = installation();
  const directory = path.join(repoRoot, "apps/server/dist");
  const receipt = writeRuntimeBuild({ repoRoot });
  const file = path.join(directory, "runtime-build.json");
  if (kind === "missing") fs.unlinkSync(file);
  if (kind === "invalid") fs.writeFileSync(file, "{}");
  if (kind === "changed-manifest") fs.writeFileSync(file, JSON.stringify({ ...receipt, artifactSha256: "0".repeat(64) }));
  if (kind === "escaped-path") fs.writeFileSync(file, JSON.stringify({ ...receipt, artifacts: { ...receipt.artifacts, "../other.js": "0".repeat(64) } }));
  expect(new RuntimeBuild(directory).identity).toMatchObject({ verification: "unverified", build: null });
});

it("refuses to label a build with a commit other than its checkout", () => {
  const repoRoot = installation();
  expect(() => writeRuntimeBuild({ repoRoot, commit: "0".repeat(40) })).toThrow("does not match the checkout");
  expect(fs.existsSync(path.join(repoRoot, "apps/server/dist/runtime-build.json"))).toBe(false);
});

function installation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-build-identity-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "apps/server/dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps/server/dist/index.js"), "export const version = 'original';");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(root, "tracked"), "original source");
  const git = args => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init"]);
  git(["add", "."]);
  git(["-c", "user.name=CloudX Test", "-c", "user.email=test@invalid", "commit", "-m", "test fixture"]);
  return root;
}

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { writeRuntimeBuild } from "./write-runtime-build.mjs";

const roots = [];
const children = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")("attests a historical server only after its top-level startup await and retains the real process identity", async () => {
  const f = installation(`
    import fs from 'node:fs';
    import http from 'node:http';
    import { token } from './token.js';
    fs.writeFileSync(process.env.STARTED_FILE, 'imported');
    await new Promise(resolve => process.once('message', resolve));
    const server = http.createServer((_request, response) => response.end(JSON.stringify({ token, pid: process.pid, installRoot: process.env.CLOUDX_INSTALL_ROOT })));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.send({ port: server.address().port });
  `);
  const child = launch(f);
  await vi.waitFor(() => expect(fs.existsSync(f.started)).toBe(true));
  expect(fs.existsSync(f.receiptFile)).toBe(false);
  const listening = once(child, "message");
  child.send("finish startup");
  const [{ port }] = await listening;
  await vi.waitFor(() => expect(fs.existsSync(f.receiptFile)).toBe(true));
  const receipt = JSON.parse(fs.readFileSync(f.receiptFile, "utf8"));
  expect(receipt).toMatchObject({ version: 1, verified: true, verification: "verified", commit: f.build.commit,
    artifactSha256: f.build.artifactSha256, pid: child.pid, invocationId: "1".repeat(32),
    build: { sourceDirty: false, nodeVersion: process.version },
    bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    processStarted: fs.readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19] });
  expect(fs.statSync(f.receiptFile).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(f.root).some(file => file.endsWith(".tmp"))).toBe(false);
  const response = await fetch(`http://127.0.0.1:${port}/legacy-ready`);
  expect(await response.json()).toEqual({ token: "prepared-runtime", pid: child.pid, installRoot: path.resolve(path.dirname(f.entry), "../../..") });
  fs.writeFileSync(path.join(f.directory, "token.js"), "export const token = 'replacement';");
  expect(JSON.parse(fs.readFileSync(f.receiptFile, "utf8"))).toEqual(receipt);
  expect(await (await fetch(`http://127.0.0.1:${port}/legacy-ready`)).json()).toEqual({ token: "prepared-runtime", pid: child.pid, installRoot: path.resolve(path.dirname(f.entry), "../../..") });
});

it.skipIf(process.platform !== "linux")("launches through the installed distribution link while verifying the prepared release", async () => {
  const f = installation("setInterval(() => {}, 1000);");
  const installed = path.join(f.root, "installed");
  fs.symlinkSync(f.directory, installed);
  const child = launch({ ...f, entry: path.join(installed, "index.js") });
  await vi.waitFor(() => expect(fs.existsSync(f.receiptFile), child.errors).toBe(true));
  expect(JSON.parse(fs.readFileSync(f.receiptFile, "utf8")).pid).toBe(child.pid);
});

it.skipIf(process.platform !== "linux").each([
  "changed lock", "changed dependency", "missing dependency", "additional dependency", "symlink artifact", "symlink directory", "manifest digest", "escaped path", "wrong Node", "invalid manifest", "missing manifest",
])("rejects %s before importing any target code and clears a stale ready receipt", async kind => {
  const f = installation("import fs from 'node:fs'; fs.writeFileSync(process.env.STARTED_FILE, 'must not execute');");
  fs.writeFileSync(f.receiptFile, '{"verified":true,"pid":1}');
  if (kind === "changed lock") fs.writeFileSync(path.join(f.root, "package-lock.json"), "changed");
  if (kind === "changed dependency") fs.writeFileSync(path.join(f.directory, "token.js"), "changed");
  if (kind === "missing dependency") fs.unlinkSync(path.join(f.directory, "token.js"));
  if (kind === "additional dependency") fs.writeFileSync(path.join(f.directory, "extra.js"), "extra");
  if (kind === "symlink artifact") {
    fs.renameSync(path.join(f.directory, "token.js"), path.join(f.root, "token.js"));
    fs.symlinkSync(path.join(f.root, "token.js"), path.join(f.directory, "token.js"));
  }
  if (kind === "symlink directory") {
    fs.mkdirSync(path.join(f.root, "redirected"));
    fs.writeFileSync(path.join(f.root, "redirected/extra.js"), "extra");
    fs.symlinkSync(path.join(f.root, "redirected"), path.join(f.directory, "redirected"));
    f.build.artifacts["redirected/extra.js"] = createHash("sha256").update("extra").digest("hex");
    f.build.artifactSha256 = createHash("sha256").update(JSON.stringify(f.build.artifacts)).digest("hex");
  }
  if (kind === "manifest digest") f.build.artifactSha256 = "0".repeat(64);
  if (kind === "escaped path") f.build.artifacts["../outside.js"] = "0".repeat(64);
  if (kind === "wrong Node") f.build.nodeVersion = "v0.0.0";
  fs.writeFileSync(f.buildFile, JSON.stringify(kind === "invalid manifest" ? {} : f.build));
  if (kind === "missing manifest") fs.unlinkSync(f.buildFile);
  const child = launch(f);
  const [code] = await once(child, "exit");
  expect(code).toBe(1);
  expect(child.errors).toContain("runtime startup verification failed");
  expect(fs.existsSync(f.started)).toBe(false);
  expect(fs.existsSync(f.receiptFile)).toBe(false);
});

it.skipIf(process.platform !== "linux").each(["artifact", "manifest"])("rejects a receipt path aliasing the prepared %s without deleting it", async kind => {
  const f = installation("setInterval(() => {}, 1000);");
  const alias = path.join(f.root, "alias");
  const protectedFile = kind === "artifact" ? f.entry : f.buildFile;
  fs.symlinkSync(path.dirname(protectedFile), alias);
  const bytes = fs.readFileSync(protectedFile);
  const child = launch({ ...f, receiptFile: path.join(alias, path.basename(protectedFile)) });
  const [code] = await once(child, "exit");
  expect(code).toBe(1);
  expect(child.errors).toContain("receipt must be separate");
  expect(fs.readFileSync(protectedFile)).toEqual(bytes);
});

it.skipIf(process.platform !== "linux").each(["throw", "reject", "changes artifacts"])("does not write a ready receipt when startup %s", failure => {
  return failedStartup(failure);
});

async function failedStartup(failure) {
  const body = failure === "throw" ? "throw new Error('startup failed');"
    : failure === "reject" ? "await Promise.reject(new Error('asynchronous startup failed'));"
      : "import fs from 'node:fs'; fs.writeFileSync(new URL('./token.js', import.meta.url), 'changed during startup');";
  const f = installation(body);
  const child = launch(f);
  const [code] = await once(child, "exit");
  expect(code).toBe(1);
  expect(fs.existsSync(f.receiptFile)).toBe(false);
}

function installation(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-managed-launch-"));
  roots.push(root);
  const directory = path.join(root, "apps/server/dist");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  const entry = path.join(directory, "index.js");
  fs.writeFileSync(entry, source);
  fs.writeFileSync(path.join(directory, "token.js"), "export const token = 'prepared-runtime';");
  const git = args => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init"]);
  git(["add", "."]);
  git(["-c", "user.name=CloudX Test", "-c", "user.email=test@invalid", "commit", "-m", "TEST: historical runtime fixture"]);
  const build = writeRuntimeBuild({ repoRoot: root });
  const buildFile = path.join(root, "prepared-build.json");
  fs.copyFileSync(path.join(directory, "runtime-build.json"), buildFile);
  return { root, directory, entry, build, buildFile, receiptFile: path.join(root, "runtime.json"), started: path.join(root, "import-started") };
}

function launch(f) {
  const launcher = fileURLToPath(new URL("./managed-runtime-launch.mjs", import.meta.url));
  const child = spawn(process.execPath, [launcher, f.entry, f.buildFile, f.receiptFile], {
    env: { ...process.env, INVOCATION_ID: "1".repeat(32), STARTED_FILE: f.started }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  child.errors = "";
  child.stderr.on("data", bytes => { child.errors += bytes; });
  return child;
}

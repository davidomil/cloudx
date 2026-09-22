import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { expect, it, vi } from "vitest";

import { InstallerRunner, prepareManagedRelease } from "./install-cloudx.mjs";
import { ManagedUpdate, UpdateHost } from "./managed-update.mjs";
import { writeUpdateJson } from "./managed-update-store.mjs";

const supportedHost = process.platform === "linux"
  && fs.readFileSync("/etc/os-release", "utf8").includes("ID=ubuntu")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5000 }).status === 0;

it.skipIf(!supportedHost)("migrates a receiptless custom systemd runtime and restores its verified build and profile after failed readiness", async () => {
  const fixture = await installedFixture();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await ready(fixture, "original");
    const original = serviceState(fixture.unit);
    const saved = savedProfile(fixture.dataDir);
    const update = createUpdate(fixture, fixture.commits.selected);
    const refused = await update.coordinator.run();
    expect(refused).toMatchObject({ state: "failed", phase: "prepare", component: "terminals" });
    expect(update.record.transition.runtimePlan.reasons[0].message).toContain("terminal-runtime/web.json");
    expect(fs.existsSync(path.join(fixture.dataDir, "terminal-runtime/web.json"))).toBe(false);
    expect(serviceState(fixture.unit).MainPID).toBe(original.MainPID);
    expect(fixture.git(["rev-parse", "HEAD"])).toBe(fixture.commits.original);
    expect(savedProfile(fixture.dataDir)).toEqual(saved);
    expect(update.runner.calls.some(call => call.command === "systemctl" && call.args.includes("stop"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.stateDir, "confirmation.json"), "utf8")).targetCommit).toBe(fixture.commits.selected);

    update.record.confirmInterruption = true;
    const completed = await update.coordinator.run();
    expect(completed).toMatchObject({ state: "succeeded", phase: "complete" });
    expect(fixture.git(["rev-parse", "HEAD"])).toBe(fixture.commits.selected);
    expect(serviceState(fixture.unit).InvocationID).not.toBe(original.InvocationID);
    expect(update.record.transition.verifiedRuntime).toMatchObject({ verification: "verified", build: { commit: fixture.commits.selected } });
    expect(savedProfile(fixture.dataDir)).toEqual(saved);
    expect(JSON.parse(fs.readFileSync(fixture.lifecycleProof, "utf8"))).toMatchObject({ token: "selected", exited: true, cleaned: true });
    const priorArtifacts = fs.readFileSync(path.join(fixture.repoRoot, "apps/server/dist/token.js"));
    const priorRuntime = await ready(fixture, "selected");

    const failed = createUpdate(fixture, fixture.commits.broken, true);
    const restored = await failed.coordinator.run();
    expect(restored).toMatchObject({ state: "failed", phase: "verify", resumable: true });
    expect(failed.record.transition.restored).toBe(true);
    expect(fixture.git(["rev-parse", "HEAD"])).toBe(fixture.commits.selected);
    expect(fs.readFileSync(path.join(fixture.repoRoot, "apps/server/dist/token.js"))).toEqual(priorArtifacts);
    expect(savedProfile(fixture.dataDir)).toEqual(saved);
    expect(fs.existsSync(path.join(fixture.dataDir, "newer-user-data"))).toBe(false);
    const restarted = await ready(fixture, "selected");
    expect(restarted.pid).not.toBe(priorRuntime.pid);
    expect(JSON.parse(curl(fixture, "/api/runtime"))).toMatchObject({ verification: "verified", build: { commit: fixture.commits.selected } });
    const failedData = failed.record.transition.retainedFailedData;
    expect(failedData).toHaveLength(1);
    expect(fs.readFileSync(path.join(failedData[0].destination, "profile.json"), "utf8")).toBe('{"version":"broken-migration"}');
    expect(fs.readFileSync(path.join(failedData[0].destination, "newer-user-data"), "utf8")).toBe("preserved after failed startup");
    for (const runner of fixture.runners)
      expect(runner.calls.filter(call => call.command === "systemctl" && call.args.some(arg => ["start", "stop", "restart", "kill"].includes(arg)))
        .every(call => call.args.at(-1) === fixture.unit)).toBe(true);
  } catch (error) {
    const journal = spawnSync("journalctl", ["--user", "--no-pager", "-n", "60", "-u", fixture.unit], { encoding: "utf8", timeout: 5000 });
    throw new Error(`${error.message}\nIsolated fixture journal:\n${journal.stdout}`, { cause: error });
  } finally {
    errors.mockRestore();
    cleanupFixture(fixture);
  }
}, 90000);

function createUpdate(fixture, targetCommit, confirmInterruption = false) {
  const id = randomUUID(), runDir = path.join(fixture.stateDir, id);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const record = { repoRoot: fixture.repoRoot, dataDir: fixture.dataDir, home: fixture.home, service: fixture.unit,
    targetCommit, confirmInterruption, run: { id, state: "running", startedAt: new Date().toISOString(), message: "fixture update" } };
  const save = value => writeUpdateJson(path.join(fixture.stateDir, `${id}.json`), value);
  const runner = new FixtureCommands(fixture, fixture.repoRoot);
  fixture.runners.push(runner);
  const host = new UpdateHost({ repoRoot: fixture.repoRoot, dataDir: fixture.dataDir, home: fixture.home, service: fixture.unit,
    port: fixture.port, runDir, save, commands: runner,
    prepareRelease: options => {
      const staged = new FixtureCommands(fixture, options.releaseRoot);
      fixture.runners.push(staged);
      return prepareManagedRelease({ ...options, runner: staged });
    } });
  return { record, runner, coordinator: new ManagedUpdate({ record, save, host }) };
}

class FixtureCommands extends InstallerRunner {
  calls = [];
  constructor(fixture, cwd) { super({ cwd, nonInteractive: true, log() {} }); this.fixture = fixture; }
  check(command, args) {
    if (command === "systemctl" && args.some(arg => ["start", "stop", "restart", "kill", "enable", "disable"].includes(arg)) && args.at(-1) !== this.fixture.unit)
      throw new Error("The integration test may only mutate its uniquely named fixture service.");
    this.calls.push({ command, args });
  }
  run(command, args, options = {}) {
    this.check(command, args);
    return super.run(command, args, { ...options, env: { ...options.env, npm_config_cache: path.join(this.fixture.root, "npm-cache") } });
  }
  inspect(command, args, options = {}) { this.check(command, args); return super.inspect(command, args, options); }
  capture(command, args, options = {}) { this.check(command, args); return super.capture(command, args, options); }
}

async function installedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-managed-host-"));
  const unit = `cloudx-managed-host-${randomUUID()}.service`;
  try {
    const home = path.join(root, "home"), remote = path.join(root, "remote"), repoRoot = path.join(root, "checkout");
    const dataDir = path.join(root, "profile"), stateDir = path.join(root, "updates"), lifecycleProof = path.join(root, "lifecycle.json");
    const port = await freePort();
    fs.mkdirSync(remote);
    fs.mkdirSync(dataDir);
    fs.mkdirSync(stateDir);
    const gitAt = (directory, args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    gitAt(remote, ["init"]);
    const write = (relative, value) => {
      const file = path.join(remote, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    };
    const packageJson = { name: "cloudx-managed-host-fixture", version: "1.0.0", type: "module", private: true, scripts: { build: "node build.mjs" } };
    write("package.json", JSON.stringify(packageJson));
    write("package-lock.json", JSON.stringify({ name: packageJson.name, version: packageJson.version, lockfileVersion: 3, requires: true,
      packages: { "": { name: packageJson.name, version: packageJson.version } } }));
    write(".gitignore", "node_modules/\napps/server/dist/\n");
    write("build.mjs", `import fs from 'node:fs';
  fs.mkdirSync('apps/server/dist', { recursive: true });
  fs.cpSync('app', 'apps/server/dist', { recursive: true });
  fs.writeFileSync('apps/server/dist/token.js', 'export const token = ' + JSON.stringify(fs.readFileSync('version', 'utf8')) + ';');
  `);
    const runtimeSource = fs.readFileSync(new URL("../apps/server/src/system/RuntimeBuild.ts", import.meta.url), "utf8");
    write("app/system/RuntimeBuild.js", ts.transpileModule(runtimeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    write("apps/server/src/workspace/SessionStateStore.ts", fs.readFileSync(new URL("../apps/server/src/workspace/SessionStateStore.ts", import.meta.url)));
    write("app/index.js", "import { start } from './server.js'; await start();\n");
    write("app/server.js", fixtureServer());
    const commit = token => {
      write("version", token);
      gitAt(remote, ["add", "."]);
      gitAt(remote, ["-c", "user.name=CloudX Test", "-c", "user.email=test@invalid", "commit", "-m", `TEST: ${token} fixture runtime`]);
      return gitAt(remote, ["rev-parse", "HEAD"]);
    };
    const commits = { original: commit("original"), selected: commit("selected"), broken: commit("broken") };
    gitAt(root, ["clone", "--no-hardlinks", remote, repoRoot]);
    gitAt(repoRoot, ["checkout", "--detach", commits.original]);
    execFileSync("npm", ["ci", "--cache", path.join(root, "npm-cache")], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
    fs.writeFileSync(path.join(dataDir, "profile.json"), '{"version":"original-profile"}');
    const tab = { id: "saved-shell", pluginId: "terminal", title: "Preserved shell", cwd: repoRoot,
      status: "stopped", indicator: { color: "green", label: "Saved", updatedAt: "now" }, createdAt: "then", updatedAt: "now" };
    fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify({ version: 1, sessions: [{ tab }], activeTabId: tab.id }));
    fs.writeFileSync(path.join(dataDir, "workspace.json"), JSON.stringify({ windows: [{ id: "saved-window", name: "Preserved layout", defaultCwd: repoRoot,
      layout: { activePaneId: "pane", root: { type: "pane", pane: { id: "pane", tabIds: [tab.id], activeTabId: tab.id } } } }] }));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem")], { stdio: "pipe" });
    fs.chmodSync(path.join(root, "key.pem"), 0o600);
    const envPath = path.join(home, ".config/cloudx/cloudx.env");
    const unitPath = path.join(home, ".config/systemd/user", unit);
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(envPath, `CLOUDX_DATA_DIR=${dataDir}\nCLOUDX_PORT=${port}\nFIXTURE_CERT=${root}/cert.pem\nFIXTURE_KEY=${root}/key.pem\nFIXTURE_LIFECYCLE_PROOF=${lifecycleProof}\n`, { mode: 0o600 });
    fs.writeFileSync(unitPath, `[Unit]\nDescription=Isolated CloudX managed update fixture\n[Service]\nType=exec\nWorkingDirectory=${repoRoot}\nEnvironmentFile=${envPath}\nExecStart=${process.execPath} ${repoRoot}/apps/server/dist/index.js\nKillMode=control-group\nSendSIGKILL=yes\nTimeoutStopSec=5\nUMask=0077\n`);
    execFileSync("systemctl", ["--user", "link", "--runtime", unitPath], { stdio: "pipe", timeout: 5000 });
    execFileSync("systemctl", ["--user", "start", unit], { stdio: "pipe", timeout: 5000 });
    return { root, home, repoRoot, dataDir, stateDir, lifecycleProof, unit, port, commits, runners: [], git: args => gitAt(repoRoot, args) };
  } catch (error) {
    cleanupFixture({ root, unit });
    throw error;
  }
}

function fixtureServer() {
  return `import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { token } from './token.js';
import { runtimeBuild } from './system/RuntimeBuild.js';
export async function start() {
  if (token === 'broken') {
    fs.writeFileSync(path.join(process.env.CLOUDX_DATA_DIR, 'profile.json'), '{"version":"broken-migration"}');
    fs.writeFileSync(path.join(process.env.CLOUDX_DATA_DIR, 'newer-user-data'), 'preserved after failed startup');
  }
  const server = https.createServer({ key: fs.readFileSync(process.env.FIXTURE_KEY), cert: fs.readFileSync(process.env.FIXTURE_CERT) }, async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/runtime') return response.end(JSON.stringify(runtimeBuild.identity));
    if (token === 'broken') { response.statusCode = 503; return response.end(JSON.stringify({ code: 'documentation_startup_failed' })); }
    if (request.url === '/api/ready/terminals') {
      const child = spawn('/bin/sh', ['-c', 'printf ready'], { stdio: 'ignore' });
      const exited = await new Promise(resolve => child.once('exit', code => resolve(code === 0)));
      let cleaned = false;
      try { process.kill(child.pid, 0); } catch (error) { cleaned = error.code === 'ESRCH'; }
      const proof = { token, exited, cleaned, childPid: child.pid };
      fs.writeFileSync(process.env.FIXTURE_LIFECYCLE_PROOF, JSON.stringify(proof));
      if (!exited || !cleaned) response.statusCode = 500;
      return response.end(JSON.stringify(proof));
    }
    response.end(JSON.stringify({ ready: true, token, pid: process.pid }));
  });
  await new Promise(resolve => server.listen(Number(process.env.CLOUDX_PORT), '127.0.0.1', resolve));
}
`;
}

function serviceState(unit) {
  return Object.fromEntries(execFileSync("systemctl", ["--user", "show", unit, "--property=MainPID,InvocationID,ActiveState"], { encoding: "utf8" }).trim().split("\n").map(line => line.split("=")));
}
function curl(fixture, route) { return execFileSync("curl", ["--fail", "--silent", "--insecure", "--max-time", "3", `https://127.0.0.1:${fixture.port}${route}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
async function ready(fixture, token) {
  let response;
  await vi.waitFor(() => { response = JSON.parse(curl(fixture, "/api/ready")); expect(response.token).toBe(token); }, { timeout: 10000 });
  return response;
}
function savedProfile(directory) {
  return Object.fromEntries(["profile.json", "sessions.json", "workspace.json"].map(name => [name, fs.readFileSync(path.join(directory, name), "utf8")]));
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function cleanupFixture({ root, unit }) {
  spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 10000 });
  spawnSync("systemctl", ["--user", "disable", "--runtime", unit], { stdio: "ignore", timeout: 5000 });
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore", timeout: 5000 });
  fs.rmSync(root, { recursive: true, force: true });
}

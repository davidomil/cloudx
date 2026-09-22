import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { InstallerRunner, prepareManagedRelease } from "./install-cloudx.mjs";
import { ManagedUpdate, UpdateHost } from "./managed-update.mjs";
import { writeUpdateJson } from "./managed-update-store.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historicalTarget = "26d8291b89309acb59fdea1cbe09234d41d0164f";
const supportedHost = process.platform === "linux"
  && fs.readFileSync("/etc/os-release", "utf8").includes("ID=ubuntu")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5000 }).status === 0;

it.skipIf(!supportedHost)("activates the real historical server and broker without a terminal readiness endpoint under isolated systemd units", async () => {
  const fixture = await HistoricalInstallation.create();
  try {
    await fixture.waitUntilReady();
    const originalWeb = fixture.serviceState(fixture.webUnit);
    const originalBroker = fixture.serviceState(fixture.brokerUnit);
    const update = fixture.update(historicalTarget);
    expect(fixture.git(["show", `${historicalTarget}:apps/server/src/server.ts`])).not.toContain("/api/ready/terminals");
    expect(await update.coordinator.run()).toMatchObject({ state: "succeeded", phase: "complete" });
    expect(fixture.git(["rev-parse", "HEAD"])).toBe(historicalTarget);
    expect(update.record.transition.integration.independentReadiness).toBe(true);
    expect(update.record.transition.runtimePlan.requiresInterruption).toBe(true);
    expect(update.record.transition.runtimePlan.stopServices).toContain("cloudx-terminal.service");
    expect(fixture.serviceState(fixture.webUnit).InvocationID).not.toBe(originalWeb.InvocationID);
    expect(fixture.serviceState(fixture.brokerUnit).InvocationID).not.toBe(originalBroker.InvocationID);
    expect(fs.realpathSync(path.join(fixture.repoRoot, "apps/server/dist/terminal/broker.js")))
      .toBe(path.join(update.record.transition.release, "apps/server/dist/terminal/broker.js"));
    expect(update.record.transition.verifiedRuntime).toMatchObject({ verification: "verified", build: { commit: historicalTarget } });
    expect(JSON.parse(fixture.curl("/api/runtime"))).toMatchObject({ verification: "verified", build: { commit: historicalTarget } });
    expect(fixture.curl("/api/ready/terminals", ["--write-out", "%{http_code}"])).toMatch(/404$/);
    expect(fs.readdirSync(fixture.dataDir).filter(name => name.startsWith("terminal-readiness-"))).toEqual([]);
    expect(fs.readFileSync(path.join(fixture.dataDir, "user-data.txt"), "utf8")).toBe("Preserve the active profile across the historical transition.\n");
    expect(fixture.calls.filter(call => call.command === "systemctl" && call.args.some(arg => ["start", "stop", "restart", "kill"].includes(arg)))
      .every(call => [fixture.webUnit, fixture.brokerUnit].includes(call.args.at(-1)))).toBe(true);
  } catch (error) {
    const journal = spawnSync("journalctl", ["--user", "--no-pager", "-n", "50", "-u", fixture.webUnit, "-u", fixture.brokerUnit], { encoding: "utf8", timeout: 5000 });
    throw new Error(`${error.message}\nHistorical fixture journal:\n${journal.stdout}`, { cause: error });
  } finally {
    await fixture.close();
  }
}, 600000);

class HistoricalInstallation {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-history-systemd-"));
  home = path.join(this.root, "home");
  repoRoot = path.join(this.root, "checkout");
  dataDir = path.join(this.root, "profile");
  stateDir = path.join(this.home, ".local/state/cloudx/settings-update");
  webUnit = `cloudx-history-web-${randomUUID()}.service`;
  brokerUnit = `cloudx-history-broker-${randomUUID()}.service`;
  calls = [];

  static async create() {
    const fixture = new HistoricalInstallation();
    try { await fixture.install(); return fixture; }
    catch (error) { await fixture.close(); throw error; }
  }

  async install() {
    this.port = await freePort();
    const dependencyPort = await freePort();
    for (const directory of [this.home, this.dataDir, this.stateDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    command("git", ["clone", "--shared", sourceRoot, this.repoRoot]);
    this.git(["checkout", "--detach", "HEAD"]);
    command("npm", ["ci", "--no-audit", "--no-fund"], { cwd: this.repoRoot, timeout: 120000 });
    command("npm", ["run", "build"], { cwd: this.repoRoot, timeout: 120000 });
    const imagegen = path.join(this.home, ".codex/skills/.system/imagegen");
    fs.mkdirSync(imagegen, { recursive: true });
    fs.writeFileSync(path.join(imagegen, "SKILL.md"), "---\nname: imagegen\ndescription: Isolated fixture.\n---\nSynthetic fixture data.\n");
    fs.writeFileSync(path.join(this.dataDir, "user-data.txt"), "Preserve the active profile across the historical transition.\n");
    // Only the external ASR/documentation HTTP dependencies are stubbed.
    const dependencies = path.join(this.root, "dependencies.mjs");
    fs.writeFileSync(dependencies, `import http from 'node:http';
http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(request.url === '/ready' ? { status: 'ready' } : request.url === '/health' ? { ready: true } : { documents: [] }));
}).listen(${dependencyPort}, '127.0.0.1');\n`);
    this.dependencies = spawn(process.execPath, [dependencies], { stdio: "ignore" });
    command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", path.join(this.root, "key.pem"), "-out", path.join(this.root, "cert.pem")]);
    fs.chmodSync(path.join(this.root, "key.pem"), 0o600);
    this.envPath = path.join(this.home, ".config/cloudx/cloudx.env");
    fs.mkdirSync(path.dirname(this.envPath), { recursive: true });
    const environment = {
      HOME: this.home, CODEX_HOME: path.join(this.home, ".codex"), CLOUDX_DATA_DIR: this.dataDir,
      CLOUDX_ALLOWED_ROOTS: this.root, CLOUDX_HOST: "127.0.0.1", CLOUDX_PORT: this.port,
      CLOUDX_APP_SERVER_ENABLED: "false", CLOUDX_AUTOMATION_START_DISABLED: "true", CLOUDX_LOG_LEVEL: "warn",
      CLOUDX_ASR_URL: `http://127.0.0.1:${dependencyPort}`, CLOUDX_DOCUMENTATION_URL: `http://127.0.0.1:${dependencyPort}`,
      CLOUDX_HTTPS_KEY_PATH: path.join(this.root, "key.pem"), CLOUDX_HTTPS_CERT_PATH: path.join(this.root, "cert.pem"),
    };
    fs.writeFileSync(this.envPath, Object.entries(environment).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
    for (const [unit, entry] of [[this.brokerUnit, "terminal/broker.js"], [this.webUnit, "index.js"]]) {
      const unitPath = path.join(this.home, ".config/systemd/user", unit);
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, `[Unit]\nDescription=Isolated historical CloudX runtime\n${unit === this.webUnit ? `Wants=${this.brokerUnit}\nAfter=${this.brokerUnit}\n` : ""}[Service]\nType=${unit === this.brokerUnit ? "notify\nNotifyAccess=all" : "exec"}\nWorkingDirectory=${this.repoRoot}\nEnvironmentFile=${this.envPath}\nExecStart=${process.execPath} ${this.repoRoot}/apps/server/dist/${entry}\nKillMode=control-group\nSendSIGKILL=yes\nTimeoutStopSec=5\nUMask=0077\n`);
      command("systemctl", ["--user", "link", "--runtime", unitPath]);
    }
    command("systemctl", ["--user", "start", this.webUnit]);
  }

  update(targetCommit) {
    const id = randomUUID(), runDir = path.join(this.stateDir, id);
    fs.mkdirSync(runDir, { mode: 0o700 });
    const record = { repoRoot: this.repoRoot, dataDir: this.dataDir, home: this.home, service: this.webUnit, coordinator: sourceRoot,
      targetCommit, confirmInterruption: true, run: { id, state: "running", startedAt: new Date().toISOString(), message: "Historical transition fixture" } };
    const save = value => writeUpdateJson(path.join(this.stateDir, `${id}.json`), value);
    const host = new UpdateHost({ repoRoot: this.repoRoot, dataDir: this.dataDir, home: this.home, service: this.webUnit,
      port: this.port, runDir, save, commands: new IsolatedCommands(this, this.repoRoot),
      prepareRelease: options => prepareManagedRelease({ ...options, runner: new IsolatedCommands(this, options.releaseRoot) }) });
    return { record, coordinator: new ManagedUpdate({ record, save, host }) };
  }

  git(args) { return command("git", args, { cwd: this.repoRoot }); }
  serviceState(unit) { return Object.fromEntries(command("systemctl", ["--user", "show", unit, "--property=MainPID,InvocationID,ActiveState"]).split("\n").map(line => line.split("="))); }
  curl(route, extra = ["--fail"]) { return command("curl", ["--silent", "--show-error", "--insecure", "--max-time", "3", ...extra, `https://127.0.0.1:${this.port}${route}`]); }
  async waitUntilReady() { await expect.poll(() => JSON.parse(this.curl("/api/ready")), { timeout: 15000 }).toEqual({ status: "ready" }); }

  async close() {
    for (const unit of [this.webUnit, this.brokerUnit]) {
      spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 10000 });
      spawnSync("systemctl", ["--user", "disable", "--runtime", unit], { stdio: "ignore", timeout: 5000 });
    }
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore", timeout: 5000 });
    if (this.dependencies?.exitCode === null) {
      const exited = new Promise(resolve => this.dependencies.once("exit", resolve));
      this.dependencies.kill("SIGKILL");
      await exited;
    }
    const socketIdentity = createHash("sha256").update(this.dataDir).digest("hex").slice(0, 16);
    fs.rmSync(`/tmp/cloudx-terminals-${process.getuid()}-${socketIdentity}`, { recursive: true, force: true });
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

class IsolatedCommands extends InstallerRunner {
  constructor(fixture, cwd) { super({ cwd, nonInteractive: true, log() {} }); this.fixture = fixture; }
  scoped(command, args) {
    const scoped = command === "systemctl" ? args.map(arg => arg === "cloudx-terminal.service" ? this.fixture.brokerUnit : arg) : args;
    if (command === "systemctl" && scoped.some(arg => ["start", "stop", "restart", "kill", "enable", "disable"].includes(arg))
      && ![this.fixture.webUnit, this.fixture.brokerUnit].includes(scoped.at(-1))) throw new Error("The historical fixture may mutate only its uniquely named services.");
    this.fixture.calls.push({ command, args: scoped });
    return scoped;
  }
  run(command, args, options) { return super.run(command, this.scoped(command, args), options); }
  inspect(command, args, options) { return super.inspect(command, this.scoped(command, args), options); }
  capture(command, args, options) { return super.capture(command, this.scoped(command, args), options); }
}

function command(executable, args, options = {}) {
  return execFileSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, ...options }).trim();
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";

import { InstallerRunner, prepareManagedRelease } from "./install-cloudx.mjs";
import { ManagedUpdate, UpdateHost, validateSavedTransition } from "./managed-update.mjs";
import { writeUpdateJson } from "./managed-update-store.mjs";
import { seedSavedTabProfile } from "./helpers/managed-update-saved-tabs-fixture.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preBrokerTarget = "224a75ef7b3efced05b2c6b3b136250d9a532dc3";
const brokerTarget = "a9613fafdc0ed1765fcf72ea7d9f61de08c3914a";
const historicalTargets = ["26d8291b89309acb59fdea1cbe09234d41d0164f", "643ad8eb1c0ebe12cf4e112d72265fbe53814b65", "ad72433b2d6283811fad6bfe288748f2c24b0c5e", preBrokerTarget];
const supportedHost = process.platform === "linux"
  && fs.readFileSync("/etc/os-release", "utf8").includes("ID=ubuntu")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5000 }).status === 0;

it.skipIf(!supportedHost).each(historicalTargets)("activates historical %s and its required terminal services under isolated systemd units", async historicalTarget => {
  const fixture = await HistoricalInstallation.create({ savedTabs: historicalTarget === preBrokerTarget });
  try {
    await fixture.waitUntilReady();
    if (fixture.savedTabs) await fixture.expectSavedTabs();
    const originalWeb = fixture.serviceState(fixture.webUnit);
    const originalBroker = fixture.serviceState(fixture.brokerUnit);
    let update = fixture.update(historicalTarget);
    expect(fixture.git(["show", `${historicalTarget}:apps/server/src/server.ts`])).not.toContain("/api/ready/terminals");
    if (fixture.savedTabs) update = await fixture.interruptAfterActivation(update);
    expect(await update.coordinator.run()).toMatchObject({ state: "succeeded", phase: "complete" });
    expect(fixture.git(["rev-parse", "HEAD"])).toBe(historicalTarget);
    expect(update.record.transition.integration.independentReadiness).toBe(true);
    expect(update.record.transition.runtimePlan.requiresInterruption).toBe(true);
    expect(update.record.transition.runtimePlan.stopServices).toContain("cloudx-terminal.service");
    expect(fixture.serviceState(fixture.webUnit).InvocationID).not.toBe(originalWeb.InvocationID);
    if (historicalTarget === preBrokerTarget) {
      expect(update.record.transition.integration.terminalMode).toBe("direct");
      expect(fixture.serviceState(fixture.brokerUnit)).toMatchObject({ ActiveState: "inactive", MainPID: "0", ConditionResult: "no" });
      // Resuming the interrupted activation first restarts the original broker.
      expect(fixture.calls.filter(call => call.command === "systemctl" && call.args.includes("start") && call.args.at(-1) === fixture.brokerUnit))
        .toHaveLength(fixture.savedTabs ? 1 : 0);
      expect(fs.existsSync(path.join(fixture.repoRoot, "apps/server/dist/terminal/broker.js"))).toBe(false);
      expect(() => process.kill(Number(originalBroker.MainPID), 0)).toThrow();
      expect(update.record.restoreSnapshotRunId).toBeUndefined();
      expect(update.record.transition.restoreData).toBeUndefined();
      await fixture.expectSavedTabs({ historical: true });
      await fixture.rejectUnrecognizedRecovery();
      await fixture.navigateSavedWebsite();
      const historicalWeb = fixture.serviceState(fixture.webUnit);
      command("systemctl", ["--user", "restart", fixture.webUnit]);
      await fixture.waitUntilReady();
      expect(fixture.serviceState(fixture.webUnit).InvocationID).not.toBe(historicalWeb.InvocationID);
      await fixture.expectSavedTabs({ historical: true });
      await fixture.recoverPreservedConversationInBrowser();
    } else {
      expect(fixture.serviceState(fixture.brokerUnit).InvocationID).not.toBe(originalBroker.InvocationID);
      expect(fs.realpathSync(path.join(fixture.repoRoot, "apps/server/dist/terminal/broker.js")))
        .toBe(path.join(update.record.transition.release, "apps/server/dist/terminal/broker.js"));
    }
    expect(update.record.transition.verifiedRuntime).toMatchObject({ verification: "verified", build: { commit: historicalTarget } });
    expect(JSON.parse(fixture.curl("/api/runtime"))).toMatchObject({ verification: "verified", build: { commit: historicalTarget } });
    expect(fixture.curl("/api/ready/terminals", ["--write-out", "%{http_code}"])).toMatch(/404$/);
    expect(fs.readdirSync(fixture.dataDir).filter(name => name.startsWith("terminal-readiness-"))).toEqual([]);
    expect(fs.readFileSync(path.join(fixture.dataDir, "user-data.txt"), "utf8")).toBe("Preserve the active profile across the historical transition.\n");
    if (historicalTarget === preBrokerTarget) {
      await fixture.startNextUpdateInSettings(historicalTarget, brokerTarget);
      const next = fixture.update(brokerTarget);
      expect(await next.coordinator.run()).toMatchObject({ state: "succeeded", phase: "complete" });
      expect(fixture.git(["rev-parse", "HEAD"])).toBe(brokerTarget);
      expect(fixture.serviceState(fixture.brokerUnit)).toMatchObject({ ActiveState: "active", ConditionResult: "yes" });
      expect(fixture.serviceState(fixture.brokerUnit).InvocationID).not.toBe(originalBroker.InvocationID);
      expect(JSON.parse(fixture.curl("/api/runtime"))).toMatchObject({ verification: "verified", build: { commit: brokerTarget } });
      expect(JSON.parse(fixture.curl("/api/ready/terminals"))).toMatchObject({ status: "ready" });
      expect(fs.readFileSync(path.join(fixture.dataDir, "user-data.txt"), "utf8")).toBe("Preserve the active profile across the historical transition.\n");
      await fixture.expectSavedTabs();
    }
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

  static async create(options = {}) {
    const fixture = new HistoricalInstallation();
    try { await fixture.install(options); return fixture; }
    catch (error) { await fixture.close(); throw error; }
  }

  async install({ savedTabs = false }) {
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
    if (savedTabs) this.savedTabs = seedSavedTabProfile({ root: this.root, home: this.home, dataDir: this.dataDir,
      webUrl: `http://127.0.0.1:${dependencyPort}/saved-dashboard?token=fixture-token` });
    // ASR/documentation HTTP dependencies and the Codex executable are fixtures;
    // CloudX services, recovery validation and supervised PTYs are production paths.
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
      ...(this.savedTabs ? { SHELL: this.savedTabs.terminalCommand, CLOUDX_ASSISTANT_BIN: this.savedTabs.terminalCommand } : {}),
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

  update(targetCommit, savedRecord) {
    const id = savedRecord?.run.id ?? randomUUID(), runDir = path.join(this.stateDir, id);
    if (!savedRecord) fs.mkdirSync(runDir, { mode: 0o700 });
    const record = savedRecord ?? { repoRoot: this.repoRoot, dataDir: this.dataDir, home: this.home, service: this.webUnit, coordinator: sourceRoot,
      targetCommit, confirmInterruption: true, run: { id, state: "running", startedAt: new Date().toISOString(), message: "Historical transition fixture" } };
    if (savedRecord) validateSavedTransition(record, runDir);
    const save = value => writeUpdateJson(path.join(this.stateDir, `${id}.json`), value);
    const host = new UpdateHost({ repoRoot: this.repoRoot, dataDir: this.dataDir, home: this.home, service: this.webUnit,
      port: this.port, runDir, save, commands: new IsolatedCommands(this, this.repoRoot),
      recovery: savedRecord?.transition,
      prepareRelease: options => prepareManagedRelease({ ...options, runner: new IsolatedCommands(this, options.releaseRoot) }) });
    save(record);
    return { record, runDir, coordinator: new ManagedUpdate({ record, save, host }) };
  }

  async interruptAfterActivation(update) {
    const recordFile = path.join(this.stateDir, `${update.record.run.id}.json`);
    const fixtureFile = path.join(this.root, "interrupted-transition.json");
    writeUpdateJson(fixtureFile, { recordFile, runDir: update.runDir, repoRoot: this.repoRoot, home: this.home,
      dataDir: this.dataDir, webUnit: this.webUnit, brokerUnit: this.brokerUnit, port: this.port });
    const child = spawn(process.execPath, [path.join(sourceRoot, "scripts/helpers/managed-update-saved-tabs-fixture.mjs"), "--interrupt-after-activation", fixtureFile],
      { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { output += bytes; });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(result, output).toEqual({ code: null, signal: "SIGKILL" });
    const saved = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    expect(saved.transition.completed).toEqual(["prepare", "quiesce", "snapshot", "activate"]);
    expect(saved.transition.mutating).toBe(true);
    expect(saved.restoreSnapshotRunId).toBeUndefined();
    expect(this.git(["rev-parse", "HEAD"])).toBe(preBrokerTarget);
    expect(this.serviceState(this.webUnit).ActiveState).toBe("inactive");
    for (const { file, bytes } of this.savedTabs.evidence) expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.existsSync(this.savedTabs.terminalLaunches)).toBe(false);
    return this.update(saved.targetCommit, saved);
  }

  async expectSavedTabs({ historical = false } = {}) {
    const expected = this.savedTabs;
    const workspace = JSON.parse(this.curl("/api/workspace"));
    expect(workspace.activeTabId).toBe("saved-shell");
    expect(workspace.activeWindowId).toBe(expected.workspace.activeWindowId);
    const windowIdentity = ({ updatedAt, ...window }) => window;
    expect(workspace.windows.map(windowIdentity)).toEqual(expected.workspace.windows.map(windowIdentity));
    expect(workspace.tabs.map(tab => tab.id)).toEqual(expected.sessions.map(({ tab }) => tab.id));
    for (const original of expected.sessions) {
      const tab = workspace.tabs.find(tab => tab.id === original.tab.id);
      const { status, indicator, updatedAt, ...identity } = original.tab;
      expect(tab).toMatchObject(identity);
      if (tab.pluginId.endsWith("terminal")) {
        expect(tab.status).toBe(historical ? "stopped" : "failed");
        expect(tab.recovery.state).toBe("missing");
      }
    }
    const saved = () => JSON.parse(fs.readFileSync(path.join(this.dataDir, "sessions.json"), "utf8"));
    await expect.poll(() => saved().sessions.map(({ tab, initialInput }) => ({ id: tab.id, initialInput })))
      .toEqual(expected.sessions.map(({ tab, initialInput }) => ({ id: tab.id, initialInput })));
    expect(saved().activeTabId).toBe("saved-shell");
    const web = JSON.parse(this.curl("/api/tabs/saved-web/actions", ["--fail", "-X", "POST", "-H", "Content-Type: application/json",
      "-H", `Origin: https://127.0.0.1:${this.port}`, "--data", JSON.stringify({ action: "get_state", input: {} })]));
    expect(web.result.url).toBe(expected.sessions[2].initialInput.url);
    for (const { file, bytes } of expected.evidence) expect(fs.readFileSync(file)).toEqual(bytes);
    for (const { tab } of expected.sessions) expect(fs.readFileSync(tab.contextPath, "utf8")).toMatch(`Saved context for ${tab.id}.\n`);
    expect(this.terminalLaunches()).toHaveLength(expected.recoveryLaunches);
    expect(fs.existsSync(expected.terminalInput)).toBe(false);
  }

  terminalLaunches() {
    return fs.existsSync(this.savedTabs.terminalLaunches)
      ? fs.readFileSync(this.savedTabs.terminalLaunches, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  }

  async recoverPreservedConversationInBrowser() {
    const browser = await chromium.launch();
    const expected = this.savedTabs;
    try {
      for (const mobile of [false, true]) {
        const page = await browser.newPage({ ignoreHTTPSErrors: true,
          viewport: mobile ? { width: 393, height: 851 } : { width: 1440, height: 960 }, isMobile: mobile, hasTouch: mobile });
        const errors = [], requests = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
          if (request.url().endsWith("/recover")) requests.push({ url: new URL(request.url()).pathname, body: request.postDataJSON() });
        });
        await page.goto(`https://127.0.0.1:${this.port}`, { waitUntil: "domcontentloaded" });
        const pane = page.locator('[data-pane-id="saved-right"]');
        const recovery = pane.getByRole("region", { name: "Saved terminal recovery", exact: true });
        const resume = recovery.getByRole("button", { name: "Resume preserved conversation", exact: true });
        await browserExpect(recovery).toContainText(`Preserved Codex conversation: ${expected.conversationId}`);
        await browserExpect(recovery.getByRole("textbox")).toHaveCount(0);
        await browserExpect(resume).toBeEnabled();
        const workspaceBefore = JSON.parse(this.curl("/api/workspace"));

        fs.writeFileSync(expected.failNextLaunch, "Exit during the Codex startup grace period.\n");
        for (const attempt of ["failed", "recovered"]) {
          const response = page.waitForResponse(response => response.url().endsWith("/api/tabs/saved-codex/recover")
            && response.request().method() === "POST");
          await resume.click();
          expect((await response).ok()).toBe(true);
          expected.recoveryLaunches++;
          await expect.poll(() => this.terminalLaunches().length).toBe(expected.recoveryLaunches);
          const launch = this.terminalLaunches().at(-1);
          expect(launch.args.slice(-2)).toEqual(["resume", expected.conversationId]);
          expect(launch.args.join(" ")).not.toContain("NEVER_REPLAY");
          if (attempt === "failed") {
            await expect.poll(() => JSON.parse(this.curl("/api/workspace")).tabs.find(tab => tab.id === "saved-codex"))
              .toMatchObject({ status: "failed", recovery: { conversationId: expected.conversationId, canResume: true } });
            await browserExpect(recovery).toContainText("127");
            await browserExpect(resume).toBeEnabled();
            expect(() => process.kill(launch.pid, 0)).toThrow();
          } else {
            await browserExpect(recovery).toHaveCount(0);
            expect(() => process.kill(launch.pid, 0)).not.toThrow();
          }
        }

        expect(requests).toEqual(Array.from({ length: 2 }, () => ({ url: "/api/tabs/saved-codex/recover",
          body: { action: "resume-conversation", sessionId: expected.conversationId } })));
        const workspaceAfter = JSON.parse(this.curl("/api/workspace"));
        expect(workspaceAfter.tabs.map(tab => tab.id)).toEqual(workspaceBefore.tabs.map(tab => tab.id));
        expect(workspaceAfter.windows[0].layout.root).toEqual(workspaceBefore.windows[0].layout.root);
        expect(workspaceAfter.tabs.find(tab => tab.id === "saved-codex")).toMatchObject({ status: "running", title: "Saved Codex" });
        const ready = JSON.parse(this.curl("/api/tabs/saved-codex/actions", ["--fail", "-X", "POST", "-H", "Content-Type: application/json",
          "-H", `Origin: https://127.0.0.1:${this.port}`, "--data", JSON.stringify({ action: "wait_until_ready", input: { timeoutMs: 2000 } })]));
        expect(ready.result.ready).toBe(true);
        expect(fs.existsSync(expected.terminalInput)).toBe(false);
        for (const { file, bytes } of expected.evidence) expect(fs.readFileSync(file)).toEqual(bytes);
        expect(errors).toEqual([]);
        await page.getByRole("button", { name: /^Saved shell/ }).click();
        await expect.poll(() => JSON.parse(this.curl("/api/workspace")).windows[0].layout.activePaneId).toBe("saved-left");
        await page.close();

        // Explicit recovery consumes the saved prompt without sending it. Restart
        // returns the same tab to recovery for the next viewport and update.
        delete expected.sessions[1].initialInput.prompt;
        command("systemctl", ["--user", "restart", this.webUnit]);
        await this.waitUntilReady();
        for (const { pid } of this.terminalLaunches()) expect(() => process.kill(pid, 0)).toThrow();
        await this.expectSavedTabs({ historical: true });
      }
    } finally { await browser.close(); }
  }

  async navigateSavedWebsite() {
    const initialInput = this.savedTabs.sessions[2].initialInput;
    const url = new URL(initialInput.url);
    url.pathname = "/changed-on-historical-release";
    const response = JSON.parse(this.curl("/api/tabs/saved-web/actions", ["--fail", "-X", "POST", "-H", "Content-Type: application/json",
      "-H", `Origin: https://127.0.0.1:${this.port}`, "--data", JSON.stringify({ action: "open_url", input: { url: url.href } })]));
    expect(response.result.url).toBe(url.href);
    initialInput.url = url.href;
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(this.dataDir, "sessions.json"), "utf8")).sessions
      .find(({ tab }) => tab.id === "saved-web").initialInput.url).toBe(url.href);
  }

  async rejectUnrecognizedRecovery() {
    const recover = body => {
      const response = this.curl("/api/tabs/saved-codex/recover", ["-X", "POST", "-H", "Content-Type: application/json",
        "-H", `Origin: https://127.0.0.1:${this.port}`, "--data", JSON.stringify(body), "--write-out", "\n%{http_code}"]);
      const split = response.lastIndexOf("\n");
      return { status: Number(response.slice(split + 1)), body: JSON.parse(response.slice(0, split)) };
    };
    const file = path.join(this.dataDir, "sessions.json");
    const before = fs.readFileSync(file);
    expect(recover({ action: "resume-conversation", sessionId: this.savedTabs.conversationId, unknown: true }))
      .toMatchObject({ status: 400, body: { message: "Unknown recovery field." } });
    expect(recover({ action: "unsupported" })).toMatchObject({ status: 400, body: { message: "Unknown recovery action." } });
    expect(fs.readFileSync(file)).toEqual(before);
    const changedConversation = recover({ action: "resume-conversation", sessionId: "12345678-1234-4234-8234-123456789def" });
    expect(changedConversation.status).toBeGreaterThanOrEqual(400);
    expect(changedConversation.body.message).toMatch(/preserved conversation only/i);
    await expect.poll(() => JSON.parse(fs.readFileSync(file, "utf8")).sessions.map(({ tab, initialInput }) => ({ id: tab.id, initialInput })))
      .toEqual(this.savedTabs.sessions.map(({ tab, initialInput }) => ({ id: tab.id, initialInput })));
    for (const { file, bytes } of this.savedTabs.evidence) expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.existsSync(this.savedTabs.terminalLaunches)).toBe(false);
  }

  git(args) { return command("git", args, { cwd: this.repoRoot }); }
  serviceState(unit) { return Object.fromEntries(command("systemctl", ["--user", "show", unit, "--property=MainPID,InvocationID,ActiveState,ConditionResult"]).split("\n").map(line => line.split("="))); }
  curl(route, extra = ["--fail"]) { return command("curl", ["--silent", "--show-error", "--insecure", "--max-time", "3", ...extra, `https://127.0.0.1:${this.port}${route}`]); }
  async waitUntilReady() { await expect.poll(() => JSON.parse(this.curl("/api/ready")), { timeout: 15000 }).toEqual({ status: "ready" }); }

  async startNextUpdateInSettings(currentCommit, targetCommit) {
    const browser = await chromium.launch();
    try {
      for (const mobile of [false, true]) {
        const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: mobile ? { width: 393, height: 851 } : { width: 1440, height: 960 }, isMobile: mobile, hasTouch: mobile });
        const starts = [];
        const errors = [];
        const run = { id: randomUUID(), state: "running", phase: "prepare", targetCommit, startedAt: new Date().toISOString(), message: "Preparing the selected target." };
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/api/system/update/preview", route => route.fulfill({ json: {
          channel: "main", currentCommit, checkedAt: new Date().toISOString(), state: "available", changelog: [], changelogComplete: true,
          target: { commit: targetCommit, name: "main", url: `https://github.com/davidomil/cloudx/commit/${targetCommit}` },
        } }));
        await page.route("**/api/system/update", route => {
          if (route.request().method() === "POST") starts.push(route.request().postDataJSON());
          return route.fulfill({ json: { available: true, ...(starts.length ? { run } : {}) } });
        });
        await page.goto(`https://127.0.0.1:${this.port}`, { waitUntil: "domcontentloaded" });
        await browserExpect(page.locator(".workspace-pane").first()).toBeVisible();
        if (this.savedTabs) {
          await browserExpect(page.getByRole("button", { name: "Start a new shell", exact: true })).toBeVisible();
          await browserExpect(page.getByText(this.savedTabs.sessions[0].tab.cwd, { exact: true }).first()).toBeVisible();
          if (!mobile) await browserExpect(page.getByRole("button", { name: "Resume preserved conversation", exact: true })).toBeEnabled();
        }
        if (mobile) {
          await page.getByRole("button", { name: "Workspace actions", exact: true }).click();
          await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        } else await page.getByRole("button", { name: "Settings", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "Settings", exact: true });
        await settings.getByRole("searchbox", { name: "Search settings" }).fill("Updates");
        await browserExpect(settings.getByRole("tab", { name: "Updates", exact: true })).toHaveAttribute("aria-selected", "true");
        await settings.getByRole("button", { name: "Update CloudX and dependencies", exact: true }).click();
        await expect.poll(() => starts).toEqual([{ channel: "main", targetCommit }]);
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally { await browser.close(); }
  }

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

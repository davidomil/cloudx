import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CodexUpdateStatus } from "@cloudx/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as codexUpdater from "../../../../scripts/codex-updater.mjs";
import { loadConfig } from "../config.js";
import { HookRegistry } from "../hooks/HookRegistry.js";
import { buildServer, buildServices } from "../server.js";
import { CodexSettingsPlugin } from "./CodexSettingsPlugin.js";
import { CodexSettingsService } from "./CodexSettingsService.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexUpdateService } from "./CodexUpdateService.js";

const roots: string[] = [];
const disposers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function installation(options: { current?: boolean; failure?: string; gated?: boolean; noisy?: boolean; detachedWriter?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-update-server-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  const prefix = path.join(root, "configured npm prefix");
  const tools = path.join(root, "tools");
  const packageDir = path.join(prefix, "lib/node_modules/@openai/codex");
  const executable = path.join(prefix, "bin/codex");
  const commandLog = path.join(root, "commands.jsonl");
  const releaseFile = path.join(root, "release-install");
  const npmPid = path.join(root, "npm.pid");
  const writerPid = path.join(root, "writer.pid");
  const writerLog = path.join(root, "writer.log");
  await Promise.all([home, tools, path.join(prefix, "bin"), path.join(packageDir, "bin")].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(commandLog, "");
  await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.0.0", bin: { codex: "bin/codex.js" } }));
  await fs.writeFile(path.join(packageDir, "bin/codex.js"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const directory = path.dirname(__dirname);
if (process.argv[2] === '--version' && process.env.CLOUDX_TEST_VERSION_LOG)
  fs.appendFileSync(process.env.CLOUDX_TEST_VERSION_LOG, 'version\\n');
if (process.argv[2] === 'session') {
  fs.writeFileSync(process.env.CLOUDX_TEST_SESSION_READY, String(process.pid));
  setInterval(() => {}, 1000);
} else if (fs.existsSync(path.join(directory, 'broken'))) {
  process.stderr.write('synthetic-private-verification-detail');
  process.exit(29);
} else {
  console.log('codex-cli ' + JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version);
}
`, { mode: 0o755 });
  await fs.symlink("../lib/node_modules/@openai/codex/bin/codex.js", executable);
  await fs.symlink(process.execPath, path.join(tools, "node"));
  await fs.symlink(execFileSync("python3", ["-I", "-S", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim(), path.join(tools, "python3"));
  await fs.writeFile(path.join(tools, "npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLOUDX_TEST_COMMAND_LOG, JSON.stringify(args) + '\\n');
const failure = process.env.CLOUDX_TEST_FAILURE;
if (args[0] === 'view') {
  if (failure === 'network') {
    process.stderr.write('ENOTFOUND synthetic-private-registry-token');
    process.exit(23);
  }
  console.log(JSON.stringify(process.env.CLOUDX_TEST_LATEST));
} else if (args[0] === 'i') {
  fs.writeFileSync(process.env.CLOUDX_TEST_NPM_PID, String(process.pid));
  if (process.env.CLOUDX_TEST_DETACHED_WRITER === 'true') {
    const child = require('node:child_process').spawn(process.execPath, ['-e',
      "const fs = require('node:fs'); fs.writeFileSync(process.env.CLOUDX_TEST_WRITER_PID, String(process.pid)); setInterval(() => fs.appendFileSync(process.env.CLOUDX_TEST_WRITER_LOG, 'write'), 10);"
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  const install = () => {
    if (process.env.CLOUDX_TEST_NOISY === 'true') fs.writeSync(1, 'synthetic-private-package-output'.repeat(20000));
    if (failure === 'permissions' || failure === 'install') {
      process.stderr.write((failure === 'permissions' ? 'EACCES ' : 'EINSTALL ') + 'synthetic-private-install-token');
      process.exit(24);
    }
    const prefix = args[args.indexOf('--prefix') + 1];
    const directory = path.join(prefix, 'lib/node_modules/@openai/codex');
    const manifestPath = path.join(directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.version = process.env.CLOUDX_TEST_LATEST;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    if (failure === 'verification') fs.writeFileSync(path.join(directory, 'broken'), 'broken');
  };
  if (process.env.CLOUDX_TEST_GATE === 'true') {
    const timer = setInterval(() => {
      if (fs.existsSync(process.env.CLOUDX_TEST_RELEASE)) { clearInterval(timer); install(); }
    }, 10);
  } else install();
} else {
  process.stderr.write('Unexpected fixture npm command: ' + JSON.stringify(args));
  process.exit(90);
}
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    HOME: home, CODEX_HOME: path.join(home, ".codex"), PATH: tools, CLOUDX_TOOL_PATH: tools,
    CLOUDX_ASSISTANT_BIN: executable, CLOUDX_NPM_GLOBAL_DIR: prefix,
    CLOUDX_TEST_COMMAND_LOG: commandLog, CLOUDX_TEST_LATEST: options.current ? "1.0.0" : "1.1.0",
    CLOUDX_TEST_FAILURE: options.failure, CLOUDX_TEST_GATE: String(options.gated ?? false),
    CLOUDX_TEST_NOISY: String(options.noisy ?? false), CLOUDX_TEST_RELEASE: releaseFile, CLOUDX_TEST_NPM_PID: npmPid,
    CLOUDX_TEST_DETACHED_WRITER: String(options.detachedWriter ?? false), CLOUDX_TEST_WRITER_PID: writerPid, CLOUDX_TEST_WRITER_LOG: writerLog,
  };
  const service = (name = "data", serviceOptions: ConstructorParameters<typeof CodexUpdateService>[2] = {}) => {
    const updates = new CodexUpdateService(path.join(root, name), env, serviceOptions);
    disposers.push(() => updates.dispose());
    return updates;
  };
  const commands = async (): Promise<string[][]> => (await fs.readFile(commandLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const waitForInstall = () => vi.waitFor(async () => {
    expect(await commands()).toContainEqual(["i", "-g", "--prefix", prefix, "@openai/codex@latest"]);
    expect(Number(await fs.readFile(npmPid, "utf8"))).toBeGreaterThan(0);
  }, { timeout: 10_000 });
  const release = () => fs.writeFile(releaseFile, "continue");
  return { root, home, dataDir, prefix, tools, packageDir, executable, commandLog, npmPid, writerPid, writerLog, env, service, commands, waitForInstall, release };
}

async function finished(updates: Pick<CodexUpdateService, "read">): Promise<CodexUpdateStatus> {
  let status: CodexUpdateStatus;
  await vi.waitFor(async () => {
    status = await updates.read();
    expect(["succeeded", "failed"]).toContain(status.phase);
  }, { timeout: 10_000 });
  return status!;
}

async function holdExpiredVersionProbe(updates: CodexUpdateService) {
  await updates.read();
  let resolve!: (version: string) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((accept, fail) => { resolve = accept; reject = fail; });
  const readVersion = vi.spyOn(codexUpdater, "readCodexVersion").mockReturnValueOnce(pending);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  const reading = updates.read();
  await vi.waitFor(() => expect(readVersion).toHaveBeenCalledTimes(1));
  return { reading, resolve, reject, readVersion };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

describe("server-owned Codex updates", () => {
  it("shows the configured executable version, installs latest in its prefix, verifies it, and restores the result", async () => {
    const f = await installation();
    f.env.CLOUDX_NPM_GLOBAL_DIR = path.join(f.root, "unused-prefix");
    const updates = f.service();
    expect(await updates.read()).toMatchObject({ phase: "idle", installedVersion: "1.0.0", outcome: null });
    expect(await f.commands()).toEqual([]);

    const started = await updates.start();
    expect(started.jobId).toEqual(expect.any(String));
    const result = await finished(updates);
    expect(result).toMatchObject({ jobId: started.jobId, phase: "succeeded", installedVersion: "1.1.0", outcome: "updated", finishedAt: expect.any(String) });
    expect(await f.commands()).toEqual([
      ["view", "@openai/codex@latest", "version", "--json"],
      ["i", "-g", "--prefix", f.prefix, "@openai/codex@latest"],
    ]);
    await updates.dispose();
    expect(await f.service().read()).toEqual(result);
  });

  it("rejects an ambiguous PATH-only command without updating another configured prefix", async () => {
    const f = await installation();
    delete f.env.CLOUDX_ASSISTANT_BIN;
    f.env.CLOUDX_NPM_GLOBAL_DIR = path.join(f.root, "unused-prefix");
    f.env.PATH = `${f.tools}${path.delimiter}${path.join(f.prefix, "bin")}`;
    const updates = f.service();
    expect(await updates.read()).toMatchObject({ installedVersion: "1.0.0" });
    await updates.start();
    expect(await finished(updates)).toMatchObject({ phase: "failed", installedVersion: "1.0.0", outcome: null, message: expect.stringMatching(/absolute|configure/i) });
    expect(await f.commands()).toEqual([]);
    await expect(fs.stat(f.env.CLOUDX_NPM_GLOBAL_DIR)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports already current without reinstalling", async () => {
    const f = await installation({ current: true });
    const updates = f.service();
    await updates.start();
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", outcome: "current", installedVersion: "1.0.0" });
    expect(await f.commands()).toEqual([["view", "@openai/codex@latest", "version", "--json"]]);
  });

  it("marks a retained unfinished job interrupted after restart and checks the executable before displaying its version", async () => {
    const f = await installation();
    const updates = f.service();
    await updates.start();
    const result = await finished(updates);
    await updates.dispose();
    const statusPath = path.join(f.dataDir, "codex-update/status.json");
    const saved = JSON.parse(await fs.readFile(statusPath, "utf8"));
    saved.update = { ...result, phase: "updating", outcome: null, finishedAt: null };
    await fs.writeFile(statusPath, JSON.stringify(saved));
    const restored = await f.service().read();
    expect(restored).toMatchObject({ jobId: result.jobId, phase: "failed", outcome: null, installedVersion: "1.1.0", message: expect.stringMatching(/interrupted/i) });
    expect((await f.commands()).filter(args => args[0] === "i")).toHaveLength(1);
  });

  it.each(["updated", "current"] as const)("keeps verification blocked after uncertain cleanup until an explicit update succeeds as %s", async outcome => {
    const f = await installation({ current: outcome === "current" });
    const versionLog = path.join(f.root, "version-probes");
    f.env.CLOUDX_TEST_VERSION_LOG = versionLog;
    await fs.writeFile(versionLog, "");
    const statusPath = path.join(f.dataDir, "codex-update/status.json");
    const lockPath = path.join(f.prefix, ".cloudx-codex-update.lock");
    const failure: CodexUpdateStatus = {
      jobId: "cleanup-incomplete-job", phase: "failed", installedVersion: null, outcome: null,
      message: "Codex update subprocess cleanup could not be confirmed. Inspect installer processes before removing .cloudx-codex-update.lock.",
      startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
    };
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, JSON.stringify({ assistantBin: f.executable, verificationBlocked: true, update: failure }));
    await fs.writeFile(lockPath, `${process.pid}\n`);
    const updates = f.service();
    expect(await updates.read()).toEqual(failure);
    expect(await updates.read()).toEqual(failure);
    await updates.dispose();
    const restored = f.service();
    expect(await restored.read()).toEqual(failure);
    expect(await fs.readFile(versionLog, "utf8")).toBe("");

    await restored.start();
    expect(await finished(restored)).toMatchObject({ phase: "failed", installedVersion: null, outcome: null, message: expect.stringMatching(/another|lock/i) });
    expect(JSON.parse(await fs.readFile(statusPath, "utf8")).verificationBlocked).toBe(true);
    expect(await fs.readFile(lockPath, "utf8")).toBe(`${process.pid}\n`);
    expect(await fs.readFile(versionLog, "utf8")).toBe("");
    expect(await f.commands()).toEqual([]);

    await fs.rm(lockPath);
    await restored.start();
    const recovered = await finished(restored);
    expect(recovered).toMatchObject({ phase: "succeeded", outcome, installedVersion: outcome === "current" ? "1.0.0" : "1.1.0" });
    expect(JSON.parse(await fs.readFile(statusPath, "utf8")).verificationBlocked).toBe(false);
    const probesAfterRecovery = await fs.readFile(versionLog, "utf8");
    expect(probesAfterRecovery).not.toBe("");
    await restored.dispose();
    expect(await f.service().read()).toEqual(recovered);
    expect((await fs.readFile(versionLog, "utf8")).length).toBeGreaterThan(probesAfterRecovery.length);
  });

  it.each(["version read", "update"])("persists uncertain cleanup from a %s and stops automatic probes across restarts", async operation => {
    const f = await installation();
    const failure = new codexUpdater.CodexUpdateError("cleanup-incomplete", "Codex update subprocess cleanup could not be confirmed. Inspect installer processes before continuing.");
    const readVersion = vi.spyOn(codexUpdater, "readCodexVersion");
    if (operation === "version read") readVersion.mockRejectedValue(failure);
    else vi.spyOn(codexUpdater, "updateCodexInstallation").mockRejectedValue(failure);
    const updates = f.service();
    if (operation === "update") await updates.start();
    const failed = await finished(updates);
    expect(failed).toMatchObject({ phase: "failed", outcome: null, installedVersion: null, message: failure.message });
    expect(JSON.parse(await fs.readFile(path.join(f.dataDir, "codex-update/status.json"), "utf8"))).toMatchObject({ verificationBlocked: true, update: failed });
    expect(await updates.read()).toEqual(failed);
    expect(await updates.read()).toEqual(failed);
    await updates.dispose();
    expect(await f.service().read()).toEqual(failed);
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(await f.commands()).toEqual([]);
  });

  it("keeps cleanup blocked when an update was requested before an outstanding version probe failed", async () => {
    const f = await installation();
    const updates = f.service();
    const probe = await holdExpiredVersionProbe(updates);
    const failure = new codexUpdater.CodexUpdateError("cleanup-incomplete", "Codex subprocess cleanup could not be confirmed. Inspect remaining processes before continuing.");
    let finishUpdate!: (result: Awaited<ReturnType<typeof codexUpdater.updateCodexInstallation>>) => void;
    const update = vi.spyOn(codexUpdater, "updateCodexInstallation").mockReturnValue(new Promise(resolve => { finishUpdate = resolve; }));
    const starts = Promise.all([updates.start(), updates.start()]);
    await Promise.resolve();
    const updatesDuringProbe = update.mock.calls.length;

    probe.reject(failure);
    const failed = await probe.reading;
    const requested = await starts;
    finishUpdate({ installedVersion: "1.1.0", previousVersion: "1.0.0", outcome: "updated" });
    await updates.dispose();

    expect(updatesDuringProbe).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(failed).toMatchObject({ phase: "failed", outcome: null, installedVersion: null, message: failure.message });
    expect(requested).toEqual([failed, failed]);
    expect(await updates.read()).toEqual(failed);
    expect(JSON.parse(await fs.readFile(path.join(f.dataDir, "codex-update/status.json"), "utf8"))).toMatchObject({ verificationBlocked: true, update: failed });
    expect(await f.service().read()).toEqual(failed);
    expect(probe.readVersion).toHaveBeenCalledTimes(1);
    expect(await f.commands()).toEqual([]);
  });

  it("admits only one update after the outstanding version probe finishes", async () => {
    const f = await installation({ gated: true });
    const updates = f.service();
    const probe = await holdExpiredVersionProbe(updates);
    const update = vi.spyOn(codexUpdater, "updateCodexInstallation");
    const starts = Promise.all([updates.start(), updates.start(), updates.start()]);
    await Promise.resolve();
    const updatesDuringProbe = update.mock.calls.length;
    probe.resolve("1.0.0");
    const started = await starts;
    await probe.reading;
    await f.waitForInstall();
    await f.release();

    expect(updatesDuringProbe).toBe(0);
    expect(new Set(started.map(status => status.jobId)).size).toBe(1);
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses a pending update when CloudX stops during the version probe", async () => {
    const f = await installation();
    const updates = f.service();
    const probe = await holdExpiredVersionProbe(updates);
    const update = vi.spyOn(codexUpdater, "updateCodexInstallation");
    const starting = updates.start();
    await Promise.resolve();
    const stopping = updates.dispose();
    probe.resolve("1.0.0");
    await expect(starting).rejects.toThrow(/stopping/i);
    await Promise.all([stopping, probe.reading]);
    expect(update).not.toHaveBeenCalled();
    expect(await f.commands()).toEqual([]);
  });

  it.each(["invalid JSON", "oversized"])("rejects %s persisted status without starting npm or exposing its contents", async corruption => {
    const f = await installation();
    const statusPath = path.join(f.dataDir, "codex-update/status.json");
    const content = corruption === "invalid JSON" ? "synthetic-private-status-value" : JSON.stringify({ value: "synthetic-private-status-value".repeat(1000) });
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, content);
    const updates = f.service();
    await expect(updates.start()).rejects.toThrow(/saved.*status.*read/i);
    await expect(updates.read()).rejects.not.toThrow(/synthetic-private/);
    expect(await fs.readFile(statusPath, "utf8")).toBe(content);
    expect(await f.commands()).toEqual([]);
  });

  it("rejects an unsavable start with permissions guidance and retains idle status without starting npm", async () => {
    const f = await installation();
    const updates = f.service();
    const idle = await updates.read();
    await fs.mkdir(f.dataDir, { recursive: true });
    const statusDirectory = path.join(f.dataDir, "codex-update");
    await fs.writeFile(statusDirectory, "blocked status storage");
    await expect(updates.start()).rejects.toThrow("Codex update status could not be saved. Check CloudX data directory permissions.");
    expect(await updates.read()).toEqual(idle);
    expect(await f.commands()).toEqual([]);
    await fs.unlink(statusDirectory);
    await updates.start();
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0" });
  });

  it.each([
    ["network", /network|registry|connect/i, "1.0.0"],
    ["permissions", /permission|writ|access/i, "1.0.0"],
    ["install", /install|npm/i, "1.0.0"],
    ["verification", /verif|executable/i, null],
  ] as const)("reports %s failure safely and keeps only a verified usable version", async (failure, message, installedVersion) => {
    const f = await installation({ failure });
    const updates = f.service();
    await updates.start();
    const result = await finished(updates);
    expect(result).toMatchObject({ phase: "failed", outcome: null, installedVersion });
    expect(result.message).toMatch(message);
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(await f.service().read()).toEqual(result);
  });

  it("reports unavailable npm while preserving the usable installed version", async () => {
    const f = await installation();
    await fs.rm(path.join(f.tools, "npm"));
    const updates = f.service();
    await updates.start();
    expect(await finished(updates)).toMatchObject({ phase: "failed", outcome: null, installedVersion: "1.0.0", message: expect.stringMatching(/npm/i) });
    expect(await f.commands()).toEqual([]);
  });

  it("shows a custom wrapper's version but rejects updating it through npm", async () => {
    const f = await installation();
    const marker = path.join(f.root, "wrapper-executed");
    await fs.rm(f.executable);
    const wrapper = `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('codex-cli 1.0.0');\n`;
    await fs.writeFile(f.executable, wrapper, { mode: 0o755 });
    const updates = f.service();
    await updates.start();
    expect(await finished(updates)).toMatchObject({ phase: "failed", outcome: null, installedVersion: "1.0.0", message: expect.stringMatching(/wrapper|npm|supported/i) });
    expect((await fs.readFile(marker, "utf8")).trim().split("\n").every(line => line === '["--version"]')).toBe(true);
    expect(await fs.readFile(f.executable, "utf8")).toBe(wrapper);
    expect(await f.commands()).toEqual([]);
  });

  it("shares one job across concurrent starts and refuses another CloudX instance targeting the same installation", async () => {
    const f = await installation({ gated: true });
    const updates = f.service();
    const started = await Promise.all([updates.start(), updates.start(), updates.start()]);
    expect(new Set(started.map(status => status.jobId)).size).toBe(1);
    await f.waitForInstall();
    const other = f.service("other-instance");
    await other.start();
    expect(await finished(other)).toMatchObject({ phase: "failed", outcome: null, message: expect.stringMatching(/another|progress|lock/i) });
    expect((await f.commands()).filter(args => args[0] === "i")).toHaveLength(1);

    await f.release();
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0" });
    await other.start();
    expect(await finished(other)).toMatchObject({ phase: "succeeded", outcome: "current" });
  });

  it("keeps a started update running when its hook caller disconnects", async () => {
    const f = await installation({ gated: true });
    const updates = f.service();
    const sources = new CodexStateSources(f.dataDir, f.env);
    disposers.push(() => sources.dispose());
    const hooks = new HookRegistry();
    new CodexSettingsPlugin(new CodexSettingsService(sources), updates).hooks.forEach(hook => hooks.register(hook));
    const controller = new AbortController();
    const started = await hooks.call("codex-update.start", {}, { caller: { kind: "http" }, signal: controller.signal });
    await f.waitForInstall();
    controller.abort();
    expect(await hooks.call("codex-update.read", {}, { caller: { kind: "ui" } })).toMatchObject({ update: { jobId: (started.update as CodexUpdateStatus).jobId, phase: "updating" } });
    await f.release();
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", outcome: "updated" });
  });

  it("preserves existing Codex and terminal processes, authentication, settings, conversations, and workspace files", async () => {
    const f = await installation();
    const preserved = ["home/.codex/auth.json", "home/.codex/config.toml", "home/.codex/sessions/conversation.jsonl", "data/config.json", "workspace/unsaved.txt"];
    for (const file of preserved) {
      await fs.mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
      await fs.writeFile(path.join(f.root, file), `original bytes: ${file}`);
    }
    const ready = path.join(f.root, "codex-session.ready");
    const codex = spawn(f.executable, ["session"], { env: { ...f.env, CLOUDX_TEST_SESSION_READY: ready }, stdio: "ignore" });
    const terminal = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    disposers.push(() => stop(codex), () => stop(terminal));
    await vi.waitFor(async () => expect(await fs.readFile(ready, "utf8")).toBe(String(codex.pid)));
    const updates = f.service();
    await updates.start();
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0" });
    for (const child of [codex, terminal]) {
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    }
    for (const file of preserved) expect(await fs.readFile(path.join(f.root, file), "utf8")).toBe(`original bytes: ${file}`);
  });

  it("bounds private logs and keeps package output out of persisted public status", async () => {
    const f = await installation({ noisy: true, failure: "install" });
    const updates = f.service();
    await updates.start();
    expect((await finished(updates)).phase).toBe("failed");
    const privateDir = path.join(f.dataDir, "codex-update");
    const log = path.join(privateDir, "update.log");
    const status = path.join(privateDir, "status.json");
    expect((await fs.stat(privateDir)).mode & 0o777).toBe(0o700);
    for (const file of [log, status]) expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(log)).size).toBeGreaterThan(0);
    expect((await fs.stat(log)).size).toBeLessThanOrEqual(256 * 1024);
    expect(await fs.readFile(status, "utf8")).not.toContain("synthetic-private");
  });

  it.each([
    ["shutdown", false], ["deadline", false], ["shutdown", true], ["deadline", true],
  ] as const)("stops npm and releases the lock on %s (detached writer: %s)", async (reason, detachedWriter) => {
    const f = await installation({ gated: true, detachedWriter });
    const updates = f.service("data", reason === "deadline" ? { maxDurationMs: 1000 } : {});
    await updates.start();
    await f.waitForInstall();
    const pid = Number(await fs.readFile(f.npmPid, "utf8"));
    let writerPid: number | undefined;
    if (detachedWriter) {
      await vi.waitFor(async () => expect((await fs.readFile(f.writerLog, "utf8")).length).toBeGreaterThan(0));
      writerPid = Number(await fs.readFile(f.writerPid, "utf8"));
    }
    if (reason === "shutdown") await updates.dispose();
    else expect(await finished(updates)).toMatchObject({ phase: "failed", message: expect.stringMatching(/time|deadline/i) });
    expect(() => process.kill(pid, 0)).toThrow();
    if (writerPid !== undefined) expect(() => process.kill(writerPid, 0)).toThrow();
    f.env.CLOUDX_TEST_DETACHED_WRITER = "false";
    await f.release();
    const next = f.service("after-shutdown");
    await next.start();
    expect(await finished(next)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0" });
  });
});

describe("Codex update HTTP boundary", () => {
  it("requires a trusted browser origin, rejects arbitrary commands and paths, and exposes one uncached job through reconnects", async () => {
    const f = await installation({ gated: true });
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value);
    const config = loadConfig({ CLOUDX_DATA_DIR: f.dataDir, CLOUDX_ALLOWED_ROOTS: f.root, CLOUDX_LOG_LEVEL: "silent",
      CLOUDX_APP_SERVER_ENABLED: "false", CLOUDX_AUTOMATION_START_DISABLED: "true", CLOUDX_WEB_DIST_DIR: path.join(f.root, "web") });
    const services = buildServices(config);
    await services.pluginContributionsReady;
    const app = await buildServer(config, services);
    disposers.push(() => app.close());
    const headers = { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" };
    const request = { method: "POST" as const, url: "/api/hooks/codex-update.start", headers, payload: { input: {} } };
    for (const rejectedHeaders of [{ host: headers.host }, { ...headers, origin: "https://untrusted.example" }, { ...headers, host: "untrusted.example" }])
      expect((await app.inject({ ...request, headers: rejectedHeaders })).statusCode).toBe(403);
    for (const input of [{ command: "arbitrary command" }, { prefix: "/arbitrary/path" }, { executable: "/arbitrary/codex" }]) {
      const rejected = await app.inject({ ...request, payload: { input } });
      expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(await f.commands()).toEqual([]);
    const before = await app.inject({ ...request, url: "/api/hooks/codex-update.read" });
    expect(before.statusCode).toBe(200);
    expect(before.headers["cache-control"]).toBe("no-store");
    expect(before.json().result.update).toMatchObject({ installedVersion: "1.0.0", phase: "idle" });
    const starts = await Promise.all([app.inject(request), app.inject(request)]);
    starts.forEach(response => expect(response.statusCode, response.body).toBe(200));
    const jobId = starts[0]!.json().result.update.jobId;
    expect(starts[1]!.json().result.update.jobId).toBe(jobId);
    await f.waitForInstall();
    const reconnect = await app.inject({ ...request, url: "/api/hooks/codex-update.read" });
    expect(reconnect.json().result.update).toMatchObject({ jobId, phase: "updating" });
    await f.release();
    await vi.waitFor(async () => {
      const response = await app.inject({ ...request, url: "/api/hooks/codex-update.read" });
      expect(response.json().result.update).toMatchObject({ jobId, phase: "succeeded", installedVersion: "1.1.0" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }, { timeout: 10_000 });
    expect((await f.commands()).filter(args => args[0] === "i")).toHaveLength(1);
  });
});

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CodexUpdateStatus } from "@cloudx/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as codexUpdater from "../../../../scripts/codex-updater.mjs";
import { loadConfig } from "../config.js";
import { HookRegistry } from "../hooks/HookRegistry.js";
import { buildServer, buildServices } from "../server.js";
import { CodexSettingsPlugin } from "./CodexSettingsPlugin.js";
import { CodexSettingsService } from "./CodexSettingsService.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexUpdateService } from "./CodexUpdateService.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>() }));

const roots: string[] = [];
const disposers: Array<() => Promise<unknown>> = [];

beforeEach(() => {
  const spawn = childProcess.spawn;
  vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
    const verifier = Array.isArray(args) ? args.findIndex(argument => argument.endsWith("/codex-runtime-verification.mjs")) : -1;
    if (verifier < 0 || !Array.isArray(args)) return spawn(command, args as string[], options);
    const source = `
      if (process.env.CLOUDX_TEST_FAILURE === 'runtime' || process.env.CLOUDX_TEST_FAILURE === 'previous-runtime' && process.argv[2]) {
        console.error('synthetic-private-runtime-detail: selected conversation was not saved');
        process.exit(1);
      }
    `;
    return spawn(command, [...args.slice(0, verifier), "-e", source, "--", ...args.slice(verifier + 1)], options);
  });
});

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
  console.log(JSON.stringify({ versions: ["0.9.0", "1.0.0", "1.1.0", "1.2.0", "1.3.0-rc.1"], "dist-tags": { latest: process.env.CLOUDX_TEST_LATEST } }));
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
    fs.cpSync(process.env.CLOUDX_TEST_BASE_PACKAGE, directory, { recursive: true });
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', path.join(prefix, 'bin/codex'));
    const manifestPath = path.join(directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.version = args.at(-1).slice('@openai/codex@'.length);
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
    CLOUDX_TEST_BASE_PACKAGE: packageDir, CLOUDX_TEST_COMMAND_LOG: commandLog, CLOUDX_TEST_LATEST: options.current ? "1.0.0" : "1.1.0",
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
    expect((await commands()).filter(args => args[0] === "i")).toHaveLength(1);
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
  it("shows the active executable, prepares an exact release separately, and restores its selection and result", async () => {
    const f = await installation();
    f.env.CLOUDX_NPM_GLOBAL_DIR = path.join(f.root, "unused-prefix");
    const updates = f.service();
    expect(await updates.read()).toMatchObject({ phase: "idle", activeVersion: "1.0.0", installedVersion: null, outcome: null });
    expect(await f.commands()).toEqual([]);

    const started = await updates.start({ targetVersion: "latest" });
    expect(started.jobId).toEqual(expect.any(String));
    const result = await finished(updates);
    expect(result).toMatchObject({ jobId: started.jobId, phase: "succeeded", installedVersion: "1.1.0", outcome: "updated", finishedAt: expect.any(String) });
    expect(await f.commands()).toEqual([
      ["view", "@openai/codex", "versions", "dist-tags", "--json"],
      ["i", "-g", "--prefix", expect.stringContaining(path.join(f.prefix, ".cloudx-codex/installs")), "@openai/codex@1.1.0"],
    ]);
    await updates.dispose();
    expect(await f.service().read()).toEqual(result);
  });

  it("discovers stable and prerelease versions without selecting or installing a release", async () => {
    const f = await installation();
    const updates = f.service();
    const before = await updates.read();
    await expect(updates.releases()).resolves.toEqual({ latestStable: "1.1.0", versions: ["1.3.0-rc.1", "1.2.0", "1.1.0", "1.0.0", "0.9.0"] });
    expect(await updates.read()).toEqual(before);
    expect(await f.commands()).toEqual([["view", "@openai/codex", "versions", "dist-tags", "--json"]]);
    expect(codexUpdater.readCodexSelection({ assistantBin: f.executable, prefix: f.prefix })).toBeNull();
  });

  it("surfaces release discovery failure without replacing the active selection", async () => {
    const f = await installation({ failure: "network" });
    const updates = f.service();
    await expect(updates.releases()).rejects.toThrow(/network|registry|connect/i);
    expect(await updates.read()).toMatchObject({ activeVersion: "1.0.0", requestedVersion: null, installedVersion: null, phase: "idle" });
    expect((await f.commands()).filter(args => args[0] === "i")).toEqual([]);
  });

  it("freezes the exact target during installation and retains it across service restart", async () => {
    const f = await installation({ gated: true });
    const updates = f.service();
    await updates.start({ targetVersion: "1.2.0" });
    await f.waitForInstall();
    expect(await updates.read()).toMatchObject({ phase: "updating", requestedVersion: "1.2.0", installedVersion: null, activeVersion: "1.0.0" });
    expect((await f.commands()).find(args => args[0] === "i")?.at(-1)).toBe("@openai/codex@1.2.0");
    await f.release();
    const selected = await finished(updates);
    expect(selected).toMatchObject({ requestedVersion: "1.2.0", installedVersion: "1.2.0", activeVersion: "1.2.0", previousVerifiedVersion: null });
    expect(JSON.parse(await fs.readFile(path.join(f.packageDir, "package.json"), "utf8")).version).toBe("1.0.0");
    f.env.CLOUDX_TEST_LATEST = "1.3.0-rc.1";
    await updates.dispose();
    expect(await f.service().read()).toEqual(selected);
    expect((await f.commands()).filter(args => args[0] === "view")).toHaveLength(1);
  });

  it("observes another instance's active selection without waiting for the binary probe cache to expire", async () => {
    const f = await installation();
    const observer = f.service("observer");
    await observer.start({ targetVersion: "1.0.0" });
    expect(await finished(observer)).toMatchObject({ activeVersion: "1.0.0", outcome: "current" });
    const writer = f.service();
    await writer.start({ targetVersion: "1.2.0" });
    expect(await finished(writer)).toMatchObject({ activeVersion: "1.2.0" });
    expect(await observer.read()).toMatchObject({ activeVersion: "1.2.0", installedVersion: "1.0.0", message: expect.stringMatching(/last operation verified Codex 1.0.0.*1.2.0.*currently active/) });
  });

  it("rejects an executable version that differs from the verified selection after restart", async () => {
    const f = await installation();
    const updates = f.service();
    await updates.start({ targetVersion: "1.2.0" });
    expect(await finished(updates)).toMatchObject({ activeVersion: "1.2.0" });
    await updates.dispose();
    vi.spyOn(codexUpdater, "readCodexVersion").mockResolvedValue("9.9.9");
    expect(await f.service().read()).toMatchObject({ phase: "failed", activeVersion: null, installedVersion: "1.2.0", outcome: null, message: expect.stringMatching(/executable.*verification/) });
  });

  it("requires shared-state acknowledgement to return to the previously verified version", async () => {
    const f = await installation();
    const updates = f.service();
    await updates.start({ targetVersion: "1.0.0" });
    expect(await finished(updates)).toMatchObject({ outcome: "current", activeVersion: "1.0.0", previousVerifiedVersion: null });
    await updates.start({ targetVersion: "1.1.0" });
    expect(await finished(updates)).toMatchObject({ activeVersion: "1.1.0", previousVerifiedVersion: "1.0.0" });
    await updates.start({ targetVersion: "previous" });
    expect(await finished(updates)).toMatchObject({ phase: "failed", requestedVersion: "1.0.0", installedVersion: null, activeVersion: "1.1.0", previousVerifiedVersion: "1.0.0", message: expect.stringMatching(/shared conversations|shared.state/i) });
    await updates.start({ targetVersion: "previous", acknowledgeDowngrade: true });
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", requestedVersion: "1.0.0", installedVersion: "1.0.0", activeVersion: "1.0.0", previousVerifiedVersion: "1.1.0" });
  });

  it("persists explicit recovery results while keeping downgrade acknowledgement required", async () => {
    const f = await installation();
    const updates = f.service();
    await updates.start({ targetVersion: "1.0.0" });
    await finished(updates);
    await updates.start({ targetVersion: "1.1.0" });
    await finished(updates);
    await updates.dispose();
    f.env.CLOUDX_TEST_FAILURE = "previous-runtime";
    const recovery = f.service();
    await recovery.start({ targetVersion: "previous", acknowledgeDowngrade: true });
    expect(await finished(recovery)).toMatchObject({ phase: "failed", activeVersion: "1.1.0" });
    await recovery.start({ targetVersion: "previous", recoveryMode: true });
    expect(await finished(recovery)).toMatchObject({ phase: "failed", installedVersion: null, activeVersion: "1.1.0", message: expect.stringContaining("Confirm the downgrade") });
    await recovery.start({ targetVersion: "previous", acknowledgeDowngrade: true, recoveryMode: true });
    const completed = await finished(recovery);
    expect(completed).toMatchObject({ phase: "succeeded", requestedVersion: "1.0.0", installedVersion: "1.0.0", activeVersion: "1.0.0", previousVerifiedVersion: "1.1.0", message: expect.stringContaining("Cross-version shared-state compatibility was not checked") });
    await recovery.dispose();
    expect(await f.service().read()).toEqual(completed);
  });

  it("selects an explicitly requested prerelease and rejects an unpublished version before installing", async () => {
    const f = await installation();
    const updates = f.service();
    await updates.start({ targetVersion: "9.9.9" });
    expect(await finished(updates)).toMatchObject({ phase: "failed", requestedVersion: "9.9.9", activeVersion: "1.0.0", installedVersion: null, message: expect.stringMatching(/not published/) });
    expect((await f.commands()).filter(args => args[0] === "i")).toEqual([]);
    await updates.start({ targetVersion: "1.3.0-rc.1" });
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", requestedVersion: "1.3.0-rc.1", activeVersion: "1.3.0-rc.1" });
  });

  it.each(["^1.2.3", "@openai/codex@1.2.3", "https://example.com/codex", "./codex", "1.2.3; echo unsafe"])("rejects invalid direct requests before reading or installing %s", async targetVersion => {
    const f = await installation();
    await expect(f.service().start({ targetVersion })).rejects.toThrow(/Invalid Codex update request/);
    expect(await f.commands()).toEqual([]);
  });

  it("rejects an ambiguous PATH-only command without updating another configured prefix", async () => {
    const f = await installation();
    delete f.env.CLOUDX_ASSISTANT_BIN;
    f.env.CLOUDX_NPM_GLOBAL_DIR = path.join(f.root, "unused-prefix");
    f.env.PATH = `${f.tools}${path.delimiter}${path.join(f.prefix, "bin")}`;
    const updates = f.service();
    expect(await updates.read()).toMatchObject({ activeVersion: "1.0.0" });
    await updates.start({ targetVersion: "latest" });
    expect(await finished(updates)).toMatchObject({ phase: "failed", activeVersion: "1.0.0", installedVersion: null, outcome: null, message: expect.stringMatching(/absolute|configure/i) });
    expect(await f.commands()).toEqual([]);
    await expect(fs.stat(f.env.CLOUDX_NPM_GLOBAL_DIR)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports already current without reinstalling", async () => {
    const f = await installation({ current: true });
    const updates = f.service();
    await updates.start({ targetVersion: "latest" });
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", outcome: "current", installedVersion: "1.0.0" });
    expect(await f.commands()).toEqual([["view", "@openai/codex", "versions", "dist-tags", "--json"]]);
  });

  it.each([false, true])("retains the working active version after failed candidate verification across reads and restart (current: %s)", async current => {
    const f = await installation({ failure: "runtime", current });
    const updates = f.service();
    await updates.start({ targetVersion: "latest" });
    const failed = await finished(updates);
    expect(failed).toMatchObject({ phase: "failed", outcome: null, installedVersion: current ? "1.0.0" : "1.1.0", activeVersion: "1.0.0", message: expect.stringMatching(/CloudX tab launch.*private update log/) });
    expect(JSON.stringify(failed)).not.toContain("synthetic-private");
    expect(await fs.readFile(path.join(f.dataDir, "codex-update/update.log"), "utf8")).toContain("synthetic-private-runtime-detail");
    expect(await updates.read()).toEqual(failed);
    expect(await f.service().read()).toEqual(failed);
    f.env.CLOUDX_TEST_FAILURE = "network";
    const unavailableRegistry = f.service();
    await unavailableRegistry.start({ targetVersion: "latest" });
    expect(await finished(unavailableRegistry)).toMatchObject({ phase: "failed", outcome: null, installedVersion: null });
    f.env.CLOUDX_TEST_FAILURE = undefined;
    const retry = f.service();
    await retry.start({ targetVersion: "latest" });
    expect(await finished(retry)).toMatchObject({ phase: "succeeded", outcome: current ? "current" : "updated", installedVersion: current ? "1.0.0" : "1.1.0" });
  });

  it("upgrades the previous main status format without changing the selected installation", async () => {
    const f = await installation();
    const legacy = { jobId: "previous-main", phase: "succeeded", installedVersion: "1.0.0", outcome: "current",
      message: "Codex 1.0.0 is already current.", startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString() };
    const statusPath = path.join(f.dataDir, "codex-update/status.json");
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, JSON.stringify({ assistantBin: f.executable, verificationBlocked: false, update: legacy }));
    const updates = f.service();
    const upgraded = await updates.read();
    expect(upgraded).toMatchObject({ ...legacy, requestedVersion: "1.0.0", activeVersion: "1.0.0", previousVerifiedVersion: null });
    expect(JSON.parse(await fs.readFile(statusPath, "utf8")).update).toEqual(upgraded);
    expect(await f.commands()).toEqual([]);
    await updates.start({ targetVersion: "1.1.0" });
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", activeVersion: "1.1.0" });
  });

  it("keeps interrupted previous-main in-place verification blocked during the status upgrade", async () => {
    const f = await installation();
    const statusPath = path.join(f.dataDir, "codex-update/status.json");
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, JSON.stringify({ assistantBin: f.executable, verificationBlocked: false,
      update: { jobId: "old-interrupted", phase: "verifying", installedVersion: "1.0.0", outcome: null,
        message: "Verifying", startedAt: new Date(0).toISOString(), finishedAt: null } }));
    const readVersion = vi.spyOn(codexUpdater, "readCodexVersion");
    const updates = f.service();
    expect(await updates.read()).toMatchObject({ phase: "failed", activeVersion: null, installedVersion: null, message: expect.stringMatching(/in-place.*interrupted/) });
    expect(readVersion).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(statusPath, "utf8")).verificationBlocked).toBe(true);
    await updates.start({ targetVersion: "1.1.0" });
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", activeVersion: "1.1.0" });
  });

  it("marks a retained unfinished job interrupted after restart and checks the executable before displaying its version", async () => {
    const f = await installation();
    const updates = f.service();
    await updates.start({ targetVersion: "latest" });
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

  it("retains the active installation and reports interrupted candidate verification across restarts", async () => {
    const f = await installation({ current: true });
    const versionLog = path.join(f.root, "version-probes");
    f.env.CLOUDX_TEST_VERSION_LOG = versionLog;
    await fs.writeFile(versionLog, "");
    const statusPath = path.join(f.dataDir, "codex-update/status.json");
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, JSON.stringify({
      assistantBin: f.executable, verificationBlocked: false,
      update: { jobId: "interrupted-verification", phase: "verifying", requestedVersion: "1.0.0", installedVersion: "1.0.0", activeVersion: "1.0.0", previousVerifiedVersion: null, outcome: null,
        message: "Verifying Codex tab launch, conversation selection, and permissions…", startedAt: new Date(0).toISOString(), finishedAt: null },
    }));
    const updates = f.service();
    const interrupted = await updates.read();
    expect(interrupted).toMatchObject({ phase: "failed", outcome: null, installedVersion: "1.0.0", activeVersion: "1.0.0", message: expect.stringMatching(/interrupted.*active selection.*retained/i) });
    expect(await updates.read()).toEqual(interrupted);
    const restored = f.service();
    expect(await restored.read()).toEqual(interrupted);
    expect(await fs.readFile(versionLog, "utf8")).not.toBe("");
    expect(JSON.parse(await fs.readFile(statusPath, "utf8")).verificationBlocked).toBe(false);
    expect(await f.commands()).toEqual([]);

    await restored.start({ targetVersion: "latest" });
    expect(await finished(restored)).toMatchObject({ phase: "succeeded", outcome: "current", installedVersion: "1.0.0" });
    expect(vi.mocked(childProcess.spawn).mock.calls.some(([, args]) => Array.isArray(args) && args.some(argument => argument.endsWith("/codex-runtime-verification.mjs")))).toBe(true);
    expect(JSON.parse(await fs.readFile(statusPath, "utf8")).verificationBlocked).toBe(false);
  });

  it.each(["updated", "current"] as const)("keeps verification blocked after uncertain cleanup until an explicit update succeeds as %s", async outcome => {
    const f = await installation({ current: outcome === "current" });
    const versionLog = path.join(f.root, "version-probes");
    f.env.CLOUDX_TEST_VERSION_LOG = versionLog;
    await fs.writeFile(versionLog, "");
    const statusPath = path.join(f.dataDir, "codex-update/status.json");
    const lockPath = path.join(f.prefix, ".cloudx-codex-update.lock");
    const failure: CodexUpdateStatus = {
      jobId: "cleanup-incomplete-job", phase: "failed", requestedVersion: "latest", installedVersion: null, activeVersion: null, previousVerifiedVersion: null, outcome: null,
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

    await restored.start({ targetVersion: "latest" });
    expect(await finished(restored)).toMatchObject({ phase: "failed", installedVersion: null, outcome: null, message: expect.stringMatching(/another|lock/i) });
    expect(JSON.parse(await fs.readFile(statusPath, "utf8")).verificationBlocked).toBe(true);
    expect(await fs.readFile(lockPath, "utf8")).toBe(`${process.pid}\n`);
    expect(await fs.readFile(versionLog, "utf8")).toBe("");
    expect(await f.commands()).toEqual([]);

    await fs.rm(lockPath);
    await restored.start({ targetVersion: "latest" });
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
    if (operation === "update") await updates.start({ targetVersion: "latest" });
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

  it.each(["start", "first read"])("keeps cleanup blocked when %s initializes the service before concurrent update requests", async initiator => {
    const f = await installation();
    const updates = f.service();
    let rejectProbe!: (error: Error) => void;
    const readVersion = vi.spyOn(codexUpdater, "readCodexVersion").mockReturnValueOnce(new Promise((_, reject) => { rejectProbe = reject; }));
    let finishUpdate!: (result: Awaited<ReturnType<typeof codexUpdater.updateCodexInstallation>>) => void;
    const update = vi.spyOn(codexUpdater, "updateCodexInstallation").mockReturnValue(new Promise(resolve => { finishUpdate = resolve; }));
    const reading = initiator === "first read" ? updates.read() : undefined;
    const starts = Promise.all([updates.start({ targetVersion: "latest" }), updates.start({ targetVersion: "latest" }), updates.start({ targetVersion: "latest" })]);
    await vi.waitFor(() => expect(readVersion).toHaveBeenCalledTimes(1));
    const updatesDuringProbe = update.mock.calls.length;
    const failure = new codexUpdater.CodexUpdateError("cleanup-incomplete", "Codex subprocess cleanup could not be confirmed. Inspect remaining processes before continuing.");

    rejectProbe(failure);
    const requested = await starts;
    const failed = reading ? await reading : requested[0]!;
    finishUpdate({ installedVersion: "1.1.0", previousVersion: "1.0.0", activeVersion: "1.1.0", previousVerifiedVersion: null, outcome: "updated" });
    await updates.dispose();

    expect(updatesDuringProbe).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(failed).toMatchObject({ jobId: null, phase: "failed", outcome: null, installedVersion: null, message: failure.message });
    expect(requested).toEqual([failed, failed, failed]);
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, "codex-update/status.json"), "utf8"));
    expect(saved).toMatchObject({ verificationBlocked: true, update: failed });
    expect(await updates.read()).toEqual(failed);
    const restored = f.service();
    expect(await restored.read()).toEqual(failed);
    expect(await restored.read()).toEqual(failed);
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(await f.commands()).toEqual([]);

    update.mockRestore();
    await restored.start({ targetVersion: "latest" });
    expect(await finished(restored)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0", outcome: "updated" });
    expect(JSON.parse(await fs.readFile(path.join(f.dataDir, "codex-update/status.json"), "utf8")).verificationBlocked).toBe(false);
  });

  it("keeps cleanup blocked when an update was requested before an outstanding version probe failed", async () => {
    const f = await installation();
    const updates = f.service();
    const probe = await holdExpiredVersionProbe(updates);
    const failure = new codexUpdater.CodexUpdateError("cleanup-incomplete", "Codex subprocess cleanup could not be confirmed. Inspect remaining processes before continuing.");
    let finishUpdate!: (result: Awaited<ReturnType<typeof codexUpdater.updateCodexInstallation>>) => void;
    const update = vi.spyOn(codexUpdater, "updateCodexInstallation").mockReturnValue(new Promise(resolve => { finishUpdate = resolve; }));
    const starts = Promise.all([updates.start({ targetVersion: "latest" }), updates.start({ targetVersion: "latest" })]);
    await Promise.resolve();
    const updatesDuringProbe = update.mock.calls.length;

    probe.reject(failure);
    const failed = await probe.reading;
    const requested = await starts;
    finishUpdate({ installedVersion: "1.1.0", previousVersion: "1.0.0", activeVersion: "1.1.0", previousVerifiedVersion: null, outcome: "updated" });
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
    const starts = Promise.allSettled([updates.start({ targetVersion: "latest" }), updates.start({ targetVersion: "1.0.0" }), updates.start({ targetVersion: "1.2.0" })]);
    await Promise.resolve();
    const updatesDuringProbe = update.mock.calls.length;
    probe.resolve("1.0.0");
    const started = await starts;
    await probe.reading;
    await f.waitForInstall();
    await f.release();

    expect(updatesDuringProbe).toBe(0);
    expect(started.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(started.filter(result => result.status === "rejected")).toHaveLength(2);
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses a pending update when CloudX stops during the version probe", async () => {
    const f = await installation();
    const updates = f.service();
    const probe = await holdExpiredVersionProbe(updates);
    const update = vi.spyOn(codexUpdater, "updateCodexInstallation");
    const starting = updates.start({ targetVersion: "latest" });
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
    await expect(updates.start({ targetVersion: "latest" })).rejects.toThrow(/saved.*status.*read/i);
    await expect(updates.read()).rejects.not.toThrow(/synthetic-private/);
    expect(await fs.readFile(statusPath, "utf8")).toBe(content);
    expect(await f.commands()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("keeps saved-status permissions guidance across reads and service recreation without starting npm", async () => {
    const f = await installation();
    const statusPath = path.join(f.dataDir, "codex-update/status.json");
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, JSON.stringify({ assistantBin: "another-executable" }), { mode: 0o000 });
    await expect(fs.readFile(statusPath, "utf8")).rejects.toMatchObject({ code: "EACCES" });
    const updates = f.service();
    const guidance = "Saved Codex update status could not be read. Check the local codex-update/status.json file before updating.";
    await expect(updates.read()).rejects.toThrow(guidance);
    await expect(updates.read()).rejects.toThrow(guidance);
    await updates.dispose();
    const restored = f.service();
    await expect(restored.read()).rejects.toThrow(guidance);
    await expect(restored.start({ targetVersion: "latest" })).rejects.toThrow(guidance);
    expect(await f.commands()).toEqual([]);
  });

  it("rejects an unsavable start with permissions guidance and retains idle status without starting npm", async () => {
    const f = await installation();
    const updates = f.service();
    const idle = await updates.read();
    await fs.mkdir(f.dataDir, { recursive: true });
    const statusDirectory = path.join(f.dataDir, "codex-update");
    await fs.writeFile(statusDirectory, "blocked status storage");
    await expect(updates.start({ targetVersion: "latest" })).rejects.toThrow("Codex update status could not be saved. Check CloudX data directory permissions.");
    expect(await updates.read()).toEqual(idle);
    expect(await f.commands()).toEqual([]);
    await fs.unlink(statusDirectory);
    await updates.start({ targetVersion: "latest" });
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0" });
  });

  it.each([
    ["network", /network|registry|connect/i, null],
    ["permissions", /permission|writ|access/i, null],
    ["install", /install|npm/i, null],
    ["verification", /verif|executable/i, null],
  ] as const)("reports %s failure safely and keeps only a verified usable version", async (failure, message, installedVersion) => {
    const f = await installation({ failure });
    const updates = f.service();
    await updates.start({ targetVersion: "latest" });
    const result = await finished(updates);
    expect(result).toMatchObject({ phase: "failed", outcome: null, installedVersion, activeVersion: "1.0.0" });
    expect(result.message).toMatch(message);
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(await f.service().read()).toEqual(result);
  });

  it("reports unavailable npm while preserving the usable installed version", async () => {
    const f = await installation();
    await fs.rm(path.join(f.tools, "npm"));
    const updates = f.service();
    await updates.start({ targetVersion: "latest" });
    expect(await finished(updates)).toMatchObject({ phase: "failed", outcome: null, activeVersion: "1.0.0", installedVersion: null, message: expect.stringMatching(/npm/i) });
    expect(await f.commands()).toEqual([]);
  });

  it("reports rejected supervisor prerequisites and permits an explicit retry after the interpreter is repaired", async () => {
    const f = await installation();
    const interpreter = path.join(f.tools, "python3");
    const python = await fs.readlink(interpreter);
    await fs.unlink(interpreter);
    await fs.writeFile(interpreter, `#!${python}
import runpy, sys
sys.version_info = (3, 8, 20)
sys.argv = sys.argv[3:]
runpy.run_path(sys.argv[0], run_name='__main__')
`, { mode: 0o755 });
    const versionLog = path.join(f.root, "version-probes");
    f.env.CLOUDX_TEST_VERSION_LOG = versionLog;
    await fs.writeFile(versionLog, "");
    const updates = f.service();

    await updates.start({ targetVersion: "latest" });
    expect(await finished(updates)).toMatchObject({
      phase: "failed", outcome: null, installedVersion: null,
      message: expect.stringMatching(/Python 3\.9 or newer.*Repair these CloudX prerequisites/),
    });
    await expect(fs.stat(path.join(f.prefix, ".cloudx-codex-update.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.commands()).toEqual([]);
    expect(await fs.readFile(versionLog, "utf8")).toBe("");
    expect(JSON.parse(await fs.readFile(path.join(f.dataDir, "codex-update/status.json"), "utf8")).verificationBlocked).toBe(false);

    await fs.unlink(interpreter);
    await fs.symlink(python, interpreter);
    await updates.start({ targetVersion: "latest" });
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0", outcome: "updated" });
  });

  it("shows a custom wrapper's version but rejects updating it through npm", async () => {
    const f = await installation();
    const marker = path.join(f.root, "wrapper-executed");
    await fs.rm(f.executable);
    const wrapper = `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('codex-cli 1.0.0');\n`;
    await fs.writeFile(f.executable, wrapper, { mode: 0o755 });
    const updates = f.service();
    await updates.start({ targetVersion: "latest" });
    expect(await finished(updates)).toMatchObject({ phase: "failed", outcome: null, activeVersion: "1.0.0", installedVersion: null, message: expect.stringMatching(/wrapper|npm|supported/i) });
    expect((await fs.readFile(marker, "utf8")).trim().split("\n").every(line => line === '["--version"]')).toBe(true);
    expect(await fs.readFile(f.executable, "utf8")).toBe(wrapper);
    expect(await f.commands()).toEqual([]);
  });

  it("rejects concurrent requests without retargeting the operation and locks the installation across instances", async () => {
    const f = await installation({ gated: true });
    const updates = f.service();
    const started = await Promise.allSettled([updates.start({ targetVersion: "latest" }), updates.start({ targetVersion: "1.0.0" }), updates.start({ targetVersion: "1.2.0" })]);
    expect(started.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(started.filter(result => result.status === "rejected")).toHaveLength(2);
    await f.waitForInstall();
    const other = f.service("other-instance");
    await other.start({ targetVersion: "latest" });
    expect(await finished(other)).toMatchObject({ phase: "failed", outcome: null, message: expect.stringMatching(/another|progress|lock/i) });
    expect((await f.commands()).filter(args => args[0] === "i")).toHaveLength(1);

    await f.release();
    expect(await finished(updates)).toMatchObject({ phase: "succeeded", installedVersion: "1.1.0" });
    await other.start({ targetVersion: "latest" });
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
    const started = await hooks.call("codex-update.start", { targetVersion: "latest" }, { caller: { kind: "http" }, signal: controller.signal });
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
    await updates.start({ targetVersion: "latest" });
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
    await updates.start({ targetVersion: "latest" });
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
    await updates.start({ targetVersion: "latest" });
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
    await next.start({ targetVersion: "latest" });
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
    const request = { method: "POST" as const, url: "/api/hooks/codex-update.start", headers, payload: { input: { targetVersion: "latest" } } };
    for (const rejectedHeaders of [{ host: headers.host }, { ...headers, origin: "https://untrusted.example" }, { ...headers, host: "untrusted.example" }])
      expect((await app.inject({ ...request, headers: rejectedHeaders })).statusCode).toBe(403);
    for (const input of [{}, { targetVersion: "^1.2.3" }, { targetVersion: "https://example.com/package" }, { targetVersion: "1.2.3; echo unsafe" }, { targetVersion: "1.2.3", acknowledgeDowngrade: "true" }, { targetVersion: "1.2.3", command: "arbitrary command" }, { targetVersion: "1.2.3", prefix: "/arbitrary/path" }, { targetVersion: "1.2.3", executable: "/arbitrary/codex" }]) {
      const rejected = await app.inject({ ...request, payload: { input } });
      expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(await f.commands()).toEqual([]);
    const before = await app.inject({ ...request, url: "/api/hooks/codex-update.read", payload: { input: {} } });
    expect(before.statusCode).toBe(200);
    expect(before.headers["cache-control"]).toBe("no-store");
    expect(before.json().result.update).toMatchObject({ activeVersion: "1.0.0", installedVersion: null, phase: "idle" });
    const releases = await app.inject({ ...request, url: "/api/hooks/codex-update.releases", payload: { input: {} } });
    expect(releases.statusCode).toBe(200);
    expect(releases.headers["cache-control"]).toBe("no-store");
    expect(releases.json().result.releases).toMatchObject({ latestStable: "1.1.0", versions: expect.arrayContaining(["1.0.0", "1.3.0-rc.1"]) });
    const starts = await Promise.all([app.inject(request), app.inject(request)]);
    const accepted = starts.find(response => response.statusCode === 200)!;
    const rejected = starts.find(response => response.statusCode !== 200)!;
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().message).toMatch(/already running/);
    const jobId = accepted.json().result.update.jobId;
    await f.waitForInstall();
    const reconnect = await app.inject({ ...request, url: "/api/hooks/codex-update.read", payload: { input: {} } });
    expect(reconnect.json().result.update).toMatchObject({ jobId, phase: "updating" });
    await f.release();
    await vi.waitFor(async () => {
      const response = await app.inject({ ...request, url: "/api/hooks/codex-update.read", payload: { input: {} } });
      expect(response.json().result.update).toMatchObject({ jobId, phase: "succeeded", installedVersion: "1.1.0" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }, { timeout: 10_000 });
    expect((await f.commands()).filter(args => args[0] === "i")).toHaveLength(1);
  });
});

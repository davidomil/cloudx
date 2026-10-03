import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { ForgeExecutionRecovery } from "../apps/server/src/forge/ForgeExecution.ts";
import { renderCloudxService, renderEnvFile } from "./install-cloudx.mjs";
import { SERVICE_NAMES } from "./install-update.mjs";
import { COORDINATOR_FILES, stageInstalledUpdater } from "./update-coordinator.mjs";
import { bundleCoordinator, verifySnapshot, writeUpdateJson } from "./managed-update-store.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const frozenCoordinatorCommit = "5ec40091e0bbbaa412c3218d0fb936efa0021e63";
const forgeFile = `plugin-data/forge-${createHash("sha256").update("forge").digest("hex")}.json`;
const roots = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")("starts the first standard-install Settings update through the default built service and packaged updater without root overrides", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-settings-native-"));
  roots.push(home);
  const checkout = path.join(home, "checkout"), dataDir = path.join(home, "profile"), bin = path.join(home, "bin");
  const envPath = path.join(home, ".config/cloudx/cloudx.env"), systemdDir = path.join(home, ".config/systemd/user");
  fs.mkdirSync(checkout);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(sourceRoot, "node_modules"), path.join(home, "node_modules"));
  for (const relative of COORDINATOR_FILES) write(path.join(checkout, relative), fs.readFileSync(path.join(sourceRoot, relative)));
  write(path.join(checkout, "package.json"), { name: "native-settings-fixture", type: "module" });
  write(path.join(checkout, ".gitignore"), "apps/server/dist/\n");
  buildFixtureRelease(checkout);
  const bundledScript = path.join(checkout, "apps/server/dist/updater/scripts/settings-update.mjs");
  const installedScript = fs.readFileSync(bundledScript, "utf8");
  write(path.join(checkout, "scripts/settings-update.mjs"), "throw new Error('The unpackaged source updater must not run.');\n");
  git(checkout, "init", "-b", "main");
  git(checkout, "-c", "user.name=Native Settings fixture", "-c", "user.email=test@invalid", "add", ".");
  git(checkout, "-c", "user.name=Native Settings fixture", "-c", "user.email=test@invalid", "commit", "-m", "TEST: Native installation");
  const targetCommit = git(checkout, "rev-parse", "HEAD");

  const environment = renderEnvFile({ host: "127.0.0.1", port: 3001, dataDir, allowedRoots: checkout });
  expect(environment).not.toMatch(/CLOUDX_(?:INSTALL_ROOT|UPDATE_COORDINATOR_ROOT)=/);
  write(envPath, environment);
  for (const name of SERVICE_NAMES) write(path.join(systemdDir, name), "[Service]\n");
  const webUnit = renderCloudxService({ repoRoot: checkout, envPath, nodePath: process.execPath, npmPath: "/fixture/npm" });
  expect(webUnit).toContain("ExecStart=/fixture/npm run start -w @cloudx/server");
  write(path.join(systemdDir, "cloudx.service"), webUnit);

  const fixtureFile = path.join(home, "services.json"), launchFile = path.join(home, "launch.json");
  write(fixtureFile, { checkout, envPath, systemdDir, launchFile, names: SERVICE_NAMES });
  write(path.join(bin, "systemctl"), `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixtureFile)}, "utf8"));
const [, action, name] = process.argv.slice(2);
if (action !== "show") throw new Error("Only service inspection is allowed.");
const state = fixture.names.includes(name) ? {
  Id: name, LoadState: "loaded", ActiveState: "active", MainPID: String(process.ppid),
  WorkingDirectory: fixture.checkout, EnvironmentFiles: fixture.envPath + " (ignore_errors=no)",
  FragmentPath: path.join(fixture.systemdDir, name), NeedDaemonReload: "no", DropInPaths: "",
  ControlGroup: fs.readFileSync("/proc/self/cgroup", "utf8").trim().split(":")[2],
  InvocationID: "a".repeat(32), KillMode: "control-group", SendSIGKILL: "yes"
} : { LoadState: "not-found", ActiveState: "inactive", MainPID: "0" };
console.log(Object.entries(state).map(([key, value]) => key + "=" + value).join("\\n"));
`);
  write(path.join(bin, "systemd-run"), `#!${process.execPath}
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(launchFile)}, JSON.stringify(process.argv.slice(2)));
`);
  for (const name of ["systemctl", "systemd-run"]) fs.chmodSync(path.join(bin, name), 0o700);
  write(path.join(bin, "package.json"), { type: "module" });
  const runner = path.join(home, "settings-request.mjs");
  write(runner, `
import { CloudxUpdateService } from ${JSON.stringify(pathToFileURL(path.join(checkout, "apps/server/dist/system/CloudxUpdateService.js")).href)};
if (process.env.CLOUDX_INSTALL_ROOT !== undefined || process.env.CLOUDX_UPDATE_COORDINATOR_ROOT !== undefined)
  throw new Error("The native installation must start without root overrides.");
const targetCommit = ${JSON.stringify(targetCommit)};
const catalog = { preview: async (channel, currentCommit) => ({ channel, currentCommit, state: "available",
  checkedAt: "2026-10-03T00:00:00Z", target: { commit: targetCommit, name: "main", url: "https://github.com/davidomil/cloudx/commits/main" },
  changelog: [], changelogComplete: true }) };
const service = new CloudxUpdateService(${JSON.stringify(dataDir)}, undefined, catalog);
const status = await service.status();
await service.preview();
const started = await service.start({ channel: "main", targetCommit, confirmInterruption: true });
console.log(JSON.stringify({ status, started }));
`);
  const cgroupAdapter = path.join(home, "service-cgroup.mjs");
  write(cgroupAdapter, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const readFile = fs.readFileSync;
fs.readFileSync = (file, ...args) => /^\\/proc\\/(?:self|\\d+)\\/cgroup$/.test(String(file))
  ? "0::/cloudx-native-fixture\\n" : readFile(file, ...args);
syncBuiltinESMExports();
`);
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    NODE_OPTIONS: `--import=${pathToFileURL(cgroupAdapter).href}` };
  delete env.CLOUDX_INSTALL_ROOT;
  delete env.CLOUDX_UPDATE_COORDINATOR_ROOT;
  const result = JSON.parse(execFileSync(process.execPath, [runner], { cwd: checkout, env, encoding: "utf8", timeout: 30_000 }));
  expect(result.status).toEqual({ available: true });
  expect(result.started).toMatchObject({ available: true, run: { state: "running", targetCommit } });
  const record = JSON.parse(fs.readFileSync(path.join(home, ".local/state/cloudx/settings-update", `${result.started.run.id}.json`), "utf8"));
  expect(record.repoRoot).toBe(checkout);
  expect(record.cli).toBe(false);
  expect(record.service).toBeUndefined();
  expect(fs.readFileSync(path.join(record.coordinator, "scripts/settings-update.mjs"), "utf8")).toBe(installedScript);
  expect(JSON.parse(fs.readFileSync(path.join(record.coordinator, "bundle.json"), "utf8")))
    .toEqual(JSON.parse(fs.readFileSync(path.join(checkout, "apps/server/dist/updater/bundle.json"), "utf8")));
  expect(JSON.parse(fs.readFileSync(launchFile, "utf8"))).toContain(path.join(record.coordinator, "scripts/settings-update.mjs"));
}, 30_000);

it.skipIf(process.platform !== "linux")("renews the coordinator between real Settings starts while keeping completed-attempt guards, early diagnostics and capacity checks", async () => {
  const installation = await settingsInstallation();
  const first = await installation.start(installation.commits.fixed);
  const original = installation.record(first.run.id);
  expect(await installation.run(first.run.id)).toMatchObject({ state: "succeeded" });
  expect(installation.git("rev-parse", "HEAD")).toBe(installation.commits.fixed);

  const completed = await installation.retainCompletedWorker();
  const oldGuard = await import(pathToFileURL(path.join(original.coordinator, "scripts/terminal-upgrade-recovery.mjs")));
  expect(() => oldGuard.assertTerminalMigrationSafe({ dataDir: installation.dataDir }))
    .toThrow("missing or conflicting terminal ownership");
  const service = await installation.service();
  expect(await service.status()).toMatchObject({ available: true });
  expect((await service.status()).forgeBlocker).toBeUndefined();

  for (const fault of ["missing completion receipt", "contradictory supervisor receipt"]) {
    if (fault === "missing completion receipt") fs.unlinkSync(completed.file);
    else write(completed.file, { ...completed.receipt, started: "999" });
    const before = installation.launches.length;
    await service.preview();
    expect(await service.start({ channel: "main", targetCommit: installation.commits.next, confirmInterruption: true }))
      .toMatchObject({ forgeBlocker: { kind: "forge", workerId: completed.workerId, issueNumber: 128 } });
    expect(installation.launches).toHaveLength(before);
    write(completed.file, completed.receipt);
  }

  await service.preview();
  const second = await service.start({ channel: "main", targetCommit: installation.commits.next, confirmInterruption: true });
  expect(second).toMatchObject({ available: true, run: { state: "running", targetCommit: installation.commits.next } });
  expect(second.run.id).not.toBe(first.run.id);
  const renewed = installation.record(second.run.id);
  expect(renewed.coordinator).not.toBe(original.coordinator);
  expect(fs.readFileSync(path.join(renewed.coordinator, "scripts/terminal-upgrade-recovery.mjs"), "utf8"))
    .toBe(fs.readFileSync(path.join(installation.checkout, "scripts/terminal-upgrade-recovery.mjs"), "utf8"));
  expect(installation.requests.at(-1).script)
    .toBe(path.join(installation.installedRelease(), "apps/server/dist/updater/scripts/settings-update.mjs"));

  installation.capacityBytes = 0;
  installation.events.length = 0;
  expect(await installation.run(second.run.id)).toMatchObject({ state: "failed", phase: "prepare", component: "capacity", resumable: true });
  expect(installation.record(second.run.id).transition.capacity).toMatchObject({ stage: "build-staging" });
  expect(installation.events).toEqual([]);
  expect(installation.git("rev-parse", "HEAD")).toBe(installation.commits.fixed);

  installation.capacityBytes = 2 ** 40;
  expect(await service.start({ channel: "main", targetCommit: installation.commits.next, resumeRunId: second.run.id, confirmInterruption: true }))
    .toMatchObject({ run: { id: second.run.id, state: "running" } });
  expect(installation.record(second.run.id).coordinator).toBe(renewed.coordinator);
  expect(await installation.run(second.run.id)).toMatchObject({ state: "succeeded" });
  expect(installation.git("rev-parse", "HEAD")).toBe(installation.commits.next);
  expect(JSON.parse(fs.readFileSync(path.join(installation.dataDir, forgeFile), "utf8"))[0].completion.attemptId)
    .toBe(completed.attemptId);
  expect(() => verifySnapshot(original.coordinator, JSON.parse(fs.readFileSync(path.join(original.coordinator, "bundle.json"), "utf8"))))
    .not.toThrow();
}, 30_000);

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

function git(directory, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function settingsInstallation() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-updater-renewal-"));
  roots.push(home);
  const remote = path.join(home, "remote"), checkout = path.join(home, "checkout"), dataDir = path.join(home, "profile");
  const envPath = path.join(home, ".config/cloudx/cloudx.env"), systemdDir = path.join(home, ".config/systemd/user");
  fs.mkdirSync(remote);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(systemdDir, { recursive: true });
  fs.symlinkSync(path.join(sourceRoot, "node_modules"), path.join(home, "node_modules"));
  git(remote, "init", "-b", "main");
  git(remote, "config", "user.name", "Settings renewal fixture");
  git(remote, "config", "user.email", "test@invalid");
  for (const relative of COORDINATOR_FILES) write(path.join(remote, relative), fs.readFileSync(path.join(sourceRoot, relative)));
  const renewalFiles = ["apps/server/src/system/CloudxUpdateService.ts", "scripts/settings-update.mjs",
    "scripts/managed-update-integration.mjs", "scripts/managed-update.mjs", "scripts/install-cloudx.mjs", "scripts/codex-updater.mjs"];
  const maintainedSources = Object.fromEntries(renewalFiles.map(relative => [relative, fs.readFileSync(path.join(remote, relative))]));
  for (const relative of renewalFiles)
    write(path.join(remote, relative), git(sourceRoot, "show", `${frozenCoordinatorCommit}:${relative}`));
  write(path.join(remote, ".gitignore"), "apps/server/dist/\n");
  write(path.join(remote, "package.json"), { name: "updater-renewal-fixture", type: "module" });
  write(path.join(remote, "package-lock.json"), { lockfileVersion: 3 });
  const guardFile = path.join(remote, "scripts/terminal-upgrade-recovery.mjs");
  const fixedGuard = fs.readFileSync(guardFile, "utf8");
  expect(fixedGuard).toContain(" && !this.completedAttempt(worker, tab)");
  write(guardFile, fixedGuard.replace(" && !this.completedAttempt(worker, tab)", ""));
  const managedFile = path.join(remote, "scripts/managed-update.mjs");
  let oldManaged = fs.readFileSync(managedFile, "utf8");
  for (const stage of ["build-staging", "prepared", "before-stop"])
    oldManaged = oldManaged.replace(`    this.preflightCapacity(record, '${stage}');\n`, "");
  write(managedFile, oldManaged);
  const commit = version => {
    write(path.join(remote, "version"), version);
    git(remote, "add", ".");
    git(remote, "commit", "-m", `TEST: ${version} updater`);
    return git(remote, "rev-parse", "HEAD");
  };
  const old = commit("old");
  write(guardFile, fixedGuard);
  for (const [relative, source] of Object.entries(maintainedSources)) write(path.join(remote, relative), source);
  const fixed = commit("fixed"), next = commit("next");
  git(home, "clone", "--no-hardlinks", remote, checkout);
  git(checkout, "checkout", "--detach", old);
  buildFixtureRelease(checkout);
  write(envPath, `CLOUDX_DATA_DIR=${dataDir}\n`);
  const staleCoordinator = bundleCoordinator(checkout, path.join(home, "retained-coordinator"), COORDINATOR_FILES);
  vi.stubEnv("CLOUDX_INSTALL_ROOT", checkout);
  vi.stubEnv("CLOUDX_UPDATE_COORDINATOR_ROOT", staleCoordinator);

  const fixture = {
    home, checkout, dataDir, commits: { old, fixed, next }, requests: [], launches: [], events: [], capacityBytes: 2 ** 40,
    unit: { LoadState: "not-found", ActiveState: "inactive" },
    state: { Id: "renewal-fixture.service", LoadState: "loaded", ActiveState: "active", MainPID: "123",
      ControlGroup: "/cloudx-renewal-fixture", InvocationID: "a".repeat(32), KillMode: "control-group", SendSIGKILL: "yes",
      WorkingDirectory: checkout, EnvironmentFiles: `${envPath} (ignore_errors=no)`, FragmentPath: path.join(systemdDir, "renewal-fixture.service"),
      NeedDaemonReload: "no", DropInPaths: "" },
    git: (...args) => git(checkout, ...args),
    installedRelease: () => path.resolve(fs.realpathSync(path.join(checkout, "apps/server/dist")), "../../.."),
    record: id => JSON.parse(fs.readFileSync(path.join(home, ".local/state/cloudx/settings-update", `${id}.json`), "utf8")),
  };
  const commands = {
    inspect(command, args, options = {}) {
      if (command === "git") return git(options.cwd ?? checkout, ...args);
      if (command === "systemctl" && args[1] === "show") {
        const state = args[2] === "cloudx-settings-update.service" ? fixture.unit
          : args[2] === "renewal-fixture.service" ? fixture.state : { LoadState: "not-found", ActiveState: "inactive", MainPID: "0" };
        const fields = args.find(arg => arg.startsWith("--property="))?.slice(11).split(",");
        return Object.entries(state).filter(([key]) => !fields || fields.includes(key))
          .map(([key, value]) => `${key}=${value}`).join("\n");
      }
      if (command === "systemd-run") {
        fixture.launches.push(args);
        fixture.unit = { LoadState: "loaded", ActiveState: "active", ControlGroup: "/cloudx-renewal-update",
          Description: args.find(arg => arg.startsWith("--description=")).slice(14) };
        return "";
      }
      if (command === "curl") return JSON.stringify(fixture.receipt);
      throw new Error(`Unexpected fixture inspection: ${command} ${args.join(" ")}`);
    },
    run(command, args, options = {}) {
      if (command === "git") return git(options.cwd ?? checkout, ...args);
      if (command !== "systemctl") throw new Error(`Unexpected fixture command: ${command}`);
      fixture.events.push(args[1]);
      if (args[1] === "stop") Object.assign(fixture.state, { ActiveState: "inactive", MainPID: "0", ControlGroup: "" });
      if (args[1] === "start") {
        const group = fs.readFileSync(`/proc/${process.pid}/cgroup`, "utf8").trim().split(":")[2];
        Object.assign(fixture.state, { ActiveState: "active", MainPID: String(process.pid), ControlGroup: group, InvocationID: randomUUID().replaceAll("-", "") });
        const build = JSON.parse(fs.readFileSync(path.join(checkout, "apps/server/dist/runtime-build.json"), "utf8"));
        fixture.receipt = { verification: "verified", build, pid: process.pid, invocationId: fixture.state.InvocationID,
          bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
          processStarted: fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19] };
      }
    },
    capture(command) {
      if (command !== "curl") throw new Error(`Unexpected fixture capture: ${command}`);
      return "{}\n200";
    },
  };
  fixture.service = async (targetCommit = next) => {
    const root = fixture.installedRelease();
    const { CloudxUpdateService } = await import(pathToFileURL(path.join(root, "apps/server/dist/system/CloudxUpdateService.js")));
    const execute = async (file, args) => {
      if (file === "git") return { stdout: fixture.git(...args) };
      expect(file).toBe(process.execPath);
      fixture.requests.push({ script: args[0], action: args[1] });
      const { SettingsUpdater } = await import(pathToFileURL(args[0]));
      const updater = new SettingsUpdater({ repoRoot: checkout, home, dataDir, serverPid: process.pid, commands,
        service: "renewal-fixture.service", port: 3001, cli: true });
      const status = args[1] === "status" ? updater.status() : updater.start(args[4], { confirmInterruption: args.includes("--confirm-interruption"),
        resumeRunId: args.find(arg => arg.startsWith("--resume="))?.slice(9) });
      return { stdout: JSON.stringify(status) };
    };
    const catalog = { preview: async (_channel, currentCommit) => ({ channel: "main", state: "available", currentCommit,
      checkedAt: "2026-10-03T00:00:00Z", target: { commit: targetCommit, name: "main", url: "https://github.com/davidomil/cloudx/commits/main" },
      changelog: [], changelogComplete: true }) };
    return new CloudxUpdateService(dataDir, execute, catalog, { identity: { verification: "unverified", reason: "Isolated fixture" } });
  };
  fixture.start = async targetCommit => {
    const service = await fixture.service(targetCommit);
    await service.preview();
    return service.start({ channel: "main", targetCommit, confirmInterruption: true });
  };
  fixture.run = async id => {
    const record = fixture.record(id);
    const { ManagedUpdate, UpdateHost } = await import(pathToFileURL(path.join(record.coordinator, "scripts/managed-update.mjs")));
    const save = value => writeUpdateJson(path.join(home, ".local/state/cloudx/settings-update", `${id}.json`), value);
    const host = new UpdateHost({ repoRoot: checkout, home, dataDir, service: "renewal-fixture.service", port: 3001,
      runDir: path.dirname(record.coordinator), save, commands, prepareRelease: ({ releaseRoot }) => buildFixtureRelease(releaseRoot),
      inspectCapacity: destination => ({ device: "fixture", destination, mount: home, blockSize: 4096,
        availableBytes: fixture.capacityBytes, availableInodes: 1_000_000 }) });
    const run = await new ManagedUpdate({ record, save, host }).run();
    // Readiness verifies the real process cgroup; later requests inspect the simulated service.
    fixture.state.ControlGroup = "/cloudx-renewal-fixture";
    fixture.unit = { LoadState: "not-found", ActiveState: "inactive" };
    const { SettingsUpdater } = await import(pathToFileURL(path.join(record.coordinator, "scripts/settings-update.mjs")));
    new SettingsUpdater({ repoRoot: checkout, home }).publish(record);
    return run;
  };
  fixture.retainCompletedWorker = async () => {
    const execution = await new ForgeExecutionRecovery(dataDir).prepare();
    const workerId = "worker-128", attemptId = randomUUID();
    const turn = { workerId, attemptId, threadId: randomUUID(), turnId: randomUUID(), status: "completed" };
    write(path.join(dataDir, forgeFile), [{ id: workerId, kind: "issue", number: 128, status: "paused", tabId: "worker-tab", completion: { attemptId, turn } }]);
    write(path.join(dataDir, `forge-workers/workspaces/${workerId}.json`), { id: workerId, launchPending: false, gitPending: false, cleaned: false });
    write(path.join(dataDir, `forge-workers/turns/${workerId}/${attemptId}.json`), turn);
    write(path.join(dataDir, "forge-workers/tabs/worker-tab.json"), { tabId: "worker-tab", workerId, attemptId, closed: false, quiescent: true, execution });
    const ready = { executionId: execution.executionId, bootId: execution.bootId, pidNamespace: execution.pidNamespace, pid: process.pid, started: "123" };
    const file = path.join(execution.directory, "complete.json"), receipt = { ...ready, exitCode: 0 };
    write(path.join(execution.directory, "ready.json"), ready);
    write(file, receipt);
    return { workerId, attemptId, file, receipt };
  };
  return fixture;
}

function buildFixtureRelease(root) {
  for (const name of ["CloudxUpdateService", "CloudxUpdateCatalog", "RuntimeBuild"]) {
    const source = fs.readFileSync(path.join(root, `apps/server/src/system/${name}.ts`), "utf8");
    write(path.join(root, `apps/server/dist/system/${name}.js`), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText);
  }
  write(path.join(root, "apps/server/dist/index.js"), "export {};\n");
  write(path.join(root, "apps/server/dist/server.js"), "export const terminalReadiness = '/api/ready/terminals';\n");
  stageInstalledUpdater(root);
}

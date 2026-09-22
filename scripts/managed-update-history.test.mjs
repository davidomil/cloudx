import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { activateManagedServices, InstallerRunner } from "./install-cloudx.mjs";
import { parseEnvironmentFile } from "./installer-environment.mjs";
import { prepareManagedIntegration } from "./managed-update-integration.mjs";
import { SettingsUpdater } from "./settings-update.mjs";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const targets = [
  ["pinned base", "a9613fafdc0ed1765fcf72ea7d9f61de08c3914a", false],
  ["before terminal readiness endpoint", "26d8291b89309acb59fdea1cbe09234d41d0164f", true],
];
const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.skipIf(process.platform !== "linux").each(targets)("builds the actual %s target with retained managed Settings and real terminal readiness", async (_name, commit, independentReadiness) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-managed-history-")); temporary.push(root);
  const home = path.join(root, "home"), repoRoot = path.join(root, "installed"), releaseRoot = path.join(root, "release");
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, ["clone", "--shared", "--no-checkout", sourceRoot, repoRoot]);
  git(repoRoot, ["checkout", "--detach", commit]);
  git(root, ["clone", "--shared", repoRoot, releaseRoot]);
  const integration = prepareManagedIntegration(releaseRoot);
  expect(integration.independentReadiness).toBe(independentReadiness);
  expect(integration.files).toContain("apps/server/src/system/CloudxUpdateService.ts");
  expect(git(releaseRoot, ["rev-parse", "HEAD"])).toBe(commit);
  const execute = promisify(execFile);
  await execute("npm", ["ci", "--offline", "--no-audit", "--no-fund"], { cwd: releaseRoot, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  await execute("npm", ["run", "build"], { cwd: releaseRoot, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }).catch(error => {
    throw new Error(`Historical ${commit} build failed:\n${error.stdout}\n${error.stderr}`, { cause: error });
  });
  expect(fs.realpathSync(path.join(releaseRoot, "node_modules/@cloudx/shared"))).toBe(path.join(releaseRoot, "packages/shared"));

  const dataDir = path.join(repoRoot, ".cloudx"), envPath = path.join(home, ".config/cloudx/cloudx.env");
  fs.mkdirSync(dataDir); fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, "CLOUDX_PORT=3001\nPRIVATE_SETTING=preserved\n");
  fs.symlinkSync(path.join(releaseRoot, "apps/server/dist"), path.join(repoRoot, "apps/server/dist"));
  const completed = { repoRoot, dataDir, home, targetCommit: commit, run: { id: randomUUID(), targetCommit: commit,
    state: "succeeded", phase: "complete", startedAt: "2026-09-22T00:00:00Z", finishedAt: "2026-09-22T00:01:00Z", message: "Historical target verified." } };
  new SettingsUpdater({ repoRoot, home, dataDir }).stage(completed);
  activateManagedServices({ repoRoot, releaseRoot, home, envConfig: parseEnvironmentFile(fs.readFileSync(envPath, "utf8")),
    runner: new InstallerRunner({ cwd: repoRoot, log() {} }), runtimeLaunch: {
      script: path.join(completed.coordinator, "scripts/managed-runtime-launch.mjs"),
      buildFile: path.join(releaseRoot, "apps/server/dist/runtime-build.json"), receiptFile: path.join(root, "runtime.json"),
    } });
  const env = parseEnvironmentFile(fs.readFileSync(envPath, "utf8"));
  const fixturePath = path.join(root, "fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify({ root, home, repoRoot, releaseRoot, dataDir, envPath, completed,
    nextCommit: targets.find(([, target]) => target !== commit)[1] }));
  const script = path.join(root, "exercise.mjs");
  fs.writeFileSync(script, historicalRuntimeExercise());
  const result = await execute(process.execPath, [script, fixturePath], { cwd: repoRoot, env: { ...process.env, ...env }, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const proof = JSON.parse(result.stdout);
  expect(proof).toMatchObject({ readiness: { broker: "ready", direct: "ready" }, completedRun: completed.run.id,
    nextTarget: targets.find(([, target]) => target !== commit)[1], dataDir, nextState: "running", retainedShell: true, clearedReadinessReceipts: true });
  expect(proof.updateInvocations.every(call => call.script === path.join(completed.coordinator, "scripts/settings-update.mjs") && call.cwd === repoRoot)).toBe(true);
  expect(proof.updateInvocations.map(call => call.action)).toContain("start");
}, 240_000);

function historicalRuntimeExercise() {
  return `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const f = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const installed = relative => import(pathToFileURL(path.join(f.repoRoot, 'apps/server/dist', relative)));
const coordinator = relative => import(pathToFileURL(path.join(f.completed.coordinator, 'scripts', relative)));
const { loadConfig } = await installed('config.js');
const { TerminalBroker } = await installed('terminal/TerminalBroker.js');
const { DurableTerminalProcessFactory, terminalSocketPath } = await installed('terminal/DurableTerminalProcess.js');
const { NodePtyTerminalProcessFactory } = await installed('terminal/NodePtyTerminalProcess.js');
const { CloudxUpdateService } = await installed('system/CloudxUpdateService.js');
const { SettingsUpdater } = await coordinator('settings-update.mjs');
const { verifyHistoricalTerminals } = await coordinator('managed-update-readiness.mjs');
const config = loadConfig();
assert.equal(config.dataDir, f.dataDir);
const socket = terminalSocketPath(config.dataDir);
const broker = new TerminalBroker(socket, new NodePtyTerminalProcessFactory());
const factory = new DurableTerminalProcessFactory(socket, new NodePtyTerminalProcessFactory());
let shell;
try {
  await broker.start();
  shell = await factory.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.dataDir, env: process.env, cols: 100, rows: 24, sessionId: 'historical-preserved-shell' });
  const readiness = await verifyHistoricalTerminals(f.releaseRoot, f.dataDir);
  const attached = await factory.attach('historical-preserved-shell');
  attached.detach();
  assert.deepEqual(fs.readdirSync(f.dataDir).filter(name => name.startsWith('terminal-readiness-')), []);
  const launches = [];
  let unit = { LoadState: 'not-found', ActiveState: 'inactive' };
  const commands = { inspect(command, args, options) {
    if (command === 'git') return execFileSync(command, args, { cwd: options?.cwd ?? f.repoRoot, encoding: 'utf8' }).trim();
    if (command === 'systemctl') {
      const service = args[2];
      const state = service === 'cloudx-settings-update.service' ? unit : { Id: service, LoadState: 'loaded', WorkingDirectory: f.repoRoot,
        FragmentPath: path.join(f.home, '.config/systemd/user', service), EnvironmentFiles: f.envPath + ' (ignore_errors=no)', NeedDaemonReload: 'no', DropInPaths: '',
        ActiveState: 'active', MainPID: String(process.pid), ControlGroup: '/fixture/cloudx.service' };
      return Object.entries(state).map(([key, value]) => key + '=' + value).join('\\n');
    }
    if (command === 'systemd-run') {
      launches.push(args);
      unit = { LoadState: 'loaded', ActiveState: 'active', Description: args.find(arg => arg.startsWith('--description=')).slice(14), ControlGroup: '/fixture/update.service' };
      return '';
    }
    throw new Error('Unexpected host command ' + command);
  } };
  const updater = new SettingsUpdater({ home: f.home, dataDir: f.dataDir, serverPid: process.pid, commands,
    readCgroup: () => '0::/fixture/cloudx.service', runtimeInspector: () => ({ requiresInterruption: false, blockers: [], reasons: [], services: [], stopServices: [] }) });
  updater.publish(f.completed);
  const updateInvocations = [];
  const execute = async (file, args, options) => {
    assert.equal(options.cwd, f.repoRoot);
    if (file === 'git') return { stdout: commands.inspect(file, args, options) };
    assert.equal(file, process.execPath);
    assert.equal(args[0], path.join(f.completed.coordinator, 'scripts/settings-update.mjs'));
    assert.equal(args[2], f.dataDir);
    updateInvocations.push({ script: args[0], action: args[1], cwd: options.cwd });
    return { stdout: JSON.stringify(args[1] === 'status' ? updater.status() : updater.start(args[4])) };
  };
  const catalog = { preview: async (channel, currentCommit) => ({ channel, currentCommit, checkedAt: '2026-09-22T00:02:00Z', state: 'available',
    target: { commit: f.nextCommit, name: 'Next historical target', url: 'https://github.com/davidomil/cloudx/commit/' + f.nextCommit }, changelog: [], changelogComplete: true }) };
  const service = new CloudxUpdateService(f.dataDir, execute, catalog);
  const status = await service.status();
  assert.equal(status.available, true);
  assert.equal(status.run.id, f.completed.run.id);
  assert.equal(status.run.state, 'succeeded');
  await service.preview();
  const next = await service.start({ channel: 'main', targetCommit: f.nextCommit });
  assert.equal(launches.length, 1);
  assert.equal(next.run.state, 'running');
  const savedNext = updater.read(next.run.id);
  assert.equal(savedNext.repoRoot, f.repoRoot);
  assert.equal(savedNext.targetCommit, f.nextCommit);
  assert.notEqual(savedNext.coordinator, f.releaseRoot);
  assert.ok(launches[0].includes(path.join(savedNext.coordinator, 'scripts/settings-update.mjs')));
  console.log(JSON.stringify({ readiness, completedRun: status.run.id, nextState: next.run.state, nextTarget: savedNext.targetCommit,
    dataDir: config.dataDir, updateInvocations, retainedShell: true, clearedReadinessReceipts: true }));
} finally {
  if (shell) { await shell.terminate(); shell.detach(); }
  await broker.stop();
  fs.rmSync(path.dirname(socket), { recursive: true, force: true });
}
`;
}

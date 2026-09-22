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
import { writeRuntimeBuild } from "./write-runtime-build.mjs";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const targets = [
  ["pinned base", "a9613fafdc0ed1765fcf72ea7d9f61de08c3914a", false, true],
  ["before terminal readiness endpoint", "26d8291b89309acb59fdea1cbe09234d41d0164f", true, true],
  ["before Settings channel selection", "643ad8eb1c0ebe12cf4e112d72265fbe53814b65", true, true],
  ["before terminal execution bindings", "ad72433b2d6283811fad6bfe288748f2c24b0c5e", true, true],
  ["before persistent terminal brokers", "224a75ef7b3efced05b2c6b3b136250d9a532dc3", true, false],
];
const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.skipIf(process.platform !== "linux").each(targets)("builds the actual %s target with retained managed Settings and real terminal readiness", async (_name, commit, independentReadiness, persistentBroker) => {
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
  writeRuntimeBuild({ repoRoot: releaseRoot, commit });
  expect(fs.existsSync(path.join(releaseRoot, "apps/server/dist/terminal/broker.js"))).toBe(persistentBroker);
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
  fs.writeFileSync(fixturePath, JSON.stringify({ root, home, repoRoot, releaseRoot, dataDir, envPath, completed, persistentBroker,
    nextCommit: targets.find(([, target]) => target !== commit)[1] }));
  const script = path.join(root, "exercise.mjs");
  fs.writeFileSync(script, historicalRuntimeExercise());
  const result = await execute(process.execPath, [script, fixturePath], { cwd: repoRoot, env: { ...process.env, ...env }, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const proof = JSON.parse(result.stdout);
  expect(proof).toMatchObject({ readiness: { broker: persistentBroker ? "ready" : "not-applicable", direct: "ready" }, completedRun: completed.run.id,
    nextTarget: targets.find(([, target]) => target !== commit)[1], dataDir, nextState: "running", retainedShell: true, clearedReadinessReceipts: true, retiredSupervisors: persistentBroker ? 2 : 1,
    runtime: { verification: "verified", build: { commit } }, selectedChannel: "main" });
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
const { NodePtyTerminalProcessFactory } = await installed('terminal/NodePtyTerminalProcess.js');
const { CloudxUpdateService } = await installed('system/CloudxUpdateService.js');
const { CloudxUpdateCatalog } = await installed('system/CloudxUpdateCatalog.js');
const { registerCloudxUpdateRoutes } = await installed('system/CloudxUpdateRoutes.js');
const { default: Fastify } = await import(pathToFileURL(path.join(f.releaseRoot, 'node_modules/fastify/fastify.js')));
const { SettingsUpdater } = await coordinator('settings-update.mjs');
const { verifyHistoricalTerminals } = await coordinator('managed-update-readiness.mjs');
const config = loadConfig();
assert.equal(config.dataDir, f.dataDir);
let socket;
let broker;
let factory = new NodePtyTerminalProcessFactory();
if (f.persistentBroker) {
  const { TerminalBroker } = await installed('terminal/TerminalBroker.js');
  const { DurableTerminalProcessFactory, terminalSocketPath } = await installed('terminal/DurableTerminalProcess.js');
  socket = terminalSocketPath(config.dataDir);
  broker = new TerminalBroker(socket, factory);
  factory = new DurableTerminalProcessFactory(socket, factory);
}
const probes = [];
const spawn = NodePtyTerminalProcessFactory.prototype.spawn;
NodePtyTerminalProcessFactory.prototype.spawn = async function(command, args, options) {
  const terminal = await spawn.call(this, command, args, options);
  if (args.some(arg => arg.includes('CLOUDX_TERMINAL_READY:'))) {
    probes.push({ pid: terminal.process.pid, directory: terminal.supervisor.directory, sessionId: options.sessionId });
  }
  return terminal;
};
let shell;
let app;
try {
  if (broker) await broker.start();
  shell = await factory.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.dataDir, env: process.env, cols: 100, rows: 24,
    ...(f.persistentBroker ? { sessionId: 'historical-preserved-shell' } : {}) });
  const readiness = await verifyHistoricalTerminals(f.releaseRoot, f.dataDir);
  assert.equal(probes.length, f.persistentBroker ? 2 : 1);
  for (const probe of probes) {
    assert.throws(() => process.kill(probe.pid, 0), { code: 'ESRCH' });
    assert.equal(fs.existsSync(probe.directory), false);
    if (probe.sessionId) await assert.rejects(factory.attach(probe.sessionId));
  }
  if (f.persistentBroker) {
    const attached = await factory.attach('historical-preserved-shell');
    attached.detach();
  } else {
    assert.equal(process.kill(shell.process.pid, 0), true);
    assert.equal(fs.existsSync(shell.supervisor.directory), true);
  }
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
  const catalog = new CloudxUpdateCatalog(async url => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('/commits/main')) return Response.json({ sha: f.nextCommit });
    if (endpoint.includes('/compare/')) return Response.json({ status: 'ahead', total_commits: 1, commits: [{ sha: f.nextCommit }] });
    if (endpoint.endsWith('/pulls')) return Response.json([]);
    throw new Error('Unexpected catalog endpoint ' + endpoint);
  });
  const service = new CloudxUpdateService(f.dataDir, execute, catalog);
  app = Fastify();
  registerCloudxUpdateRoutes(app, service, ['http://localhost']);
  const request = async options => {
    const response = await app.inject({ ...options, headers: { origin: 'http://localhost' } });
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
    return response.json();
  };
  const runtime = await request({ url: '/api/runtime' });
  assert.equal(runtime.verification, 'verified');
  assert.equal(runtime.build.commit, f.completed.targetCommit);
  const status = await request({ url: '/api/system/update' });
  assert.equal(status.available, true);
  assert.equal(status.run.id, f.completed.run.id);
  assert.equal(status.run.state, 'succeeded');
  assert.equal((await request({ url: '/api/system/update/preview' })).target.commit, f.nextCommit);
  const selected = await request({ method: 'PUT', url: '/api/system/update/preview', payload: { channel: 'main' } });
  const next = await request({ method: 'POST', url: '/api/system/update', payload: { channel: selected.channel, targetCommit: selected.target.commit } });
  assert.equal(launches.length, 1);
  assert.equal(next.run.state, 'running');
  const savedNext = updater.read(next.run.id);
  assert.equal(savedNext.repoRoot, f.repoRoot);
  assert.equal(savedNext.targetCommit, f.nextCommit);
  assert.notEqual(savedNext.coordinator, f.releaseRoot);
  assert.ok(launches[0].includes(path.join(savedNext.coordinator, 'scripts/settings-update.mjs')));
  console.log(JSON.stringify({ readiness, completedRun: status.run.id, nextState: next.run.state, nextTarget: savedNext.targetCommit,
    dataDir: config.dataDir, updateInvocations, retainedShell: true, clearedReadinessReceipts: true, retiredSupervisors: probes.length, runtime, selectedChannel: selected.channel }));
} finally {
  if (app) await app.close();
  if (shell) { await shell.terminate(); shell.detach?.(); }
  if (broker) await broker.stop();
  if (socket) fs.rmSync(path.dirname(socket), { recursive: true, force: true });
}
`;
}

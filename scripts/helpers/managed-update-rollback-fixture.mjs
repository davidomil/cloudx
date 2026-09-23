import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { ManagedUpdate, UpdateHost } from '../managed-update.mjs';
import { SERVICE_NAMES } from '../install-update.mjs';
import { writeUpdateJson } from '../managed-update-store.mjs';

export const BROKER = 'cloudx-terminal.service';
export const FORGE_STATE = `plugin-data/forge-${createHash('sha256').update('forge').digest('hex')}.json`;
const homes = [];
export function cleanupUpdates() { vi.restoreAllMocks(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); }

export function git(root, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }

export function updateFixture({ originalBroker = 'inactive', preserveBroker = false, originalWeb = 'inactive', activate = true } = {}) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-rollback-')); homes.push(home);
  const root = path.join(home, 'checkout'), dataDir = path.join(home, 'profile');
  const id = randomUUID(), runDir = path.join(home, '.local/state/cloudx/settings-update', id), release = path.join(runDir, 'release');
  fs.mkdirSync(root); fs.mkdirSync(dataDir); fs.mkdirSync(runDir, { recursive: true });
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 'fixture@local'); git(root, 'config', 'user.name', 'Fixture');
  write(path.join(root, 'version.txt'), 'previous'); git(root, 'add', '.'); git(root, 'commit', '-m', 'TEST: previous');
  const sourceCommit = git(root, 'rev-parse', 'HEAD'), sourceIndex = git(root, 'write-tree');
  write(path.join(root, 'version.txt'), 'target'); git(root, 'commit', '-am', 'TEST: target');
  const targetCommit = git(root, 'rev-parse', 'HEAD'); git(home, 'clone', root, release); git(root, 'reset', '--hard', sourceCommit);
  write(path.join(root, 'apps/server/dist/index.js'), 'previous runtime');
  write(path.join(release, 'apps/server/dist/index.js'), 'target runtime');
  const envPath = path.join(home, '.config/cloudx/cloudx.env'), systemdDir = path.join(home, '.config/systemd/user');
  write(envPath, `CLOUDX_DATA_DIR=${dataDir}\n`);
  for (const name of SERVICE_NAMES) if (name !== BROKER || originalBroker !== 'missing') write(path.join(systemdDir, name), 'previous unit');
  const states = Object.fromEntries(SERVICE_NAMES.map(name => [name, {
    LoadState: name === BROKER && originalBroker === 'missing' ? 'not-found' : 'loaded',
    ActiveState: 'inactive', MainPID: '0', InvocationID: '', ControlGroup: '', KillMode: 'control-group', SendSIGKILL: 'yes', WorkingDirectory: root,
  }]));
  if (originalBroker === 'active') Object.assign(states[BROKER], { ActiveState: 'active', MainPID: '100', InvocationID: 'a'.repeat(32) });
  if (originalWeb === 'active') Object.assign(states['cloudx.service'], { ActiveState: 'active', MainPID: '101', InvocationID: 'c'.repeat(32) });
  const originalStates = structuredClone(states), events = [];
  const show = service => Object.entries(states[service]).map(([key, value]) => `${key}=${value}`).join('\n');
  const activateService = service => {
    if (states[service].ActiveState !== 'active') Object.assign(states[service], { LoadState: 'loaded', ActiveState: 'active', MainPID: '200', InvocationID: randomUUID().replaceAll('-', '') });
  };
  const commands = {
    inspect(command, args, options = {}) {
      if (command === 'git') return git(options.cwd ?? root, ...args);
      if (command === 'systemctl' && args[1] === 'show') return show(args[2]);
      throw new Error(`Unexpected inspection: ${command} ${args.join(' ')}`);
    },
    capture(command, args) {
      if (command !== 'curl') throw new Error(`Unexpected capture: ${command}`);
      if (args.at(-1).endsWith('/api/ready')) throw Object.assign(new Error('Target readiness failed permanently'), { status: 22, stdout: '{"code":"terminal_supervision_failed"}\n503' });
      return '{}\n200';
    },
    run(command, args) {
      if (command !== 'systemctl') throw new Error(`Unexpected run: ${command}`);
      const [, action, service] = args; events.push({ action, service, version: fs.readFileSync(path.join(root, 'version.txt'), 'utf8') });
      if (action === 'start') {
        activateService(service);
        if (service === 'cloudx.service') activateService(BROKER);
        commands.afterStart?.(service);
      }
      if (action === 'stop') {
        commands.beforeStop?.(service);
        Object.assign(states[service], { ActiveState: 'inactive', MainPID: '0', InvocationID: '', ControlGroup: '' });
      }
    },
    mkdir(directory) { fs.mkdirSync(directory, { recursive: true }); },
    logVerboseProcessResult() {},
    which(command) { return `/usr/bin/${command}`; },
    writeFile: write,
  };
  const record = { home, repoRoot: root, dataDir, targetCommit, coordinator: path.join(runDir, 'coordinator'),
    run: { id, state: 'running', phase: 'start', targetCommit }, transition: {
      completed: activate ? ['prepare', 'quiesce', 'snapshot', 'activate'] : ['prepare'], mutating: activate,
      sourceCommit, sourceIndex, release, environment: { CLOUDX_DATA_DIR: dataDir },
      serviceTarget: { kind: 'standard', serviceNames: [...SERVICE_NAMES] },
      serviceStates: Object.fromEntries(SERVICE_NAMES.map(service => [service, show(service)])),
      runtimePlan: { services: [{ role: 'broker', service: BROKER, state: originalStates[BROKER] }], stopServices: originalBroker === 'active' && !preserveBroker ? [BROKER] : [] },
      artifacts: ['apps/server/dist'], buildManifests: {},
    } };
  if (originalBroker === 'active' && !preserveBroker) Object.assign(states[BROKER], { ActiveState: 'inactive', MainPID: '0', InvocationID: '' });
  const recordPath = `${runDir}.json`, save = value => writeUpdateJson(recordPath, value);
  const host = Object.assign(Object.create(UpdateHost.prototype), {
    home, runDir, save, runner: commands, paths: { repoRoot: root, dataDir, envPath, systemdDir },
    target: record.transition.serviceTarget, envConfig: record.transition.environment,
  });
  const draft = [{ id: 'review', status: 'awaiting_review', draft: { status: 'draft', body: 'review result' } }];
  const forgeFile = path.join(dataDir, FORGE_STATE);
  write(forgeFile, JSON.stringify(draft));
  record.transition.targetFiles = host.captureCheckout(sourceCommit, targetCommit, release);
  if (activate) { host.snapshot(record); host.activate(record); }
  const publish = () => write(forgeFile, JSON.stringify([{ ...draft[0], status: 'completed', publicationState: 'posted', publicationId: 'published-review-42', draft: { ...draft[0].draft, status: 'posted' } }]));
  return { host, record, recordPath, save, root, dataDir, forgeFile, publish, states, events, commands, originalStates };
}

export function runPreparedUpdate(fixture) {
  vi.spyOn(fixture.host, 'quiesce').mockImplementation(record => { record.transition.mutating = true; });
  return new ManagedUpdate({ record: fixture.record, save: fixture.save, host: fixture.host }).run();
}

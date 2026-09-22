import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedUpdate, UpdateHost, validateSavedTransition } from './managed-update.mjs';
import { writeUpdateJson } from './managed-update-store.mjs';

const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const serviceFile = 'apps/server/src/system/CloudxUpdateService.ts';
const historicalCommit = 'a9613fafdc0ed1765fcf72ea7d9f61de08c3914a';
const temporary = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of temporary.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

function git(root, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }

function historicalDowngrade() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-checkout-rollback-')); temporary.push(home);
  const origin = path.join(home, 'origin'), root = path.join(home, 'installed'), dataDir = path.join(home, 'profile');
  fs.mkdirSync(origin); fs.mkdirSync(dataDir);
  git(origin, 'init', '-b', 'main'); git(origin, 'config', 'user.name', 'Fixture'); git(origin, 'config', 'user.email', 'fixture@local');
  const historicalSource = execFileSync('git', ['show', `${historicalCommit}:${serviceFile}`], { cwd: sourceRoot, encoding: 'utf8' });
  const currentSource = fs.readFileSync(path.join(sourceRoot, serviceFile), 'utf8');
  for (const [relative, content] of Object.entries({
    '.gitignore': 'node_modules/\n**/dist/\n', 'package.json': '{"type":"module"}', 'package-lock.json': '{"lockfileVersion":3}',
    'local.txt': 'unchanged tracked file\n',
    [serviceFile]: historicalSource,
    'apps/server/src/server.ts': 'updates?: Pick<CloudxUpdateService, "status" | "start" | "preview" | "selectChannel">; // /api/ready/terminals\n',
    'apps/web/src/ui/fixture.txt': 'historical Settings files are supplied by the managed integration\n',
    'apps/server/src/workspace/SessionStateStore.ts': 'if (value.version !== 1) throw new Error();',
    'services/documentation-indexer/src/cloudx_documentation_indexer/catalog_schema.py': 'SCHEMA_VERSION = 2\n',
  })) write(path.join(origin, relative), content);
  git(origin, 'add', '.'); git(origin, 'commit', '-m', 'TEST: historical target');
  const targetCommit = git(origin, 'rev-parse', 'HEAD');
  write(path.join(origin, serviceFile), currentSource); git(origin, 'commit', '-am', 'TEST: installed source');
  git(home, 'clone', origin, root);
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  write(path.join(root, 'apps/server/dist/index.js'), 'previous generated runtime');
  write(path.join(root, 'node_modules/dependency/index.js'), 'previous dependency');
  write(path.join(root, 'local.txt'), 'retained staged edit\n'); git(root, 'add', 'local.txt');
  write(path.join(root, 'notes.txt'), 'retained untracked note\n');
  write(path.join(dataDir, 'workspace.json'), '{"windows":[]}');
  const originalIndex = git(root, 'write-tree');
  const envPath = path.join(home, '.config/cloudx/cloudx.env');
  const originalEnvironment = `CLOUDX_DATA_DIR=${dataDir}\nPRIVATE_SETTING=retained\n`;
  write(envPath, originalEnvironment);
  for (const name of ['cloudx-asr.service', 'cloudx-documentation.service', 'cloudx.service', 'cloudx-terminal.service'])
    write(path.join(home, '.config/systemd/user', name), 'original unit');
  const id = randomUUID(), runDir = path.join(home, '.local/state/cloudx/settings-update', id), recordPath = `${runDir}.json`;
  fs.mkdirSync(runDir, { recursive: true });
  const events = [], states = {};
  const state = name => states[name] ??= { LoadState: 'loaded', ActiveState: 'inactive', MainPID: '0', InvocationID: '', ControlGroup: '',
    KillMode: 'control-group', SendSIGKILL: 'yes', WorkingDirectory: root, Id: name, NeedDaemonReload: 'no', DropInPaths: '',
    EnvironmentFiles: `${envPath} (ignore_errors=no)`, FragmentPath: path.join(home, '.config/systemd/user', name) };
  const commands = {
    inspect(command, args, options = {}) {
      if (command === 'git') return git(options.cwd ?? root, ...args);
      if (command === 'systemctl') return Object.entries(state(args[2])).map(([key, value]) => `${key}=${value}`).join('\n');
      throw new Error(`Unexpected inspection: ${command}`);
    },
    capture(command, args) {
      if (command !== 'curl') throw new Error(`Unexpected capture: ${command}`);
      if (args.at(-1).endsWith('/api/ready')) throw Object.assign(new Error('Historical target failed readiness'), {
        status: 22, stdout: '{"code":"terminal_supervision_failed"}\n503',
      });
      return '{}\n200';
    },
    run(command, args, options = {}) {
      if (command === 'git') return git(options.cwd ?? root, ...args);
      if (command !== 'systemctl') throw new Error(`Unexpected run: ${command}`);
      const [, action, service] = args; events.push({ action, service, commit: git(root, 'rev-parse', 'HEAD') });
      if (action === 'start') Object.assign(state(service), { ActiveState: 'active', MainPID: '123', InvocationID: randomUUID().replaceAll('-', '') });
      if (action === 'stop') Object.assign(state(service), { ActiveState: 'inactive', MainPID: '0', InvocationID: '' });
    },
    mkdir(directory) { fs.mkdirSync(directory, { recursive: true }); },
    writeFile: write,
    which(command) { return `/usr/bin/${command}`; },
    logVerboseProcessResult() {},
  };
  const prepareRelease = ({ releaseRoot }) => {
    write(path.join(releaseRoot, 'apps/server/dist/index.js'), 'historical prepared runtime');
    write(path.join(releaseRoot, 'apps/server/dist/server.js'), '// /api/ready/terminals\n');
    write(path.join(releaseRoot, 'node_modules/dependency/index.js'), 'historical prepared dependency');
  };
  const record = { repoRoot: root, dataDir, home, targetCommit, coordinator: sourceRoot, confirmInterruption: true,
    run: { id, state: 'running', targetCommit }, transition: { completed: [] } };
  const save = value => writeUpdateJson(recordPath, value);
  const newHost = record => new UpdateHost({ repoRoot: root, dataDir, home, runDir, commands, prepareRelease, save, recovery: record.transition });
  return { root, dataDir, envPath, originalEnvironment, historicalSource, currentSource, sourceCommit, originalIndex, record, recordPath, save, newHost, events, runDir };
}

function expectPreviousInstallation(f) {
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.sourceCommit);
  expect(git(f.root, 'write-tree')).toBe(f.originalIndex);
  expect(fs.readFileSync(path.join(f.root, serviceFile), 'utf8')).toBe(f.currentSource);
  expect(fs.lstatSync(path.join(f.root, 'apps/server/dist')).isDirectory()).toBe(true);
  expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toBe('previous generated runtime');
  expect(fs.readFileSync(path.join(f.root, 'node_modules/dependency/index.js'), 'utf8')).toBe('previous dependency');
  expect(fs.readFileSync(path.join(f.root, 'local.txt'), 'utf8')).toBe('retained staged edit\n');
  expect(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8')).toBe('retained untracked note\n');
  expect(fs.readFileSync(f.envPath, 'utf8')).toBe(f.originalEnvironment);
}

describe('historical checkout recovery', () => {
  it('rolls back failed historical readiness and resumes with coherent source, artifacts, configuration and local work', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = historicalDowngrade();
    const result = await new ManagedUpdate({ record: f.record, save: f.save, host: f.newHost(f.record) }).run();
    expect(result).toMatchObject({ state: 'failed', phase: 'verify', resumable: true, message: 'Update stopped; the previous installation is retained.' });
    expectPreviousInstallation(f);
    expect(f.record.transition.integration.files).toContain(serviceFile);
    expect(Buffer.from(f.record.transition.targetFiles.find(file => file.relative === serviceFile).content, 'base64').toString()).toBe(f.historicalSource);
    expect(fs.readFileSync(path.join(f.record.transition.release, serviceFile), 'utf8')).toBe(f.currentSource);
    const resumed = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(() => validateSavedTransition(resumed, f.runDir)).not.toThrow();
    const retry = await new ManagedUpdate({ record: resumed, save: f.save, host: f.newHost(resumed) }).run();
    expect(retry).toMatchObject({ state: 'failed', phase: 'verify', message: 'Update stopped; the previous installation is retained.' });
    expectPreviousInstallation(f);
    expect(f.events.filter(event => event.action === 'start' && event.service === 'cloudx.service' && event.commit === f.record.targetCommit)).toHaveLength(2);
  });

  it('retains a new edit to the activated target until the operator resolves the checkout conflict', () => {
    const f = historicalDowngrade(), host = f.newHost(f.record);
    host.prepare(f.record); host.quiesce(f.record); host.snapshot(f.record); host.activate(f.record);
    const edit = `${f.historicalSource}\n// new operator edit after activation\n`;
    write(path.join(f.root, serviceFile), edit);
    expect(() => host.restore(f.record)).toThrow(/Checkout recovery conflict/);
    expect(fs.lstatSync(path.join(f.root, 'apps/server/dist')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toBe('historical prepared runtime');
    expect(fs.readFileSync(path.join(f.root, serviceFile), 'utf8')).toBe(edit);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.targetCommit);
    write(path.join(f.root, 'saved-operator-edit.ts'), edit);
    write(path.join(f.root, serviceFile), f.historicalSource);
    const resumed = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    f.newHost(resumed).restore(resumed);
    expectPreviousInstallation(f);
    expect(fs.readFileSync(path.join(f.root, 'saved-operator-edit.ts'), 'utf8')).toBe(edit);
  });

  it.each(['permissions', 'directory', 'symbolic link'])('preserves an operator change to the activated file %s', kind => {
    const f = historicalDowngrade(), host = f.newHost(f.record);
    host.prepare(f.record); host.quiesce(f.record); host.snapshot(f.record); host.activate(f.record);
    const file = path.join(f.root, serviceFile);
    if (kind === 'permissions') fs.chmodSync(file, 0o700);
    else {
      fs.unlinkSync(file);
      if (kind === 'directory') fs.mkdirSync(file);
      else fs.symlinkSync('/operator/source', file);
    }
    expect(() => host.restore(f.record)).toThrow(/Checkout recovery conflict/);
    expect(fs.lstatSync(path.join(f.root, 'apps/server/dist')).isSymbolicLink()).toBe(true);
    if (kind === 'permissions') expect(fs.statSync(file).mode & 0o777).toBe(0o700);
    else if (kind === 'directory') expect(fs.lstatSync(file).isDirectory()).toBe(true);
    else expect(fs.readlinkSync(file)).toBe('/operator/source');
  });

  it('rejects missing checkout evidence before changing the activated runtime or profile', () => {
    const f = historicalDowngrade(), host = f.newHost(f.record);
    host.prepare(f.record); host.quiesce(f.record); host.snapshot(f.record); host.activate(f.record);
    delete f.record.transition.targetFiles;
    write(path.join(f.dataDir, 'target-state.json'), '{"retained":true}');
    expect(() => host.restore(f.record)).toThrow('saved expected checkout is incomplete');
    expect(fs.lstatSync(path.join(f.root, 'apps/server/dist')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(f.dataDir, 'target-state.json'), 'utf8')).toBe('{"retained":true}');
  });

  it.each(['traversal', 'duplicate path', 'missing content', 'missing mode', 'different paths'])('rejects malformed saved target checkout evidence: %s', kind => {
    const f = historicalDowngrade(), host = f.newHost(f.record);
    host.prepare(f.record);
    const t = f.record.transition;
    if (kind === 'traversal') t.targetFiles[0].relative = '../external';
    if (kind === 'duplicate path') t.targetFiles.push({ ...t.targetFiles[0] });
    if (kind === 'missing content') delete t.targetFiles[0].content;
    if (kind === 'missing mode') delete t.targetFiles[0].mode;
    if (kind === 'different paths') t.sourceFiles = [{ ...t.targetFiles[0], relative: 'other-file' }];
    expect(() => validateSavedTransition(f.record, f.runDir)).toThrow(/checkout recovery paths?/);
  });
});

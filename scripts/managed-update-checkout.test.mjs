import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedUpdate, UpdateHost, validateSavedTransition } from './managed-update.mjs';
import { writeUpdateJson } from './managed-update-store.mjs';

const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const serviceFile = 'apps/server/src/system/CloudxUpdateService.ts';
const historicalCommit = 'a9613fafdc0ed1765fcf72ea7d9f61de08c3914a';
const temporary = [];
beforeEach(() => { for (const method of ['log', 'warn', 'error']) vi.spyOn(console, method).mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); for (const home of temporary.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

function git(root, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }

function historicalDowngrade({ originalWeb = 'inactive', directoryBoundary = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-checkout-rollback-')); temporary.push(home);
  const origin = path.join(home, 'origin'), root = path.join(home, 'installed'), dataDir = path.join(home, 'profile');
  fs.mkdirSync(origin); fs.mkdirSync(dataDir);
  git(origin, 'init', '-b', 'main'); git(origin, 'config', 'user.name', 'Fixture'); git(origin, 'config', 'user.email', 'fixture@local');
  const historicalSource = execFileSync('git', ['show', `${historicalCommit}:${serviceFile}`], { cwd: sourceRoot, encoding: 'utf8' });
  const currentSource = fs.readFileSync(path.join(sourceRoot, serviceFile), 'utf8');
  for (const [relative, content] of Object.entries({
    '.gitignore': 'node_modules/\n**/dist/\n', 'package.json': '{"type":"module"}', 'package-lock.json': '{"lockfileVersion":3}',
    'local.txt': 'unchanged tracked file\n', 'unstaged.txt': 'original tracked work\n',
    [serviceFile]: historicalSource,
    'apps/server/src/server.ts': 'updates?: Pick<CloudxUpdateService, "status" | "start" | "preview" | "selectChannel">; // /api/ready/terminals\n',
    'apps/web/src/ui/fixture.txt': 'historical Settings files are supplied by the managed integration\n',
    'apps/server/src/workspace/SessionStateStore.ts': 'if (value.version !== 1) throw new Error();',
    'services/documentation-indexer/src/cloudx_documentation_indexer/catalog_schema.py': 'SCHEMA_VERSION = 2\n',
  })) write(path.join(origin, relative), content);
  if (directoryBoundary) {
    write(path.join(home, 'external/preserved.txt'), 'external files stay unchanged');
    fs.symlinkSync('../external', path.join(origin, 'recovery-tree'));
  }
  git(origin, 'add', '.'); git(origin, 'commit', '-m', 'TEST: historical target');
  const targetCommit = git(origin, 'rev-parse', 'HEAD');
  if (directoryBoundary) {
    fs.unlinkSync(path.join(origin, 'recovery-tree'));
    write(path.join(origin, 'recovery-tree/preserved.txt'), currentSource);
    git(origin, 'add', 'recovery-tree');
  }
  write(path.join(origin, serviceFile), currentSource); git(origin, 'commit', '-am', 'TEST: installed source');
  git(home, 'clone', origin, root);
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  write(path.join(root, 'apps/server/dist/index.js'), 'previous generated runtime');
  write(path.join(root, 'node_modules/dependency/index.js'), 'previous dependency');
  write(path.join(root, 'local.txt'), 'retained staged edit\n'); git(root, 'add', 'local.txt');
  write(path.join(root, 'unstaged.txt'), 'retained unstaged edit\n');
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
  const state = name => states[name] ??= { LoadState: 'loaded', ActiveState: name === 'cloudx.service' ? originalWeb : 'inactive', MainPID: '0', InvocationID: '', ControlGroup: `/cloudx-checkout-fixture/${name}`,
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
  return { root, dataDir, envPath, originalEnvironment, historicalSource, currentSource, sourceCommit, originalIndex, record, recordPath, save, newHost, events, runDir, states };
}

function expectPreviousInstallation(f) {
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.sourceCommit);
  expect(git(f.root, 'write-tree')).toBe(f.originalIndex);
  expect(fs.readFileSync(path.join(f.root, serviceFile), 'utf8')).toBe(f.currentSource);
  expect(fs.lstatSync(path.join(f.root, 'apps/server/dist')).isDirectory()).toBe(true);
  expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toBe('previous generated runtime');
  expect(fs.readFileSync(path.join(f.root, 'node_modules/dependency/index.js'), 'utf8')).toBe('previous dependency');
  expect(fs.readFileSync(path.join(f.root, 'local.txt'), 'utf8')).toBe('retained staged edit\n');
  expect(fs.readFileSync(path.join(f.root, 'unstaged.txt'), 'utf8')).toBe('retained unstaged edit\n');
  expect(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8')).toBe('retained untracked note\n');
  expect(fs.readFileSync(f.envPath, 'utf8')).toBe(f.originalEnvironment);
}

function temporaryCheckoutFile(f, relative = serviceFile) {
  return path.join(f.root, path.dirname(relative), `.cloudx-restore-${f.record.run.id}-${createHash('sha256').update(path.basename(relative)).digest('hex')}`);
}

function failPartialCheckoutWrite(f, relative = serviceFile) {
  const write = fs.writeFileSync;
  return vi.spyOn(fs, 'writeFileSync').mockImplementation((file, bytes, options) => {
    const destination = typeof file === 'number' ? fs.realpathSync(`/proc/self/fd/${file}`) : String(file);
    if ([path.join(f.root, relative), temporaryCheckoutFile(f, relative)].includes(destination) && Buffer.isBuffer(bytes) && bytes.equals(Buffer.from(f.currentSource))) {
      write(file, bytes.subarray(0, 64), options);
      throw Object.assign(new Error('disk is full after 64 source bytes'), { code: 'ENOSPC' });
    }
    return write(file, bytes, options);
  });
}

async function resumeCheckoutRestoration(f) {
  const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
  validateSavedTransition(record, f.runDir);
  const host = f.newHost(record);
  host.quiesce = () => { throw new Error('Target retry deferred by test'); };
  const result = await new ManagedUpdate({ record, save: f.save, host }).run();
  expect(result).toMatchObject({ state: 'failed', phase: 'quiesce', resumable: true });
  expect(record.transition).toMatchObject({ restored: true, mutating: false });
  expect(record.transition.checkoutRestoration).toBeUndefined();
  expectPreviousInstallation(f);
  expect(git(f.root, 'status', '--porcelain')).toBe('M  local.txt\n M unstaged.txt\n?? notes.txt');
  expect(fs.existsSync(temporaryCheckoutFile(f))).toBe(false);
  expect(f.states['cloudx.service'].ActiveState).toBe('active');
  expect(f.events.some(event => event.action === 'start' && event.service === 'cloudx.service' && event.commit === f.sourceCommit)).toBe(true);
}

function activateForRecovery(f) {
  const host = f.newHost(f.record);
  host.prepare(f.record); host.quiesce(f.record); host.snapshot(f.record); host.activate(f.record); host.start(f.record);
  f.record.transition.completed = ['prepare', 'quiesce', 'snapshot', 'activate', 'start'];
  f.save(f.record);
  return host;
}

describe('historical checkout recovery', () => {
  it('recovers source, index, artifacts and local work in a fresh coordinator after a partial ENOSPC write', async () => {
    const f = historicalDowngrade({ originalWeb: 'active' });
    const failure = failPartialCheckoutWrite(f);
    const result = await new ManagedUpdate({ record: f.record, save: f.save, host: f.newHost(f.record) }).run();
    expect(result).toMatchObject({ state: 'failed', phase: 'verify', resumable: true, message: 'Update stopped; restoration needs to continue.' });
    expect(result.recoveryAction).toContain('ENOSPC');
    expect(fs.readFileSync(temporaryCheckoutFile(f))).toEqual(Buffer.from(f.currentSource).subarray(0, 64));
    expect(fs.readFileSync(path.join(f.root, serviceFile), 'utf8')).toBe(f.historicalSource);
    expect(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')).transition.checkoutRestoration).toBe('copying');
    expect(f.states['cloudx.service'].ActiveState).toBe('inactive');
    failure.mockRestore();
    await resumeCheckoutRestoration(f);
  });

  it.each(['during the partial write', 'after flushing the file', 'after replacing the file', 'after restoring the index', 'after restoring HEAD'])('recovers through a fresh coordinator after real SIGKILL %s', async boundary => {
    const f = historicalDowngrade({ originalWeb: 'active' });
    activateForRecovery(f);
    const child = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      import { ManagedUpdate, UpdateHost, validateSavedTransition } from ${JSON.stringify(new URL('./managed-update.mjs', import.meta.url).href)};
      import { writeUpdateJson } from ${JSON.stringify(new URL('./managed-update-store.mjs', import.meta.url).href)};
      const [recordPath, boundary, serviceFile, temporary] = process.argv.slice(1);
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      const runDir = recordPath.slice(0, -5);
      validateSavedTransition(record, runDir);
      const source = Buffer.from(record.transition.sourceFiles.find(entry => entry.relative === serviceFile).content, 'base64');
      const installed = path.join(record.repoRoot, serviceFile);
      const save = value => writeUpdateJson(recordPath, value);
      const killAt = point => { if (boundary === point) process.kill(process.pid, 'SIGKILL'); };
      const commands = {
        inspect(command, args, options = {}) {
          if (command !== 'git') return 'LoadState=loaded\\nActiveState=inactive\\nMainPID=0\\nControlGroup=\\nWorkingDirectory=' + record.repoRoot;
          const result = execFileSync(command, args, { cwd: options.cwd ?? record.repoRoot, encoding: 'utf8' }).trim();
          if (args[0] === 'read-tree' && args[1] === record.transition.sourceIndex) killAt('after restoring the index');
          if (args[0] === 'update-ref' && args[1] === 'HEAD' && args[2] === record.transition.sourceCommit) killAt('after restoring HEAD');
          return result;
        },
        run() {},
      };
      const host = new UpdateHost({ repoRoot: record.repoRoot, dataDir: record.dataDir, home: record.home, runDir, commands, save, recovery: record.transition });
      const write = fs.writeFileSync, sync = fs.fsyncSync, rename = fs.renameSync;
      fs.writeFileSync = (file, bytes, options) => {
        const destination = typeof file === 'number' ? fs.realpathSync('/proc/self/fd/' + file) : String(file);
        if (boundary === 'during the partial write' && [installed, temporary].includes(destination) && Buffer.isBuffer(bytes) && bytes.equals(source)) {
          write(file, bytes.subarray(0, 64), options);
          process.kill(process.pid, 'SIGKILL');
        }
        return write(file, bytes, options);
      };
      fs.fsyncSync = fd => {
        sync(fd);
        if (fs.realpathSync('/proc/self/fd/' + fd) === temporary) killAt('after flushing the file');
      };
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (String(to) === installed && String(from) === temporary) killAt('after replacing the file');
      };
      await new ManagedUpdate({ record, save, host }).run();
      process.exitCode = 2;
    `;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', child, f.recordPath, boundary, serviceFile, temporaryCheckoutFile(f)], { encoding: 'utf8', timeout: 10000 });
    expect(killed.error, killed.stderr).toBeUndefined();
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const interrupted = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(interrupted.transition.checkoutRestoration).toBe('copying');
    validateSavedTransition(interrupted, f.runDir);
    if (boundary === 'during the partial write') expect(fs.readFileSync(temporaryCheckoutFile(f))).toEqual(Buffer.from(f.currentSource).subarray(0, 64));
    await resumeCheckoutRestoration(f);
  });

  it.each(['activated source', 'temporary content', 'temporary symbolic link', 'temporary hard link', 'temporary permissions'])('preserves an operator change to %s after interrupted restoration', async change => {
    const f = historicalDowngrade({ originalWeb: 'active' }), host = activateForRecovery(f);
    const failure = failPartialCheckoutWrite(f);
    expect(() => host.restore(f.record)).toThrow('disk is full');
    failure.mockRestore();
    const temporary = temporaryCheckoutFile(f), edited = change === 'activated source' ? path.join(f.root, serviceFile) : temporary;
    const external = path.join(f.root, 'operator-recovery-note.txt');
    write(external, 'retain this operator work');
    if (change === 'temporary symbolic link' || change === 'temporary hard link') {
      fs.unlinkSync(temporary);
      if (change === 'temporary symbolic link') fs.symlinkSync(external, temporary);
      else fs.linkSync(external, temporary);
    } else if (change === 'temporary permissions') fs.chmodSync(temporary, 0o700);
    else write(edited, 'retain this operator work');
    const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    validateSavedTransition(record, f.runDir);
    expect(() => f.newHost(record).assertCheckoutRestorable(record)).toThrow('Checkout recovery conflict');
    const result = await new ManagedUpdate({ record, save: f.save, host: f.newHost(record) }).run();
    expect(result).toMatchObject({ state: 'failed', phase: 'restore', message: 'Update stopped; restoration needs to continue.' });
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.targetCommit);
    if (change === 'temporary permissions') expect(fs.statSync(temporary).mode & 0o777).toBe(0o700);
    else expect(fs.readFileSync(edited, 'utf8')).toBe('retain this operator work');
    expect(fs.readFileSync(external, 'utf8')).toBe('retain this operator work');
    expect(f.states['cloudx.service'].ActiveState).toBe('inactive');
  });

  it('preserves a preexisting reserved temporary name before changing runtime artifacts', () => {
    const f = historicalDowngrade(), host = activateForRecovery(f);
    const temporary = temporaryCheckoutFile(f);
    write(temporary, f.currentSource.slice(0, 64));
    expect(() => host.restore(f.record)).toThrow(/Checkout recovery conflict/);
    expect(fs.lstatSync(path.join(f.root, 'apps/server/dist')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(temporary, 'utf8')).toBe(f.currentSource.slice(0, 64));
    expect(f.record.transition.checkoutRestoration).toBeUndefined();
  });

  it('cleans only its interrupted temporary file when restoring a directory replaced by a target symlink', async () => {
    const f = historicalDowngrade({ originalWeb: 'active', directoryBoundary: true }), host = activateForRecovery(f);
    const relative = 'recovery-tree/preserved.txt', failure = failPartialCheckoutWrite(f, relative);
    expect(() => host.restore(f.record)).toThrow('disk is full');
    failure.mockRestore();
    expect(fs.readFileSync(temporaryCheckoutFile(f, relative))).toEqual(Buffer.from(f.currentSource).subarray(0, 64));
    await resumeCheckoutRestoration(f);
    expect(fs.readFileSync(path.join(f.root, relative), 'utf8')).toBe(f.currentSource);
    expect(fs.readFileSync(path.join(f.record.home, 'external/preserved.txt'), 'utf8')).toBe('external files stay unchanged');
    expect(fs.existsSync(temporaryCheckoutFile(f, relative))).toBe(false);
  });

  it('rejects a reserved temporary name tracked by the source checkout before changing runtime artifacts', () => {
    const f = historicalDowngrade(), temporary = temporaryCheckoutFile(f);
    write(temporary, 'tracked operator work');
    git(f.root, 'add', temporary);
    git(f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'TEST: tracked reserved recovery name');
    const host = activateForRecovery(f);
    expect(fs.existsSync(temporary)).toBe(false);
    expect(() => host.restore(f.record)).toThrow(/reserved by the source checkout/);
    expect(fs.lstatSync(path.join(f.root, 'apps/server/dist')).isSymbolicLink()).toBe(true);
    expect(f.record.transition.checkoutRestoration).toBeUndefined();
    expect(git(f.root, 'show', `${f.record.transition.sourceCommit}:${path.relative(f.root, temporary)}`)).toBe('tracked operator work');
  });

  it.each([null, 'complete', false])('rejects an invalid saved checkout restoration state: %j', state => {
    const f = historicalDowngrade(); activateForRecovery(f);
    f.record.transition.checkoutRestoration = state;
    expect(() => validateSavedTransition(f.record, f.runDir)).toThrow('checkout restoration progress');
  });

  it.each([{ activationIntent: false }, { mutating: false }, { restored: true }, { snapshotVerified: false }, { sourceFiles: undefined }, { targetFiles: undefined }])('rejects contradictory checkout restoration evidence: %j', flags => {
    const f = historicalDowngrade(); activateForRecovery(f);
    Object.assign(f.record.transition, { checkoutRestoration: 'copying' }, flags);
    expect(() => validateSavedTransition(f.record, f.runDir)).toThrow('checkout restoration progress');
  });

  it('rolls back failed historical readiness and resumes with coherent source, artifacts, configuration and local work', async () => {
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

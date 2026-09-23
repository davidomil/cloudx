import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedUpdate, UpdateHost } from './managed-update.mjs';
import { writeUpdateJson, snapshotTree } from './managed-update-store.mjs';

const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function git(root, ...args) { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'apply.whitespace=fix', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function write(root, file, value) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); }
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-managed-host-')); temporary.push(home);
  const root = path.join(home, 'checkout'), origin = path.join(home, 'origin');
  fs.mkdirSync(origin); git(origin, 'init', '-b', 'main'); git(origin, 'config', 'user.email', 'test@local'); git(origin, 'config', 'user.name', 'Test');
  const source = { 'package.json': '{"name":"fixture","type":"module"}', 'package-lock.json': '{"lockfileVersion":3}', 'version.txt': 'old', 'local.txt': 'original',
    'apps/server/src/workspace/SessionStateStore.ts': 'if (value.version !== 1) throw new Error();',
    'services/documentation-indexer/src/cloudx_documentation_indexer/catalog_schema.py': 'SCHEMA_VERSION = 2\n' };
  for (const [name, value] of Object.entries(source)) write(origin, name, value);
  git(origin, 'add', '.'); git(origin, 'commit', '-m', 'TEST: old'); const old = git(origin, 'rev-parse', 'HEAD');
  git(home, 'clone', origin, root);
  write(origin, 'version.txt', 'new'); git(origin, 'commit', '-am', 'TEST: new'); const target = git(origin, 'rev-parse', 'HEAD');
  const dataDir = path.join(home, 'profile'); fs.mkdirSync(dataDir);
  write(dataDir, 'workspace.json', '{"windows":[]}');
  const envPath = path.join(home, '.config/cloudx/cloudx.env'); write(home, '.config/cloudx/cloudx.env', `CLOUDX_DATA_DIR=${dataDir}\nSECRET=keep-private\n`);
  for (const name of ['cloudx-asr.service', 'cloudx-documentation.service', 'cloudx.service', 'cloudx-terminal.service']) write(home, `.config/systemd/user/${name}`, 'original unit');
  const id = randomUUID(), runDir = path.join(home, '.local/state/cloudx/settings-update', id); fs.mkdirSync(runDir, { recursive: true });
  const recordPath = `${runDir}.json`;
  const calls = [];
  const properties = service => ({ LoadState: 'loaded', ActiveState: 'inactive', MainPID: '0', InvocationID: '', ControlGroup: '', KillMode: 'control-group', SendSIGKILL: 'yes', WorkingDirectory: root,
    Id: service, NeedDaemonReload: 'no', DropInPaths: '', EnvironmentFiles: `${envPath} (ignore_errors=no)`, FragmentPath: path.join(home, '.config/systemd/user', service) });
  const commands = {
    inspect(command, args, options = {}) {
      calls.push([command, args]);
      if (command === 'git') return git(options.cwd ?? root, ...args);
      if (command === 'systemctl') return Object.entries(properties(args[2])).map(([key, value]) => `${key}=${value}`).join('\n');
      throw new Error(`Unexpected inspection: ${command}`);
    },
    run(command, args, options = {}) { calls.push([command, args]); if (command === 'git') git(options.cwd ?? root, ...args); else if (command !== 'systemctl') throw new Error(`Unexpected run: ${command}`); },
    mkdir(directory) { fs.mkdirSync(directory, { recursive: true }); },
    logVerboseProcessResult() {},
    which(command) { return `/usr/bin/${command}`; },
    writeFile(file, content) { write(path.dirname(file), path.basename(file), content); }
  };
  const record = { repoRoot: root, dataDir, home, targetCommit: target, coordinator: runDir, confirmInterruption: true,
    run: { id, state: 'running', targetCommit: target, startedAt: new Date().toISOString() }, transition: { completed: [] } };
  const build = vi.fn(({ releaseRoot }) => {
    write(releaseRoot, 'apps/server/dist/index.js', `export const version = ${JSON.stringify(fs.readFileSync(path.join(releaseRoot, 'version.txt'), 'utf8'))};`);
    write(releaseRoot, 'apps/server/dist/server.js', "// /api/ready/terminals\nexport {};\n");
    write(releaseRoot, 'node_modules/dependency/index.js', 'export default 1;');
    fs.mkdirSync(path.join(releaseRoot, 'node_modules/@fixture'), { recursive: true });
    fs.symlinkSync('../dependency', path.join(releaseRoot, 'node_modules/@fixture/package'));
  });
  write(root, 'apps/server/dist/index.js', 'export const version = "running-older-than-checkout";');
  write(root, 'node_modules/dependency/index.js', 'export default 0;');
  const save = value => writeUpdateJson(recordPath, value);
  const host = new UpdateHost({ repoRoot: root, home, dataDir, runDir, commands, prepareRelease: build, save });
  return { home, root, origin, dataDir, old, target, record, recordPath, host, save, commands, build, calls, envPath };
}

describe('managed update host with real Git and recovery files', () => {
  it('keeps a prepared target inactive and verifies it after a later explicit activation', async () => {
    const f = fixture();
    f.record.noStart = true;
    const execute = record => new ManagedUpdate({ record, save: f.save, host: f.host }).run();
    expect(await execute(f.record)).toMatchObject({ state: 'prepared' });
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.old);
    expect(fs.lstatSync(path.join(f.root, 'apps/server/dist')).isSymbolicLink()).toBe(false);
    expect(f.calls.filter(([command, args]) => command === 'systemctl' && args[1] !== 'show')).toEqual([]);
    const resumed = JSON.parse(fs.readFileSync(f.recordPath));
    resumed.noStart = false;
    vi.spyOn(f.host, 'start').mockImplementation(() => {});
    const verify = vi.spyOn(f.host, 'verify').mockImplementation(record => {
      expect(record.run.state).toBe('running');
      expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.target);
      expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toContain('new');
    });
    expect(await execute(resumed)).toMatchObject({ state: 'succeeded' });
    expect(verify).toHaveBeenCalledOnce();
    expect(f.build).toHaveBeenCalledOnce();
  });

  it.each(['local work', 'configuration', 'built artifact'])('rejects changed %s before activating a prepared target', async change => {
    const f = fixture();
    f.record.noStart = true;
    const execute = record => new ManagedUpdate({ record, save: f.save, host: f.host }).run();
    await execute(f.record);
    const resumed = JSON.parse(fs.readFileSync(f.recordPath));
    resumed.noStart = false;
    if (change === 'local work') write(f.root, 'local.txt', 'new operator edit');
    if (change === 'configuration') fs.appendFileSync(f.envPath, 'CLOUDX_PORT=4443\n');
    if (change === 'built artifact') write(resumed.transition.release, 'apps/server/dist/index.js', 'unverified changed bytes');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await execute(resumed)).toMatchObject({ state: 'failed', phase: 'quiesce', resumable: true });
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.old);
    expect(f.calls.filter(([command, args]) => command === 'systemctl' && args[1] !== 'show')).toEqual([]);
    expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toContain('running-older-than-checkout');
  });

  it('captures service state at activation instead of restoring the state from preparation', async () => {
    const f = fixture();
    f.record.noStart = true;
    await new ManagedUpdate({ record: f.record, save: f.save, host: f.host }).run();
    const oldInspect = f.commands.inspect;
    const oldRun = f.commands.run;
    let active = true;
    f.commands.inspect = (command, args, options) => {
      const result = oldInspect(command, args, options);
      return active && command === 'systemctl' && args[2] === 'cloudx-asr.service'
        ? result.replace('ActiveState=inactive', 'ActiveState=active').replace('MainPID=0', 'MainPID=456') : result;
    };
    f.commands.run = (command, args, options) => {
      if (command === 'systemctl' && args[1] === 'stop' && args.includes('cloudx-asr.service')) active = false;
      oldRun(command, args, options);
    };
    f.record.noStart = false;
    f.host.quiesce(f.record);
    expect(f.record.transition.serviceStates['cloudx-asr.service']).toContain('ActiveState=active');
    expect(f.record.transition.serviceStates['cloudx-asr.service']).toContain('MainPID=456');
  });

  it.each(['local staged work', 'local work with trailing whitespace  \n', '\0binary\x01work'])('prepares without changing checkout, local work, running build or saved configuration (%j)', localWork => {
    const f = fixture();
    write(f.root, 'local.txt', localWork); git(f.root, 'add', 'local.txt');
    write(f.root, 'notes.txt', 'unrelated untracked work');
    const oldIndex = git(f.root, 'write-tree');
    f.host.prepare(f.record);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.old);
    expect(git(f.root, 'write-tree')).toBe(oldIndex);
    expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toContain('running-older-than-checkout');
    expect(fs.readFileSync(f.envPath, 'utf8')).toContain('SECRET=keep-private');
    expect(fs.readFileSync(path.join(f.record.transition.release, 'local.txt'), 'utf8')).toBe(localWork);
    expect(f.calls.filter(([command, args]) => command === 'systemctl' && args[1] !== 'show')).toEqual([]);
  });

  it.each(['upgrade', 'downgrade', 'diverged', 'repair'])('activates %s and restores exact previous build, index, local work and configuration', kind => {
    const f = fixture();
    if (kind === 'downgrade') { git(f.root, 'fetch', 'origin'); git(f.root, 'merge', '--ff-only', 'origin/main'); f.record.targetCommit = f.old; }
    if (kind === 'diverged') { git(f.root, 'config', 'user.email', 'test@local'); git(f.root, 'config', 'user.name', 'Test'); write(f.root, 'branch-only.txt', 'local commit retained by ref'); git(f.root, 'add', 'branch-only.txt'); git(f.root, 'commit', '-m', 'TEST: local branch'); }
    if (kind === 'repair') { f.record.targetCommit = f.old; write(f.root, 'apps/server/dist/runtime-build.json', 'broken old build metadata'); }
    write(f.root, 'local.txt', 'local unstaged change'); write(f.root, 'notes.txt', 'keep notes');
    const original = git(f.root, 'rev-parse', 'HEAD');
    f.host.prepare(f.record); f.host.quiesce(f.record); f.host.snapshot(f.record); f.host.activate(f.record);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.targetCommit);
    expect(git(f.root, 'rev-parse', `refs/cloudx/updates/${f.record.run.id}`)).toBe(original);
    expect(fs.lstatSync(path.join(f.root, 'apps/server/dist')).isSymbolicLink()).toBe(true);
    f.host.restore(f.record);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(original);
    expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toContain('running-older-than-checkout');
    expect(fs.readFileSync(path.join(f.root, 'node_modules/dependency/index.js'), 'utf8')).toContain('default 0');
    expect(fs.readFileSync(path.join(f.root, 'local.txt'), 'utf8')).toBe('local unstaged change');
    expect(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8')).toBe('keep notes');
    expect(fs.readFileSync(f.envPath, 'utf8')).toContain('SECRET=keep-private');
  });

  it.each(['file-to-directory', 'directory-to-file', 'leading whitespace'])('restores a target path transition: %s', shape => {
    const f = fixture();
    if (shape === 'leading whitespace') write(f.origin, ' leading.txt', 'selected target');
    else if (shape === 'file-to-directory') { fs.rmSync(path.join(f.origin, 'version.txt')); write(f.origin, 'version.txt/child', 'target child'); }
    else {
      write(f.root, 'old-directory/child', 'original child');
      git(f.root, 'config', 'user.name', 'Test'); git(f.root, 'config', 'user.email', 'test@local');
      git(f.root, 'add', 'old-directory/child'); git(f.root, 'commit', '-m', 'TEST: source directory');
      write(f.origin, 'old-directory', 'target file');
    }
    git(f.origin, 'add', '.'); git(f.origin, 'commit', '-m', 'TEST: target shape');
    f.record.targetCommit = git(f.origin, 'rev-parse', 'HEAD');
    const original = git(f.root, 'rev-parse', 'HEAD');
    if (shape === 'file-to-directory') f.build.mockImplementation(({ releaseRoot }) => {
      write(releaseRoot, 'apps/server/dist/index.js', 'export {};');
      write(releaseRoot, 'apps/server/dist/server.js', '// /api/ready/terminals');
    });
    f.host.prepare(f.record); f.host.quiesce(f.record); f.host.snapshot(f.record); f.host.activate(f.record); f.host.restore(f.record);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(original);
    expect(git(f.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    if (shape === 'leading whitespace') expect(fs.existsSync(path.join(f.root, ' leading.txt'))).toBe(false);
    if (shape === 'directory-to-file') expect(fs.readFileSync(path.join(f.root, 'old-directory/child'), 'utf8')).toBe('original child');
    if (shape === 'file-to-directory') expect(fs.readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('old');
  });

  it('restores a crash between working tree replacement and the HEAD write', () => {
    const f = fixture(); f.host.prepare(f.record); f.host.quiesce(f.record); f.host.snapshot(f.record);
    const inspect = f.commands.inspect.bind(f.commands);
    f.commands.inspect = (command, args, options) => { if (command === 'git' && args[0] === 'update-ref' && args[1] === 'HEAD') throw new Error('simulated process death'); return inspect(command, args, options); };
    expect(() => f.host.activate(f.record)).toThrow('simulated process death');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.old);
    expect(fs.readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('new');
    f.commands.inspect = inspect;
    f.host.restore(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')));
    expect(fs.readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('old');
    expect(git(f.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('restores a directory replaced by a symlink without touching its external destination', () => {
    const f = fixture();
    const outside = path.join(f.home, 'outside');
    write(outside, 'child', 'original child');
    write(f.root, 'old-directory/child', 'original child');
    git(f.root, 'config', 'user.name', 'Test'); git(f.root, 'config', 'user.email', 'test@local');
    git(f.root, 'add', 'old-directory/child'); git(f.root, 'commit', '-m', 'TEST: source directory');
    fs.symlinkSync(outside, path.join(f.origin, 'old-directory'));
    git(f.origin, 'add', 'old-directory'); git(f.origin, 'commit', '-m', 'TEST: target symlink');
    f.record.targetCommit = git(f.origin, 'rev-parse', 'HEAD');
    const original = git(f.root, 'rev-parse', 'HEAD');
    f.host.prepare(f.record); f.host.quiesce(f.record); f.host.snapshot(f.record); f.host.activate(f.record); f.host.restore(f.record);
    expect(fs.readFileSync(path.join(outside, 'child'), 'utf8')).toBe('original child');
    expect(fs.lstatSync(path.join(f.root, 'old-directory')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(f.root, 'old-directory/child'), 'utf8')).toBe('original child');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(original);
    expect(git(f.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it.each(['tracked conflict', 'untracked collision'])('retains %s and stops before dependency preparation', kind => {
    const f = fixture();
    if (kind === 'tracked conflict') write(f.root, 'version.txt', 'local version');
    else write(f.origin, 'new.txt', 'upstream');
    if (kind === 'untracked collision') { git(f.origin, 'add', 'new.txt'); git(f.origin, 'commit', '-m', 'TEST: new path'); f.record.targetCommit = git(f.origin, 'rev-parse', 'HEAD'); write(f.root, 'new.txt', 'untracked local'); }
    expect(() => f.host.prepare(f.record)).toThrow(/conflict/);
    expect(f.build).not.toHaveBeenCalled();
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.old);
  });

  it('preserves target-written newer data before rollback and keeps it across another attempt', () => {
    const f = fixture(); f.host.prepare(f.record); f.host.quiesce(f.record); f.host.snapshot(f.record); f.host.activate(f.record);
    f.record.transition.targetStarted = true; write(f.dataDir, 'newer.json', '{"important":"new"}');
    f.host.restore(f.record);
    const newer = f.record.transition.retainedFailedData[0].destination;
    expect(fs.readFileSync(path.join(newer, 'newer.json'), 'utf8')).toContain('important');
    expect(fs.existsSync(path.join(f.dataDir, 'newer.json'))).toBe(false);
    f.host.quiesce(f.record); f.host.snapshot(f.record);
    expect(fs.readFileSync(path.join(newer, 'newer.json'), 'utf8')).toContain('important');
  });

  it.each(['parent traversal', 'mismatched record filename'])('rejects a matching historical snapshot with %s before offering restoration', malformed => {
    const f = fixture(); f.host.prepare(f.record);
    const id = randomUUID(), stateDir = path.dirname(f.host.runDir), previousRun = path.join(stateDir, id);
    fs.mkdirSync(previousRun);
    const destination = malformed === 'parent traversal' ? `${previousRun}/../outside-snapshot` : path.join(previousRun, 'snapshot/data-0');
    const manifest = snapshotTree(f.dataDir, path.resolve(destination));
    const candidate = { home: f.home, repoRoot: f.root, dataDir: f.dataDir, envPath: f.envPath,
      run: { id, startedAt: new Date().toISOString() },
      transition: { sourceCommit: f.target, environment: f.host.envConfig, snapshots: [{ root: f.dataDir, destination, manifest }] } };
    const filename = malformed === 'mismatched record filename' ? randomUUID() : id;
    writeUpdateJson(path.join(stateDir, `${filename}.json`), candidate);
    f.record.restoreSnapshotRunId = id;
    expect(() => f.host.planData(f.record)).toThrow(malformed === 'parent traversal' ? /recovery data/i : /snapshot record identity/i);
    expect(f.record.transition.restoreData).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, 'confirmation.json'))).toBe(false);
    expect(fs.readFileSync(path.join(f.dataDir, 'workspace.json'), 'utf8')).toBe('{"windows":[]}');
  });

  it('reprepares changed local work on resume instead of looping on a stale prepared release', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture(); f.host.prepare(f.record); f.record.transition.completed = ['prepare']; write(f.root, 'local.txt', 'changed during build');
    const run = await new ManagedUpdate({ record: f.record, save: f.save, host: f.host }).run();
    expect(run).toMatchObject({ state: 'failed', resumable: true });
    expect(f.record.transition.completed).toEqual([]);
    expect(f.calls.filter(([command, args]) => command === 'systemctl' && args[1] === 'stop')).toEqual([]);
  });

  it('captures fresh checkout recovery after the source changes between attempts', () => {
    const f = fixture();
    f.host.prepare(f.record); f.host.quiesce(f.record); f.host.snapshot(f.record); f.host.activate(f.record); f.host.restore(f.record);
    write(f.root, 'new-local-commit.txt', 'keep the new source');
    git(f.root, 'config', 'user.name', 'Test'); git(f.root, 'config', 'user.email', 'test@local');
    git(f.root, 'add', 'new-local-commit.txt'); git(f.root, 'commit', '-m', 'TEST: changed source');
    const original = git(f.root, 'rev-parse', 'HEAD');
    f.host.prepare(f.record); f.host.quiesce(f.record); f.host.snapshot(f.record); f.host.activate(f.record); f.host.restore(f.record);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(original);
    expect(fs.readFileSync(path.join(f.root, 'new-local-commit.txt'), 'utf8')).toBe('keep the new source');
    expect(git(f.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('verifies only the captured terminal identities through the bundled probe', () => {
    const f = fixture();
    f.record.transition.release = path.join(f.home, 'prepared');
    f.record.transition.preservedSessionIds = ['exact-shell', 'exact-codex'];
    const inspect = vi.spyOn(f.commands, 'inspect').mockReturnValue(JSON.stringify({ sessionIds: f.record.transition.preservedSessionIds }));
    expect(f.host.probeTerminals(f.record, 'verify')).toEqual(['exact-shell', 'exact-codex']);
    const [node, args, options] = inspect.mock.calls[0];
    expect(node).toBe(process.execPath);
    expect(args.slice(0, 4)).toEqual([path.join(f.record.coordinator, 'scripts/managed-update-terminals.mjs'), 'verify', f.record.transition.release, f.dataDir]);
    expect(JSON.parse(fs.readFileSync(args[4], 'utf8'))).toEqual({ sessionIds: ['exact-shell', 'exact-codex'] });
    expect(options.timeout).toBe(60000);
    inspect.mockReturnValue('{"sessionIds":["different-session"]}');
    expect(() => f.host.probeTerminals(f.record, 'verify')).toThrow('preserved terminal sessions could not be attached');
  });
});

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { InstallerRunner } from './install-cloudx.mjs';
import { SettingsUpdater } from './settings-update.mjs';
import { launchManagedUpdate, parseUpdateArguments } from './update-cloudx.mjs';

const roots = [];
const previousExitCode = process.exitCode;
const targetCommit = 'a'.repeat(40);
const runId = 'b1440a6d-90c8-4679-b638-f1b230ab3701';
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each([
  ['--unknown'], ['--target-commit'], ['--target-commit', 'main'], ['--checkout', 'relative'],
  ['--resume', 'not-a-run'], ['--restore-snapshot', 'not-a-run'],
  ['--service', 'preview.service'], ['--port', '3443'], ['--host', '127.0.0.1'],
  ['--resume', '--status']
])('rejects invalid managed update arguments before host actions: %j', (...argv) => {
  expect(() => parseUpdateArguments(argv)).toThrow();
});

it('preserves the exact target, custom service and explicit recovery choices', () => {
  expect(parseUpdateArguments(['--checkout', '/srv/cloudx data', '--target-commit', targetCommit,
    '--service', 'preview.service', '--port', '3443', '--host', '127.0.0.1',
    '--confirm-interruption', '--restore-snapshot', runId, '--non-interactive'])).toEqual({
    repoRoot: '/srv/cloudx data', targetCommit, service: 'preview.service', port: '3443', host: '127.0.0.1',
    confirmInterruption: true, restoreSnapshotRunId: runId, nonInteractive: true
  });
});

it('reads update status without remote Git lookup or starting an update', async () => {
  const fixture = cliFixture();
  const status = { available: true, run: { id: runId, state: 'failed', resumable: true, phase: 'prepare' } };
  vi.spyOn(SettingsUpdater.prototype, 'status').mockReturnValue(status);
  const start = vi.spyOn(SettingsUpdater.prototype, 'start');
  const inspect = vi.spyOn(InstallerRunner.prototype, 'inspect').mockImplementation(() => { throw new Error('No host command is needed for this fixture status.'); });
  expect(await launchManagedUpdate({ ...fixture, status: true })).toEqual(status);
  expect(start).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
});

it('resumes the persisted target without consulting a moving release channel', async () => {
  const fixture = cliFixture();
  vi.spyOn(SettingsUpdater.prototype, 'read').mockReturnValue({ targetCommit, home: fixture.home, dataDir: path.join(fixture.repoRoot, '.cloudx'),
    envPath: path.join(fixture.home, '.config/cloudx/cloudx.env') });
  const start = vi.spyOn(SettingsUpdater.prototype, 'start').mockReturnValue({ available: true, run: { id: runId, state: 'running' } });
  const inspect = vi.spyOn(InstallerRunner.prototype, 'inspect').mockImplementation(() => { throw new Error('Resume must not consult the remote catalog.'); });
  await launchManagedUpdate({ ...fixture, resumeRunId: runId, nonInteractive: true });
  expect(start).toHaveBeenCalledWith(targetCommit, expect.objectContaining({ resumeRunId: runId }));
  expect(inspect).not.toHaveBeenCalled();
});

it.each(['resume', 'status'])('uses saved custom-service configuration for %s when the live environment file is missing', async action => {
  const fixture = cliFixture();
  fs.unlinkSync(path.join(fixture.home, '.config/cloudx/cloudx.env'));
  const saved = { targetCommit, repoRoot: fixture.repoRoot, home: fixture.home, dataDir: path.join(fixture.repoRoot, 'custom-data'),
    envPath: path.join(fixture.home, 'missing-custom.env'), service: 'saved-preview.service', port: '3443', host: '::1' };
  vi.spyOn(SettingsUpdater.prototype, 'read').mockReturnValue(saved);
  vi.spyOn(SettingsUpdater.prototype, 'readRecord').mockReturnValue(saved);
  vi.spyOn(SettingsUpdater.prototype, 'pointer').mockReturnValue({ id: runId });
  const start = vi.spyOn(SettingsUpdater.prototype, 'start').mockReturnValue({ available: true, run: { id: runId, state: 'running' } });
  const status = vi.spyOn(SettingsUpdater.prototype, 'status').mockReturnValue({ available: true });
  const inspect = vi.spyOn(InstallerRunner.prototype, 'inspect').mockImplementation(() => { throw new Error('The saved configuration must be loaded first.'); });
  await launchManagedUpdate({ ...fixture, ...(action === 'resume' ? { resumeRunId: runId } : { status: true }), nonInteractive: true });
  const updater = (action === 'resume' ? start : status).mock.instances[0];
  expect(updater).toMatchObject({ dataDir: saved.dataDir, serviceName: saved.service, port: saved.port, host: saved.host, paths: { envPath: saved.envPath } });
  expect(inspect).not.toHaveBeenCalled();
});

it('keeps noninteractive interruption confirmation pending without silently accepting it', async () => {
  const fixture = cliFixture();
  const confirmation = { targetCommit, requiresInterruption: true, message: 'Running terminals will stop.' };
  const start = vi.spyOn(SettingsUpdater.prototype, 'start').mockReturnValue({ available: true, confirmation });
  expect(await launchManagedUpdate({ ...fixture, targetCommit, nonInteractive: true })).toMatchObject({ confirmation });
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][1].confirmInterruption).toBeUndefined();
  expect(process.exitCode).toBe(1);
});

it('hands current installer updates to the managed launcher before invoking Git or installation commands', () => {
  const { root, bin, trace } = shellFixture();
  const scripts = path.join(root, 'checkout/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  copyInstaller('install-cloudx.mjs');
  fs.writeFileSync(path.join(scripts, 'update-cloudx.mjs'), `
    import fs from 'node:fs';
    export const parseUpdateArguments = argv => ({ argv });
    export const launchManagedUpdate = options => fs.appendFileSync(process.env.CLOUDX_TEST_TRACE, JSON.stringify({ kind: 'handoff', options }) + '\\n');
  `);
  for (const command of ['git', 'npm', 'systemctl', 'sudo']) executable(path.join(bin, command), `
    import fs from 'node:fs';
    fs.appendFileSync(process.env.CLOUDX_TEST_TRACE, JSON.stringify({ kind: 'unexpected-command', command: ${JSON.stringify(command)} }) + '\\n');
    process.exit(90);
  `);
  const argv = ['--update', '--checkout', path.dirname(scripts), '--target-commit', targetCommit, '--non-interactive'];
  const result = spawnSync(process.execPath, [path.join(scripts, 'install-cloudx.mjs'), ...argv], {
    cwd: path.dirname(scripts), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLOUDX_TEST_TRACE: trace }
  });
  expect(result.status, result.stderr).toBe(0);
  expect(events(trace)).toEqual([{ kind: 'handoff', options: { argv } }]);

  function copyInstaller(name) {
    if (fs.existsSync(path.join(scripts, name))) return;
    const source = fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    fs.writeFileSync(path.join(scripts, name), source);
    for (const match of source.matchAll(/from\s+["']\.\/([^"']+\.mjs)["']/g)) copyInstaller(match[1]);
  }
});

it.each([false, true])('the maintained recovery entry stages its coordinator without modifying the installed checkout (download failure: %s)', failure => {
  const { root, bin, trace } = shellFixture();
  const checkout = path.join(root, 'installed checkout');
  const state = path.join(root, 'private state');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, 'local-work'), 'preserve local work');
  executable(path.join(bin, 'git'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.CLOUDX_TEST_TRACE, JSON.stringify({ kind: 'git', args }) + '\\n');
    if (${JSON.stringify(failure)}) process.exit(51);
    const stage = args.at(-1);
    fs.mkdirSync(path.join(stage, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'scripts/update-cloudx.mjs'), '// staged entry');
  `);
  executable(path.join(bin, 'node'), `
    import fs from 'node:fs';
    fs.appendFileSync(process.env.CLOUDX_TEST_TRACE, JSON.stringify({ kind: 'node', args: process.argv.slice(2) }) + '\\n');
  `);
  const argv = ['--checkout', checkout, '--target-commit', targetCommit, '--non-interactive'];
  const result = spawnSync('/bin/bash', [new URL('./recover-cloudx.sh', import.meta.url).pathname, ...argv], {
    cwd: checkout, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLOUDX_TEST_TRACE: trace, XDG_STATE_HOME: state }
  });
  expect(result.status, result.stderr).toBe(failure ? 51 : 0);
  expect(fs.readFileSync(path.join(checkout, 'local-work'), 'utf8')).toBe('preserve local work');
  expect(fs.readdirSync(checkout)).toEqual(['local-work']);
  const calls = events(trace);
  expect(calls[0].args.slice(0, -1)).toEqual(['clone', '--quiet', '--depth=1', '--branch', 'main', '--', 'https://github.com/davidomil/cloudx.git']);
  expect(calls[0].args.at(-1)).toMatch(/private state\/cloudx\/recovery-launchers\/launcher-[^/]+\/coordinator$/);
  expect(calls).toHaveLength(failure ? 1 : 2);
  if (!failure) expect(calls[1]).toEqual({ kind: 'node', args: [path.join(calls[0].args.at(-1), 'scripts/update-cloudx.mjs'), ...argv] });
  expect(fs.statSync(path.join(state, 'cloudx/recovery-launchers')).mode & 0o777).toBe(0o700);
});

function cliFixture() {
  const root = temporaryRoot();
  const home = path.join(root, 'home'), repoRoot = path.join(root, 'checkout');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(path.join(home, '.config/cloudx'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/cloudx/cloudx.env'), `CLOUDX_DATA_DIR=${path.join(root, 'data')}\n`);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { home, repoRoot };
}
function shellFixture() {
  const root = temporaryRoot(), bin = path.join(root, 'bin'), trace = path.join(root, 'calls.jsonl');
  fs.mkdirSync(bin);
  return { root, bin, trace };
}
function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-update-cli-'));
  roots.push(root);
  return root;
}
function executable(file, script) { fs.writeFileSync(file, `#!${process.execPath}\n${script}`, { mode: 0o700 }); }
function events(trace) { return fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)); }

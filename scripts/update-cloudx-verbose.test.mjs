import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SERVICE_NAMES } from './install-update.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it.each(['flag', 'environment', 'default'])('runs the real installer and staged coordinator with %s diagnostics', mode => {
  const fixture = installation();
  const { record, log, stderr, stdout } = fixture.run(mode === 'flag' ? ['--verbose'] : [], mode === 'environment' ? '1' : '');
  const verbose = mode !== 'default';
  expect(record.verbose === true).toBe(verbose);
  expect(record.run).toMatchObject({ state: 'failed', resumable: true, phase: 'prepare' });
  expect(record.transition.mutating).not.toBe(true);
  expect(log).toContain('$ git rev-parse HEAD');
  expect(stderr.includes('[verbose] cwd:')).toBe(verbose);
  expect(stdout).not.toContain('[verbose]');
  expect(log.includes('[verbose] cwd:')).toBe(verbose);
  if (verbose) {
    expect(log).toContain('[verbose] exit: 42');
    expect(log).toContain('[verbose] stdout:\n  fixture partial output');
    expect(log).toContain('[verbose] stderr:\n  fixture preparation failure');
  }
  expect(fs.statSync(fixture.logPath(record)).mode & 0o777).toBe(0o600);
  expect(`${log}\n${stderr}`).not.toContain('fixture-secret-token');
});

it.each([false, true])('retains the coordinator and enables diagnostics across resume (initial verbose: %s)', initiallyVerbose => {
  const fixture = installation();
  const first = fixture.run(initiallyVerbose ? ['--verbose'] : []);
  const initial = first.record;
  const { record, log } = fixture.run(['--resume', initial.run.id, ...(initiallyVerbose ? [] : ['--verbose'])]);
  expect(record.run).toMatchObject({ id: initial.run.id, state: 'failed', phase: 'prepare', resumable: true });
  expect(record).toMatchObject({ verbose: true, targetCommit: initial.targetCommit, coordinator: initial.coordinator });
  const resumedLog = log.slice(first.log.length);
  expect(resumedLog).toContain('[verbose] stdout:\n  fixture partial output');
  expect(resumedLog).toContain('[verbose] stderr:\n  fixture preparation failure');
});

it.each(['flag', 'environment', 'default'])('carries %s diagnostics through release preparation', mode => {
  const fixture = installation('build');
  const { record, log, stderr, stdout } = fixture.run(mode === 'flag' ? ['--verbose'] : [], mode === 'environment' ? '1' : '');
  expect(record.verbose === true).toBe(mode !== 'default');
  expectPreparationDiagnostics(record, log, mode !== 'default');
  expect(stdout).not.toContain('[verbose]');
  expect(fs.statSync(fixture.logPath(record)).mode & 0o777).toBe(0o600);
  expect(`${log}\n${stderr}`).not.toContain('fixture-secret-token');
});

it.each([
  { mode: 'retained verbose', initialFlags: ['--verbose'], resumeFlags: [], verbose: true },
  { mode: 'enabled verbose', initialFlags: [], resumeFlags: ['--verbose'], verbose: true },
  { mode: 'quiet', initialFlags: [], resumeFlags: [], verbose: false },
])('resumes release preparation with $mode diagnostics', ({ initialFlags, resumeFlags, verbose }) => {
  const fixture = installation('build');
  const first = fixture.run(initialFlags);
  const initial = first.record;
  const { record, log, stderr } = fixture.run(['--resume', initial.run.id, ...resumeFlags]);
  expect(record.run.id).toBe(initial.run.id);
  expect(record).toMatchObject({ targetCommit: initial.targetCommit, coordinator: initial.coordinator });
  expect(record.verbose === true).toBe(verbose);
  expectPreparationDiagnostics(record, log.slice(first.log.length), verbose);
  expect(fs.statSync(fixture.logPath(record)).mode & 0o777).toBe(0o600);
  expect(`${log}\n${stderr}`).not.toContain('fixture-secret-token');
});

function expectPreparationDiagnostics(record, log, verbose) {
  expect(record.run).toMatchObject({ state: 'failed', resumable: true, phase: 'prepare' });
  expect(record.transition.mutating).not.toBe(true);
  expect(log).toContain('fixture build failure');
  const release = record.transition.release;
  const commands = log.split(/^\$ /m).slice(1);
  const preparation = commands.slice(commands.findIndex(block => block.startsWith('node -v\n')));
  expect(preparation.map(block => block.split('\n')[0])).toEqual([
    'node -v', 'npm -v', 'npm ci',
    `python3 -m venv ${release}/.update-tools/uv`,
    expect.stringMatching(/^.*\/\.update-tools\/uv\/bin\/pip install uv==/),
    `${release}/.update-tools/uv/bin/uv --version`,
    ...['asr', 'documentation-indexer'].map(service =>
      `${release}/.update-tools/uv/bin/uv sync --locked --python 3.12 --managed-python --project ${release}/services/${service} --extra dev`),
    'npm run build',
  ]);
  for (const block of preparation) {
    expect(block.includes(`[verbose] cwd: ${release}\n`), block).toBe(verbose);
    expect(block.includes('[verbose] env:'), block).toBe(verbose);
    expect(block.includes('CLOUDX_HOST=127.0.0.1'), block).toBe(verbose);
  }
  if (!verbose) expect(log).not.toContain('[verbose]');
}

function installation(failAt = 'git') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-update-verbose-'));
  roots.push(root);
  const repoRoot = path.join(root, 'checkout'), home = path.join(root, 'home');
  const dataDir = path.join(repoRoot, '.cloudx');
  const stateDir = path.join(home, '.local/state/cloudx/settings-update');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.config/cloudx'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/cloudx/cloudx.env'), `CLOUDX_DATA_DIR=${dataDir}\n`);
  for (const service of SERVICE_NAMES) fs.writeFileSync(path.join(home, '.config/systemd/user', service), 'fixture unit\n');
  const logPath = record => path.join(stateDir, `${record.run.id}.log`);
  return {
    logPath,
    run(flags, verboseEnvironment = '') {
      const output = spawnSync(process.execPath, [new URL('./install-cloudx.mjs', import.meta.url).pathname,
        '--update', '--checkout', repoRoot, '--target-commit', 'a'.repeat(40), '--non-interactive', ...flags], {
        cwd: repoRoot, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, CLOUDX_TEST_UPDATE_HOME: home, CLOUDX_INSTALL_ROOT: repoRoot,
          CLOUDX_TEST_UPDATE_FAILURE: failAt, CLOUDX_HOST: '127.0.0.1',
          CLOUDX_INSTALL_VERBOSE: verboseEnvironment, SECRET_TOKEN: 'fixture-secret-token',
          NODE_OPTIONS: `--import=${new URL('./helpers/managed-update-cli-host.mjs', import.meta.url).href}` },
      });
      expect(output.status, output.stderr || output.stdout).toBe(0);
      const { id } = JSON.parse(fs.readFileSync(path.join(stateDir, 'latest.json'), 'utf8'));
      const record = JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.json`), 'utf8'));
      return { ...output, record, log: fs.readFileSync(logPath(record), 'utf8') };
    },
  };
}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SERVICE_NAMES } from './install-update.mjs';
import { verifySnapshot } from './managed-update-store.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it.each([undefined, 'preview.service'])('prepares through the real installer without changing %s or claiming activation', service => {
  const fixture = installation(service);
  const first = fixture.run(['--no-start']);
  expectPrepared(first.record);
  expect(first.stdout).toContain('not activated');
  expect(first.stdout).toContain(`--resume ${first.record.run.id}`);
  expect(first.log).toContain('$ npm run build');
  expect(first.log).toContain('$ npm ci');
  expect(first.log.includes('$ python3 -m venv')).toBe(!service);
  expect(fixture.commands().filter(item => item.status !== undefined).map(item => item.status)).toEqual([0, 0]);
  for (const [relative, manifest] of Object.entries(first.record.transition.buildManifests))
    expect(() => verifySnapshot(path.join(first.record.transition.release, relative), manifest)).not.toThrow();
  fixture.expectUntouched();

  const status = fixture.run(['--status']);
  expect(status.record.run).toEqual(first.record.run);
  expect(status.stdout).toContain('"state": "prepared"');
  const resumed = fixture.run(['--resume', first.record.run.id, '--no-start']);
  expectPrepared(resumed.record);
  expect(resumed.record.coordinator).toBe(first.record.coordinator);
  expect(fixture.commands().filter(item => item.command === 'npm' && item.args.join(' ') === 'run build')).toHaveLength(1);
  fixture.expectUntouched();
});

it('retains preparation-only intent when retrying a failed build, then asks for consent before activation', () => {
  const fixture = installation('preview.service');
  const failed = fixture.run(['--no-start'], 'build');
  expect(failed.record.run).toMatchObject({ state: 'failed', phase: 'prepare', resumable: true });
  const prepared = fixture.run(['--resume', failed.record.run.id]);
  expectPrepared(prepared.record);
  expect(prepared.record).toMatchObject({ targetCommit: failed.record.targetCommit, coordinator: failed.record.coordinator });
  fixture.expectUntouched();

  const pending = fixture.run(['--resume', prepared.record.run.id], '', 1);
  expect(pending.stdout).toContain('"confirmation"');
  expect(pending.record.run.state).toBe('prepared');
  expect(pending.record.confirmInterruption).toBe(false);
  fixture.expectUntouched();
});

function expectPrepared(record) {
  expect(record).toMatchObject({ noStart: true, transition: { completed: ['prepare'] },
    run: { state: 'prepared', phase: 'prepared', resumable: true, message: expect.stringContaining('not activated') } });
  expect(record.run.recoveryAction).toContain('resume');
  expect(record.transition.mutating).not.toBe(true);
  for (const field of ['snapshots', 'activationIntent', 'targetStarted', 'replaced']) expect(record.transition[field]).toBeUndefined();
}

function installation(service) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-update-no-start-'));
  roots.push(root);
  const repoRoot = path.join(root, 'checkout'), home = path.join(root, 'home');
  const dataDir = path.join(repoRoot, '.cloudx'), stateDir = path.join(home, '.local/state/cloudx/settings-update');
  const retained = {
    [path.join(repoRoot, 'apps/server/dist/index.js')]: '// installed runtime\n',
    [path.join(repoRoot, 'node_modules/installed.txt')]: 'installed dependencies\n',
    [path.join(dataDir, 'user.txt')]: 'original profile\n',
    [path.join(repoRoot, 'local-work.txt')]: 'unrelated work\n',
    [path.join(home, '.config/cloudx/cloudx.env')]: `CLOUDX_DATA_DIR=${dataDir}\n`,
    ...Object.fromEntries([...SERVICE_NAMES, 'preview.service'].map(name => [path.join(home, '.config/systemd/user', name), 'fixture unit\n'])),
  };
  for (const [file, content] of Object.entries(retained)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.writeFileSync(path.join(home, 'update-cgroup'), '0::/user.slice/cloudx-settings-update.service\n');
  const commands = () => fs.readFileSync(path.join(home, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return {
    commands,
    expectUntouched() {
      for (const [file, content] of Object.entries(retained)) expect(fs.readFileSync(file, 'utf8')).toBe(content);
      expect(commands().filter(item => item.command === 'systemctl' && item.args[1] !== 'show')).toEqual([]);
      expect(commands().filter(item => item.command === 'git' && item.args[0] === 'read-tree' && item.cwd === repoRoot)
        .every(item => item.args.includes('--dry-run'))).toBe(true);
      expect(commands().filter(item => item.command === 'git' && item.cwd === repoRoot && ['checkout', 'reset', 'update-ref'].includes(item.args[0]))).toEqual([]);
    },
    run(flags, failAt = '', expectedExit = 0) {
      const output = spawnSync(process.execPath, [new URL('./install-cloudx.mjs', import.meta.url).pathname,
        '--update', '--checkout', repoRoot, '--target-commit', 'a'.repeat(40), '--non-interactive',
        ...(service ? ['--service', service, '--port', '3443'] : []), ...flags], {
        cwd: repoRoot, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, CLOUDX_TEST_UPDATE_HOME: home, CLOUDX_INSTALL_ROOT: repoRoot,
          CLOUDX_TEST_UPDATE_FAILURE: failAt, CLOUDX_TEST_UPDATE_ACTIVE: service ?? 'cloudx.service', CLOUDX_INSTALL_VERBOSE: '',
          NODE_OPTIONS: `--import=${new URL('./helpers/managed-update-cli-host.mjs', import.meta.url).href}` },
      });
      expect(output.status, output.stderr || output.stdout).toBe(expectedExit);
      const { id } = JSON.parse(fs.readFileSync(path.join(stateDir, 'latest.json'), 'utf8'));
      const record = JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.json`), 'utf8'));
      return { ...output, record, log: fs.readFileSync(path.join(stateDir, `${id}.log`), 'utf8') };
    },
  };
}

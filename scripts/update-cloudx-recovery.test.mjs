import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { SettingsUpdater } from './settings-update.mjs';
import { SERVICE_NAMES } from './install-update.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const historical = 'c664071e04091db6be78df09d8c91a1975e9313c';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it.each(['standard', 'custom'])('retains offline CLI status and resume after historical checkout replacement (%s service)', kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx retained-cli-'space-"));
  roots.push(root);
  const home = path.join(root, 'home'), checkout = path.join(root, 'checkout');
  const dataDir = path.join(home, 'profile'), envPath = path.join(home, 'saved.env');
  const runId = 'b1440a6d-90c8-4679-b638-f1b230ab3701';
  const names = kind === 'custom' ? ['preview.service'] : SERVICE_NAMES;
  fs.mkdirSync(dataDir, { recursive: true });
  git(root, ['clone', '--shared', '--no-checkout', source, checkout]);
  git(checkout, ['checkout', '--detach', 'HEAD']);
  const updater = new SettingsUpdater({ repoRoot: checkout, home });
  const record = { repoRoot: checkout, home, dataDir, envPath, targetCommit: historical,
    ...(kind === 'custom' ? { service: names[0], port: '3443', host: '127.0.0.1' } : {}),
    run: { id: runId, state: 'failed', phase: 'activate', message: 'Interrupted activation',
      startedAt: '2026-09-22T12:00:00.000Z', resumable: true, targetCommit: historical },
    transition: { mutating: true, completed: ['prepare', 'quiesce', 'snapshot'],
      environmentText: `CLOUDX_DATA_DIR=${dataDir}\n`,
      serviceTarget: { kind: kind === 'custom' ? 'web' : 'standard', serviceNames: names } },
  };
  updater.stage(record);
  updater.publish(record);
  git(checkout, ['checkout', '--detach', historical]);
  expect(fs.existsSync(path.join(checkout, 'scripts/update-cloudx.mjs'))).toBe(false);
  expect(fs.existsSync(envPath)).toBe(false);

  const preload = path.join(root, 'host.mjs'), trace = path.join(root, 'commands.jsonl');
  fs.writeFileSync(preload, `
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    const record = JSON.parse(fs.readFileSync(${JSON.stringify(updater.recordPath(runId))}, 'utf8'));
    let launched = false;
    os.homedir = () => record.home;
    childProcess.spawnSync = (command, args) => {
      fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ command, args }) + '\\n');
      let output;
      if (command === 'systemctl' && args[1] === 'show') {
        const name = args[2];
        output = name === 'cloudx-settings-update.service'
          ? { LoadState: launched ? 'loaded' : 'not-found', ActiveState: launched ? 'active' : 'inactive',
              Description: launched ? 'CloudX Settings update ' + record.run.id : '' }
          : { Id: name, LoadState: 'loaded', ActiveState: 'inactive', MainPID: '0', ControlGroup: '',
              WorkingDirectory: record.repoRoot, EnvironmentFiles: record.envPath + ' (ignore_errors=no)',
              FragmentPath: record.home + '/.config/systemd/user/' + name };
      } else if (command === 'systemd-run') {
        launched = true;
        output = {};
      } else throw new Error('Unexpected host command: ' + command);
      return { status: 0, stdout: Object.entries(output).map(([key, value]) => key + '=' + value).join('\\n'), stderr: '' };
    };
    syncBuiltinESMExports();
  `);
  const entry = path.join(record.coordinator, 'scripts/update-cloudx.mjs');
  const invoke = flags => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--checkout', checkout, ...flags], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    return result.stdout;
  };
  expect(JSON.parse(invoke(['--status']))).toMatchObject({ available: true, run: record.run });
  expect(fs.readFileSync(trace, 'utf8')).not.toContain('systemd-run');
  const resumed = invoke(['--resume', runId, '--non-interactive']);
  expect(resumed).toContain('"state": "running"');
  expect(resumed).toContain(entry.replaceAll("'", "'\\''"));
  expect(updater.read(runId)).toMatchObject({ targetCommit: historical, coordinator: record.coordinator,
    run: { id: runId, state: 'running', phase: 'activate' }, transition: record.transition });
  const printedStatus = resumed.split('\n').find(line => line.endsWith(' --status'));
  const printed = spawnSync('/bin/sh', ['-c', printedStatus], { cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(preload).href)}` } });
  expect(printed.status, printed.stderr).toBe(0);
  expect(JSON.parse(printed.stdout).run.id).toBe(runId);
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const launches = calls.filter(call => call.command === 'systemd-run');
  expect(launches).toHaveLength(1);
  expect(launches[0].args.slice(launches[0].args.indexOf('--') + 1)).toEqual([
    process.execPath, path.join(record.coordinator, 'scripts/settings-update.mjs'), 'run', runId,
  ]);
  expect(fs.readFileSync(path.join(updater.stateDir, runId, 'recovery.env'), 'utf8')).toBe(record.transition.environmentText);
  expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(historical);
});

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  }).trim();
}

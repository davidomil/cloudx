import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedUpdate, UpdateHost, validateSavedTransition } from './managed-update.mjs';
import { BROKER, cleanupUpdates, git, updateFixture, write } from './helpers/managed-update-rollback-fixture.mjs';

afterEach(cleanupUpdates);

function directWebUpdate({ originalBroker = 'active' } = {}) {
  const f = updateFixture({ activate: false, originalBroker });
  const service = 'selected-web.service';
  f.record.service = service;
  f.record.transition.serviceTarget = f.host.target = { kind: 'web', serviceNames: [service] };
  f.record.transition.serviceStates = { [service]: 'ActiveState=inactive' };
  f.record.transition.integration = { version: 1, files: [], independentReadiness: true, terminalMode: 'direct' };
  f.states[service] = { ...f.states['cloudx.service'], EnvironmentFiles: `${f.host.paths.envPath} (ignore_errors=no)` };
  f.brokerFile = path.join(f.host.paths.systemdDir, 'selected-terminal.service');
  f.brokerUnit = `[Unit]\nDescription=Existing custom broker\n\n[Service]\nWorkingDirectory=${f.root}\nExecStart=/usr/bin/node ${f.root}/apps/server/dist/terminal/broker.js\nEnvironment=CUSTOM_SETTING=retained\n`;
  write(f.brokerFile, f.brokerUnit);
  fs.chmodSync(f.brokerFile, 0o640);
  Object.assign(f.states[BROKER], f.originalStates[BROKER], { FragmentPath: f.brokerFile, DropInPaths: '' });
  const inspect = f.commands.inspect;
  f.commands.inspect = (command, args, options) => {
    const result = inspect(command, args, options);
    if (command !== 'systemctl') return result;
    const properties = args.find(arg => arg.startsWith('--property=')).slice('--property='.length).split(',');
    return result.split('\n').filter(line => properties.includes(line.split('=')[0])).join('\n');
  };
  write(path.join(f.host.paths.systemdDir, service), `[Unit]\nWants=${BROKER}\n`);
  f.record.transition.mutating = true;
  return f;
}

function snapshotDirectUpdate(f) {
  f.host.prepareDirectBroker(f.record);
  Object.assign(f.states[BROKER], { ActiveState: 'inactive', MainPID: '0', InvocationID: '' });
  f.host.snapshot(f.record);
}

function recoveryHost(f, record) {
  return new UpdateHost({ repoRoot: f.root, home: f.host.home, dataDir: f.dataDir, service: f.record.service,
    runDir: f.host.runDir, commands: f.commands, save: f.save, recovery: record.transition });
}

describe('service transitions to targets without persistent terminal brokers', () => {
  it('guards the generated standard broker unit and omits its explicit startup for a direct target', () => {
    const f = updateFixture({ activate: false });
    f.record.transition.integration = { version: 1, files: [], independentReadiness: true, terminalMode: 'direct' };
    f.host.snapshot(f.record); f.host.activate(f.record); f.host.start(f.record);
    expect(fs.readFileSync(path.join(f.host.paths.systemdDir, BROKER), 'utf8')).toContain(`ConditionPathExists=${f.root}/apps/server/dist/terminal/broker.js`);
    expect(f.events.filter(event => event.action === 'start').map(event => event.service)).not.toContain(BROKER);
    expect(f.events.filter(event => event.action === 'start').map(event => event.service)).toContain('cloudx.service');
  });

  it.each(['active', 'inactive'])('restores the owned custom broker configuration and its original %s state after target failure', originalBroker => {
    const f = directWebUpdate({ originalBroker });
    snapshotDirectUpdate(f); f.host.activate(f.record);
    const modified = fs.readFileSync(f.brokerFile, 'utf8');
    expect(modified).toContain(f.brokerUnit);
    expect(modified).toContain(`ConditionPathExists=${f.root}/apps/server/dist/terminal/broker.js`);
    expect(fs.statSync(f.brokerFile).mode & 0o777).toBe(0o640);
    f.host.start(f.record);
    const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(() => validateSavedTransition(record, f.host.runDir)).not.toThrow();
    recoveryHost(f, record).restore(record);
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toBe(f.brokerUnit);
    expect(f.states[BROKER].ActiveState).toBe(originalBroker);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(record.transition.sourceCommit);
    expect(fs.statSync(f.brokerFile).mode & 0o777).toBe(0o640);
  });

  it.each(['active', 'inactive'])('restores the custom broker state at activation after it was %s during preparation', async originalBroker => {
    const f = directWebUpdate({ originalBroker });
    f.host.prepareDirectBroker(f.record);
    Object.assign(f.record.transition, { mutating: false, localPatch: f.host.localChanges(),
      environmentText: fs.readFileSync(f.host.paths.envPath, 'utf8') });
    vi.spyOn(f.host, 'planData').mockImplementation(() => {});
    f.record.noStart = true;
    const execute = () => new ManagedUpdate({ record: f.record, host: f.host, save: f.save }).run();
    expect(await execute()).toMatchObject({ state: 'prepared' });
    const activationState = originalBroker === 'active' ? 'inactive' : 'active';
    Object.assign(f.states[BROKER], { ActiveState: activationState, MainPID: activationState === 'active' ? '100' : '0',
      InvocationID: activationState === 'active' ? 'b'.repeat(32) : '', ControlGroup: activationState === 'active' ? '/cloudx-fixture/broker' : '' });
    f.record.noStart = false;
    f.record.confirmInterruption = true;
    expect(await execute()).toMatchObject({ state: 'failed', phase: 'verify' });
    expect(f.record.transition.directBroker.state).toContain(`ActiveState=${activationState}`);
    expect(f.states[BROKER].ActiveState).toBe(activationState);
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toBe(f.brokerUnit);
    expect(f.events.some(event => event.action === 'start' && event.service === BROKER)).toBe(activationState === 'active');
  });

  it('prepares again before activating when an owned broker appears during the preparation pause', async () => {
    const f = directWebUpdate({ originalBroker: 'missing' });
    f.host.prepareDirectBroker(f.record);
    Object.assign(f.record.transition, { mutating: false, localPatch: f.host.localChanges(),
      environmentText: fs.readFileSync(f.host.paths.envPath, 'utf8') });
    vi.spyOn(f.host, 'planData').mockImplementation(() => {});
    f.record.noStart = true;
    const execute = () => new ManagedUpdate({ record: f.record, host: f.host, save: f.save }).run();
    expect(await execute()).toMatchObject({ state: 'prepared' });
    expect(f.record.transition.directBroker).toBeUndefined();

    f.states[BROKER].LoadState = 'loaded';
    f.record.noStart = false;
    expect(await execute()).toMatchObject({ state: 'failed', phase: 'quiesce', component: 'services', resumable: true });
    expect(f.record.transition.completed).toEqual([]);
    expect(f.record.transition.mutating).toBe(false);
    expect(f.events).toEqual([]);
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toBe(f.brokerUnit);

    const prepare = vi.spyOn(f.host, 'prepare').mockImplementation(record => f.host.prepareDirectBroker(record));
    const checkGuard = vi.fn(() => expect(fs.readFileSync(f.brokerFile, 'utf8'))
      .toContain(`ConditionPathExists=${f.root}/apps/server/dist/terminal/broker.js`));
    f.commands.afterStart = checkGuard;
    expect(await execute()).toMatchObject({ state: 'failed', phase: 'verify' });
    expect(prepare).toHaveBeenCalledOnce();
    expect(checkGuard).toHaveBeenCalledOnce();
    expect(f.record.transition.directBroker.file).toBe(f.brokerFile);
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toBe(f.brokerUnit);
  });

  it('journals and restores the owned backing file when systemd reports a runtime unit link', () => {
    const f = directWebUpdate();
    const managerPath = path.join(f.host.home, 'runtime/systemd/user', path.basename(f.brokerFile));
    fs.mkdirSync(path.dirname(managerPath), { recursive: true });
    fs.symlinkSync(f.brokerFile, managerPath);
    f.states[BROKER].FragmentPath = managerPath;
    snapshotDirectUpdate(f); f.host.activate(f.record);
    expect(f.record.transition.directBroker.file).toBe(f.brokerFile);
    expect(f.record.transition.configuration.map(entry => entry.file)).not.toContain(managerPath);
    expect(fs.lstatSync(managerPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(managerPath, 'utf8')).toContain('ConditionPathExists=');
    const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(() => validateSavedTransition(record, f.host.runDir)).not.toThrow();
    recoveryHost(f, record).restore(record);
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toBe(f.brokerUnit);
    expect(fs.lstatSync(managerPath).isSymbolicLink()).toBe(true);
    expect(f.states[BROKER].ActiveState).toBe('active');
    const otherUnit = path.join(f.host.paths.systemdDir, 'another.service');
    write(otherUnit, 'another unit');
    fs.unlinkSync(managerPath); fs.symlinkSync(otherUnit, managerPath);
    expect(() => recoveryHost(f, record)).toThrow('one owned terminal broker unit');
    expect(fs.readFileSync(otherUnit, 'utf8')).toBe('another unit');
  });

  it('restores the broker unit and active state with a new coordinator after real SIGKILL following its atomic replacement', () => {
    const f = directWebUpdate(); snapshotDirectUpdate(f);
    const child = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      import { UpdateHost } from ${JSON.stringify(new URL('./managed-update.mjs', import.meta.url).href)};
      import { writeUpdateJson } from ${JSON.stringify(new URL('./managed-update-store.mjs', import.meta.url).href)};
      const recordPath = process.argv[1], record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      const brokerFile = record.transition.directBroker.file;
      const host = Object.assign(Object.create(UpdateHost.prototype), {
        home: record.home, runDir: recordPath.slice(0, -5), save: value => writeUpdateJson(recordPath, value),
        paths: { repoRoot: record.repoRoot, dataDir: record.dataDir, envPath: path.join(record.home, '.config/cloudx/cloudx.env'), systemdDir: path.dirname(brokerFile) },
        target: record.transition.serviceTarget, envConfig: record.transition.environment,
        runner: {
          inspect(command, args) {
            if (command === 'git') return execFileSync(command, args, { cwd: record.repoRoot, encoding: 'utf8' }).trim();
            return 'LoadState=loaded\\nActiveState=inactive\\nMainPID=0\\nControlGroup=\\nWorkingDirectory=' + record.repoRoot + '\\nFragmentPath=' + brokerFile + '\\nDropInPaths=';
          },
          run() {},
        },
      });
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        rename(source, destination);
        if (destination === brokerFile) process.kill(process.pid, 'SIGKILL');
      };
      host.activate(record);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', child, f.recordPath], { encoding: 'utf8', timeout: 30000 });
    expect(result.signal, result.stderr).toBe('SIGKILL');
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toContain('ConditionPathExists=');
    const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(() => validateSavedTransition(record, f.host.runDir)).not.toThrow();
    recoveryHost(f, record).restore(record);
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toBe(f.brokerUnit);
    expect(f.states[BROKER].ActiveState).toBe('active');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(record.transition.sourceCommit);
  });

  it.each(['foreign checkout', 'missing broker'])('leaves a %s untouched', ownership => {
    const f = directWebUpdate();
    if (ownership === 'foreign checkout') f.states[BROKER].WorkingDirectory = path.join(f.host.home, 'another-checkout');
    else f.states[BROKER].LoadState = 'not-found';
    f.host.prepareDirectBroker(f.record);
    expect(f.record.transition.directBroker).toBeUndefined();
    f.host.snapshot(f.record); f.host.activate(f.record);
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toBe(f.brokerUnit);
  });

  it.each(['outside unit', 'symlink', 'hardlink', 'drop-in'])('rejects an owned broker with an unsafe %s before modifying it', boundary => {
    const f = directWebUpdate();
    if (boundary === 'outside unit') {
      f.states[BROKER].FragmentPath = path.join(f.host.home, 'outside.service');
      write(f.states[BROKER].FragmentPath, f.brokerUnit);
    }
    if (boundary === 'drop-in') f.states[BROKER].DropInPaths = path.join(f.host.paths.systemdDir, `${BROKER}.d/override.conf`);
    if (boundary === 'hardlink') fs.linkSync(f.brokerFile, path.join(f.host.home, 'linked.service'));
    if (boundary === 'symlink') {
      const outside = path.join(f.host.home, 'outside.service');
      fs.renameSync(f.brokerFile, outside); fs.symlinkSync(outside, f.brokerFile);
    }
    expect(() => f.host.prepareDirectBroker(f.record)).toThrow(/terminal broker/);
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toBe(f.brokerUnit);
    expect(f.events).toEqual([]);
  });

  it('rejects a broker unit changed between preparation and snapshot', () => {
    const f = directWebUpdate(); f.host.prepareDirectBroker(f.record);
    fs.appendFileSync(f.brokerFile, '# user edit\n');
    expect(() => f.host.snapshot(f.record)).toThrow('unit changed during preparation');
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toContain('# user edit');
  });

  it.each(['outside path', 'unrelated recovery file', 'mismatched contents', 'changed service identity'])('rejects a saved broker with %s during recovery', corruption => {
    const f = directWebUpdate(); snapshotDirectUpdate(f); f.host.activate(f.record);
    const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    if (corruption === 'changed service identity') {
      f.states[BROKER].FragmentPath = path.join(f.host.paths.systemdDir, 'another.service');
      write(f.states[BROKER].FragmentPath, 'another unit');
      expect(() => recoveryHost(f, record)).toThrow('one owned terminal broker unit');
    } else {
      if (corruption === 'outside path') record.transition.directBroker.file = path.join(f.host.home, 'outside.service');
      if (corruption === 'unrelated recovery file') record.transition.configuration.push({ file: path.join(f.host.paths.systemdDir, 'unrelated.service'), content: '' });
      if (corruption === 'mismatched contents') record.transition.configuration.find(entry => entry.file === f.brokerFile).content = Buffer.from('wrong unit').toString('base64');
      expect(() => validateSavedTransition(record, f.host.runDir)).toThrow(/configuration/);
    }
    expect(fs.readFileSync(f.brokerFile, 'utf8')).toContain('ConditionPathExists=');
  });
});

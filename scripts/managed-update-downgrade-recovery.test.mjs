import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedUpdate, UpdateHost, validateSavedTransition } from './managed-update.mjs';
import { snapshotTree, verifySnapshot, writeUpdateJson } from './managed-update-store.mjs';
import { cleanupUpdates, git, updateFixture, write } from './helpers/managed-update-rollback-fixture.mjs';

afterEach(cleanupUpdates);

function catalogSchema(directory, version) {
  fs.mkdirSync(directory, { recursive: true });
  execFileSync('python3', ['-I', '-S', '-c', 'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("PRAGMA user_version=" + sys.argv[2])', path.join(directory, 'catalog.sqlite'), String(version)]);
}

function preparedDowngrade({ externalDocumentation = false } = {}) {
  const f = updateFixture({ activate: false, originalWeb: 'active' });
  const t = f.record.transition;
  const archive = externalDocumentation ? path.join(f.host.home, 'archive') : path.join(f.dataDir, 'documentation');
  if (externalDocumentation) f.host.envConfig.CLOUDX_DOCUMENTATION_DATA_DIR = archive;
  write(path.join(t.release, 'services/documentation-indexer/src/cloudx_documentation_indexer/catalog_schema.py'), 'SCHEMA_VERSION = 2\n');
  write(path.join(t.release, 'apps/server/src/workspace/SessionStateStore.ts'), 'if (value.version !== 1) throw new Error();\n');
  write(path.join(f.dataDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id: 'original-session' }], layout: 'older layout' }));
  write(path.join(f.dataDir, 'terminal-runtime/retained.json'), 'live runtime state');
  write(f.forgeFile, JSON.stringify([{ id: 'review', status: 'completed', updatedAt: '2026-09-22T00:00:00.000Z', tabId: 'saved-tab', attemptId: 'saved-attempt', publicationId: 'already-published', draft: { status: 'posted' } }]));
  write(path.join(f.dataDir, 'forge-workers/workspaces/review.json'), JSON.stringify({ id: 'review', launchPending: false, gitPending: false, cleaned: false }));
  write(path.join(f.dataDir, 'forge-workers/tabs/saved-tab.json'), JSON.stringify({ tabId: 'saved-tab', workerId: 'review', attemptId: 'saved-attempt', closed: true, quiescent: true }));
  catalogSchema(archive, 2);
  const id = randomUUID(), stateDir = path.dirname(f.host.runDir), historicalRun = path.join(stateDir, id);
  const roots = [f.dataDir, ...(externalDocumentation ? [archive] : [])];
  const snapshots = roots.map((root, index) => {
    const destination = path.join(historicalRun, `data-${index}`);
    return { root, destination, manifest: snapshotTree(root, destination, { exclude: relative => relative.startsWith('terminal-runtime') }) };
  });
  writeUpdateJson(path.join(stateDir, `${id}.json`), { home: f.host.home, repoRoot: f.root, dataDir: f.dataDir,
    run: { id, startedAt: '2026-09-21T00:00:00.000Z' }, transition: { sourceCommit: f.record.targetCommit, environment: f.host.envConfig, snapshots } });
  catalogSchema(archive, 3);
  write(path.join(f.dataDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id: 'original-session' }], layout: 'current layout' }));
  write(path.join(f.dataDir, 'newer-user-data.txt'), 'retained newer user data');
  f.record.restoreSnapshotRunId = id;
  f.record.confirmInterruption = true;
  f.host.planData(f.record);
  expect(t.dataCompatibility).toMatchObject({ compatible: false, archiveSchema: 3, targetArchiveSchema: 2 });
  expect(t.restoreData).toHaveLength(roots.length);
  t.mutating = true;
  t.completed = ['prepare', 'quiesce', 'snapshot'];
  f.host.stopWriters();
  f.host.snapshot(f.record);
  return { ...f, archive };
}

function failCopy(f, boundary) {
  const sync = fs.fsyncSync, copy = fs.copyFileSync;
  if (boundary === 'after clearing') return vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    sync(fd);
    if (fs.realpathSync(`/proc/self/fd/${fd}`) === f.dataDir && !fs.existsSync(f.forgeFile))
      throw Object.assign(new Error('disk is full after clearing'), { code: 'ENOSPC' });
  });
  return vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, mode) => {
    const destination = fs.realpathSync(path.dirname(target));
    if (String(target).endsWith('.restore') && (boundary === 'first copy' || boundary === 'external archive' && destination === f.archive))
      throw Object.assign(new Error('disk is full during downgrade copy'), { code: 'ENOSPC' });
    copy(source, target, mode);
  });
}

function freshCoordinator(f) {
  const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
  validateSavedTransition(record, f.host.runDir);
  const host = new UpdateHost({ home: f.host.home, repoRoot: f.root, dataDir: f.dataDir, runDir: f.host.runDir,
    save: f.save, commands: f.commands, recovery: record.transition });
  host.quiesce = () => { throw new Error('Target retry deferred by test'); };
  return { record, host, update: new ManagedUpdate({ record, save: f.save, host }) };
}

async function expectCoherentRecovery(f) {
  const { record, update } = freshCoordinator(f);
  expect(await update.run()).toMatchObject({ state: 'failed', phase: 'quiesce', resumable: true });
  expect(record.transition).toMatchObject({ restored: true, mutating: false });
  expect(record.transition.snapshotApplication).toBeUndefined();
  expect(record.transition.profileRestoration).toBeUndefined();
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(record.transition.sourceCommit);
  expect(git(f.root, 'write-tree')).toBe(record.transition.sourceIndex);
  expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toBe('previous runtime');
  expect(fs.readFileSync(f.host.paths.envPath, 'utf8')).toBe(`CLOUDX_DATA_DIR=${f.dataDir}\n`);
  expect(f.states['cloudx.service'].ActiveState).toBe('active');
  for (const snapshot of record.transition.snapshots) {
    verifySnapshot(snapshot.root, snapshot.manifest);
    verifySnapshot(snapshot.destination, snapshot.manifest);
  }
  for (const configuration of record.transition.configuration)
    expect(fs.readFileSync(configuration.file).toString('base64')).toBe(configuration.content);
  expect(fs.readFileSync(path.join(f.dataDir, 'terminal-runtime/retained.json'), 'utf8')).toBe('live runtime state');
  expect(fs.readFileSync(path.join(f.dataDir, 'newer-user-data.txt'), 'utf8')).toBe('retained newer user data');
  expect(fs.readFileSync(path.join(f.archive, 'catalog.sqlite')).readUInt32BE(60)).toBe(3);
  expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0].publicationId).toBe('already-published');
  return record;
}

describe('durable application of a confirmed downgrade snapshot', () => {
  it.each(['after clearing', 'first copy'])('recovers the previous installation with a fresh coordinator after ENOSPC at %s', async boundary => {
    const f = preparedDowngrade();
    const failure = failCopy(f, boundary);
    expect(() => f.host.activate(f.record)).toThrow('disk is full');
    const interrupted = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(interrupted.transition.snapshotApplication).toEqual(['copying']);
    expect(interrupted.transition.profileRestoration).toBeUndefined();
    expect(fs.existsSync(f.forgeFile)).toBe(false);
    failure.mockRestore();
    await expectCoherentRecovery(f);
  });

  it.each(['after clearing', 'during Forge copying', 'after restoring a tab before its workspace'])('recovers with a fresh coordinator after real SIGKILL %s', async boundary => {
    const f = preparedDowngrade();
    const child = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      import { UpdateHost, validateSavedTransition } from ${JSON.stringify(new URL('./managed-update.mjs', import.meta.url).href)};
      import { writeUpdateJson } from ${JSON.stringify(new URL('./managed-update-store.mjs', import.meta.url).href)};
      const [recordPath, boundary] = process.argv.slice(1);
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      const runDir = recordPath.slice(0, -5);
      validateSavedTransition(record, runDir);
      const host = new UpdateHost({ home: record.home, repoRoot: record.repoRoot, dataDir: record.dataDir, runDir,
        save: value => writeUpdateJson(recordPath, value), recovery: record.transition,
        commands: {
          inspect(command, args) {
            if (command === 'git') return execFileSync(command, args, { cwd: record.repoRoot, encoding: 'utf8' }).trim();
            return 'LoadState=loaded\\nActiveState=inactive\\nMainPID=0\\nControlGroup=\\nWorkingDirectory=' + record.repoRoot;
          },
          run() {},
        },
      });
      const sync = fs.fsyncSync, copy = fs.copyFileSync, rename = fs.renameSync;
      fs.fsyncSync = fd => {
        sync(fd);
        if (boundary === 'after clearing' && fs.realpathSync('/proc/self/fd/' + fd) === record.dataDir &&
            !fs.existsSync(${JSON.stringify(f.forgeFile)})) process.kill(process.pid, 'SIGKILL');
      };
      fs.copyFileSync = (source, target, mode) => {
        copy(source, target, mode);
        if (boundary === 'during Forge copying' && String(target).endsWith('.restore') &&
            fs.realpathSync(path.dirname(target)).includes('/forge-workers/tabs')) process.kill(process.pid, 'SIGKILL');
      };
      fs.renameSync = (source, target) => {
        rename(source, target);
        if (boundary === 'after restoring a tab before its workspace' && String(source).endsWith('.restore') &&
            fs.realpathSync(path.dirname(target)).includes('/forge-workers/tabs')) process.kill(process.pid, 'SIGKILL');
      };
      host.activate(record);
      process.exitCode = 2;
    `;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', child, f.recordPath, boundary], { encoding: 'utf8', timeout: 10000 });
    expect(killed.error, killed.stderr).toBeUndefined();
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    expect(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')).transition.snapshotApplication).toEqual(['copying']);
    if (boundary === 'during Forge copying') expect(fs.readdirSync(path.join(f.dataDir, 'forge-workers/tabs')).some(name => name.endsWith('.restore'))).toBe(true);
    await expectCoherentRecovery(f);
  });

  it('restores both data roots after the older profile was applied and the external archive copy failed', async () => {
    const f = preparedDowngrade({ externalDocumentation: true });
    const failure = failCopy(f, 'external archive');
    expect(() => f.host.activate(f.record)).toThrow('disk is full');
    expect(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')).transition.snapshotApplication).toEqual(['applied', 'copying']);
    failure.mockRestore();
    await expectCoherentRecovery(f);
  });

  it('continues rollback after both downgrade application and the rollback profile copy run out of space', async () => {
    const f = preparedDowngrade({ externalDocumentation: true });
    const applicationFailure = failCopy(f, 'external archive');
    expect(() => f.host.activate(f.record)).toThrow('disk is full');
    applicationFailure.mockRestore();
    const rollbackFailure = failCopy(f, 'first copy');
    expect(await freshCoordinator(f).update.run()).toMatchObject({ state: 'failed', phase: 'restore', resumable: true });
    const interrupted = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(interrupted.transition.snapshotApplication).toEqual(['applied', 'copying']);
    expect(interrupted.transition.profileRestoration).toEqual(['copying']);
    rollbackFailure.mockRestore();
    await expectCoherentRecovery(f);
  });

  it('does not clear active data when persisting snapshot application intent fails', () => {
    const f = preparedDowngrade();
    f.host.save = record => {
      if (record.transition.snapshotApplication?.includes('copying')) throw Object.assign(new Error('cannot persist snapshot intent'), { code: 'ENOSPC' });
      f.save(record);
    };
    expect(() => f.host.activate(f.record)).toThrow('cannot persist snapshot intent');
    for (const snapshot of f.record.transition.snapshots) verifySnapshot(snapshot.root, snapshot.manifest);
    expect(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')).transition.snapshotApplication).toBeUndefined();
  });

  it('preserves an actual publication written after interrupted snapshot application', async () => {
    const f = preparedDowngrade();
    const failure = failCopy(f, 'after clearing');
    expect(() => f.host.activate(f.record)).toThrow('disk is full');
    failure.mockRestore();
    f.publish();
    const { update } = freshCoordinator(f);
    expect(await update.run()).toMatchObject({ state: 'failed', phase: 'restore', component: 'forge' });
    expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0].publicationId).toBe('published-review-42');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.targetCommit);
  });

  it('rejects deleted Forge records after snapshot application completed', async () => {
    const f = preparedDowngrade();
    f.host.activate(f.record);
    expect(f.record.transition.snapshotApplication).toEqual(['applied']);
    fs.rmSync(f.forgeFile);
    const { update } = freshCoordinator(f);
    expect(await update.run()).toMatchObject({ state: 'failed', phase: 'restore', component: 'forge' });
  });

  it.each(['publication', 'deletion'])('keeps strict ownership checks after starting the target: %s', async change => {
    const f = preparedDowngrade();
    f.host.activate(f.record);
    f.host.start(f.record);
    expect(f.record.transition.snapshotApplication).toBeUndefined();
    if (change === 'publication') f.publish();
    else fs.rmSync(f.forgeFile);
    const { update } = freshCoordinator(f);
    expect(await update.run()).toMatchObject({ state: 'failed', phase: 'restore', component: 'forge' });
    if (change === 'publication') expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0].publicationId).toBe('published-review-42');
    else expect(fs.existsSync(f.forgeFile)).toBe(false);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.targetCommit);
  });

  it('does not treat unrelated Forge temporary files as updater-owned copies', async () => {
    const f = preparedDowngrade();
    const failure = failCopy(f, 'after clearing');
    expect(() => f.host.activate(f.record)).toThrow('disk is full');
    failure.mockRestore();
    const foreign = path.join(f.dataDir, `forge-workers/tabs/new-worker.json.${randomUUID()}.restore`);
    write(foreign, 'unrelated worker data');
    const { update } = freshCoordinator(f);
    expect(await update.run()).toMatchObject({ state: 'failed', phase: 'restore', resumable: true });
    expect(fs.readFileSync(foreign, 'utf8')).toBe('unrelated worker data');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.targetCommit);
  });

  it('checks publication state again before applying the selected historical snapshot', () => {
    const f = preparedDowngrade();
    f.publish();
    expect(() => f.host.activate(f.record)).toThrow('publication records changed');
    expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0].publicationId).toBe('published-review-42');
    expect(fs.readFileSync(path.join(f.dataDir, 'newer-user-data.txt'), 'utf8')).toBe('retained newer user data');
  });

  it.each([null, ['unknown'], ['copying', 'copying'], ['applied', 'copying']])('rejects invalid snapshot application progress: %j', progress => {
    const f = preparedDowngrade();
    f.record.transition.activationIntent = true;
    f.record.transition.snapshotApplication = progress;
    expect(() => validateSavedTransition(f.record, f.host.runDir)).toThrow('snapshot application progress');
  });

  it.each([{ restored: true }, { mutating: false }, { activationIntent: false }, { targetStarted: true }])('rejects inconsistent snapshot application progress: %j', flags => {
    const f = preparedDowngrade();
    Object.assign(f.record.transition, { activationIntent: true, snapshotApplication: ['copying'] }, flags);
    expect(() => validateSavedTransition(f.record, f.host.runDir)).toThrow('snapshot application progress');
  });
});

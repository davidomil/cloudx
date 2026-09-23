import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedUpdate, UpdateHost, validateSavedTransition } from './managed-update.mjs';
import { verifySnapshot } from './managed-update-store.mjs';
import { cleanupUpdates, FORGE_STATE, git, updateFixture, write } from './helpers/managed-update-rollback-fixture.mjs';

afterEach(cleanupUpdates);

function activatedUpdate({ externalDocumentation = false } = {}) {
  const f = updateFixture({ activate: false, originalWeb: 'active' });
  if (externalDocumentation) {
    f.host.envConfig.CLOUDX_DOCUMENTATION_DATA_DIR = path.join(f.host.home, 'archive');
    write(path.join(f.host.envConfig.CLOUDX_DOCUMENTATION_DATA_DIR, 'document.txt'), 'original external archive');
  }
  write(path.join(f.dataDir, 'sessions.json'), '{"session":"original-session","layout":"original-layout"}');
  write(path.join(f.dataDir, 'documentation/archive.txt'), 'original archive');
  write(path.join(f.dataDir, 'terminal-runtime/retained.json'), 'live runtime state');
  write(f.forgeFile, JSON.stringify([{ id: 'review', status: 'completed', updatedAt: '2026-09-22T00:00:00.000Z', tabId: 'saved-tab', attemptId: 'saved-attempt', publicationId: 'already-published', draft: { status: 'posted' } }]));
  write(path.join(f.dataDir, 'forge-workers/workspaces/review.json'), JSON.stringify({ id: 'review', launchPending: false, gitPending: false, cleaned: false }));
  write(path.join(f.dataDir, 'forge-workers/tabs/saved-tab.json'), JSON.stringify({ tabId: 'saved-tab', workerId: 'review', attemptId: 'saved-attempt', closed: true, quiescent: true }));
  f.record.transition.mutating = true;
  f.record.transition.completed = ['prepare', 'quiesce', 'snapshot', 'activate'];
  f.host.snapshot(f.record);
  f.host.activate(f.record);
  f.host.start(f.record);
  write(path.join(f.dataDir, 'sessions.json'), '{"session":"original-session","schema":2}');
  write(path.join(f.dataDir, 'new-target-data.txt'), 'retain this newer data');
  return f;
}

function injectCopyFailure(f, boundary) {
  const fsync = fs.fsyncSync, copy = fs.copyFileSync;
  let copies = 0;
  if (boundary === 'after clearing') return vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    fsync(fd);
    if (fs.realpathSync(`/proc/self/fd/${fd}`) === f.dataDir && !fs.existsSync(f.forgeFile))
      throw Object.assign(new Error('disk is full after clearing'), { code: 'ENOSPC' });
  });
  return vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, mode) => {
    if (String(destination).endsWith('.restore') && ++copies === 2)
      throw Object.assign(new Error('disk is full during profile copy'), { code: 'ENOSPC' });
    return copy(source, destination, mode);
  });
}

async function resumeRestoration(f, refreshedAt) {
  const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
  validateSavedTransition(record, f.host.runDir);
  const host = Object.assign(Object.create(UpdateHost.prototype), f.host);
  // Stop at the next attempt after the fresh coordinator restores the installation.
  host.quiesce = () => { throw new Error('Target retry deferred by test'); };
  const result = await new ManagedUpdate({ record, save: f.save, host }).run();
  expect(result).toMatchObject({ state: 'failed', phase: 'quiesce', resumable: true });
  expect(record.transition).toMatchObject({ restored: true, mutating: false });
  expect(record.transition.profileRestoration).toBeUndefined();
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(record.transition.sourceCommit);
  expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toBe('previous runtime');
  expect(fs.readFileSync(f.host.paths.envPath, 'utf8')).toBe(`CLOUDX_DATA_DIR=${f.dataDir}\n`);
  expect(f.states['cloudx.service'].ActiveState).toBe('active');
  for (const snapshot of record.transition.snapshots) verifySnapshot(snapshot.root, refreshedAt && snapshot.root === f.dataDir
    ? snapshot.manifest.filter(entry => entry.path !== FORGE_STATE) : snapshot.manifest);
  if (refreshedAt) expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0].updatedAt).toBe(refreshedAt);
  expect(fs.readFileSync(path.join(f.dataDir, 'terminal-runtime/retained.json'), 'utf8')).toBe('live runtime state');
  expect(fs.existsSync(path.join(f.dataDir, 'new-target-data.txt'))).toBe(false);
  const retained = record.transition.retainedFailedData;
  expect(retained).toHaveLength(record.transition.snapshots.length);
  verifySnapshot(retained[0].destination, retained[0].manifest);
  expect(fs.readFileSync(path.join(retained[0].destination, 'new-target-data.txt'), 'utf8')).toBe('retain this newer data');
  return record;
}

describe('durable restoration of an interrupted profile copy', () => {
  it('retains snapshot directories while replacing nested files and links without following redirects', () => {
    const f = updateFixture({ activate: false });
    const directory = path.join(f.dataDir, 'documentation');
    const outside = path.join(f.host.home, 'unrelated');
    write(path.join(outside, 'keep.txt'), 'Unrelated data');
    write(path.join(directory, 'nested/original.txt'), 'Original nested data');
    write(path.join(directory, 'file.txt'), 'Original file');
    fs.symlinkSync(outside, path.join(directory, 'link'));
    f.host.snapshot(f.record);
    const identity = fs.statSync(directory, { bigint: true });
    f.host.activate(f.record);
    f.host.start(f.record);
    fs.rmSync(path.join(directory, 'nested'), { recursive: true });
    fs.symlinkSync(outside, path.join(directory, 'nested'));
    fs.rmSync(path.join(directory, 'file.txt'));
    write(path.join(directory, 'file.txt/target.txt'), 'Target directory');
    fs.unlinkSync(path.join(directory, 'link'));
    write(path.join(directory, 'link/target.txt'), 'Target link replacement');
    write(path.join(directory, 'target-only/extra.txt'), 'New target data');

    f.host.restore(f.record);

    const restored = fs.statSync(directory, { bigint: true });
    expect([restored.ino, restored.birthtimeNs]).toEqual([identity.ino, identity.birthtimeNs]);
    expect(fs.readFileSync(path.join(directory, 'nested/original.txt'), 'utf8')).toBe('Original nested data');
    expect(fs.readFileSync(path.join(directory, 'file.txt'), 'utf8')).toBe('Original file');
    expect(fs.readlinkSync(path.join(directory, 'link'))).toBe(outside);
    expect(fs.existsSync(path.join(directory, 'target-only'))).toBe(false);
    expect(fs.readdirSync(outside)).toEqual(['keep.txt']);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('Unrelated data');
  });

  it.each(['after clearing', 'during copying'])('restores the complete profile and services with a fresh coordinator after ENOSPC %s', async boundary => {
    const f = activatedUpdate();
    const failure = injectCopyFailure(f, boundary);
    const result = await new ManagedUpdate({ record: f.record, save: f.save, host: f.host }).run();
    expect(result).toMatchObject({ state: 'failed', resumable: true });
    expect(result.recoveryAction).toContain('ENOSPC');
    const interrupted = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(interrupted.transition.profileRestoration).toEqual(['copying']);
    expect(interrupted.transition.failedData).toHaveLength(1);
    expect(interrupted.transition.mutating).toBe(true);
    expect(f.states['cloudx.service'].ActiveState).toBe('inactive');
    failure.mockRestore();
    await resumeRestoration(f);
  });

  it.each(['after clearing', 'during Forge copying', 'after restoring a tab before its workspace'])('restores with a fresh coordinator after real SIGKILL %s', async boundary => {
    const f = activatedUpdate();
    const child = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      import { ManagedUpdate, UpdateHost } from ${JSON.stringify(new URL('./managed-update.mjs', import.meta.url).href)};
      import { writeUpdateJson } from ${JSON.stringify(new URL('./managed-update-store.mjs', import.meta.url).href)};
      const [recordPath, boundary] = process.argv.slice(1);
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      const save = value => writeUpdateJson(recordPath, value);
      const host = Object.assign(Object.create(UpdateHost.prototype), {
        home: record.home, runDir: recordPath.slice(0, -5), save,
        paths: { repoRoot: record.repoRoot, dataDir: record.dataDir }, target: record.transition.serviceTarget,
        runner: {
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
      await new ManagedUpdate({ record, save, host }).run();
      process.exitCode = 2;
    `;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', child, f.recordPath, boundary], { encoding: 'utf8', timeout: 10000 });
    expect(killed.error, killed.stderr).toBeUndefined();
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    expect(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')).transition.profileRestoration).toEqual(['copying']);
    if (boundary === 'during Forge copying') expect(fs.readdirSync(path.join(f.dataDir, 'forge-workers/tabs')).some(name => name.endsWith('.restore'))).toBe(true);
    await resumeRestoration(f);
  });

  it('still refuses a publication written after the interrupted clear', async () => {
    const f = activatedUpdate();
    const failure = injectCopyFailure(f, 'after clearing');
    expect(() => f.host.restore(f.record)).toThrow('disk is full');
    failure.mockRestore();
    f.publish();
    const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    const host = Object.assign(Object.create(UpdateHost.prototype), f.host);
    const result = await new ManagedUpdate({ record, save: f.save, host }).run();
    expect(result).toMatchObject({ state: 'failed', phase: 'restore', component: 'forge' });
    expect(result.cause).toContain('prevent repeating published work');
    expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0].publicationId).toBe('published-review-42');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.targetCommit);
  });

  it.each([false, true])('resumes an external archive copy without repeating an already restored profile (Forge timestamp refreshed: %s)', async refreshTimestamp => {
    const f = activatedUpdate({ externalDocumentation: true });
    const archive = f.host.envConfig.CLOUDX_DOCUMENTATION_DATA_DIR;
    write(path.join(archive, 'document.txt'), 'newer external archive');
    const copy = fs.copyFileSync;
    const failure = vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, mode) => {
      if (String(target).endsWith('.restore') && fs.realpathSync(path.dirname(target)) === archive)
        throw Object.assign(new Error('external archive is full'), { code: 'ENOSPC' });
      copy(source, target, mode);
    });
    expect(() => f.host.restore(f.record)).toThrow('external archive is full');
    expect(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')).transition.profileRestoration).toEqual(['restored', 'copying']);
    failure.mockRestore();
    const refreshedAt = refreshTimestamp ? '2026-09-22T01:00:00.000Z' : undefined;
    if (refreshedAt) {
      const workers = JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'));
      workers[0].updatedAt = refreshedAt;
      write(f.forgeFile, JSON.stringify(workers));
    }
    const profileCopies = [];
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, mode) => {
      if (String(target).endsWith('.restore') && fs.realpathSync(path.dirname(target)).startsWith(`${f.dataDir}/`)) profileCopies.push(target);
      copy(source, target, mode);
    });
    const record = await resumeRestoration(f, refreshedAt);
    expect(profileCopies).toEqual([]);
    expect(fs.readFileSync(path.join(archive, 'document.txt'), 'utf8')).toBe('original external archive');
    expect(fs.readFileSync(path.join(record.transition.retainedFailedData[1].destination, 'document.txt'), 'utf8')).toBe('newer external archive');
  });

  it.each([null, ['unknown'], ['copying', 'copying'], ['copying']])('rejects a malformed or unbacked restoration journal: %j', progress => {
    const f = activatedUpdate();
    f.record.transition.profileRestoration = progress;
    expect(() => validateSavedTransition(f.record, f.host.runDir)).toThrow('profile restoration progress');
  });

  it.each([{ restored: true }, { mutating: false }, { targetStarted: false }])('rejects restoration progress with contradictory transition flags: %j', flags => {
    const f = activatedUpdate();
    const failure = injectCopyFailure(f, 'after clearing');
    expect(() => f.host.restore(f.record)).toThrow('disk is full');
    failure.mockRestore();
    const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    Object.assign(record.transition, flags);
    expect(() => validateSavedTransition(record, f.host.runDir)).toThrow('profile restoration progress');
  });
});

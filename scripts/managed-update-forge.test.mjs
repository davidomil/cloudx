import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgeWorkflowService } from '../apps/server/src/forge/ForgeWorkflowService.ts';
import { ForgeWorkflowStore, ForgeWorkerReports } from '../apps/server/src/forge/ForgeWorkflowStore.ts';
import { ForgeRuntime } from '../apps/server/src/forge/ForgeRuntime.ts';
import { PluginDataStore } from '../apps/server/src/plugins/PluginDataStore.ts';
import { PathPolicy } from '../apps/server/src/pathPolicy.ts';
import { readDirectoryIdentity } from '../apps/server/src/directoryIdentity.ts';
import { ManagedUpdate, UpdateHost, validateSavedTransition } from './managed-update.mjs';
import { cleanupUpdates, FORGE_STATE, git, runPreparedUpdate, updateFixture, write } from './helpers/managed-update-rollback-fixture.mjs';

const services = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  vi.useRealTimers();
  cleanupUpdates();
});

async function forgeUpdate({ status = 'completed', published = status === 'completed' } = {}) {
  const f = updateFixture({ activate: false, originalWeb: 'active' });
  const store = new ForgeWorkflowStore(new PluginDataStore(f.dataDir));
  const worker = {
    id: randomUUID(), kind: 'review', number: 7, changeNumber: 7, title: 'Review update',
    repository: { provider: 'github', apiUrl: 'https://api.github.com', projectPath: 'fixture/cloudx' },
    baseBranch: 'main', templateId: 'review', status, autoPost: false,
    startedAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
    draft: {
      id: randomUUID(), startedAt: '2026-09-20T10:00:00.000Z', headSha: 'a'.repeat(40),
      body: 'Review findings', comments: [], event: 'comment', status: published ? 'posted' : 'draft',
      ...(published ? { publication: { commentIds: ['review-42'] }, postedAt: '2026-09-20T10:01:00.000Z' } : {}),
    },
  };
  await store.write([worker]);
  const original = await store.read();
  const provider = {
    getChangeRequest: vi.fn(async () => ({ state: 'open', merged: false, headSha: worker.draft.headSha })),
    postReview: vi.fn(async () => ({ commentIds: ['review-43'] })),
  };
  const deps = {
    store, reports: new ForgeWorkerReports(f.dataDir), settings: () => ({ repository: worker.repository }),
    runtime: { launch: vi.fn(), recover: vi.fn() }, provider: vi.fn(() => provider), notify: vi.fn(),
  };
  const forge = new ForgeWorkflowService(deps);
  services.push(forge);
  return { ...f, store, original, worker, provider, deps, forge };
}

async function pausedWorkspace() {
  const f = updateFixture({ activate: false, originalWeb: 'active' });
  const id = randomUUID(), tabs = new Map(), contexts = new Map();
  const repository = { provider: 'github', apiUrl: 'https://api.github.com', projectPath: 'fixture/cloudx' };
  const origin = 'https://github.com/fixture/cloudx.git';
  const deps = {
    dataDir: f.dataDir, pathPolicy: new PathPolicy([f.host.home]),
    isRepositoryTrusted: () => true,
    gitAccess: async () => ({ cloneUrl: origin, authorization: 'Basic fixture-secret' }),
    git: async (cwd, args) => git(cwd, ...args.map(argument => argument === origin && args[0] === 'fetch' ? f.root : argument)),
    sessions: {
      getTab: tabId => tabs.get(tabId), listTabs: () => [...tabs.values()],
      getContextDirectory: tabId => contexts.get(tabId),
      getSession: () => ({ attachTerminal: async () => ({ screen: { data: 'Paused worker output', cols: 80, rows: 24 }, dispose() {} }) }),
      executePluginAction: vi.fn(async tabId => { tabs.get(tabId).status = 'stopped'; return {}; }),
      discardPreparedTab: vi.fn(async tabId => { tabs.delete(tabId); }),
    },
    workspaceCommands: { createTab: vi.fn(async (request, options) => {
      await options.authorizeProjectTrust();
      const tab = { ...request, id: randomUUID(), ownerPluginId: 'forge' };
      const context = path.join(f.dataDir, 'context', tab.id);
      tab.contextPath = path.join(context, 'context.md');
      write(tab.contextPath, 'Preserve the worker context');
      write(path.join(f.dataDir, 'codex-launches', tab.id, 'config.toml'), 'Preserve the worker launch');
      contexts.set(tab.id, await readDirectoryIdentity(context));
      tabs.set(tab.id, tab);
      return { tab };
    }) },
    rulesSkills: { list: async () => ({ templates: [{ id: 'worker' }] }) },
  };
  const runtime = new ForgeRuntime(deps);
  const workspace = { id, ...await runtime.prepareWorkspace({ id, expectedRepository: repository, baseBranch: 'main' }) };
  const request = { id, worktreePath: workspace.worktreePath, attemptId: 'first-attempt', templateId: 'worker',
    model: 'gpt-6-astra', reasoningEffort: 'xhigh', prompt: 'Resolve the issue.', windowId: 'window', paneId: 'pane' };
  const tabId = await runtime.launch(request);
  await runtime.pause(tabId);
  write(f.forgeFile, JSON.stringify([{ id, status: 'paused', worktreePath: workspace.worktreePath, tabId, attemptId: request.attemptId }]));
  write(path.join(workspace.worktreePath, 'local-work.txt'), 'Uncommitted worker work');
  const owned = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'forge-workers/workspaces', `${id}.json`), 'utf8'));
  const tab = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'forge-workers/tabs', `${tabId}.json`), 'utf8'));
  const identities = [owned.worktree, owned.gitDirectory, tab.context, tab.launch];
  return { ...f, deps, workspace, request, identities };
}

describe('Forge rollback ownership', () => {
  it.each(['rollback', 'snapshot application', 'interrupted rollback'])('preserves a real paused worker workspace, context and launch through %s', async operation => {
    const f = await pausedWorkspace();
    if (operation === 'snapshot application') {
      f.host.snapshot(f.record);
      f.record.transition.restoreData = f.record.transition.snapshots;
      f.commands.afterStart = service => {
        if (service !== 'cloudx.service') return;
        for (const identity of f.identities) {
          const stat = fs.statSync(identity.path, { bigint: true });
          expect(stat.ino.toString()).toBe(identity.ino);
          expect(stat.birthtimeNs.toString()).toBe(identity.durable.birthtimeNs);
        }
      };
    }
    const fsync = fs.fsyncSync;
    const failure = operation === 'interrupted rollback' && vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      fsync(fd);
      if (fs.realpathSync(`/proc/self/fd/${fd}`) === f.dataDir && !fs.existsSync(f.forgeFile))
        throw Object.assign(new Error('Disk full after clearing profile files'), { code: 'ENOSPC' });
    });
    const result = await runPreparedUpdate(f);
    expect(result).toMatchObject({ state: 'failed', phase: 'verify', component: 'verify', resumable: true });
    if (failure) {
      expect(f.record.transition.profileRestoration).toEqual(['copying']);
      failure.mockRestore();
      f.record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
      validateSavedTransition(f.record, f.host.runDir);
      const host = Object.assign(Object.create(UpdateHost.prototype), f.host, {
        quiesce() { throw new Error('Target retry deferred by test'); },
      });
      const resumed = await new ManagedUpdate({ record: f.record, save: f.save, host }).run();
      expect(resumed).toMatchObject({ state: 'failed', phase: 'quiesce' });
    }
    expect(f.record.transition).toMatchObject({ restored: true, mutating: false });
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.transition.sourceCommit);
    for (const identity of f.identities) expect(await readDirectoryIdentity(identity.path)).toEqual(identity);
    expect(fs.readFileSync(path.join(f.workspace.worktreePath, 'local-work.txt'), 'utf8')).toBe('Uncommitted worker work');
    expect(f.deps.workspaceCommands.createTab).toHaveBeenCalledOnce();
    const resumed = new ForgeRuntime(f.deps);
    await expect(resumed.previewOwnership(f.workspace.id)).resolves.toMatchObject({ directories: [] });
    const tabId = await resumed.launch({ ...f.request, attemptId: 'second-attempt' });
    expect(f.deps.sessions.getTab(tabId)).toMatchObject({ cwd: f.workspace.worktreePath, pluginMetadata: { 'forge-workers': { workerId: f.workspace.id } } });
    expect(f.deps.workspaceCommands.createTab).toHaveBeenCalledTimes(2);
  }, 15000);

  it('does not rebind a replaced worker directory during rollback', async () => {
    const f = await pausedWorkspace();
    const original = path.join(f.host.home, 'original-worker');
    f.commands.afterStart = service => {
      if (service !== 'cloudx.service' || fs.existsSync(original)) return;
      fs.renameSync(f.workspace.worktreePath, original);
      fs.cpSync(original, f.workspace.worktreePath, { recursive: true });
    };
    await runPreparedUpdate(f);
    expect(f.record.transition.restored).toBe(true);
    const resumed = new ForgeRuntime(f.deps);
    await expect(resumed.previewOwnership(f.workspace.id)).rejects.toThrow('ownership changed');
    await expect(resumed.launch({ ...f.request, attemptId: 'second-attempt' })).rejects.toThrow('ownership changed');
    expect(f.deps.workspaceCommands.createTab).toHaveBeenCalledOnce();
  }, 15000);

  it.each([false, true])('restores a profile without prior Forge state after empty-store initialization (fresh coordinator: %s)', async freshCoordinator => {
    const f = await forgeUpdate();
    fs.unlinkSync(f.forgeFile);
    const start = f.host.start.bind(f.host), restore = f.host.restore.bind(f.host);
    vi.spyOn(f.host, 'start').mockImplementation(async record => {
      start(record);
      f.forge.start();
      expect((await f.forge.dashboard()).workers).toEqual([]);
      expect(await f.store.read()).toEqual([]);
    });
    vi.spyOn(f.host, 'restore').mockImplementation(async record => {
      await f.forge.dispose();
      expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))).toEqual([]);
      if (freshCoordinator) throw new Error('Coordinator interrupted before rollback');
      return restore(record);
    });

    const result = await runPreparedUpdate(f);
    expect(result).toMatchObject({ state: 'failed', phase: 'verify', resumable: true });
    let record = f.record;
    if (freshCoordinator) {
      record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
      validateSavedTransition(record, f.host.runDir);
      expect(record.transition).toMatchObject({ mutating: true, targetStarted: true });
      expect(git(f.root, 'rev-parse', 'HEAD')).toBe(record.targetCommit);
      const host = new UpdateHost({ repoRoot: f.root, home: f.host.home, dataDir: f.dataDir,
        runDir: f.host.runDir, commands: f.commands, save: f.save, recovery: record.transition });
      vi.spyOn(host, 'quiesce').mockImplementation(() => { throw new Error('Target retry deferred by test'); });
      const resumed = await new ManagedUpdate({ record, save: f.save, host }).run();
      expect(resumed).toMatchObject({ state: 'failed', phase: 'quiesce', resumable: true });
    }

    expect(record.transition).toMatchObject({ restored: true, mutating: false });
    expect(fs.existsSync(f.forgeFile)).toBe(false);
    expect(await f.store.read()).toEqual([]);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(record.transition.sourceCommit);
    expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toBe('previous runtime');
    expect(f.states['cloudx.service'].ActiveState).toBe('active');
    expect(f.events).toContainEqual({ action: 'start', service: 'cloudx.service', version: 'previous' });
    const retained = record.transition.retainedFailedData[0].destination;
    expect(JSON.parse(fs.readFileSync(path.join(retained, FORGE_STATE), 'utf8'))).toEqual([]);
    expect(f.deps.provider).not.toHaveBeenCalled();
    expect(f.deps.runtime.launch).not.toHaveBeenCalled();
    expect(f.deps.runtime.recover).not.toHaveBeenCalled();
  });

  it.each(['null', '{}', '""', '[', '[null]'])('does not treat a malformed workflow store as empty: %s', async content => {
    const f = updateFixture({ activate: false });
    fs.unlinkSync(f.forgeFile);
    f.commands.afterStart = service => { if (service === 'cloudx.service') write(f.forgeFile, content); };

    const result = await runPreparedUpdate(f);

    expect(result.state).toBe('failed');
    expect(f.record.transition.restored).not.toBe(true);
    expect(fs.readFileSync(f.forgeFile, 'utf8')).toBe(content);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.targetCommit);
  });

  it.each(['absent', 'empty'])('does not erase a worker published after a previously %s workflow store', async initial => {
    const f = updateFixture({ activate: false });
    if (initial === 'absent') fs.unlinkSync(f.forgeFile);
    else write(f.forgeFile, '[]');
    f.commands.afterStart = service => { if (service === 'cloudx.service') f.publish(); };

    const result = await runPreparedUpdate(f);

    expect(result).toMatchObject({ state: 'failed', component: 'forge' });
    expect(result.cause).toContain('prevent repeating published work');
    expect(f.record.transition.restored).not.toBe(true);
    expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0].publicationId).toBe('published-review-42');
  });

  it.each(['completed', 'paused', 'awaiting_review', 'stopped', 'failed'])('restores after Forge startup and shutdown only refresh the timestamp of a worker in %s state', async status => {
    const f = await forgeUpdate({ status });
    const start = f.host.start.bind(f.host), restore = f.host.restore.bind(f.host);
    let started, stopped;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(f.host, 'start').mockImplementation(async record => {
      start(record);
      vi.setSystemTime(new Date('2026-09-22T10:00:00.000Z'));
      f.forge.start();
      started = (await f.forge.dashboard()).workers;
    });
    vi.spyOn(f.host, 'restore').mockImplementation(async record => {
      vi.setSystemTime(new Date('2026-09-22T10:01:00.000Z'));
      await f.forge.dispose();
      stopped = await f.store.read();
      return restore(record);
    });

    const result = await runPreparedUpdate(f);

    expect(started).toEqual([{ ...f.original[0], updatedAt: '2026-09-22T10:00:00.000Z' }]);
    expect(stopped).toEqual([{ ...f.original[0], updatedAt: '2026-09-22T10:01:00.000Z' }]);
    expect(result).toMatchObject({ state: 'failed', phase: 'verify', component: 'verify', resumable: true });
    expect(f.record.transition).toMatchObject({ restored: true, mutating: false });
    expect(await f.store.read()).toEqual(f.original);
    expect(fs.readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('previous');
    expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toBe('previous runtime');
    expect(f.states['cloudx.service'].ActiveState).toBe('active');
    expect(f.events).toContainEqual({ action: 'start', service: 'cloudx.service', version: 'previous' });
    const retained = f.record.transition.retainedFailedData[0].destination;
    expect(JSON.parse(fs.readFileSync(path.join(retained, FORGE_STATE), 'utf8'))).toEqual(stopped);
    expect(f.deps.provider).not.toHaveBeenCalled();
    expect(f.deps.runtime.launch).not.toHaveBeenCalled();
    expect(f.deps.runtime.recover).not.toHaveBeenCalled();
  });

  it('keeps a completed review published through Forge during target startup posted after failed readiness', async () => {
    const f = await forgeUpdate({ published: false });
    const start = f.host.start.bind(f.host);
    vi.spyOn(f.host, 'start').mockImplementation(async record => {
      start(record);
      await f.forge.dashboard();
      await f.forge.submitReview(f.worker.id, f.worker.draft.id);
      await f.forge.dispose();
    });

    const result = await runPreparedUpdate(f);

    expect(result).toMatchObject({ state: 'failed', phase: 'verify', component: 'forge', resumable: true });
    expect(result.cause).toContain('prevent repeating published work');
    expect(f.record.transition).toMatchObject({ mutating: true });
    expect((await f.store.read())[0]).toMatchObject({ status: 'completed', draft: { status: 'posted', publication: { commentIds: ['review-43'] } } });
    expect(f.provider.postReview).toHaveBeenCalledTimes(1);
    expect(() => f.host.restore(f.record)).toThrow('prevent repeating published work');
    const restarted = new ForgeWorkflowService(f.deps);
    services.push(restarted);
    await expect(restarted.submitReview(f.worker.id, f.worker.draft.id)).rejects.toThrow('No unsubmitted review draft');
    expect(f.provider.postReview).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['worker start time', worker => { worker.startedAt = '2026-09-22T10:01:00.000Z'; }],
    ['review publication time', worker => { worker.draft.postedAt = '2026-09-22T10:01:00.000Z'; }],
    ['review publication receipt', worker => { worker.draft.publication.commentIds = ['review-43']; }],
    ['unknown nested timestamp', worker => { worker.otherOwnership = { updatedAt: '2026-09-22T10:01:00.000Z' }; }],
  ])('blocks restoration when the %s changes', async (_name, change) => {
    const f = await forgeUpdate();
    f.commands.afterStart = service => {
      if (service !== 'cloudx.service') return;
      const workers = structuredClone(f.original);
      change(workers[0]);
      write(f.forgeFile, JSON.stringify(workers));
    };
    const result = await runPreparedUpdate(f);
    expect(result.component).toBe('forge');
    expect(result.cause).toContain('prevent repeating published work');
    expect(f.record.transition.restored).not.toBe(true);
  });

  it('does not ignore updatedAt in execution ownership records', async () => {
    const f = await forgeUpdate();
    const execution = path.join(f.dataDir, 'forge-workers/executions', `${f.worker.id}.json`);
    write(execution, JSON.stringify({ workerId: f.worker.id, updatedAt: '2026-09-20T10:00:00.000Z' }));
    f.commands.afterStart = service => {
      if (service === 'cloudx.service') write(execution, JSON.stringify({ workerId: f.worker.id, updatedAt: '2026-09-22T10:01:00.000Z' }));
    };
    const result = await runPreparedUpdate(f);
    expect(result.component).toBe('forge');
    expect(result.cause).toContain('prevent repeating published work');
    expect(f.record.transition.restored).not.toBe(true);
  });
});

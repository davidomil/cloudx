import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgeWorkflowService } from '../apps/server/src/forge/ForgeWorkflowService.ts';
import { ForgeWorkflowStore, ForgeWorkerReports } from '../apps/server/src/forge/ForgeWorkflowStore.ts';
import { PluginDataStore } from '../apps/server/src/plugins/PluginDataStore.ts';
import { cleanupUpdates, FORGE_STATE, runPreparedUpdate, updateFixture, write } from './helpers/managed-update-rollback-fixture.mjs';

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

describe('Forge rollback ownership', () => {
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

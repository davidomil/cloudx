import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ForgeWorkflowService } from '../apps/server/src/forge/ForgeWorkflowService.ts';
import { ForgeWorkflowStore, ForgeWorkerReports } from '../apps/server/src/forge/ForgeWorkflowStore.ts';
import { PluginDataStore } from '../apps/server/src/plugins/PluginDataStore.ts';
import { PathPolicy } from '../apps/server/src/pathPolicy.ts';
import { ManagedUpdate, UpdateHost, validateSavedTransition } from './managed-update.mjs';
import { cleanupUpdates, git, runPreparedUpdate, updateFixture, write } from './helpers/managed-update-rollback-fixture.mjs';
import { cleanupHistoricalForge, historicalForge } from './helpers/managed-update-forge-history-fixture.mjs';

const services = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  cleanupUpdates();
  cleanupHistoricalForge();
});

async function originalProfile() {
  const history = historicalForge('c664071e', { integrate: false });
  const f = updateFixture({ activate: false, originalWeb: 'active' });
  fs.unlinkSync(f.forgeFile);
  const repository = { provider: 'github', apiUrl: 'https://api.github.com', projectPath: 'fixture/cloudx' };
  const origin = 'https://github.com/fixture/cloudx.git';
  const headSha = f.record.transition.sourceCommit;
  const provider = { getChangeRequest: vi.fn(async number => ({ number, headSha, baseSha: headSha, baseBranch: 'main',
    headBranch: 'feature', title: `Original review ${number}`, state: 'open', merged: false, comments: [], linkedIssues: [] })),
    postReview: vi.fn(async () => ({ commentIds: ['published-original'], inlineReview: { id: 'inline-original', commentCount: 1 } })) };
  const reports = new ForgeWorkerReports(f.dataDir);
  const runtime = new history.ForgeRuntime({ dataDir: f.dataDir, pathPolicy: new PathPolicy([f.host.home]),
    isRepositoryTrusted: () => true, gitAccess: async () => ({ cloneUrl: origin, authorization: 'Basic fixture' }),
    git: async (cwd, args) => git(cwd, ...args.map(arg => arg === origin && args[0] === 'fetch' ? f.root : arg)),
    sessions: { getTab: () => undefined, listTabs: () => [] }, workspaceCommands: {}, rulesSkills: {} });
  runtime.launch = vi.fn(async () => randomUUID());
  runtime.isActive = vi.fn(() => true);
  runtime.close = vi.fn(async () => {});
  runtime.workerHistory = vi.fn(async () => undefined);
  const settings = () => ({ repository, baseBranch: 'main', reviewTemplateId: 'review', reviewModel: 'fixture',
    reviewReasoningEffort: 'high', maxRunMinutes: 60 });
  const store = new history.ForgeWorkflowStore(new history.PluginDataStore(f.dataDir));
  const original = new history.ForgeWorkflowService({ store, reports, runtime, provider: () => provider, settings, notify: vi.fn() });
  services.push(original);
  for (const number of [7, 8]) {
    const worker = await original.startReview(repository, number, false, { windowId: 'window', paneId: 'pane' });
    expect(worker.status, worker.error).toBe('running');
    write(path.join(f.dataDir, 'forge-reports', `${worker.attemptId}.json`), JSON.stringify({ kind: 'review', headSha,
      event: 'approve', body: `Original review ${number}`, comments: [{ body: 'Original finding', path: 'version.txt', line: 1 }] }));
    await original.poll();
    expect((await original.dashboard()).workers.find(saved => saved.id === worker.id).status).toBe('completed');
    if (number === 7) await original.submitReview(worker.id);
  }
  await original.dispose();
  const saved = JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'));
  expect(saved).toHaveLength(2);
  for (const worker of saved) {
    expect(worker.draft.id).toBeUndefined();
    expect(worker.draft.startedAt).toBeUndefined();
    expect(worker.reviewBaseline).toBeUndefined();
    expect(worker.completion).toBeUndefined();
  }
  const currentStore = new ForgeWorkflowStore(new PluginDataStore(f.dataDir));
  const currentRuntime = { launch: vi.fn(), recover: vi.fn() };
  function restartCurrent() {
    const service = new ForgeWorkflowService({ store: currentStore, reports, runtime: currentRuntime,
      provider: () => provider, settings, notify: vi.fn() });
    services.push(service);
    return service;
  }
  const current = restartCurrent();
  const relative = 'apps/server/src/forge/ForgeWorkflowValidation.ts';
  write(path.join(f.record.transition.release, relative), fs.readFileSync(relative, 'utf8'));
  return { ...f, saved, currentStore, current, currentRuntime, restartCurrent, provider };
}

it('loads every original 0.1.3 review on upgrade and preserves posted receipts without publication', async () => {
  const f = await originalProfile();
  f.host.planData(f.record);
  expect(f.record.transition.dataCompatibility.compatible).toBe(true);
  const workers = (await f.current.dashboard()).workers;
  expect(workers).toHaveLength(f.saved.length);
  for (const { updatedAt, ...original } of f.saved) expect(workers.find(worker => worker.id === original.id)).toMatchObject({
    ...original, draft: { ...original.draft, id: original.id, startedAt: original.startedAt },
  });
  const posted = workers.find(worker => worker.draft.status === 'posted');
  await expect(f.current.submitReview(posted.id, posted.draft.id)).rejects.toThrow('No unsubmitted review draft');
  await f.current.dispose();
  expect(await f.currentStore.read()).toHaveLength(f.saved.length);
  expect(f.currentRuntime.launch).not.toHaveBeenCalled();
  expect(f.currentRuntime.recover).not.toHaveBeenCalled();
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 15000);

it.each(['c664071e', '224a75ef', 'a9613faf', '2e69451b', '39d42ec97528b24a15caa5bfa777dec103992fe3'])('retains original draft identity when the selected target is %s', async commit => {
  const f = await originalProfile();
  const target = historicalForge(commit);
  const record = { ...f.record, transition: { ...f.record.transition, release: target.root } };
  f.host.planData(record);
  expect(record.transition.dataCompatibility.compatible).toBe(true);
  const before = fs.readFileSync(f.forgeFile);
  const workers = await new target.ForgeWorkflowStore(new target.PluginDataStore(f.dataDir)).read();
  expect(workers).toHaveLength(f.saved.length);
  for (const original of f.saved) expect(workers.find(worker => worker.id === original.id).draft).toEqual({
    id: original.id, startedAt: original.startedAt, ...original.draft,
  });
  expect(fs.readFileSync(f.forgeFile)).toEqual(before);
}, 15000);

it.each([false, true])('restores original 0.1.3 reviews after target persistence and failed readiness (fresh Resume: %s)', async resume => {
  const f = await originalProfile();
  f.host.planData(f.record);
  const before = fs.readFileSync(f.forgeFile);
  const start = f.host.start.bind(f.host), restore = f.host.restore.bind(f.host);
  vi.spyOn(f.host, 'start').mockImplementation(async record => {
    start(record);
    await f.current.dashboard();
    await f.current.dispose();
    for (const worker of await f.currentStore.read()) expect(worker.draft.id).toBe(worker.id);
  });
  vi.spyOn(f.host, 'restore').mockImplementation(record => {
    if (resume) throw new Error('Coordinator stopped before restoration');
    return restore(record);
  });
  const result = await runPreparedUpdate(f);
  expect(result).toMatchObject({ state: 'failed', phase: 'verify', resumable: true });
  let record = f.record;
  if (resume) {
    record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    validateSavedTransition(record, f.host.runDir);
    const host = new UpdateHost({ repoRoot: f.root, home: f.host.home, dataDir: f.dataDir,
      runDir: f.host.runDir, commands: f.commands, save: f.save, recovery: record.transition });
    vi.spyOn(host, 'quiesce').mockImplementation(() => { throw new Error('Target retry deferred by test'); });
    expect(await new ManagedUpdate({ record, save: f.save, host }).run()).toMatchObject({ state: 'failed', phase: 'quiesce' });
  }
  expect(record.transition).toMatchObject({ restored: true, mutating: false });
  expect(fs.readFileSync(f.forgeFile)).toEqual(before);
  expect(await f.currentStore.read()).toHaveLength(f.saved.length);
  const restarted = f.restartCurrent();
  const workers = (await restarted.dashboard()).workers;
  expect(workers).toHaveLength(f.saved.length);
  const posted = workers.find(worker => worker.draft.status === 'posted');
  await expect(restarted.submitReview(posted.id, posted.draft.id)).rejects.toThrow('No unsubmitted review draft');
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(record.transition.sourceCommit);
  expect(f.states['cloudx.service'].ActiveState).toBe('active');
  expect(f.currentRuntime.launch).not.toHaveBeenCalled();
  expect(f.currentRuntime.recover).not.toHaveBeenCalled();
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 15000);

it.each(['publication', 'identity'])('keeps changed %s protected after an original historical profile loads', async change => {
  const f = await originalProfile();
  const start = f.host.start.bind(f.host);
  vi.spyOn(f.host, 'start').mockImplementation(async record => {
    start(record);
    const workers = (await f.current.dashboard()).workers;
    const draft = workers.find(worker => worker.draft.status === 'draft');
    if (change === 'publication') await f.current.submitReview(draft.id, draft.draft.id);
    await f.current.dispose();
    if (change === 'identity') {
      const saved = await f.currentStore.read();
      saved.find(worker => worker.id === draft.id).draft.id = randomUUID();
      await f.currentStore.write(saved);
    }
  });
  const result = await runPreparedUpdate(f);
  expect(result).toMatchObject({ state: 'failed', phase: 'verify', component: 'forge' });
  expect(result.cause).toContain('prevent repeating published work');
  expect(f.record.transition.restored).not.toBe(true);
  const saved = await f.currentStore.read();
  if (change === 'publication') {
    expect(saved.every(worker => worker.draft.status === 'posted')).toBe(true);
    expect(f.provider.postReview).toHaveBeenCalledTimes(2);
  } else expect(saved.find(worker => worker.draft.status === 'draft').draft.id).not.toBe(saved.find(worker => worker.draft.status === 'draft').id);
  expect(f.currentRuntime.launch).not.toHaveBeenCalled();
}, 15000);

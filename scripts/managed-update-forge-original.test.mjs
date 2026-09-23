import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ForgeWorkflowService } from '../apps/server/src/forge/ForgeWorkflowService.ts';
import { ForgeWorkflowStore, ForgeWorkerReports } from '../apps/server/src/forge/ForgeWorkflowStore.ts';
import { ForgeRuntime } from '../apps/server/src/forge/ForgeRuntime.ts';
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

async function originalProfile(targetCommit) {
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
  const runtimeDeps = { dataDir: f.dataDir, pathPolicy: new PathPolicy([f.host.home]),
    isRepositoryTrusted: () => true, gitAccess: async () => ({ cloneUrl: origin, authorization: 'Basic fixture' }),
    git: async (cwd, args) => git(cwd, ...args.map(arg => arg === origin && args[0] === 'fetch' ? f.root : arg)),
    sessions: { getTab: () => undefined, listTabs: () => [] }, workspaceCommands: {}, rulesSkills: {} };
  const runtime = new history.ForgeRuntime(runtimeDeps);
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
  const target = targetCommit ? historicalForge(targetCommit) :
    { ForgeWorkflowService, ForgeWorkflowStore, ForgeRuntime, PluginDataStore };
  const currentStore = new target.ForgeWorkflowStore(new target.PluginDataStore(f.dataDir));
  const currentRuntime = new target.ForgeRuntime(runtimeDeps);
  vi.spyOn(currentRuntime, 'launch').mockImplementation(async () => randomUUID());
  vi.spyOn(currentRuntime, 'recover');
  vi.spyOn(currentRuntime, 'close').mockResolvedValue();
  function restartCurrent() {
    const service = new target.ForgeWorkflowService({ store: currentStore, reports, runtime: currentRuntime,
      provider: () => provider, settings, notify: vi.fn() });
    services.push(service);
    return service;
  }
  const current = restartCurrent();
  if (targetCommit) f.record.transition.release = target.root;
  const relative = 'apps/server/src/forge/ForgeWorkflowValidation.ts';
  if (!targetCommit) write(path.join(f.record.transition.release, relative), fs.readFileSync(relative, 'utf8'));
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

const nativeTarget = '2f28a100cd765b8c209e85fdacb03b03a57ba0df';
const continuationTargets = [undefined, 'c664071e', '224a75ef', 'a9613faf', 'aec0d06e', '4083e120', '7604d8d', nativeTarget];
it.each(continuationTargets.flatMap(target => ['draft', 'posted'].map(status => ({ target, status }))))(
  'starts a fresh full review after an original 0.1.3 $status review on $target', async ({ target, status }) => {
  const f = await originalProfile(target);
  f.host.planData(f.record);
  expect(f.record.transition.dataCompatibility.compatible).toBe(true);
  const before = (await f.current.dashboard()).workers;
  const original = before.find(worker => worker.draft.status === status);
  expect(original.worktreePath).toBeUndefined();
  expect(original.reviewBaseline).toBeUndefined();
  const ownershipPath = path.join(f.dataDir, 'forge-workers', 'workspaces', `${original.id}.json`);
  const ownership = fs.readFileSync(ownershipPath);
  expect(JSON.parse(ownership)).toMatchObject({ cleaned: true });
  f.provider.getChangeRequest.mockImplementation(async number => ({ number, headSha: f.record.targetCommit,
    baseSha: f.record.transition.sourceCommit, baseBranch: 'main', headBranch: 'feature', title: `Next review ${number}`,
    state: 'open', merged: false, comments: [], linkedIssues: [] }));

  const next = await f.current.startReview(original.repository, original.number, false, { windowId: 'window', paneId: 'pane' });
  expect(next.status, next.error).toBe('running');
  expect(next.id).not.toBe(original.id);
  expect(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'forge-workers', 'workspaces', `${next.id}.json`), 'utf8')))
    .toMatchObject({ id: next.id, worktreePath: next.worktreePath });
  expect(next.reviewBaseline).toBeUndefined();
  expect(next.completion.reviewScope).toEqual({ kind: 'initial', current: {
    headSha: f.record.targetCommit, baseSha: f.record.transition.sourceCommit, mergeBaseSha: f.record.transition.sourceCommit,
  } });
  expect(git(next.worktreePath, 'diff', '--name-only', `${f.record.transition.sourceCommit}...${f.record.targetCommit}`)).toBe('version.txt');
  const context = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'forge-reports', `${next.attemptId}.context.json`), 'utf8'));
  expect(context.previousReviews).toEqual([original.draft]);
  expect(context.reviewScope).toEqual(next.completion.reviewScope);
  expect(f.currentRuntime.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    id: next.id, worktreePath: next.worktreePath, prompt: expect.stringContaining('review the full pinned PR/MR comparison'),
  }), expect.any(AbortSignal));
  expect(f.currentRuntime.recover).not.toHaveBeenCalled();
  expect(fs.readFileSync(ownershipPath)).toEqual(ownership);
  const saved = await f.currentStore.read();
  expect(saved).toHaveLength(before.length + 1);
  for (const { updatedAt, ...worker } of before) expect(saved.find(candidate => candidate.id === worker.id)).toMatchObject(worker);
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 15000);

it('excludes a native reviewer whose checkout is retained for file recovery', async () => {
  const f = await originalProfile(nativeTarget);
  const workers = await f.currentStore.read();
  const original = workers.find(worker => worker.draft.status === 'posted');
  const ownershipPath = path.join(f.dataDir, 'forge-workers', 'workspaces', `${original.id}.json`);
  const ownership = fs.readFileSync(ownershipPath);
  original.worktreePath = JSON.parse(ownership).worktreePath;
  original.retainedWorkspace = { worktreePath: original.worktreePath, retainedPaths: ['review-notes.txt'] };
  const retainedNotes = path.join(original.worktreePath, 'review-notes.txt');
  write(retainedNotes, 'Uncommitted review notes');
  await f.currentStore.write(workers);

  const next = await f.current.startReview(original.repository, original.number, false, { windowId: 'window', paneId: 'pane' });
  expect(next.status, next.error).toBe('running');
  expect(next.id).not.toBe(original.id);
  expect(next.worktreePath).not.toBe(original.worktreePath);
  expect(next.completion.reviewScope).toEqual({ kind: 'initial', current: {
    headSha: f.record.transition.sourceCommit, baseSha: f.record.transition.sourceCommit, mergeBaseSha: f.record.transition.sourceCommit,
  } });
  const context = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'forge-reports', `${next.attemptId}.context.json`), 'utf8'));
  expect(context.previousReviews).toEqual([original.draft]);
  expect(f.currentRuntime.recover).not.toHaveBeenCalled();
  expect(fs.readFileSync(ownershipPath)).toEqual(ownership);
  expect(fs.readFileSync(retainedNotes, 'utf8')).toBe('Uncommitted review notes');
  const { updatedAt, ...retainedReview } = original;
  expect((await f.currentStore.read()).find(worker => worker.id === original.id)).toMatchObject(retainedReview);
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 15000);

it.each(continuationTargets.flatMap(target => ['posting', 'post_failed'].map(status => ({ target, status }))))(
  'requires reconciliation of an original 0.1.3 $status review on $target before starting another', async ({ target, status }) => {
  const f = await originalProfile(target);
  const original = f.saved.find(worker => worker.draft.status === 'draft');
  original.draft.status = status;
  write(f.forgeFile, JSON.stringify(f.saved));
  const prepare = vi.spyOn(f.currentRuntime, 'prepareWorkspace');

  await expect(f.current.startReview(original.repository, original.number, false, { windowId: 'window', paneId: 'pane' }))
    .rejects.toThrow('The previous review submission must be reconciled');
  expect(prepare).not.toHaveBeenCalled();
  expect(f.currentRuntime.launch).not.toHaveBeenCalled();
  expect(f.currentRuntime.recover).not.toHaveBeenCalled();
  const saved = await f.currentStore.read();
  expect(saved).toHaveLength(f.saved.length);
  expect(saved.find(worker => worker.id === original.id)).toMatchObject({ status: 'completed', draft: { status: 'post_failed' } });
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 15000);

it.each([
  { target: 'a9613faf', missing: 'ownership' },
  { target: 'aec0d06e', missing: 'ownership' },
  { target: '7604d8d', missing: 'ownership' },
  { target: '7604d8d', missing: 'baseline' },
  { target: nativeTarget, missing: 'ownership' },
  { target: nativeTarget, missing: 'baseline' },
])('retains modern $missing protection on $target', async ({ target, missing }) => {
  const f = await originalProfile(target);
  const original = f.saved.find(worker => worker.draft.status === 'draft');
  const modern = await f.current.startReview(original.repository, 9, false, { windowId: 'window', paneId: 'pane' });
  expect(modern.status, modern.error).toBe('running');
  await f.current.dispose();
  const workers = await f.currentStore.read();
  const saved = workers.find(worker => worker.id === modern.id);
  Object.assign(saved, { status: 'completed', attemptId: undefined, tabId: undefined, completion: undefined,
    draft: { ...original.draft, id: randomUUID(), startedAt: modern.startedAt, status: 'draft' } });
  if (missing === 'ownership') {
    saved.reviewBaseline = { reviewId: saved.draft.id, revision: modern.completion.reviewScope.current };
    fs.unlinkSync(path.join(f.dataDir, 'forge-workers', 'workspaces', `${modern.id}.json`));
  }
  await f.currentStore.write(workers);
  const restarted = f.restartCurrent();
  const prepare = vi.spyOn(f.currentRuntime, 'prepareWorkspace');
  f.currentRuntime.launch.mockClear();

  const rejected = await restarted.startReview(original.repository, 9, false, { windowId: 'window', paneId: 'pane' });
  expect(rejected.id).toBe(modern.id);
  expect(rejected.status).not.toBe('running');
  expect(rejected.error).toContain(missing === 'ownership' ? 'ownership record is missing or invalid' : 'no verified baseline evidence');
  expect(prepare).not.toHaveBeenCalled();
  expect(f.currentRuntime.launch).not.toHaveBeenCalled();
  expect(await f.currentStore.read()).toHaveLength(workers.length);
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 15000);

it.each(['c664071e', '224a75ef', 'a9613faf', 'aec0d06e', '4083e1204ca86a84e3722248bb619a644326e34e'])('retains original draft identity when the selected target is %s', async commit => {
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

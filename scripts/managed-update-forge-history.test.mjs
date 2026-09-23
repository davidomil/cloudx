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
import { inspectDataCompatibility } from './managed-update-data.mjs';
import { cleanupUpdates, git, runPreparedUpdate, updateFixture, write } from './helpers/managed-update-rollback-fixture.mjs';
import { cleanupHistoricalForge, historicalForge } from './helpers/managed-update-forge-history-fixture.mjs';

const services = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  cleanupUpdates();
  cleanupHistoricalForge();
});

function completedReview() {
  const attemptId = randomUUID(), id = randomUUID();
  const revision = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'b'.repeat(40) };
  const report = { kind: 'review', headSha: revision.headSha, event: 'approve', body: 'Reviewed A', comments: [] };
  return {
    id, kind: 'review', number: 7, changeNumber: 7, title: 'Historical review',
    repository: { provider: 'github', apiUrl: 'https://api.github.com', projectPath: 'fixture/cloudx' },
    baseBranch: 'main', templateId: 'review', status: 'completed', autoPost: false,
    startedAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z', headSha: revision.headSha,
    completion: { attemptId, deadlineAt: '2026-09-20T11:00:00.000Z', readyAt: '2026-09-20T10:01:00.000Z',
      turn: { workerId: id, attemptId, threadId: 'thread', turnId: 'turn', status: 'completed' },
      reviewScope: { kind: 'initial', current: revision }, report },
    draft: { ...report, id: attemptId, startedAt: '2026-09-20T10:00:00.000Z', status: 'posted',
      publication: { commentIds: ['published-A'] }, postedAt: '2026-09-20T10:02:00.000Z' },
    reviewBaseline: { reviewId: attemptId, revision },
  };
}

it.each(['2e69451b', 'c664071e'].flatMap(commit => [false, true].map(resume => [commit, resume])))('restores after %s Forge persistence and failed readiness (fresh Resume: %s)', async (commit, resume) => {
  const history = historicalForge(commit);
  const f = updateFixture({ activate: false, originalWeb: 'active' });
  const currentStore = new ForgeWorkflowStore(new PluginDataStore(f.dataDir));
  await currentStore.write([completedReview()]);
  const original = await currentStore.read();
  const historicalStore = new history.ForgeWorkflowStore(new history.PluginDataStore(f.dataDir));
  const deps = { store: historicalStore, reports: new history.ForgeWorkerReports(f.dataDir),
    runtime: { launch: vi.fn(), recover: vi.fn() }, provider: vi.fn(), notify: vi.fn(),
    settings: () => ({ repository: original[0].repository }) };
  const service = new history.ForgeWorkflowService(deps);
  services.push(service);
  const start = f.host.start.bind(f.host), restore = f.host.restore.bind(f.host);
  vi.spyOn(f.host, 'start').mockImplementation(async record => {
    start(record);
    service.start();
    await service.dashboard();
  });
  vi.spyOn(f.host, 'restore').mockImplementation(async record => {
    await service.dispose();
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
    const resumed = await new ManagedUpdate({ record, save: f.save, host }).run();
    expect(resumed).toMatchObject({ state: 'failed', phase: 'quiesce' });
  }
  expect(record.transition).toMatchObject({ restored: true, mutating: false });
  expect(await currentStore.read()).toEqual(original);
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(record.transition.sourceCommit);
  expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toBe('previous runtime');
  expect(f.states['cloudx.service'].ActiveState).toBe('active');
  expect(deps.provider).not.toHaveBeenCalled();
  expect(deps.runtime.launch).not.toHaveBeenCalled();
  expect(deps.runtime.recover).not.toHaveBeenCalled();
}, 15000);

async function reviewRoundTrip({ commit, ...options } = {}) {
  const history = historicalForge(commit, options);
  const f = updateFixture({ activate: false });
  fs.unlinkSync(f.forgeFile);
  const repository = { provider: 'github', apiUrl: 'https://api.github.com', projectPath: 'fixture/cloudx' };
  const origin = 'https://github.com/fixture/cloudx.git';
  const baseSha = f.record.transition.sourceCommit;
  const change = { number: 7, title: 'Review transition', state: 'open', merged: false, headSha: baseSha, baseSha,
    baseBranch: 'main', headBranch: 'feature', url: 'https://github.com/fixture/cloudx/pull/7', comments: [], linkedIssues: [] };
  const provider = { getChangeRequest: vi.fn(async () => ({ ...change })), getChangeRequestStatus: vi.fn(async () => ({ ...change })),
    postReview: vi.fn(async () => ({ commentIds: ['published-A'] })) };
  const reports = new ForgeWorkerReports(f.dataDir);
  const runtimeDeps = { dataDir: f.dataDir, pathPolicy: new PathPolicy([f.host.home]), isRepositoryTrusted: () => true,
    gitAccess: async () => ({ cloneUrl: origin, authorization: 'Basic fixture-secret' }),
    git: async (cwd, args) => git(cwd, ...args.map(arg => arg === origin && args[0] === 'fetch' ? f.root : arg)),
    sessions: { getTab: () => undefined, listTabs: () => [] }, workspaceCommands: {}, rulesSkills: {} };
  function serviceFor(classes) {
    const runtime = new classes.ForgeRuntime(runtimeDeps);
    runtime.launch = vi.fn(async () => randomUUID());
    runtime.finish = vi.fn(async () => {});
    runtime.pause = vi.fn(async () => {});
    runtime.close = vi.fn(async () => {});
    runtime.workerHistory = vi.fn(async () => undefined);
    runtime.isActive = vi.fn(() => true);
    runtime.readTurnCompletion = vi.fn(async (workerId, attemptId) => ({ workerId, attemptId,
      threadId: 'synthetic-thread', turnId: attemptId, status: await reports.read(attemptId) ? 'completed' : 'running' }));
    const store = new classes.ForgeWorkflowStore(new classes.PluginDataStore(f.dataDir));
    const deps = { store, reports, runtime, provider: () => provider, notify: vi.fn(), settings: () => ({ repository,
      baseBranch: 'main', reviewTemplateId: 'review', reviewModel: 'fixture', reviewReasoningEffort: 'high', maxRunMinutes: 60 }) };
    const service = new classes.ForgeWorkflowService(deps);
    services.push(service);
    return { service, runtime, store };
  }
  const currentClasses = { ForgeWorkflowService, ForgeWorkflowStore, PluginDataStore, ForgeRuntime };
  async function finishReview(instance, worker) {
    write(path.join(f.dataDir, 'forge-reports', `${worker.attemptId}.json`), JSON.stringify({ kind: 'review', headSha: change.headSha,
      event: 'approve', body: `Reviewed ${change.headSha}`, comments: [] }));
    await instance.service.poll();
    const completed = (await instance.service.dashboard()).workers.find(candidate => candidate.id === worker.id);
    expect(completed.status, completed.error).toBe('completed');
    return completed;
  }
  const placement = { windowId: 'window', paneId: 'pane' };
  const original = serviceFor(currentClasses);
  const first = await finishReview(original, await original.service.startReview(repository, 7, false, placement));
  await original.service.submitReview(first.id, first.draft.id);
  await original.service.dispose();
  const initial = (await original.store.read())[0];
  expect(initial.reviewBaseline.revision.headSha).toBe(baseSha);
  return { ...f, history, change, provider, reports, serviceFor, currentClasses, placement, finishReview, initial };
}

it.each(['2e69451b', 'a9613faf', '643ad8eb', '224a75ef'])('downgrades to %s, completes a review, then upgrades and continues from the new verified baseline', async commit => {
  const f = await reviewRoundTrip({ commit });
  expect(inspectDataCompatibility(f.history.root, {}, f.dataDir).compatible).toBe(true);
  const downgraded = f.serviceFor(f.history);
  expect((await downgraded.service.dashboard()).workers[0].reviewBaseline).toEqual(f.initial.reviewBaseline);
  f.change.headSha = f.record.targetCommit;
  const second = await f.finishReview(downgraded, await downgraded.service.startReview(f.initial.repository, 7, false, f.placement));
  expect(second.reviewBaseline).toMatchObject({ reviewId: second.draft.id, revision: { headSha: f.change.headSha } });
  expect(second.reviewHistory).toEqual([f.initial.draft]);
  expect(second.completion.reviewScope.current).toEqual(second.reviewBaseline.revision);
  const revision = second.reviewBaseline.revision;
  for (const [name, sha] of [['head', revision.headSha], ['base', revision.baseSha], ['merge-base', revision.mergeBaseSha]])
    expect(git(second.worktreePath, 'rev-parse', `refs/cloudx/reviews/${revision.headSha}/${revision.baseSha}/${name}`)).toBe(sha);
  await downgraded.service.dispose();
  expect(inspectDataCompatibility(process.cwd(), {}, f.dataDir).compatible).toBe(true);
  const upgraded = f.serviceFor(f.currentClasses);
  expect((await upgraded.service.dashboard()).workers[0].reviewBaseline).toEqual(second.reviewBaseline);
  const next = await upgraded.service.startReview(f.initial.repository, 7, false, f.placement);
  expect(next.status, next.error).toBe('running');
  expect(next.completion.reviewScope).toMatchObject({ kind: 'unchanged', current: revision, previous: revision });
  expect(next.reviewHistory).toEqual([f.initial.draft, second.draft]);
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 20000);

it('preserves current reviews and edits a separate 0.1.3 review before upgrading from its retained baseline', async () => {
  const f = await reviewRoundTrip({ commit: 'c664071e' });
  const downgraded = f.serviceFor(f.history);
  expect((await downgraded.service.dashboard()).workers[0]).toMatchObject({
    draft: f.initial.draft, reviewBaseline: f.initial.reviewBaseline,
  });
  f.change.number = 8;
  f.change.headSha = f.record.targetCommit;
  const second = await f.finishReview(downgraded, await downgraded.service.startReview(f.initial.repository, 8, false, f.placement));
  expect(second.reviewBaseline).toEqual({ reviewId: second.draft.id, revision: second.completion.reviewScope.current });
  expect(second.draft).toMatchObject({ id: second.completion.attemptId, startedAt: second.startedAt });
  await downgraded.service.saveReview(second.id, { body: 'Edited historical review', comments: [], event: 'approve' });
  await downgraded.service.dispose();
  const persisted = await downgraded.store.read();
  expect(persisted[0]).toMatchObject({ draft: f.initial.draft, reviewBaseline: f.initial.reviewBaseline });
  expect(persisted[1]).toMatchObject({ draft: { ...second.draft, body: 'Edited historical review' }, reviewBaseline: second.reviewBaseline });
  const revision = second.reviewBaseline.revision;
  for (const [name, sha] of [['head', revision.headSha], ['base', revision.baseSha], ['merge-base', revision.mergeBaseSha]])
    expect(git(second.worktreePath, 'rev-parse', `refs/cloudx/reviews/${revision.headSha}/${revision.baseSha}/${name}`)).toBe(sha);
  const upgraded = f.serviceFor(f.currentClasses);
  const next = await upgraded.service.startReview(f.initial.repository, 8, false, f.placement);
  expect(next.status, next.error).toBe('running');
  expect(next.completion.reviewScope).toMatchObject({ kind: 'unchanged', current: revision, previous: revision });
  expect(next.reviewHistory).toEqual([persisted[1].draft]);
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 20000);

it.each(['retention', 'cleanup'])('preserves 0.1.3 review evidence when %s fails before a return upgrade', async failure => {
  const f = await reviewRoundTrip({ commit: 'c664071e' });
  const downgraded = f.serviceFor(f.history);
  f.change.number = 8;
  f.change.headSha = f.record.targetCommit;
  const worker = await downgraded.service.startReview(f.initial.repository, 8, false, f.placement);
  write(path.join(f.dataDir, 'forge-reports', `${worker.attemptId}.json`), JSON.stringify({ kind: 'review', headSha: f.change.headSha,
    event: 'approve', body: 'Historical completed review', comments: [] }));
  if (failure === 'retention')
    vi.spyOn(downgraded.runtime, 'retainReviewBaseline').mockRejectedValue(new Error('Retained evidence unavailable'));
  else vi.spyOn(f.reports, 'remove').mockRejectedValueOnce(new Error('Interrupted report cleanup'));
  await downgraded.service.poll();
  const failed = (await downgraded.service.dashboard()).workers.find(candidate => candidate.id === worker.id);
  expect(failed.status).toBe('failed');
  expect(await f.reports.read(worker.attemptId)).toBeDefined();
  expect(fs.existsSync(worker.worktreePath)).toBe(true);
  if (failure === 'cleanup') {
    downgraded.runtime.launch.mockClear();
    const resumed = await downgraded.service.resume(worker.id, f.placement);
    expect(resumed).toMatchObject({ status: 'completed', draft: failed.draft, reviewBaseline: failed.reviewBaseline });
    expect(downgraded.runtime.launch).not.toHaveBeenCalled();
  }
  await downgraded.service.dispose();
  const upgraded = f.serviceFor(f.currentClasses);
  const loaded = (await upgraded.service.dashboard()).workers.find(candidate => candidate.id === worker.id);
  if (failure === 'retention') {
    expect(loaded.draft).toBeUndefined();
    expect(loaded.reviewBaseline).toBeUndefined();
  } else {
    expect(loaded).toMatchObject({ draft: { id: worker.attemptId }, reviewBaseline: { reviewId: worker.attemptId } });
    expect(loaded.status).toBe('completed');
    expect(upgraded.runtime.launch).not.toHaveBeenCalled();
  }
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 20000);

it.each(['2e69451b', '224a75ef'])('keeps the previous review and baseline when %s retention fails before completion', async commit => {
  const f = await reviewRoundTrip({ commit });
  const downgraded = f.serviceFor(f.history);
  f.change.headSha = f.record.targetCommit;
  const worker = await downgraded.service.startReview(f.initial.repository, 7, false, f.placement);
  vi.spyOn(downgraded.runtime, 'retainReviewBaseline').mockRejectedValue(new Error('Retained Git evidence unavailable'));
  write(path.join(f.dataDir, 'forge-reports', `${worker.attemptId}.json`), JSON.stringify({ kind: 'review', headSha: f.change.headSha,
    event: 'approve', body: 'Review B', comments: [] }));
  await downgraded.service.poll();
  const failed = (await downgraded.service.dashboard()).workers[0];
  expect(failed).toMatchObject({ status: 'failed', reviewBaseline: f.initial.reviewBaseline, reviewHistory: [f.initial.draft] });
  expect(failed.draft).toBeUndefined();
  expect(await f.reports.read(worker.attemptId)).toBeDefined();
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 20000);

it('detects the real historical writer producing stale baseline evidence before a return upgrade', async () => {
  const f = await reviewRoundTrip({ integrate: false });
  const downgraded = f.serviceFor(f.history);
  expect((await downgraded.service.dashboard()).workers[0].completion.reviewScope).toBeUndefined();
  f.change.headSha = f.record.targetCommit;
  const second = await f.finishReview(downgraded, await downgraded.service.startReview(f.initial.repository, 7, false, f.placement));
  expect(second.draft.headSha).toBe(f.change.headSha);
  expect(second.reviewBaseline).toEqual(f.initial.reviewBaseline);
  await downgraded.service.dispose();
  const before = fs.readFileSync(f.forgeFile);
  const compatibility = inspectDataCompatibility(process.cwd(), {}, f.dataDir);
  expect(compatibility.compatible).toBe(false);
  expect(compatibility.issues).toContainEqual(expect.stringContaining('most recent completed review'));
  await expect(new ForgeWorkflowStore(new PluginDataStore(f.dataDir)).read()).rejects.toThrow('most recent completed review');
  expect(fs.readFileSync(f.forgeFile)).toEqual(before);
}, 20000);

it('does not rewind a new historical review or publication after failed target readiness', async () => {
  const f = await reviewRoundTrip();
  const downgraded = f.serviceFor(f.history);
  const start = f.host.start.bind(f.host);
  let completed;
  vi.spyOn(f.host, 'start').mockImplementation(async record => {
    start(record);
    f.change.headSha = f.record.targetCommit;
    f.provider.postReview.mockResolvedValueOnce({ commentIds: ['published-B'] });
    completed = await f.finishReview(downgraded, await downgraded.service.startReview(f.initial.repository, 7, false, f.placement));
    await downgraded.service.submitReview(completed.id, completed.draft.id);
    await downgraded.service.dispose();
    write(path.join(f.dataDir, 'forge-workers/tabs', `${completed.tabId}.json`), JSON.stringify({
      workerId: completed.id, tabId: completed.tabId, closed: false, quiescent: true,
    }));
  });
  const result = await runPreparedUpdate(f);
  expect(result).toMatchObject({ state: 'failed', phase: 'verify', component: 'forge' });
  expect(result.cause).toContain('prevent repeating published work');
  expect(f.record.transition.restored).not.toBe(true);
  const saved = (await new ForgeWorkflowStore(new PluginDataStore(f.dataDir)).read())[0];
  expect(saved.reviewBaseline).toEqual(completed.reviewBaseline);
  expect(saved.draft).toMatchObject({ id: completed.draft.id, status: 'posted', publication: { commentIds: ['published-B'] } });
  const restarted = f.serviceFor(f.currentClasses);
  await expect(restarted.service.submitReview(completed.id, completed.draft.id)).rejects.toThrow('No unsubmitted review draft');
  expect(f.provider.postReview).toHaveBeenCalledTimes(2);
}, 20000);

it('preserves the completed pre-native review before cleanup fails, then loads it on return upgrade', async () => {
  const f = await reviewRoundTrip({ commit: '224a75ef' });
  const downgraded = f.serviceFor(f.history);
  f.change.headSha = f.record.targetCommit;
  const worker = await downgraded.service.startReview(f.initial.repository, 7, false, f.placement);
  write(path.join(f.dataDir, 'forge-reports', `${worker.attemptId}.json`), JSON.stringify({ kind: 'review', headSha: f.change.headSha,
    event: 'approve', body: 'Completed review B', comments: [] }));
  vi.spyOn(f.reports, 'remove').mockRejectedValueOnce(new Error('Interrupted report cleanup'));
  await downgraded.service.poll();
  const interrupted = (await downgraded.service.dashboard()).workers[0];
  expect(interrupted).toMatchObject({ status: 'failed', draft: { id: worker.attemptId, body: 'Completed review B' },
    reviewBaseline: { reviewId: worker.attemptId, revision: { headSha: f.change.headSha } } });
  expect(await f.reports.read(worker.attemptId)).toBeDefined();
  await downgraded.service.dispose();
  const upgraded = f.serviceFor(f.currentClasses);
  expect((await upgraded.service.dashboard()).workers[0].draft).toEqual(interrupted.draft);
  const resumed = await upgraded.service.resume(worker.id, f.placement);
  expect(resumed).toMatchObject({ status: 'completed', draft: interrupted.draft, reviewBaseline: interrupted.reviewBaseline });
  expect(upgraded.runtime.launch).not.toHaveBeenCalled();
  expect(f.provider.postReview).toHaveBeenCalledOnce();
}, 20000);

it.each(['2e69451b', '224a75ef', 'c664071e'])('keeps report and saved-draft body limits compatible across %s', commit => {
  const history = historicalForge(commit);
  const validation = history.load('apps/server/src/forge/ForgeWorkflowValidation.ts');
  const saved = completedReview();
  const report = { ...saved.completion.report, body: 'a'.repeat(100_001) };
  expect(validation.parseWorkerReport({ kind: 'issue', title: 'Issue completed', body: 'Validation passed' }).kind).toBe('issue');
  expect(() => validation.parseWorkerReport(report)).toThrow();
  saved.draft.body = 'a'.repeat(100_512);
  expect(validation.parseWorkers([saved])[0].draft.body).toHaveLength(100_512);
  saved.draft.body += 'a';
  expect(() => validation.parseWorkers([saved])).toThrow();
}, 15000);

it('does not publish a pre-native review when cancellation arrives during report cleanup', async () => {
  const f = await reviewRoundTrip({ commit: '224a75ef' });
  const downgraded = f.serviceFor(f.history);
  f.change.headSha = f.record.targetCommit;
  const worker = await downgraded.service.startReview(f.initial.repository, 7, true, f.placement);
  write(path.join(f.dataDir, 'forge-reports', `${worker.attemptId}.json`), JSON.stringify({ kind: 'review', headSha: f.change.headSha,
    event: 'approve', body: 'Review completed before cancellation', comments: [] }));
  const remove = f.reports.remove.bind(f.reports);
  let pause;
  vi.spyOn(f.reports, 'remove').mockImplementationOnce(async attemptId => {
    await remove(attemptId);
    pause = downgraded.service.pause(worker.id);
  });
  await downgraded.service.poll();
  await pause;
  const paused = (await downgraded.service.dashboard()).workers[0];
  expect(paused).toMatchObject({ status: 'paused', draft: { id: worker.attemptId, status: 'draft' },
    reviewBaseline: { reviewId: worker.attemptId, revision: { headSha: f.change.headSha } } });
  expect(f.provider.postReview).toHaveBeenCalledOnce();
  await downgraded.service.dispose();
  expect((await new ForgeWorkflowStore(new PluginDataStore(f.dataDir)).read())[0].draft).toEqual(paused.draft);
}, 20000);

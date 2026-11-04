import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedUpdate } from './managed-update.mjs';
import { BROKER, cleanupUpdates, git, updateFixture, write } from './helpers/managed-update-rollback-fixture.mjs';

const conversationId = '12345678-1234-1234-1234-123456789abc';
const capacity = { blockSize: 4096, availableBytes: 10 ** 12, availableInodes: 10 ** 6, quotaStatus: 'fixture quota checked' };
afterEach(cleanupUpdates);

function preparedRecovery() {
  const f = updateFixture({ activate: false, originalWeb: 'active', originalBroker: 'active', preserveBroker: true });
  for (const service of ['cloudx.service', BROKER]) f.states[service].ControlGroup = `/cloudx-recovery-fixture/${f.record.run.id}/${service}`;
  Object.assign(f.record.transition, { localPatch: f.host.localChanges(), environmentText: fs.readFileSync(f.host.paths.envPath, 'utf8') });
  f.record.confirmInterruption = true;
  vi.spyOn(f.host, 'planData').mockImplementation(() => {});
  vi.spyOn(f.host, 'preflightCapacity').mockImplementation(() => {});
  f.host.inspectCapacity = vi.fn(() => ({ ...capacity }));
  const tab = { id: 'retained-codex', pluginId: 'codex-terminal', title: 'Retained conversation', cwd: '/project', status: 'running',
    indicator: { color: 'green', label: 'Running', updatedAt: 'now' }, createdAt: 'then', updatedAt: 'now' };
  const json = (relative, value) => write(path.join(f.dataDir, relative), JSON.stringify(value));
  json('workspace.json', { windows: [{ id: 'window', name: 'Existing workspace', defaultCwd: '/project',
    layout: { activePaneId: 'pane', root: { type: 'pane', pane: { id: 'pane', tabIds: [tab.id] } } } }] });
  json('sessions.json', { version: 1, activeTabId: tab.id, sessions: [{ tab, initialInput: { resume: { mode: 'session', sessionId: conversationId } } }] });
  const transcript = path.join(f.dataDir, `codex-home/sessions/retained-${conversationId}.jsonl`);
  write(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: conversationId, cwd: tab.cwd } })}\n{"type":"event_msg","payload":{"message":"retained history"}}\n`);
  const home = path.join(f.dataDir, 'codex-home'), identity = fs.statSync(home);
  json(`codex-launches/${tab.id}/.cloudx-source.json`, { version: 1, sourceId: 'shared', home, dev: String(identity.dev), ino: String(identity.ino) });
  json(`codex-launches/${tab.id}/.cloudx-conversation.json`, { sessionId: conversationId, cwd: tab.cwd, transcriptPath: transcript });
  const execute = () => new ManagedUpdate({ record: f.record, save: f.save, host: f.host }).run();
  return { ...f, transcript, json, execute };
}

describe('durable terminal recovery inspection', () => {
  it.each([
    ['capacity', /requires .*bytes.*available/u],
    ['transcript header', /transcript metadata does not match/u],
    ['Forge ownership', /missing workspace ownership/u],
    ['service ownership', /belongs to another checkout/u],
  ])('rejects changed %s before stopping services or starting restoration', async (changed, cause) => {
    const f = preparedRecovery();
    expect(f.host.inspectRuntimeRecovery(f.record)).toMatchObject({ requiresInterruption: true, blockers: [] });
    if (changed === 'capacity') f.host.inspectCapacity.mockReturnValue({ ...capacity, availableBytes: 0 });
    if (changed === 'transcript header') write(f.transcript, '{"type":"session_meta","payload":{"id":"another-conversation","cwd":"/project"}}\n');
    if (changed === 'Forge ownership') write(f.forgeFile, JSON.stringify([{ id: 'review', status: 'paused', worktreePath: '/retained/review' }]));
    if (changed === 'service ownership') f.states['cloudx.service'].WorkingDirectory = path.join(f.host.home, 'another-checkout');
    const services = structuredClone(f.states), history = fs.readFileSync(f.transcript);
    const restore = vi.spyOn(f.host, 'restore');

    expect(await f.execute()).toMatchObject({ state: 'failed', phase: 'quiesce', resumable: true, cause: expect.stringMatching(cause) });

    expect(f.record.transition.mutating).toBe(false);
    expect(f.record.transition.completed).toEqual(['prepare']);
    expect(restore).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(f.states).toEqual(services);
    expect(fs.readFileSync(f.transcript)).toEqual(history);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.record.transition.sourceCommit);
    expect(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')).transition.mutating).toBe(false);
  });

  it('persists scan progress in the durable journal while services remain running', () => {
    const f = preparedRecovery();
    fs.truncateSync(f.transcript, 64 * 1024 ** 2 + 1);
    const progress = [];
    vi.spyOn(f.host, 'save').mockImplementation(record => {
      f.save(record);
      const saved = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
      if (!saved.run.message.includes('bytes inspected')) return;
      expect(saved.run).toMatchObject({ state: 'running', component: 'terminals', message: expect.stringContaining('67108864 bytes inspected') });
      expect(saved.transition.mutating).toBe(false);
      expect(f.events).toEqual([]);
      expect(f.states['cloudx.service'].ActiveState).toBe('active');
      expect(f.states[BROKER].ActiveState).toBe('active');
      progress.push(saved.run.message);
    });

    expect(f.host.inspectRuntimeRecovery(f.record)).toMatchObject({ blockers: [], requiresInterruption: true });

    expect(progress).toHaveLength(1);
    expect(progress[0]).toContain('transcripts/retained-codex.jsonl');
    expect(fs.statSync(f.transcript).size).toBe(64 * 1024 ** 2 + 1);
    expect(f.host.inspectCapacity).toHaveBeenCalledWith(f.dataDir);
  });

  it('rechecks recovery on resume and verifies its backup before stopping the broker', async () => {
    const f = preparedRecovery();
    f.host.inspectRuntimeRecovery(f.record);
    f.host.inspectCapacity.mockReturnValue({ ...capacity, availableBytes: 0 });
    const restore = vi.spyOn(f.host, 'restore');
    expect(await f.execute()).toMatchObject({ state: 'failed', phase: 'quiesce' });
    expect(restore).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    const expected = fs.readFileSync(f.transcript);
    f.host.inspectCapacity.mockReturnValue({ ...capacity });
    const inspection = vi.spyOn(f.host, 'inspectRuntimeRecovery');
    f.commands.beforeStop = service => {
      expect(inspection).toHaveBeenCalledWith(f.record);
      expect(f.record.transition.mutating).toBe(true);
      if (service !== BROKER) return;
      const backup = fs.readdirSync(f.dataDir).find(name => name.startsWith('terminal-recovery-'));
      expect(backup).toBeDefined();
      expect(fs.readFileSync(path.join(f.dataDir, backup, 'transcripts/retained-codex.jsonl'))).toEqual(expected);
    };
    // This regression ends after the recovery snapshot. Deployment has separate coverage.
    for (const phase of ['snapshot', 'activate', 'start', 'verify']) vi.spyOn(f.host, phase).mockImplementation(() => {});

    const resumed = await f.execute();
    expect(resumed.cause).toBeUndefined();
    expect(resumed).toMatchObject({ state: 'succeeded' });

    expect(inspection).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    expect(f.events.filter(({ action }) => action === 'stop').map(({ service }) => service)).toContain(BROKER);
    expect(fs.readFileSync(f.transcript)).toEqual(expected);
    expect(f.record.transition.terminalRecovery).toBeDefined();
  });
});

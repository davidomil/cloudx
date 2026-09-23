import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdateHost, validateSavedTransition } from './managed-update.mjs';
import { BROKER, cleanupUpdates, runPreparedUpdate, updateFixture, write } from './helpers/managed-update-rollback-fixture.mjs';

afterEach(cleanupUpdates);

describe('production rollback after target startup', () => {
  it.each(['startup', 'writer shutdown'])('never rewinds a Forge review published during %s', async publicationTime => {
    const f = updateFixture({ activate: false });
    if (publicationTime === 'startup') f.commands.afterStart = service => { if (service === 'cloudx.service') f.publish(); };
    else f.commands.beforeStop = service => { if (service === 'cloudx.service') f.publish(); };
    const result = await runPreparedUpdate(f);
    expect(result).toMatchObject({ state: 'failed', phase: 'verify', component: 'forge', resumable: true });
    expect(result.cause).toContain('prevent repeating published work');
    expect(result.recoveryAction).toContain('Forge ownership or publication records changed');
    expect(f.record.transition.mutating).toBe(true);
    expect(f.record.transition.restored).not.toBe(true);
    expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0]).toMatchObject({ status: 'completed', publicationId: 'published-review-42', draft: { status: 'posted' } });
    expect(fs.readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('target');
    expect(f.states['cloudx.service'].ActiveState).toBe('inactive');
    expect(f.events.filter(event => event.action === 'start' && event.version === 'previous')).toEqual([]);
    const saved = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(() => f.host.restore(saved)).toThrow('prevent repeating published work');
    expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0].draft.status).toBe('posted');
  });

  it.each(['inactive', 'missing'])('stops the broker started from an originally %s service before restoring the previous runtime', async originalBroker => {
    const f = updateFixture({ originalBroker, activate: false });
    const result = await runPreparedUpdate(f);
    expect(result).toMatchObject({ state: 'failed', phase: 'verify', resumable: true });
    expect(f.record.transition.restored).toBe(true);
    expect(f.states[BROKER].ActiveState).toBe('inactive');
    expect(f.events).toContainEqual({ action: 'stop', service: BROKER, version: 'target' });
    expect(fs.readFileSync(path.join(f.root, 'apps/server/dist/index.js'), 'utf8')).toBe('previous runtime');
    expect(fs.readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('previous');
  });

  it('journals broker startup before web dependencies start and restores after a coordinator dies before recording the new invocation', () => {
    const f = updateFixture({ originalBroker: 'missing' });
    f.commands.afterStart = service => { if (service === 'cloudx.service') throw new Error('coordinator killed after dependency start'); };
    expect(() => f.host.start(f.record)).toThrow('coordinator killed');
    const saved = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(saved.transition).toMatchObject({ targetStarted: true, brokerStartup: { preservedInvocationId: null } });
    expect(saved.transition.brokerStartup.invocationId).toBeUndefined();
    const recoveryHost = Object.assign(Object.create(UpdateHost.prototype), f.host);
    recoveryHost.restore(saved);
    expect(f.states[BROKER].ActiveState).toBe('inactive');
    expect(fs.readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('previous');
  });

  it('records the broker invocation actually started by the target', () => {
    const f = updateFixture(); f.host.start(f.record);
    const saved = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
    expect(saved.transition.brokerStartup).toEqual({ preservedInvocationId: null, invocationId: f.states[BROKER].InvocationID });
    expect(() => validateSavedTransition(saved, f.host.runDir)).not.toThrow();
  });

  it('preserves only the exact compatible original broker invocation', () => {
    const f = updateFixture({ originalBroker: 'active', preserveBroker: true });
    f.host.start(f.record); f.host.restore(f.record);
    expect(f.states[BROKER].InvocationID).toBe(f.originalStates[BROKER].InvocationID);
    expect(f.events.filter(event => event.action === 'stop' && event.service === BROKER)).toEqual([]);
  });

  it('stops a replacement invocation even when the original broker was preserved', () => {
    const f = updateFixture({ originalBroker: 'active', preserveBroker: true });
    f.host.start(f.record); f.states[BROKER].InvocationID = 'b'.repeat(32); f.host.restore(f.record);
    expect(f.events).toContainEqual({ action: 'stop', service: BROKER, version: 'target' });
    expect(f.states[BROKER].InvocationID).not.toBe('b'.repeat(32));
  });

  it('rechecks unresolved Forge work after writers stop before restoring the profile', () => {
    const f = updateFixture(); f.host.start(f.record);
    f.commands.beforeStop = service => {
      if (service === 'cloudx.service') write(f.forgeFile, JSON.stringify([{ id: 'review', status: 'running' }]));
    };
    expect(() => f.host.restore(f.record)).toThrow('Forge ownership changed while services stopped');
    expect(JSON.parse(fs.readFileSync(f.forgeFile, 'utf8'))[0].status).toBe('running');
    expect(fs.readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('target');
  });

  it.each(['different checkout', 'incomplete termination policy'])('leaves the runtime intact when the new broker has a %s', conflict => {
    const f = updateFixture(); f.host.start(f.record);
    if (conflict === 'different checkout') f.states[BROKER].WorkingDirectory = path.join(f.root, 'another-checkout');
    else f.states[BROKER].KillMode = 'process';
    expect(() => f.host.restore(f.record)).toThrow(conflict === 'different checkout' ? 'belongs to another checkout' : 'terminate its full control group');
    expect(f.states[BROKER].ActiveState).toBe('active');
    expect(fs.readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('target');
    expect(f.events.filter(event => event.action === 'stop' && event.service === BROKER)).toEqual([]);
  });

  it.each([null, {}, { preservedInvocationId: 'invalid' }, { preservedInvocationId: null, invocationId: 'invalid' }])('rejects malformed saved broker startup evidence: %j', brokerStartup => {
    const f = updateFixture();
    f.record.transition.brokerStartup = brokerStartup;
    expect(() => validateSavedTransition(f.record, f.host.runDir)).toThrow('broker invocation identity');
  });
});

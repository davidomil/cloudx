import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeUpdateJson } from './managed-update-store.mjs';

const phases = ['prepare', 'quiesce', 'snapshot', 'activate', 'start', 'verify'];
const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function crashFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-update-crash-'));
  temporary.push(root);
  const selectedTarget = 'b'.repeat(40), originalCommit = 'a'.repeat(40);
  const originalData = { schema: 1, sessions: ['saved-session'], layout: { selected: 'saved-session' } };
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  writeUpdateJson(path.join(root, 'run.json'), { targetCommit: selectedTarget, sourceCommit: originalCommit,
    run: { id: 'fixture-run', state: 'running', targetCommit: selectedTarget } });
  writeUpdateJson(path.join(root, 'data.json'), originalData);
  writeUpdateJson(path.join(root, 'installation.json'), { commit: originalCommit });
  const script = path.join(root, 'coordinator.mjs');
  fs.writeFileSync(script, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { ManagedUpdate } from ${JSON.stringify(new URL('./managed-update.mjs', import.meta.url).href)};
    import { writeUpdateJson } from ${JSON.stringify(new URL('./managed-update-store.mjs', import.meta.url).href)};

    const [root, killAt] = process.argv.slice(2);
    const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    const write = (name, value) => writeUpdateJson(path.join(root, name), value);
    const record = read('run.json');
    const log = action => fs.appendFileSync(path.join(root, 'actions.jsonl'), JSON.stringify({
      action, pid: process.pid, schema: read('data.json').schema, targetCommit: record.targetCommit,
    }) + '\\n', { mode: 0o600, flush: true });
    const save = value => {
      if (value.run.state === 'succeeded') {
        assert.equal(value.transition.verifiedTarget, value.targetCommit);
        assert.equal(value.transition.verifiedPid, process.pid, 'Success requires verification in this process.');
        log('succeeded');
      }
      write('run.json', value);
    };
    const host = {
      prepare(record) {
        assert.equal(record.transition.preparedTarget, undefined, 'Completed preparation must not repeat.');
        record.transition.preparedTarget = record.targetCommit;
        log('prepare');
      },
      quiesce(record) {
        record.transition.mutating = true;
        save(record);
        log('quiesce');
      },
      snapshot(record) {
        assert.equal(read('data.json').schema, 1, 'A resumed snapshot requires the original schema.');
        write('snapshot.json', read('data.json'));
        record.transition.snapshotReady = true;
        log('snapshot');
      },
      activate(record) {
        assert.equal(record.transition.preparedTarget, record.targetCommit);
        write('installation.json', { commit: record.targetCommit });
        log('activate');
      },
      start(record) {
        log('start');
        const data = read('data.json');
        assert.equal(data.schema, 1, 'Startup refuses to repeat migration on schema 2.');
        assert.equal(read('installation.json').commit, record.targetCommit);
        write('data.json', { ...data, schema: 2, migratedFor: record.targetCommit });
      },
      verify(record) {
        assert.equal(read('installation.json').commit, record.targetCommit);
        assert.equal(read('data.json').schema, 2);
        assert.equal(read('data.json').migratedFor, record.targetCommit);
        record.transition.verifiedTarget = record.targetCommit;
        record.transition.verifiedPid = process.pid;
        log('verify');
      },
      restore(record) {
        log('restore');
        if (record.transition.snapshotReady) write('data.json', read('snapshot.json'));
        assert.equal(read('data.json').schema, 1);
        write('installation.json', { commit: record.sourceCommit });
        delete record.transition.snapshotReady;
        delete record.transition.verifiedTarget;
        delete record.transition.verifiedPid;
      },
    };
    const checkpoint = boundary => {
      if (boundary !== killAt) return;
      write('killed-at.json', { boundary, pid: process.pid });
      process.kill(process.pid, 'SIGKILL');
    };
    const result = await new ManagedUpdate({ record, save, host, checkpoint }).run();
    if (result.state !== 'succeeded') process.exitCode = 1;
  `);
  return {
    read, selectedTarget, originalData,
    actions: () => fs.existsSync(path.join(root, 'actions.jsonl'))
      ? fs.readFileSync(path.join(root, 'actions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    run: checkpoint => spawnSync(process.execPath, [script, root, checkpoint ?? ''], { encoding: 'utf8', timeout: 10_000 }),
  };
}

describe('managed update recovery after real coordinator process death', () => {
  it.each(phases.flatMap(phase => ['before', 'after'].map(boundary => [boundary, phase])))('resumes after SIGKILL %s %s', (boundary, phase) => {
    const fixture = crashFixture();
    const checkpoint = `${boundary}:${phase}`;
    const killed = fixture.run(checkpoint);
    expect(killed.error, killed.stderr).toBeUndefined();
    expect(killed.status, killed.stderr).toBeNull();
    expect(killed.signal).toBe('SIGKILL');
    expect(fixture.read('killed-at.json')).toEqual({ boundary: checkpoint, pid: killed.pid });

    const interrupted = fixture.read('run.json');
    expect(interrupted.targetCommit).toBe(fixture.selectedTarget);
    expect(interrupted.run).toMatchObject({ state: 'running', phase, targetCommit: fixture.selectedTarget });
    expect(interrupted.run.finishedAt).toBeUndefined();
    const performed = phases.slice(0, phases.indexOf(phase) + (boundary === 'after' ? 1 : 0));
    const beforeResume = fixture.actions();
    expect(beforeResume.map(event => event.action)).toEqual(performed);

    const resumed = fixture.run();
    expect(resumed.error, resumed.stderr).toBeUndefined();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.signal).toBeNull();
    expect(resumed.pid).not.toBe(killed.pid);

    const restored = performed.includes('quiesce');
    const resumedActions = fixture.actions().slice(beforeResume.length);
    expect(resumedActions.map(event => event.action)).toEqual([
      ...(restored ? ['restore', ...phases.slice(1)] : phases.slice(performed.length)), 'succeeded',
    ]);
    expect(fixture.actions().filter(event => event.action === 'prepare')).toHaveLength(1);
    expect(fixture.actions().filter(event => event.action === 'start').every(event => event.schema === 1)).toBe(true);
    expect(fixture.actions().every(event => event.targetCommit === fixture.selectedTarget)).toBe(true);
    expect(resumedActions.every(event => event.pid === resumed.pid)).toBe(true);
    if (performed.includes('start')) expect(resumedActions[0]).toMatchObject({ action: 'restore', schema: 2 });

    expect(fixture.read('run.json')).toMatchObject({ targetCommit: fixture.selectedTarget,
      run: { state: 'succeeded', phase: 'complete', resumable: false, targetCommit: fixture.selectedTarget },
      transition: { completed: phases, mutating: false, verifiedTarget: fixture.selectedTarget, verifiedPid: resumed.pid } });
    expect(fixture.read('run.json').run.finishedAt).toEqual(expect.any(String));
    expect(fixture.read('installation.json')).toEqual({ commit: fixture.selectedTarget });
    expect(fixture.read('data.json')).toEqual({ ...fixture.originalData, schema: 2, migratedFor: fixture.selectedTarget });
  });
});

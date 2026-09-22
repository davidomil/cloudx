import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedUpdate, validateSavedTransition } from './managed-update.mjs';
import { SERVICE_NAMES } from './install-update.mjs';
import { writeUpdateJson } from './managed-update-store.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function transition() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-transition-'));
  roots.push(root);
  const journal = path.join(root, 'run.json');
  const data = path.join(root, 'data.json');
  fs.writeFileSync(data, '{"sessions":["original"],"schema":1}');
  const actions = [];
  const host = Object.fromEntries(['prepare', 'quiesce', 'snapshot', 'activate', 'start', 'verify', 'restore'].map(phase => [phase, vi.fn(record => {
    actions.push(phase);
    if (phase === 'quiesce') record.transition.mutating = true;
    if (phase === 'snapshot') record.transition.originalData = fs.readFileSync(data, 'utf8');
    if (phase === 'start') fs.writeFileSync(data, '{"sessions":["original"],"schema":2}');
    if (phase === 'restore' && record.transition.originalData) fs.writeFileSync(data, record.transition.originalData);
  })]));
  const record = { targetCommit: 'b'.repeat(40), run: { id: 'run', state: 'running' } };
  const save = record => writeUpdateJson(journal, record);
  const execute = (record, checkpoint) => new ManagedUpdate({ record, save, host, checkpoint }).run();
  return { record, execute, host, actions, journal, data };
}

describe('durable managed transition', () => {
  it('reports success only after target startup and runtime verification', async () => {
    const fixture = transition();
    const result = await fixture.execute(fixture.record);
    expect(fixture.actions).toEqual(['prepare', 'quiesce', 'snapshot', 'activate', 'start', 'verify']);
    expect(result).toMatchObject({ state: 'succeeded', phase: 'complete', resumable: false });
    await fixture.execute(JSON.parse(fs.readFileSync(fixture.journal)));
    expect(fixture.host.start).toHaveBeenCalledOnce();
  });

  it.each(['prepare', 'quiesce', 'snapshot', 'activate', 'start', 'verify'])('restores failure during %s and resumes without duplicating prepared work', async phase => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = transition();
    f.host[phase].mockImplementationOnce(() => { throw Object.assign(new Error('private secret'), { code: 'ENOSPC' }); });
    expect(await f.execute(f.record)).toMatchObject({ state: 'failed', phase, resumable: true });
    expect(JSON.stringify(f.record.run)).not.toContain('private secret');
    expect(fs.readFileSync(f.data, 'utf8')).toContain('"schema":1');
    expect(await f.execute(JSON.parse(fs.readFileSync(f.journal)))).toMatchObject({ state: 'succeeded' });
    expect(f.host.prepare).toHaveBeenCalledTimes(phase === 'prepare' ? 2 : 1);
  });

  it('restores durable activation intent before resuming a killed coordinator', async () => {
    const f = transition();
    f.record.transition = { completed: ['prepare', 'quiesce', 'snapshot'], mutating: true, originalData: fs.readFileSync(f.data, 'utf8') };
    fs.writeFileSync(f.data, '{"schema":2}');
    expect(await f.execute(f.record)).toMatchObject({ state: 'succeeded' });
    expect(f.actions[0]).toBe('restore');
    expect(f.host.prepare).not.toHaveBeenCalled();
    expect(f.host.start).toHaveBeenCalledOnce();
  });

  it('keeps failed restoration resumable without beginning another activation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = transition();
    f.record.transition = { completed: ['prepare', 'snapshot'], mutating: true };
    f.host.restore.mockImplementation(() => { throw new Error('disk still full'); });
    expect(await f.execute(f.record)).toMatchObject({ state: 'failed', phase: 'restore', resumable: true });
    expect(f.host.activate).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(f.journal)).transition.mutating).toBe(true);
  });
});

it.each([null, 'shell', ['../other'], ['shell', 'shell'], ['x'.repeat(129)], [42]])('rejects malformed saved terminal identities: %j', sessionIds => {
  const { record, runDir } = savedTransition();
  record.transition.preservedSessionIds = sessionIds;
  expect(() => validateSavedTransition(record, runDir)).toThrow('terminal session identities');
});

function savedTransition({ service, externalDocumentation } = {}) {
  const home = '/home/cloudx-update-test';
  const id = '12345678-1234-4123-8123-123456789abc';
  const runDir = path.join(home, '.local/state/cloudx/settings-update', id);
  const repoRoot = path.join(home, 'checkout');
  const dataDir = path.join(home, 'profile');
  const serviceNames = service ? [service] : SERVICE_NAMES;
  const installed = path.join(repoRoot, 'apps/server/dist');
  const record = {
    home, repoRoot, dataDir, service, envPath: path.join(home, '.config/cloudx/cloudx.env'),
    run: { id }, targetCommit: 'b'.repeat(40),
    transition: {
      sourceCommit: 'a'.repeat(40), sourceIndex: 'c'.repeat(40),
      serviceTarget: { kind: service ? 'web' : 'standard', serviceNames: [...serviceNames] },
      serviceStates: Object.fromEntries(serviceNames.map(name => [name, 'ActiveState=active'])),
      environment: { CLOUDX_DATA_DIR: dataDir, ...(externalDocumentation ? { CLOUDX_DOCUMENTATION_DATA_DIR: externalDocumentation } : {}) },
      artifacts: ['apps/server/dist'], buildManifests: { 'apps/server/dist': [] },
      replaced: [{ installed, previous: `${installed}.cloudx-previous-${id}`, existed: true }],
      configuration: [{ file: path.join(home, '.config/systemd/user', serviceNames[0]), content: null }],
      snapshots: [{ root: dataDir, destination: path.join(runDir, 'snapshot-1/data-0'), manifest: [] }],
      sourceFiles: [{ relative: 'apps/server/package.json', type: 'file', mode: 0o100644, content: 'e30=' }],
    },
  };
  return { record, runDir };
}

describe('saved transition boundaries', () => {
  it('accepts direct readiness only when the independent integration owns it', () => {
    const { record, runDir } = savedTransition();
    record.transition.integration = { version: 1, files: [], independentReadiness: true, terminalMode: 'direct' };
    expect(() => validateSavedTransition(record, runDir)).not.toThrow();
    record.transition.integration.independentReadiness = false;
    expect(() => validateSavedTransition(record, runDir)).toThrow('Invalid saved managed integration');
    record.transition.integration.independentReadiness = true;
    record.transition.integration.terminalMode = 'unknown';
    expect(() => validateSavedTransition(record, runDir)).toThrow('Invalid saved managed integration');
  });

  it('accepts standard, custom-service and external-archive recovery records', () => {
    for (const options of [{}, { service: 'cloudx-worker@review.service' }, { externalDocumentation: '/srv/cloudx-archive' }]) {
      const { record, runDir } = savedTransition(options);
      if (options.externalDocumentation) record.transition.snapshots.push({ root: options.externalDocumentation, destination: path.join(runDir, 'snapshot-1/data-1'), manifest: [] });
      expect(() => validateSavedTransition(record, runDir)).not.toThrow();
    }
    const { record, runDir } = savedTransition();
    delete record.transition;
    expect(() => validateSavedTransition(record, runDir)).not.toThrow();
  });

  it.each(['repoRoot', 'dataDir', 'home', 'envPath'])('rejects a noncanonical saved %s before recovery', field => {
    for (const invalid of ['/', 'relative/path', '/home/../outside', '/home//cloudx', '/home/cloudx\0other']) {
      const { record, runDir } = savedTransition();
      record[field] = invalid;
      delete record.transition;
      expect(() => validateSavedTransition(record, runDir)).toThrow();
    }
  });

  it.each(['../other.service', 'other.service\0suffix'])('rejects custom service name %j', service => {
    const { record, runDir } = savedTransition({ service });
    expect(() => validateSavedTransition(record, runDir)).toThrow(/service/i);
  });

  it.each(['/', 'relative/archive', '/srv/archive/../other', '/srv/archive\0other'])('rejects saved archive path %j', externalDocumentation => {
    const { record, runDir } = savedTransition({ externalDocumentation });
    expect(() => validateSavedTransition(record, runDir)).toThrow(/documentation path/i);
  });

  it('rejects a different saved profile and a custom-service snapshot of an unmanaged archive', () => {
    const { record, runDir } = savedTransition({ service: 'review.service', externalDocumentation: '/srv/archive' });
    record.transition.snapshots.push({ root: '/srv/archive', destination: path.join(runDir, 'snapshot-1/data-1') });
    expect(() => validateSavedTransition(record, runDir)).toThrow(/recovery data/i);
    record.transition.snapshots.pop();
    record.transition.environment.CLOUDX_DATA_DIR = '/tmp/another-profile';
    expect(() => validateSavedTransition(record, runDir)).toThrow(/environment/i);
  });

  it.each([
    ['another service', t => { t.serviceTarget.serviceNames.push('unrelated.service'); }],
    ['another service kind', t => { t.serviceTarget.kind = 'web'; }],
    ['unselected restart service', t => { t.serviceStates['unrelated.service'] = 'ActiveState=active'; }],
    ['service path traversal', t => { t.serviceStates['../unrelated.service'] = 'ActiveState=active'; }],
  ])('rejects %s in the saved service selection', (_name, mutate) => {
    const { record, runDir } = savedTransition();
    mutate(record.transition);
    expect(() => validateSavedTransition(record, runDir)).toThrow(/service/i);
  });

  it.each(['../outside', '/tmp/outside', 'apps/server/../server/dist', 'apps/server/dist/child', 'apps/server/dist\0other'])('rejects artifact %j in both activation and manifest records', relative => {
    for (const field of ['artifacts', 'buildManifests']) {
      const { record, runDir } = savedTransition();
      record.transition[field] = field === 'artifacts' ? [relative] : { [relative]: [] };
      expect(() => validateSavedTransition(record, runDir)).toThrow(/runtime|artifact/i);
    }
  });

  it.each([
    ['installed path', artifact => { artifact.installed += '/../outside'; }],
    ['previous path', artifact => { artifact.previous += '/../outside'; }],
    ['previous run', artifact => { artifact.previous = `${artifact.installed}.cloudx-previous-another-run`; }],
    ['existence marker', artifact => { artifact.existed = 'yes'; }],
  ])('rejects a malformed artifact %s', (_name, mutate) => {
    const { record, runDir } = savedTransition();
    mutate(record.transition.replaced[0]);
    expect(() => validateSavedTransition(record, runDir)).toThrow(/runtime/i);
  });

  it.each(['outside', 'normalized alias', 'unselected service', 'NUL'])('rejects saved configuration for %s', kind => {
    const { record, runDir } = savedTransition();
    const files = {
      outside: '/tmp/config',
      'normalized alias': `${record.home}/.config/cloudx/../cloudx/cloudx.env`,
      'unselected service': path.join(record.home, '.config/systemd/user/unrelated.service'),
      NUL: `${record.envPath}\0other`,
    };
    record.transition.configuration = [{ file: files[kind], content: null }];
    expect(() => validateSavedTransition(record, runDir)).toThrow(/configuration/i);
  });

  it.each(['sibling', 'parent traversal', 'nested traversal', 'root itself', 'NUL'])('rejects a snapshot destination containing %s', kind => {
    const { record, runDir } = savedTransition();
    const destinations = {
      sibling: `${runDir}-other/snapshot`,
      'parent traversal': `${runDir}/../outside`,
      'nested traversal': `${runDir}/snapshot/../../outside`,
      'root itself': runDir,
      NUL: `${runDir}/snapshot\0other`,
    };
    record.transition.snapshots[0].destination = destinations[kind];
    expect(() => validateSavedTransition(record, runDir)).toThrow(/recovery data/i);
  });

  it.each(['/tmp/unrelated', '/', '/home/cloudx-update-test/profile/../profile'])('rejects a snapshot rooted at %j', root => {
    const { record, runDir } = savedTransition();
    record.transition.snapshots[0].root = root;
    expect(() => validateSavedTransition(record, runDir)).toThrow(/recovery data/i);
  });

  it('accepts only a confirmed previous run as the downgrade snapshot source', () => {
    const { record, runDir } = savedTransition();
    record.restoreSnapshotRunId = '87654321-1234-4123-8123-123456789abc';
    const savedRun = path.join(path.dirname(runDir), record.restoreSnapshotRunId);
    record.transition.restoreData = [{ root: record.dataDir, destination: path.join(savedRun, 'snapshot-1/data-0'), manifest: [] }];
    expect(() => validateSavedTransition(record, runDir)).not.toThrow();
    for (const destination of [`${savedRun}/../outside`, `${savedRun}-other/snapshot`, path.join(runDir, 'snapshot'), savedRun]) {
      record.transition.restoreData[0].destination = destination;
      expect(() => validateSavedTransition(record, runDir)).toThrow(/recovery data/i);
    }
    record.transition.restoreData[0].destination = path.join(savedRun, 'snapshot-1/data-0');
    record.transition.restoreData[0].root = '/tmp/unrelated';
    expect(() => validateSavedTransition(record, runDir)).toThrow(/recovery data/i);
    record.transition.restoreData[0].root = record.dataDir;
    record.restoreSnapshotRunId = record.run.id;
    expect(() => validateSavedTransition(record, runDir)).toThrow(/snapshot/i);
    delete record.restoreSnapshotRunId;
    expect(() => validateSavedTransition(record, runDir)).toThrow(/snapshot/i);
  });

  it.each(['../outside', 'apps/../../outside', 'apps/../apps/server.ts', '/tmp/outside', 'apps//server.ts', 'apps\\..\\outside', '.git/config', 'apps/server.ts\0other'])('rejects checkout recovery path %j', relative => {
    const { record, runDir } = savedTransition();
    record.transition.sourceFiles[0].relative = relative;
    expect(() => validateSavedTransition(record, runDir)).toThrow(/checkout recovery path/i);
  });
});

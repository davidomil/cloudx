import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_NAMES } from './install-update.mjs';
import { manifestTree, snapshotTree } from './managed-update-store.mjs';
import { UpdateHost } from './managed-update.mjs';
import { SettingsUpdater, UPDATE_UNIT } from './settings-update.mjs';
import { UpdateBackupCleanup } from './update-backup-cleanup.mjs';
import { inspectBackupReferences } from './update-backup-references.mjs';
import { UpdateOperationLock } from './update-operation-lock.mjs';

const SOURCE_COMMIT = 'a'.repeat(40), TARGET_COMMIT = 'b'.repeat(40);
const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function installation() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-backup-cleanup-'));
  temporary.push(home);
  const repoRoot = path.join(home, 'checkout'), dataDir = path.join(repoRoot, '.cloudx');
  const envPath = path.join(home, '.config/cloudx/cloudx.env');
  const systemdDir = path.join(home, '.config/systemd/user');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(systemdDir, { recursive: true });
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, `CLOUDX_DATA_DIR=${dataDir}\n`);
  for (const name of SERVICE_NAMES) fs.writeFileSync(path.join(systemdDir, name), 'installed launcher\n');
  fs.writeFileSync(path.join(dataDir, 'workspaces.json'), JSON.stringify({ tabs: ['saved terminal'], layout: 'preserved' }));
  const host = {
    unit: { LoadState: 'not-found', ActiveState: 'inactive' },
    references: { paths: [] },
    calls: [],
    checkpoint: () => {},
  };
  const updater = new SettingsUpdater({
    home, repoRoot, dataDir, serverPid: process.pid,
    readCgroup: () => `0::/user.slice/${UPDATE_UNIT}\n`,
    runtimeInspector: () => ({ requiresInterruption: false, reasons: [], blockers: [], services: [], stopServices: [] }),
    stageCoordinator: record => {
      const coordinator = path.join(updater.stateDir, record.run.id, 'coordinator');
      fs.mkdirSync(path.join(coordinator, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(coordinator, 'scripts/settings-update.mjs'), 'export {};\n');
      fs.writeFileSync(path.join(coordinator, 'bundle.json'), JSON.stringify(manifestTree(coordinator)));
      return coordinator;
    },
    commands: {
      inspect(command, args) {
        host.calls.push([command, args]);
        if (command === 'systemctl') {
          const name = args[2];
          const state = name === UPDATE_UNIT ? host.unit : {
            Id: name, LoadState: 'loaded', WorkingDirectory: repoRoot,
            EnvironmentFiles: `${envPath} (ignore_errors=no)`, FragmentPath: path.join(systemdDir, name),
            NeedDaemonReload: 'no', DropInPaths: '', ActiveState: 'active', MainPID: String(process.pid),
            ControlGroup: host.serviceControlGroup ?? '/user.slice',
          };
          return Object.entries(state).map(([key, value]) => `${key}=${value}`).join('\n');
        }
        if (command === 'git') {
          if (args[0] === 'status') return '';
          if (args.includes('--show-toplevel')) return repoRoot;
          if (args.includes('HEAD')) return SOURCE_COMMIT;
        }
        if (command === 'sudo') return '';
        if (command === 'systemd-run') {
          host.unit = { LoadState: 'loaded', ActiveState: 'active',
            Description: args.find(arg => arg.startsWith('--description=')).slice(14),
            ControlGroup: `/user.slice/${UPDATE_UNIT}` };
          return '';
        }
        throw new Error(`Unexpected fixture command: ${command}`);
      },
    },
  });
  const createCleanup = () => new UpdateBackupCleanup({ updater,
    referenceInspector: () => host.references,
    checkpoint: (...args) => host.checkpoint(...args),
  });
  return { home, repoRoot, dataDir, envPath, systemdDir, host, updater, cleanup: createCleanup(), createCleanup };
}

function retainedRun(f, { state = 'succeeded', mutating = false, previousArtifact = false, release = false, coordinator = false } = {}) {
  const id = randomUUID(), runDir = path.join(f.updater.stateDir, id);
  const destination = path.join(runDir, `snapshot-${randomUUID()}`, 'data-0');
  const manifest = snapshotTree(f.dataDir, destination);
  const record = {
    home: f.home, repoRoot: f.repoRoot, dataDir: f.dataDir, envPath: f.envPath, targetCommit: TARGET_COMMIT,
    run: { id, targetCommit: TARGET_COMMIT, state, phase: 'complete', message: 'Saved update',
      startedAt: '2026-09-15T12:00:00.000Z', finishedAt: '2026-09-15T12:01:00.000Z', resumable: state !== 'succeeded' },
    transition: { sourceCommit: SOURCE_COMMIT, mutating, snapshots: [{ root: f.dataDir, destination, manifest }], replaced: [] },
  };
  if (previousArtifact) {
    const installed = path.join(f.repoRoot, 'apps/web/dist'), previous = `${installed}.cloudx-previous-${id}`;
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, 'index.html'), 'previous build');
    record.transition.replaced.push({ installed, previous, existed: true });
  }
  if (release) {
    record.transition.release = path.join(runDir, 'release');
    fs.mkdirSync(path.join(record.transition.release, 'apps/web/dist'), { recursive: true });
    fs.writeFileSync(path.join(record.transition.release, 'apps/web/dist/index.html'), 'staged build');
    record.transition.artifacts = ['apps/web/dist'];
    record.transition.buildManifests = { 'apps/web/dist': manifestTree(path.join(record.transition.release, 'apps/web/dist')) };
  }
  if (coordinator) record.coordinator = f.updater.stageCoordinator(record);
  f.updater.save(record);
  fs.writeFileSync(path.join(runDir, 'coordinator.log'), 'retained update log');
  return record;
}

function reviewedCleanup(f) {
  const preview = f.cleanup.preview();
  const journal = f.cleanup.start({ previewId: preview.id, confirmPermanentDeletion: true });
  return { preview, journal, finish: () => f.cleanup.run(journal.id) };
}

function backupFor(inventory, record, kind = 'snapshot') {
  return inventory.backups.find(backup => backup.runId === record.run.id && backup.kind === kind);
}

function stopCleanupAfterLaunchGrace(f) {
  f.host.unit = { LoadState: 'not-found', ActiveState: 'inactive' };
  const persisted = JSON.parse(fs.readFileSync(f.cleanup.journalFile, 'utf8'));
  persisted.startedAt = new Date(Date.now() - 30_000).toISOString();
  f.updater.write(f.cleanup.journalFile, persisted);
}

describe('retained update backup cleanup', () => {
  it('reviews every completed snapshot with its commits, date, outcome and measured storage', () => {
    const f = installation(), first = retainedRun(f), second = retainedRun(f);
    const inventory = f.cleanup.inventory();
    for (const record of [first, second]) {
      expect(backupFor(inventory, record)).toMatchObject({
        sourceCommit: SOURCE_COMMIT, targetCommit: TARGET_COMMIT, createdAt: record.run.startedAt,
        outcome: 'succeeded', path: record.transition.snapshots[0].destination,
        logicalBytes: expect.any(Number), allocatedBytes: expect.any(Number), reclaimableBytes: expect.any(Number),
      });
      expect(backupFor(inventory, record).protectionReason).toBeUndefined();
    }
  });

  it('permanently deletes all reviewed completed snapshots and previous artifacts while preserving live state and readable logs', () => {
    const f = installation(), first = retainedRun(f, { previousArtifact: true }), second = retainedRun(f);
    const savedProfile = fs.readFileSync(path.join(f.dataDir, 'workspaces.json'), 'utf8');
    const liveBuild = path.join(f.repoRoot, 'apps/web/dist/index.html');
    fs.mkdirSync(path.dirname(liveBuild), { recursive: true });
    fs.writeFileSync(liveBuild, 'live build');
    const { finish } = reviewedCleanup(f), completed = finish();
    expect(completed.state).toBe('completed');
    expect(completed.results.filter(item => item.status === 'deleted')).toHaveLength(3);
    for (const record of [first, second]) {
      expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(false);
      const reconciled = f.updater.read(record.run.id);
      expect(reconciled.backupCleanup.snapshotsUnavailable).toBe(true);
      expect(reconciled.transition.snapshots[0].backupCleanup.state).toBe('deleted');
      expect(reconciled.transition.snapshotVerified).toBe(false);
      expect(fs.readFileSync(path.join(f.updater.stateDir, record.run.id, 'coordinator.log'), 'utf8')).toBe('retained update log');
    }
    expect(fs.existsSync(first.transition.replaced[0].previous)).toBe(false);
    expect(fs.readFileSync(liveBuild, 'utf8')).toBe('live build');
    expect(fs.readFileSync(path.join(f.dataDir, 'workspaces.json'), 'utf8')).toBe(savedProfile);
    for (const name of SERVICE_NAMES) expect(fs.readFileSync(path.join(f.systemdDir, name), 'utf8')).toBe('installed launcher\n');
    expect(completed.freeSpace.length).toBeGreaterThan(0);
    for (const capacity of completed.freeSpace) expect(capacity.availableBytesAfter).toEqual(expect.any(Number));
  });

  it('leaves every backup intact when the reviewed preview is cancelled or explicit permanent-deletion consent is missing', () => {
    const f = installation(), record = retainedRun(f), preview = f.cleanup.preview();
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(true);
    for (const confirmPermanentDeletion of [undefined, false, 'true']) {
      expect(() => f.cleanup.start({ previewId: preview.id, confirmPermanentDeletion })).toThrow(/confirm|permanent/i);
    }
    expect(f.host.calls.some(([command]) => command === 'systemd-run')).toBe(false);
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(true);
  });

  it('protects a same-size snapshot replacement made before preview by checking the saved manifest digest', () => {
    const f = installation(), record = retainedRun(f), file = path.join(record.transition.snapshots[0].destination, 'workspaces.json');
    const size = fs.statSync(file).size;
    fs.unlinkSync(file);
    fs.writeFileSync(file, 'x'.repeat(size));
    const backup = backupFor(f.cleanup.preview(), record);
    expect(backup.protectionReason).toMatch(/digest|manifest|snapshot|contents/i);
    expect(backup.reclaimableBytes).toBe(0);
    const completed = retainedRun(f);
    const result = reviewedCleanup(f).finish();
    expect(result.results.find(item => item.runId === record.run.id).status).toBe('protected');
    expect(result.results.find(item => item.runId === completed.run.id).status).toBe('deleted');
    expect(fs.readFileSync(file, 'utf8')).toBe('x'.repeat(size));
  });

  it.each(['prepared', 'failed'])('protects every %s run while other completed snapshots can be deleted', state => {
    const f = installation(), protectedRun = retainedRun(f, { state }), completed = retainedRun(f);
    const inventory = f.cleanup.inventory();
    expect(backupFor(inventory, protectedRun).protectionReason).toMatch(/update|run|resume|progress|prepared|failed/i);
    expect(backupFor(inventory, completed).protectionReason).toBeUndefined();
    const result = reviewedCleanup(f).finish();
    expect(result.results.find(item => item.runId === protectedRun.run.id)).toMatchObject({ status: 'protected', reason: expect.any(String) });
    expect(fs.existsSync(protectedRun.transition.snapshots[0].destination)).toBe(true);
  });

  it('protects a running update and blocks cleanup of all completed backups until it finishes', () => {
    const f = installation(), running = retainedRun(f, { state: 'running' }), completed = retainedRun(f);
    const inventory = f.cleanup.inventory();
    expect(backupFor(inventory, running).protectionReason).toMatch(/running|resume/i);
    expect(inventory.blockedReason).toMatch(/running|update/i);
    expect(() => f.cleanup.preview()).toThrow(/running|update/i);
    for (const record of [running, completed]) expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(true);
  });

  it('blocks bulk cleanup whenever a saved update is mutating the installation', () => {
    const f = installation(), record = retainedRun(f, { state: 'failed', mutating: true });
    retainedRun(f);
    expect(f.cleanup.inventory().blockedReason).toMatch(/mutat|restor|update/i);
    expect(() => f.cleanup.preview()).toThrow(/mutat|restor|update/i);
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(true);
  });

  it('blocks cleanup when the installed updater cannot establish installation ownership', () => {
    const f = installation(), record = retainedRun(f), preview = f.cleanup.preview();
    f.updater.preflight = () => 'Standard installed service ownership is missing';
    expect(f.cleanup.inventory().blockedReason).toBe('Standard installed service ownership is missing');
    expect(() => f.cleanup.start({ previewId: preview.id, confirmPermanentDeletion: true })).toThrow('Standard installed service ownership is missing');
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(true);
    expect(f.host.calls.some(([command]) => command === 'systemd-run')).toBe(false);
  });

  it('protects snapshots selected by restoration confirmation and another run’s restore data', () => {
    const f = installation(), confirmation = retainedRun(f), restoreData = retainedRun(f), selectable = retainedRun(f);
    const pending = retainedRun(f, { state: 'prepared' });
    pending.restoreSnapshotRunId = restoreData.run.id;
    pending.transition.restoreData = restoreData.transition.snapshots;
    f.updater.save(pending);
    f.updater.write(path.join(f.updater.stateDir, 'confirmation.json'), { repoRoot: f.repoRoot, targetCommit: TARGET_COMMIT, restoreSnapshotRunId: confirmation.run.id });
    const inventory = f.cleanup.inventory();
    expect(backupFor(inventory, confirmation).protectionReason).toMatch(/restor|selected|confirm/i);
    expect(backupFor(inventory, restoreData).protectionReason).toMatch(/restor|selected/i);
    expect(backupFor(inventory, selectable).protectionReason).toBeUndefined();
  });

  it('retains old broker and Codex dependencies while deleting their unused data snapshots', () => {
    const f = installation(), broker = retainedRun(f, { release: true }), codex = retainedRun(f, { coordinator: true });
    f.host.references.paths = [
      { path: path.join(broker.transition.release, 'apps/server/dist/terminal/broker.js'), reason: 'Live terminal broker process 123' },
      { path: path.join(codex.coordinator, 'scripts/settings-update.mjs'), reason: 'Surviving Codex process 456' },
    ];
    const inventory = f.cleanup.inventory();
    expect(backupFor(inventory, broker, 'release').protectionReason).toMatch(/broker/i);
    expect(backupFor(inventory, codex, 'coordinator').protectionReason).toMatch(/Codex/i);
    reviewedCleanup(f).finish();
    expect(fs.existsSync(broker.transition.release)).toBe(true);
    expect(fs.existsSync(codex.coordinator)).toBe(true);
    expect(fs.existsSync(broker.transition.snapshots[0].destination)).toBe(false);
    expect(fs.existsSync(codex.transition.snapshots[0].destination)).toBe(false);
  });

  it('protects executable releases when live-reference ownership cannot be established', () => {
    const f = installation(), record = retainedRun(f, { release: true, coordinator: true });
    f.host.references.uncertainReason = 'Cannot inspect a live process environment';
    const inventory = f.cleanup.inventory();
    for (const kind of ['release', 'coordinator']) expect(backupFor(inventory, record, kind).protectionReason).toMatch(/Cannot inspect/);
  });

  it('does not remove an unrelated directory merely because its name resembles a previous artifact', () => {
    const f = installation(), record = retainedRun(f), unrelated = path.join(f.repoRoot, `customer-data.cloudx-previous-${record.run.id}`);
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'important'), 'user data');
    reviewedCleanup(f).finish();
    expect(fs.readFileSync(path.join(unrelated, 'important'), 'utf8')).toBe('user data');
  });

  it('protects a saved snapshot path that escapes its recorded run ownership', () => {
    const f = installation(), record = retainedRun(f), unrelated = path.join(f.home, 'other-data');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'important'), 'user data');
    record.transition.snapshots[0].destination = unrelated;
    f.updater.save(record);
    expect(() => f.cleanup.inventory()).toThrow(/own|path|run|snapshot|recover/i);
    expect(() => f.cleanup.preview()).toThrow(/own|path|run|snapshot|recover/i);
    expect(fs.readFileSync(path.join(unrelated, 'important'), 'utf8')).toBe('user data');
  });

  it('does not trust a replaced-artifact record naming an unrelated installation path', () => {
    const f = installation(), record = retainedRun(f);
    const installed = path.join(f.repoRoot, 'customer-data'), previous = `${installed}.cloudx-previous-${record.run.id}`;
    fs.mkdirSync(previous);
    fs.writeFileSync(path.join(previous, 'important'), 'saved user data');
    record.transition.replaced.push({ installed, previous, existed: true });
    f.updater.save(record);
    expect(() => f.cleanup.inventory()).toThrow(/own|generat|path|artifact|replacement/i);
    expect(() => f.cleanup.preview()).toThrow(/own|generat|path|artifact|replacement/i);
    expect(fs.readFileSync(path.join(previous, 'important'), 'utf8')).toBe('saved user data');
  });

  it('never follows links embedded in an owned snapshot while deleting their link entries', () => {
    const f = installation(), record = retainedRun(f), snapshot = record.transition.snapshots[0];
    fs.symlinkSync(f.dataDir, path.join(snapshot.destination, 'profile-link'));
    snapshot.manifest = manifestTree(snapshot.destination);
    f.updater.save(record);
    const result = reviewedCleanup(f).finish();
    expect(result.results.find(item => item.runId === record.run.id).status).toBe('deleted');
    expect(fs.readFileSync(path.join(f.dataDir, 'workspaces.json'), 'utf8')).toContain('saved terminal');
  });

  it.each(['record', 'tree', 'references'])('rejects a preview whose reviewed %s changed before confirmation', changed => {
    const f = installation(), record = retainedRun(f, { release: true }), preview = f.cleanup.preview();
    if (changed === 'record') { record.run.message = 'Changed after preview'; f.updater.save(record); }
    if (changed === 'tree') fs.writeFileSync(path.join(record.transition.snapshots[0].destination, 'new-file'), 'unreviewed');
    if (changed === 'references') f.host.references.paths = [{ path: record.transition.release, reason: 'New live broker' }];
    expect(() => f.cleanup.start({ previewId: preview.id, confirmPermanentDeletion: true })).toThrow(/chang|stale|review/i);
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(true);
    expect(f.host.calls.some(([command]) => command === 'systemd-run')).toBe(false);
  });

  it('skips a directory replaced after launch without traversing its new contents', () => {
    const f = installation(), record = retainedRun(f), { journal, finish } = reviewedCleanup(f);
    const snapshot = record.transition.snapshots[0].destination, moved = `${snapshot}-reviewed`;
    fs.renameSync(snapshot, moved);
    fs.mkdirSync(snapshot);
    fs.writeFileSync(path.join(snapshot, 'new-owner'), 'preserve replacement');
    const completed = finish();
    expect(completed.results.find(item => item.runId === record.run.id)).toMatchObject({ status: 'skipped', reason: expect.any(String) });
    expect(completed.recoveryAction).toMatch(/chang|identity|review/i);
    expect(fs.readFileSync(path.join(snapshot, 'new-owner'), 'utf8')).toBe('preserve replacement');
    expect(fs.existsSync(moved)).toBe(true);
    expect(completed.id).toBe(journal.id);
  });

  it('never follows a snapshot symlink substituted after launch', () => {
    const f = installation(), record = retainedRun(f), { finish } = reviewedCleanup(f);
    const snapshot = record.transition.snapshots[0].destination, moved = `${snapshot}-reviewed`;
    fs.renameSync(snapshot, moved);
    fs.symlinkSync(f.dataDir, snapshot);
    const completed = finish();
    expect(completed.results.find(item => item.runId === record.run.id).status).toBe('skipped');
    expect(fs.readFileSync(path.join(f.dataDir, 'workspaces.json'), 'utf8')).toContain('saved terminal');
    expect(fs.lstatSync(snapshot).isSymbolicLink()).toBe(true);
  });

  it('rechecks directory identities after the deletion checkpoint and preserves replacement contents', () => {
    const f = installation(), record = retainedRun(f), snapshot = record.transition.snapshots[0].destination;
    const { finish } = reviewedCleanup(f);
    let replaced = false;
    f.host.checkpoint = (phase, entry) => {
      if (phase !== 'before-delete-entry' || entry.path !== snapshot || entry.relative || replaced) return;
      replaced = true;
      fs.renameSync(snapshot, `${snapshot}-reviewed`);
      fs.mkdirSync(snapshot);
      fs.writeFileSync(path.join(snapshot, 'replacement'), 'unreviewed contents');
    };
    const completed = finish();
    expect(replaced).toBe(true);
    expect(completed.results.find(item => item.runId === record.run.id).status).toMatch(/failed|skipped/);
    expect(fs.readFileSync(path.join(snapshot, 'replacement'), 'utf8')).toBe('unreviewed contents');
    expect(fs.existsSync(`${snapshot}-reviewed`)).toBe(true);
  });

  it('rechecks file identities after the deletion checkpoint and preserves replacement bytes', () => {
    const f = installation(), record = retainedRun(f), snapshot = record.transition.snapshots[0].destination;
    const { finish } = reviewedCleanup(f);
    f.host.checkpoint = (phase, entry) => {
      if (phase !== 'before-delete-entry' || entry.path !== snapshot || entry.relative !== 'workspaces.json') return;
      fs.renameSync(path.join(snapshot, entry.relative), path.join(f.home, 'reviewed-file'));
      fs.writeFileSync(path.join(snapshot, entry.relative), 'new unreviewed owner');
    };
    const completed = finish();
    expect(completed.results.find(item => item.runId === record.run.id).status).toMatch(/failed|skipped/);
    expect(fs.readFileSync(path.join(snapshot, 'workspaces.json'), 'utf8')).toBe('new unreviewed owner');
  });

  it('does not traverse a run-directory symlink substituted after launch', () => {
    const f = installation(), record = retainedRun(f), { finish } = reviewedCleanup(f);
    const runDir = path.join(f.updater.stateDir, record.run.id), moved = `${runDir}-reviewed`;
    fs.renameSync(runDir, moved);
    fs.symlinkSync(moved, runDir);
    const result = finish();
    expect(result.results.find(item => item.runId === record.run.id).status).toMatch(/skipped|failed/);
    expect(fs.existsSync(path.join(moved, path.relative(runDir, record.transition.snapshots[0].destination)))).toBe(true);
    expect(fs.lstatSync(runDir).isSymbolicLink()).toBe(true);
  });

  it('reports interrupted cleanup durably after restart and requires a new preview to continue', () => {
    const f = installation(), record = retainedRun(f), { journal } = reviewedCleanup(f);
    f.host.unit = { LoadState: 'not-found', ActiveState: 'inactive' };
    const persisted = JSON.parse(fs.readFileSync(f.cleanup.journalFile, 'utf8'));
    persisted.startedAt = new Date(Date.now() - 30_000).toISOString();
    f.updater.write(f.cleanup.journalFile, persisted);
    const restarted = f.createCleanup(), interrupted = restarted.status();
    expect(interrupted).toMatchObject({ id: journal.id, state: 'interrupted', recoveryAction: expect.stringMatching(/review|preview/i), finishedAt: expect.any(String) });
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(true);
    expect(f.createCleanup().status()).toEqual(interrupted);
    const completed = reviewedCleanup({ ...f, cleanup: restarted }).finish();
    expect(completed.state).toBe('completed');
  });

  it('reconciles a dead cleanup owner whose lock was saved before any journal without deleting backups', () => {
    const f = installation(), record = retainedRun(f), cleanupId = randomUUID();
    const token = f.cleanup.lock.acquire('backup-cleanup', cleanupId), owner = f.cleanup.lock.read();
    f.updater.write(path.join(f.cleanup.lock.file, `${token}.json`), {
      ...owner, pid: 2147483647, createdAt: new Date(Date.now() - 30_000).toISOString(),
    });
    const recovered = f.createCleanup();
    recovered.status();
    expect(recovered.lock.read()).toBeNull();
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(true);
    expect(reviewedCleanup({ ...f, cleanup: recovered }).finish().state).toBe('completed');
  });

  it('releases the matching inactive lock left after a completed journal was durably saved', () => {
    const f = installation(), record = retainedRun(f), { journal, finish } = reviewedCleanup(f);
    const owner = f.cleanup.lock.read();
    finish();
    fs.mkdirSync(f.cleanup.lock.file);
    f.updater.write(path.join(f.cleanup.lock.file, `${owner.token}.json`), owner);
    f.host.unit = { LoadState: 'not-found', ActiveState: 'inactive' };
    const restarted = f.createCleanup();
    expect(restarted.status()).toMatchObject({ id: journal.id, state: 'completed' });
    expect(restarted.lock.read()).toBeNull();
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(false);
    retainedRun(f);
    expect(reviewedCleanup({ ...f, cleanup: restarted }).finish().state).toBe('completed');
  });

  it('cannot release a replacement operation owner through an obsolete lock token', () => {
    const f = installation(), lock = new UpdateOperationLock(f.updater.stateDir), token = lock.acquire('update');
    fs.renameSync(lock.file, `${lock.file}-old-owner`);
    const replacement = new UpdateOperationLock(f.updater.stateDir), replacementToken = replacement.acquire('update');
    expect(() => lock.release(token)).toThrow();
    expect(replacement.read().token).toBe(replacementToken);
    expect(fs.existsSync(path.join(lock.file, `${replacementToken}.json`))).toBe(true);
    replacement.release(replacementToken);
  });

  it('recovers a crash after deleting a file from durable deletion intent and a newly reviewed partial tree', () => {
    const f = installation(), record = retainedRun(f), snapshot = record.transition.snapshots[0].destination;
    const { journal, finish } = reviewedCleanup(f);
    f.host.checkpoint = (phase, entry) => {
      if (phase === 'after-delete-entry' && entry.relative === 'workspaces.json') {
        throw Object.assign(new Error('Fixture coordinator crashed'), { cleanupInterrupted: true });
      }
    };
    expect(finish).toThrow('Fixture coordinator crashed');
    expect(fs.existsSync(path.join(snapshot, 'workspaces.json'))).toBe(false);
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(f.updater.read(record.run.id).backupCleanup.snapshotsUnavailable).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(f.cleanup.journalFile, 'utf8'));
    expect(persisted.results[0].status).toBe('deleting');
    persisted.startedAt = new Date(Date.now() - 30_000).toISOString();
    f.updater.write(f.cleanup.journalFile, persisted);
    f.host.unit = { LoadState: 'not-found', ActiveState: 'inactive' };
    f.host.checkpoint = () => {};
    const restarted = f.createCleanup(), interrupted = restarted.status();
    expect(interrupted).toMatchObject({ id: journal.id, state: 'interrupted', results: [{ status: 'failed', reason: expect.stringContaining('partially removed') }] });
    expect(reviewedCleanup({ ...f, cleanup: restarted }).finish().results[0].status).toBe('deleted');
    expect(fs.existsSync(snapshot)).toBe(false);
  });

  it('does not offer deleted snapshots for a later explicit data restoration', () => {
    const f = installation(), record = retainedRun(f);
    reviewedCleanup(f).finish();
    const nextId = randomUUID(), next = {
      home: f.home, repoRoot: f.repoRoot, dataDir: f.dataDir,
      run: { id: nextId }, targetCommit: SOURCE_COMMIT, restoreSnapshotRunId: record.run.id,
      transition: { release: f.repoRoot },
    };
    const planning = { envConfig: {}, paths: { dataDir: f.dataDir }, runDir: path.join(f.updater.stateDir, nextId) };
    expect(() => UpdateHost.prototype.planData.call(planning, next)).toThrow('No compatible pre-transition snapshot is available');
    expect(next.transition.restoreData).toBeUndefined();
    expect(fs.existsSync(path.join(f.updater.stateDir, 'confirmation.json'))).toBe(false);
  });

  it('excludes externally shared file allocation from the estimated reclaimable space', () => {
    const f = installation(), record = retainedRun(f);
    const file = path.join(record.transition.snapshots[0].destination, 'workspaces.json');
    fs.linkSync(file, path.join(f.home, 'still-needed-profile.json'));
    const sharedAllocation = fs.statSync(file).blocks * 512;
    const preview = f.cleanup.preview(), backup = backupFor(preview, record);
    expect(backup.reclaimableBytes).toBeLessThanOrEqual(backup.allocatedBytes - sharedAllocation);
    reviewedCleanup(f).finish();
    expect(fs.readFileSync(path.join(f.home, 'still-needed-profile.json'), 'utf8')).toContain('saved terminal');
  });

  it('counts shared allocation once when all hard links belong to reviewed backups', () => {
    const f = installation(), first = retainedRun(f), second = retainedRun(f);
    const firstFile = path.join(first.transition.snapshots[0].destination, 'workspaces.json');
    const secondFile = path.join(second.transition.snapshots[0].destination, 'workspaces.json');
    fs.unlinkSync(secondFile);
    fs.linkSync(firstFile, secondFile);
    const preview = f.cleanup.preview(), backups = preview.backups.filter(backup => backup.kind === 'snapshot');
    const allocationAcrossNames = backups.reduce((sum, backup) => sum + backup.allocatedBytes, 0);
    expect(preview.reclaimableBytes).toBeLessThanOrEqual(allocationAcrossNames - fs.statSync(firstFile).blocks * 512);
    expect(reviewedCleanup(f).finish().results.every(item => item.status === 'deleted')).toBe(true);
  });

  it('reports allocated storage for sparse snapshots instead of claiming their logical size will be freed', () => {
    const f = installation(), record = retainedRun(f), snapshot = record.transition.snapshots[0];
    const sparse = path.join(snapshot.destination, 'sparse-data');
    const fd = fs.openSync(sparse, 'w');
    try { fs.ftruncateSync(fd, 16 * 1024 * 1024); } finally { fs.closeSync(fd); }
    snapshot.manifest = manifestTree(snapshot.destination);
    f.updater.save(record);
    const preview = f.cleanup.preview(), backup = backupFor(preview, record);
    expect(backup.logicalBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(backup.allocatedBytes).toBeLessThan(backup.logicalBytes);
    expect(preview.reclaimableBytes).toBeLessThanOrEqual(backup.allocatedBytes);
    expect(preview.estimateNote).toMatch(/allocat|shared|hard.?link|estimate/i);
  });

  it('retains partial-deletion evidence and reports permission failures without claiming retained bytes were deleted', () => {
    const f = installation(), first = retainedRun(f), second = retainedRun(f), snapshot = second.transition.snapshots[0];
    fs.writeFileSync(path.join(snapshot.destination, 'denied.json'), 'permission failure evidence');
    snapshot.manifest = manifestTree(snapshot.destination);
    f.updater.save(second);
    const { finish } = reviewedCleanup(f), unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (String(file).endsWith('/denied.json')) throw Object.assign(new Error('Fixture permission denied'), { code: 'EACCES' });
      return unlink(file);
    });
    const result = finish();
    expect(result.state).toBe('completed');
    expect(result.results.find(item => item.runId === first.run.id)).toMatchObject({ status: 'deleted' });
    expect(result.results.find(item => item.runId === second.run.id)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/permission|EACCES|denied/i) });
    expect(fs.readFileSync(path.join(snapshot.destination, 'denied.json'), 'utf8')).toBe('permission failure evidence');
    expect(f.updater.read(second.run.id).transition.snapshots).toHaveLength(1);
    expect(f.createCleanup().status()).toEqual(result);
    for (const filesystem of result.freeSpace) expect(filesystem.availableBytesAfter).toEqual(expect.any(Number));
  });

  it('preserves an interrupted cleanup’s failure history after a subsequent cleanup completes', () => {
    const f = installation(), record = retainedRun(f), { journal, finish } = reviewedCleanup(f);
    f.host.checkpoint = phase => {
      if (phase === 'before-delete-backup') throw Object.assign(new Error('Fixture interruption'), { cleanupInterrupted: true });
    };
    expect(finish).toThrow('Fixture interruption');
    stopCleanupAfterLaunchGrace(f);
    f.host.checkpoint = () => {};
    const restarted = f.createCleanup(), interrupted = restarted.status();
    const evidencePath = restarted.historyFile(journal.id), evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    expect(interrupted.results[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('interrupted') });
    expect(evidence).toMatchObject({ id: journal.id, state: 'interrupted', results: interrupted.results });
    const completed = reviewedCleanup({ ...f, cleanup: restarted }).finish();
    expect(completed.state).toBe('completed');
    expect(completed.id).not.toBe(journal.id);
    expect(JSON.parse(fs.readFileSync(evidencePath, 'utf8'))).toEqual(evidence);
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(false);
  });

  it.each(['crash', 'permission failure'])('removes only the remaining owned coordinator files after a partial %s and a fresh preview', failure => {
    const f = installation(), record = retainedRun(f, { coordinator: true }), { journal, finish } = reviewedCleanup(f);
    let removedBundle = false;
    let permission;
    if (failure === 'permission failure') {
      const unlink = fs.unlinkSync;
      permission = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
        if (String(file).endsWith('/settings-update.mjs')) throw Object.assign(new Error('Fixture coordinator permission denied'), { code: 'EACCES' });
        return unlink(file);
      });
    }
    f.host.checkpoint = (phase, entry) => {
      if (entry.path !== record.coordinator || phase !== 'after-delete-entry' || entry.relative !== 'bundle.json') return;
      removedBundle = true;
      if (failure === 'crash') throw Object.assign(new Error('Fixture coordinator crash'), { cleanupInterrupted: true });
    };
    if (failure === 'crash') expect(finish).toThrow('Fixture coordinator crash');
    else expect(finish().results.find(item => item.path === record.coordinator)).toMatchObject({ status: 'failed', reason: expect.stringContaining('EACCES') });
    expect(removedBundle).toBe(true);
    expect(fs.existsSync(path.join(record.coordinator, 'bundle.json'))).toBe(false);
    expect(fs.existsSync(path.join(record.coordinator, 'scripts/settings-update.mjs'))).toBe(true);
    permission?.mockRestore();
    stopCleanupAfterLaunchGrace(f);
    f.host.checkpoint = () => {};
    const restarted = f.createCleanup();
    restarted.status();
    const inventory = restarted.inventory(), remaining = backupFor(inventory, record, 'coordinator');
    expect(remaining.protectionReason).toBeUndefined();
    const completed = reviewedCleanup({ ...f, cleanup: restarted }).finish();
    expect(completed.results.find(item => item.path === record.coordinator).status).toBe('deleted');
    expect(fs.existsSync(record.coordinator)).toBe(false);
    expect(fs.readFileSync(path.join(f.updater.stateDir, record.run.id, 'coordinator.log'), 'utf8')).toBe('retained update log');
    expect(JSON.parse(fs.readFileSync(restarted.historyFile(journal.id), 'utf8')).results.find(item => item.path === record.coordinator).status).toBe('failed');
  });

  it('protects coordinator files changed after an interrupted partial cleanup instead of treating them as remaining owned bytes', () => {
    const f = installation(), record = retainedRun(f, { coordinator: true }), { finish } = reviewedCleanup(f);
    f.host.checkpoint = (phase, entry) => {
      if (entry.path === record.coordinator && phase === 'after-delete-entry' && entry.relative === 'bundle.json') {
        throw Object.assign(new Error('Fixture interrupted coordinator'), { cleanupInterrupted: true });
      }
    };
    expect(finish).toThrow('Fixture interrupted coordinator');
    stopCleanupAfterLaunchGrace(f);
    f.host.checkpoint = () => {};
    const restarted = f.createCleanup();
    restarted.status();
    const script = path.join(record.coordinator, 'scripts/settings-update.mjs');
    fs.writeFileSync(script, 'new unreviewed user contents');
    expect(backupFor(restarted.inventory(), record, 'coordinator').protectionReason).toMatch(/changed|unreviewed|partial/i);
    retainedRun(f);
    const result = reviewedCleanup({ ...f, cleanup: restarted }).finish();
    expect(result.results.find(item => item.path === record.coordinator).status).toBe('protected');
    expect(fs.readFileSync(script, 'utf8')).toBe('new unreviewed user contents');
  });

  it('runs a CLI cleanup worker from the cleanup service while retaining installed service checks and exact worker cgroup ownership', () => {
    const f = installation(), record = retainedRun(f);
    f.host.serviceControlGroup = '/user.slice/cloudx.service';
    f.updater.readCgroup = () => '0::/user.slice/cloudx.service\n';
    const { journal, finish } = reviewedCleanup(f);
    f.updater.readCgroup = () => `0::/user.slice/${UPDATE_UNIT}\n`;
    expect(f.updater.preflight()).toMatch(/standard installed|services|checkout/i);
    f.updater.cli = true;
    expect(f.updater.preflight()).toBeUndefined();
    f.updater.readCgroup = () => '0::/user.slice/unrelated.service\n';
    expect(() => f.cleanup.run(journal.id)).toThrow('Backup cleanup must run in its managed update service');
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(true);
    f.updater.readCgroup = () => `0::/user.slice/${UPDATE_UNIT}\n`;
    expect(finish().state).toBe('completed');
    expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(false);
  });

  it('arbitrates cleanup through the existing update unit and prevents update-start until cleanup finishes', () => {
    const f = installation();
    retainedRun(f);
    const { finish } = reviewedCleanup(f);
    const launch = f.host.calls.find(([command]) => command === 'systemd-run');
    expect(launch[1]).toContain(`--unit=${UPDATE_UNIT}`);
    expect(() => f.updater.start(TARGET_COMMIT)).toThrow('An update or backup cleanup operation is in progress');
    finish();
    f.host.unit = { LoadState: 'not-found', ActiveState: 'inactive' };
    expect(f.updater.start(TARGET_COMMIT)).toMatchObject({ available: true, run: { state: 'running' } });
  });

  it('discovers live file-descriptor and installed-launcher dependencies through the real host reference inspector', () => {
    const f = installation(), record = retainedRun(f, { release: true, coordinator: true });
    const releaseFile = path.join(record.transition.release, 'apps/web/dist/index.html');
    fs.writeFileSync(path.join(f.systemdDir, SERVICE_NAMES[0]), `ExecStart=${process.execPath} ${record.coordinator}/scripts/settings-update.mjs\n`);
    const fd = fs.openSync(releaseFile, 'r');
    try {
      const references = inspectBackupReferences(f.updater);
      expect(references.paths).toContainEqual({ path: releaseFile, reason: expect.stringContaining(`Live process ${process.pid}`) });
      expect(references.paths.some(reference => reference.path.includes(record.coordinator) && reference.reason.includes('launcher'))).toBe(true);
    } finally { fs.closeSync(fd); }
  });

  it('protects the active web build through its installed artifact link even before any process opens the files', () => {
    const f = installation(), record = retainedRun(f, { release: true });
    const installed = path.join(f.repoRoot, 'apps/web/dist'), target = path.join(record.transition.release, 'apps/web/dist');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.symlinkSync(target, installed);
    const references = inspectBackupReferences(f.updater);
    expect(references.paths).toContainEqual({ path: target, reason: expect.stringMatching(/installed|active|build|artifact/i) });
    f.host.references = { paths: references.paths.filter(reference => reference.path === target) };
    const inventory = f.cleanup.inventory();
    expect(backupFor(inventory, record, 'release').protectionReason).toBeDefined();
    reviewedCleanup(f).finish();
    expect(fs.readFileSync(path.join(installed, 'index.html'), 'utf8')).toBe('staged build');
  });

  it('keeps a surviving process running from its old release while discovering its coordinator argument', async () => {
    const f = installation(), record = retainedRun(f, { release: true, coordinator: true });
    const coordinatorArgument = path.join(record.coordinator, 'scripts/settings-update.mjs');
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); process.stdin.resume(); process.stdin.on('end', () => process.exit());", coordinatorArgument],
      { cwd: record.transition.release, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await once(child.stdout, 'data');
      const references = inspectBackupReferences(f.updater);
      expect(references.paths).toContainEqual({ path: record.transition.release, reason: expect.stringContaining(`Live process ${child.pid}`) });
      expect(references.paths).toContainEqual({ path: coordinatorArgument, reason: expect.stringContaining(`Live process ${child.pid}`) });
      f.host.references = { paths: references.paths.filter(reference => reference.reason.includes(`Live process ${child.pid}`)) };
      const inventory = f.cleanup.inventory();
      expect(backupFor(inventory, record, 'release').protectionReason).toBeDefined();
      expect(backupFor(inventory, record, 'coordinator').protectionReason).toBeDefined();
      reviewedCleanup(f).finish();
      expect(fs.existsSync(record.transition.snapshots[0].destination)).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(fs.existsSync(record.transition.release)).toBe(true);
      expect(fs.existsSync(record.coordinator)).toBe(true);
    } finally {
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
  });
});

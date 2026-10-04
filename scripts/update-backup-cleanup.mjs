import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifySnapshot } from './managed-update-store.mjs';
import { validateSavedTransition } from './managed-update.mjs';
import { BackupDirectory, backupParent, readBackupJson, writeBackupJson, scanBackup, deleteReviewedBackup, fingerprint } from './update-backup-filesystem.mjs';
import { UpdateOperationLock, processIdentity, updateConflict } from './update-operation-lock.mjs';
import { inspectBackupReferences, backupReferenceReason } from './update-backup-references.mjs';

export const BACKUP_CLEANUP_DESCRIPTION = 'CloudX update backup cleanup ';
const UPDATE_UNIT = 'cloudx-settings-update.service';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERATED = ['node_modules', 'packages/shared/dist', 'packages/plugin-api/dist', 'apps/server/dist', 'apps/web/dist', 'services/asr/.venv', 'services/documentation-indexer/.venv'];
const ESTIMATE_NOTE = 'Allocated blocks are counted once across eligible hard links; links retained outside the selection count as zero reclaimable bytes. Reflinks, filesystem snapshots and open deleted files can retain allocation, so this is an upper estimate. Retained update records, reviewed identities and cleanup journals also occupy space. The result reports measured available space, not an inferred saving.';
const RECOVERY = 'Deletion stopped. Completed deletions remain permanent; pending or partially removed backups remain listed. Review a new preview and confirm cleanup again to remove the remaining owned files. Recovery snapshots touched by cleanup are unavailable.';
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);

export class UpdateBackupCleanup {
  constructor({ updater, referenceInspector = inspectBackupReferences, checkpoint = () => {}, remove = deleteReviewedBackup } = {}) {
    this.updater = updater;
    this.stateDir = updater.stateDir;
    this.referenceInspector = referenceInspector;
    this.checkpoint = checkpoint;
    this.remove = remove;
    this.lock = new UpdateOperationLock(this.stateDir);
    this.journalFile = path.join(this.stateDir, 'backup-cleanup.json');
    this.previewFile = path.join(this.stateDir, 'backup-cleanup-preview.json');
  }

  readOptional(file) { try { return readBackupJson(file); } catch (error) { if (missing(error)) return null; throw error; } }
  write(file, value) { writeBackupJson(file, value); }
  historyFile(id) { if (!UUID.test(id)) throw new Error('Invalid cleanup history identity.'); return path.join(this.stateDir, 'backup-cleanups', `${id}.json`); }
  writeJournal(journal) {
    this.write(this.historyFile(journal.id), journal);
    this.write(this.journalFile, journal);
  }
  publicJournal(journal) {
    if (!journal) return null;
    const { id, state, startedAt, finishedAt, results, freeSpace, recoveryAction } = journal;
    return { id, state, startedAt, ...(finishedAt ? { finishedAt } : {}), results, freeSpace, ...(recoveryAction ? { recoveryAction } : {}) };
  }

  verifyManifest(artifact, tree, manifest) {
    backupParent(artifact.path, (parent, name) => {
      const directory = new BackupDirectory(parent.entry(name));
      try {
        const stat = fs.fstatSync(directory.fd), reviewed = tree.entries[0];
        if (stat.dev !== reviewed.dev || stat.ino !== reviewed.ino) throw new Error('Backup root changed before ownership verification.');
        verifySnapshot(`/proc/self/fd/${directory.fd}/.`, manifest);
      } finally { directory.close(); }
    });
  }

  records() {
    let names;
    try { names = backupParent(path.join(this.stateDir, 'inventory-anchor'), parent => fs.readdirSync(parent.entry('.'))); }
    catch (error) { if (missing(error)) return []; throw error; }
    const records = [];
    for (const name of names.filter(name => UUID.test(name.slice(0, -5)) && name.endsWith('.json')).sort()) {
      const record = readBackupJson(path.join(this.stateDir, name));
      if (record.repoRoot !== this.updater.repoRoot || record.dataDir !== this.updater.dataDir) continue;
      if (record.home !== this.updater.home || record.run?.id !== name.slice(0, -5)
        || !['running', 'prepared', 'succeeded', 'failed'].includes(record.run.state)
        || !/^[a-f0-9]{40}$/.test(record.targetCommit ?? '') || !Number.isFinite(Date.parse(record.run.startedAt))) throw new Error('Invalid update backup ownership record.');
      const runDir = path.join(this.stateDir, record.run.id);
      if (record.coordinator && record.coordinator !== path.join(runDir, 'coordinator')
        || record.transition?.release && record.transition.release !== path.join(runDir, 'release')) throw new Error('Invalid staged update backup ownership.');
      validateSavedTransition(record, runDir);
      records.push(record);
    }
    return records;
  }

  blockedReason(records, cleanupId) {
    const unit = this.updater.unit();
    if (unit.running && unit.Description !== `${BACKUP_CLEANUP_DESCRIPTION}${cleanupId}`) return 'Wait for the running update or backup cleanup to finish.';
    if (records.some(record => record.run.state === 'running' || record.transition?.mutating)) return 'An update is running or installation restoration is pending. Resume recovery before cleaning backups.';
    const lock = this.lock.read();
    if (lock && lock.cleanupId !== cleanupId && (lock.cleanupId || processIdentity(lock.pid) === lock.processIdentity)) return 'An update or backup cleanup request is in progress.';
    return undefined;
  }

  selectedSnapshots(records) {
    const selected = new Set();
    const confirmation = this.readOptional(path.join(this.stateDir, 'confirmation.json'));
    if (confirmation?.repoRoot === this.updater.repoRoot && UUID.test(confirmation.restoreSnapshotRunId ?? '')) selected.add(confirmation.restoreSnapshotRunId);
    for (const record of records) {
      if (record.run.state === 'succeeded' && !record.transition?.mutating) continue;
      if (record.restoreSnapshotRunId) selected.add(record.restoreSnapshotRunId);
      for (const snapshot of record.transition?.restoreData ?? []) {
        const owner = path.relative(this.stateDir, snapshot.destination).split(path.sep)[0];
        if (UUID.test(owner)) selected.add(owner);
      }
    }
    return selected;
  }

  artifacts(records) {
    const artifacts = [];
    const seen = new Set();
    const selected = this.selectedSnapshots(records);
    for (const record of records) {
      const runDir = path.join(this.stateDir, record.run.id), t = record.transition ?? {};
      const add = (kind, destination, source, original) => {
        if (seen.has(destination)) throw new Error('Update backup ownership overlaps another recorded backup.');
        seen.add(destination);
        const id = `${record.run.id}:${kind}:${fingerprint(destination).slice(0, 16)}`;
        const artifact = { id, runId: record.run.id, kind, path: destination, targetCommit: record.targetCommit,
          ...(t.sourceCommit ? { sourceCommit: t.sourceCommit } : {}), createdAt: record.run.startedAt, outcome: record.run.state,
          priorCleanup: record.backupCleanup?.artifacts?.find(value => value.path === destination),
          logicalBytes: null, allocatedBytes: null, reclaimableBytes: null, source, original, recordHash: fingerprint(record) };
        if (record.run.state !== 'succeeded' || t.mutating) artifact.protectionReason = `Update is ${record.run.state}; its preparation, resume or rollback data must be retained.`;
        else if (['snapshot', 'failed-data'].includes(kind) && selected.has(record.run.id)) artifact.protectionReason = 'This update snapshot is selected for data restoration or recovery.';
        artifacts.push(artifact);
      };
      for (const source of ['snapshots', 'failedData', 'retainedFailedData']) {
        const snapshots = t[source] ?? [];
        if (!Array.isArray(snapshots)) throw new Error('Invalid retained snapshot ownership.');
        for (const snapshot of snapshots) {
          const relative = path.relative(runDir, snapshot.destination ?? '');
          const owned = source === 'snapshots' ? /^snapshot-[0-9a-f-]{36}\/data-\d+$/.test(relative) : /^failed-data-\d+-[0-9a-f-]{36}$/.test(relative);
          if (!owned || !Array.isArray(snapshot.manifest)) throw new Error('Snapshot has no exact owned backup path or manifest.');
          add(source === 'snapshots' ? 'snapshot' : 'failed-data', snapshot.destination, source, snapshot);
        }
      }
      for (const artifact of t.replaced ?? []) {
        if (!GENERATED.some(relative => artifact.installed === path.join(record.repoRoot, relative))
          || artifact.previous !== `${artifact.installed}.cloudx-previous-${record.run.id}` || typeof artifact.existed !== 'boolean') throw new Error('Invalid previous generated artifact ownership.');
        if (artifact.existed) add('previous-artifact', artifact.previous, 'replaced', artifact);
      }
      if (t.release) add('release', t.release, 'release');
      if (record.coordinator) add('coordinator', record.coordinator, 'coordinator');
    }
    for (const a of artifacts) for (const b of artifacts) {
      if (a !== b && b.path.startsWith(`${a.path}/`)) throw new Error('Recorded backup roots overlap.');
    }
    return artifacts;
  }

  inspect({ cleanupId, verifyOwnership = false } = {}) {
    const records = this.records();
    const blockedReason = this.updater.preflight() ?? this.blockedReason(records, cleanupId);
    const references = this.referenceInspector(this.updater);
    const artifacts = this.artifacts(records);
    const existing = [];
    for (const artifact of artifacts) {
      try {
        const tree = scanBackup(artifact.path, { allowRootLink: artifact.kind === 'previous-artifact' });
        if (['snapshot', 'failed-data'].includes(artifact.kind)) {
          const owned = new Map(artifact.original.manifest.map(entry => [entry.path, entry]));
          const partial = artifact.original.backupCleanup !== undefined;
          if ((!partial && tree.entries.length !== owned.size) || tree.entries.some(entry => {
            const saved = owned.get(entry.path);
            return !saved || saved.type !== entry.type || entry.type === 'file' && saved.size !== entry.size || entry.type === 'link' && saved.link !== entry.link;
          })) artifact.protectionReason ??= 'Snapshot contents differ from their saved ownership manifest; inspect the retained files manually.';
        }
        if (verifyOwnership && ['snapshot', 'failed-data'].includes(artifact.kind) && !artifact.protectionReason) {
          const present = new Set(tree.entries.map(entry => entry.path));
          this.verifyManifest(artifact, tree, artifact.original.manifest.filter(entry => present.has(entry.path)));
        }
        if (artifact.priorCleanup && !artifact.protectionReason) {
          const prior = this.readOptional(this.historyFile(artifact.priorCleanup.cleanupId).replace(/\.json$/, '.preview.json'));
          const reviewed = prior?.artifacts?.find(value => value.id === artifact.id && value.path === artifact.path);
          if (!reviewed?.tree) throw new Error('Partial cleanup has no saved ownership tree.');
          const entries = new Map(reviewed.tree.entries.map(entry => [entry.path, entry]));
          if (fingerprint(tree.ancestors) !== fingerprint(reviewed.tree.ancestors) || tree.entries.some(entry => {
            const original = entries.get(entry.path);
            const keys = entry.type === 'directory' ? ['type', 'dev', 'ino', 'mode'] : ['type', 'dev', 'ino', 'mode', 'size', 'mtime', 'link'];
            return !original || keys.some(key => original[key] !== entry[key]);
          })) throw new Error('Partially removed backup contains changed or unreviewed files.');
        }
        if (artifact.kind === 'coordinator' && !artifact.protectionReason && !artifact.priorCleanup) {
          const bundle = readBackupJson(path.join(artifact.path, 'bundle.json'));
          this.verifyManifest(artifact, tree, bundle);
          const owned = new Set(['', 'bundle.json', ...bundle.flatMap(entry => {
            const parents = []; let parent = path.posix.dirname(entry.path);
            while (parent !== '.') { parents.push(parent); parent = path.posix.dirname(parent); }
            return [entry.path, ...parents];
          })]);
          if (tree.entries.some(entry => !owned.has(entry.path))) artifact.protectionReason = 'Coordinator contains files outside its saved bundle; inspect them manually.';
        }
        artifact.tree = tree;
        artifact.logicalBytes = tree.logicalBytes;
        artifact.allocatedBytes = tree.allocatedBytes;
        artifact.reclaimableBytes = artifact.protectionReason ? 0 : tree.allocatedBytes;
        artifact.protectionReason ??= backupReferenceReason(artifact.path, references);
        if (!artifact.protectionReason && tree.entries[0]?.type === 'link') {
          artifact.protectionReason = backupReferenceReason(fs.realpathSync(artifact.path), references);
        }
        if (artifact.protectionReason) artifact.reclaimableBytes = 0;
        if (artifact.protectionReason) delete artifact.tree;
        existing.push(artifact);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // A missing root is already gone. An incomplete child scan is retained.
          try { backupParent(artifact.path, (parent, name) => fs.lstatSync(parent.entry(name))); }
          catch (rootError) { if (rootError.code === 'ENOENT') continue; }
        }
        artifact.protectionReason ??= `Backup ownership or storage could not be verified: ${error.code ?? error.message}`;
        artifact.reclaimableBytes = 0;
        existing.push(artifact);
      }
    }
    const eligible = existing.filter(artifact => !artifact.protectionReason);
    const inodes = new Map();
    for (const artifact of eligible) {
      artifact.reclaimableBytes = 0;
      for (const entry of artifact.tree.entries) {
        const key = `${entry.dev}:${entry.ino}`;
        const value = inodes.get(key) ?? { count: 0, entry, artifact };
        value.count++;
        inodes.set(key, value);
      }
    }
    let reclaimableBytes = 0;
    for (const { count, entry, artifact } of inodes.values()) {
      if (entry.type !== 'directory' && count < entry.nlink) continue;
      const bytes = entry.blocks * 512;
      artifact.reclaimableBytes += bytes;
      reclaimableBytes += bytes;
    }
    return { artifacts: existing, records, reclaimableBytes, ...(blockedReason ? { blockedReason } : {}) };
  }

  publicBackup(artifact) {
    const { source, original, tree, recordHash, priorCleanup, ...backup } = artifact;
    return backup;
  }
  inventory() {
    this.status();
    const inspection = this.inspect();
    return { backups: inspection.artifacts.map(artifact => this.publicBackup(artifact)), ...(inspection.blockedReason ? { blockedReason: inspection.blockedReason } : {}) };
  }
  preview() {
    this.status();
    const inspection = this.inspect({ verifyOwnership: true });
    if (inspection.blockedReason) throw updateConflict(inspection.blockedReason);
    const preview = { id: randomUUID(), createdAt: new Date().toISOString(), backups: inspection.artifacts.map(artifact => this.publicBackup(artifact)), reclaimableBytes: inspection.reclaimableBytes, estimateNote: ESTIMATE_NOTE };
    this.write(this.previewFile, { ...preview, artifacts: inspection.artifacts.map(({ original, ...artifact }) => artifact), recordsHash: fingerprint(inspection.records) });
    return preview;
  }

  validatePreview(preview, inspection) {
    if (inspection.blockedReason) throw updateConflict(inspection.blockedReason);
    const current = new Map(inspection.artifacts.map(artifact => [artifact.id, artifact]));
    const changed = preview.recordsHash !== fingerprint(inspection.records) || preview.artifacts.length !== current.size
      || preview.artifacts.some(reviewed => {
        const artifact = current.get(reviewed.id);
        if (!artifact) return true;
        if (reviewed.protectionReason) return false;
        return artifact.protectionReason || artifact.tree?.fingerprint !== reviewed.tree?.fingerprint || artifact.recordHash !== reviewed.recordHash;
      });
    if (changed) {
      throw updateConflict('The backup files, update records or live references changed. Review a new cleanup preview before deleting anything.');
    }
  }

  start({ previewId, confirmPermanentDeletion } = {}) {
    if (!UUID.test(previewId ?? '') || confirmPermanentDeletion !== true) throw updateConflict('Review the preview and explicitly confirm permanent deletion.');
    this.status();
    const id = randomUUID();
    const token = this.lock.acquire('backup-cleanup', id);
    let launched = false;
    try {
      const preview = this.readOptional(this.previewFile);
      if (!preview || preview.id !== previewId) throw updateConflict('The cleanup preview is no longer current. Review a new preview.');
      const inspection = this.inspect({ cleanupId: id });
      this.validatePreview(preview, inspection);
      if (!preview.artifacts.some(artifact => !artifact.protectionReason)) throw updateConflict('No eligible update backups remain.');
      const devices = new Set();
      const freeSpace = [];
      for (const artifact of inspection.artifacts.filter(artifact => !artifact.protectionReason)) {
        const stat = fs.statSync(path.dirname(artifact.path));
        if (devices.has(stat.dev)) continue;
        devices.add(stat.dev);
        const capacity = fs.statfsSync(path.dirname(artifact.path));
        freeSpace.push({ path: path.dirname(artifact.path), availableBytesBefore: capacity.bavail * capacity.bsize, availableBytesAfter: null });
      }
      const journal = { id, previewId, lockToken: token, pid: null, state: 'running', startedAt: new Date().toISOString(), freeSpace,
        results: preview.artifacts.map(artifact => ({ id: artifact.id, runId: artifact.runId, path: artifact.path,
          status: artifact.protectionReason ? 'protected' : 'pending', ...(artifact.protectionReason ? { reason: artifact.protectionReason } : {}), deletedLogicalBytes: 0 })) };
      this.writeJournal(journal);
      this.write(this.historyFile(id).replace(/\.json$/, '.preview.json'), preview);
      this.updater.commands.inspect('systemd-run', ['--user', '--quiet', '--collect', `--unit=${UPDATE_UNIT}`, '--property=Type=exec',
        `--description=${BACKUP_CLEANUP_DESCRIPTION}${id}`, '--property=UMask=0077', '--property=KillMode=control-group', '--property=RuntimeMaxSec=3600',
        '--property=StandardInput=null', '--property=StandardOutput=null', '--property=StandardError=null', '--', process.execPath.replaceAll('%', '%%').replaceAll('$', '$$'),
        ...[fileURLToPath(import.meta.url), this.updater.repoRoot, this.updater.home, this.updater.dataDir, id].map(value => value.replaceAll("%", "%%").replaceAll("$", "$$"))]);
      launched = true;
      return this.publicJournal(journal);
    } finally {
      if (!launched) {
        const journal = this.readOptional(this.journalFile);
        if (journal?.id === id) this.interrupt(journal, 'The cleanup service could not start. Review a new preview and try again.');
        if (this.lock.read()?.token === token) this.lock.release(token);
      }
    }
  }

  interrupt(journal, reason = RECOVERY) {
    journal.state = 'interrupted';
    journal.finishedAt = new Date().toISOString();
    journal.recoveryAction = reason;
    for (const result of journal.results) {
      if (result.status === 'deleting') { result.status = 'failed'; result.reason = 'Cleanup was interrupted after deletion intent was saved; this backup may be partially removed.'; }
      else if (result.status === 'pending') { result.status = 'skipped'; result.reason = 'Cleanup stopped before this backup was deleted.'; }
    }
    this.measureAfter(journal);
    this.writeJournal(journal);
    if (this.lock.read()?.token === journal.lockToken) this.lock.release(journal.lockToken);
  }
  status() {
    let journal = this.readOptional(this.journalFile);
    const lock = this.lock.read();
    if (lock?.cleanupId) {
      const owned = this.readOptional(this.historyFile(lock.cleanupId));
      if (journal?.id !== lock.cleanupId && owned) journal = owned;
      const unit = this.updater.unit();
      if (journal?.id !== lock.cleanupId) {
        const starterAlive = processIdentity(lock.pid) === lock.processIdentity;
        if (!unit.running && !starterAlive) {
          journal = { id: lock.cleanupId, state: 'running', lockToken: lock.token, startedAt: lock.createdAt, results: [], freeSpace: [] };
          this.interrupt(journal, 'Cleanup was interrupted before its deletion journal was created. No backup deletion began. Review a new preview to start cleanup.');
        }
      } else if (journal.state !== 'running' && !unit.running) this.lock.release(lock.token);
    }
    if (!journal) return null;
    if (journal.state === 'running') {
      const unit = this.updater.unit();
      const running = unit.running && unit.Description === `${BACKUP_CLEANUP_DESCRIPTION}${journal.id}`;
      if (!running && Date.now() - Date.parse(journal.startedAt) > 20_000) this.interrupt(journal);
    }
    return this.publicJournal(journal);
  }
  measureAfter(journal) {
    for (const filesystem of journal.freeSpace) {
      try { const capacity = fs.statfsSync(filesystem.path); filesystem.availableBytesAfter = capacity.bavail * capacity.bsize; }
      catch { filesystem.availableBytesAfter = null; }
    }
  }

  recordDeletionIntent(artifact, record, cleanupId) {
    const t = record.transition;
    record.backupCleanup ??= {};
    const artifacts = record.backupCleanup.artifacts ??= [];
    const previous = artifacts.find(value => value.path === artifact.path);
    if (previous) previous.cleanupId = cleanupId;
    else artifacts.push({ id: artifact.id, kind: artifact.kind, path: artifact.path, cleanupId });
    if (['snapshot', 'failed-data'].includes(artifact.kind)) {
      const snapshot = t[artifact.source].find(snapshot => snapshot.destination === artifact.path);
      snapshot.backupCleanup = { id: cleanupId, state: 'deleting' };
      if (artifact.kind === 'snapshot') {
        record.backupCleanup = { ...(record.backupCleanup ?? {}), snapshotsUnavailable: true };
        t.snapshotVerified = false;
      }
    }
    this.write(this.updater.recordPath(record.run.id), record);
  }

  run(id, { verifyService = true } = {}) {
    let journal = this.readOptional(this.journalFile);
    if (!journal || journal.id !== id || journal.state !== 'running' || this.lock.read()?.token !== journal.lockToken) throw updateConflict('The saved cleanup identity or operation lock changed.');
    const unit = this.updater.unit();
    if (verifyService && (!unit.running || unit.Description !== `${BACKUP_CLEANUP_DESCRIPTION}${id}`
      || !this.updater.readCgroup(process.pid).split('\n').some(line => line.split(':').at(-1) === unit.ControlGroup || line.split(':').at(-1)?.startsWith(`${unit.ControlGroup}/`)))) throw new Error('Backup cleanup must run in its managed update service.');
    const preview = this.readOptional(this.previewFile);
    try {
      let initial = this.inspect({ cleanupId: id });
      if (!preview || preview.id !== journal.previewId) throw updateConflict('The saved cleanup preview changed before deletion.');
      this.validatePreview(preview, initial);
      journal.pid = process.pid;
      this.writeJournal(journal);
      const recordHashes = new Map(initial.records.map(record => [record.run.id, fingerprint(record)]));
      initial = null;
      for (const artifact of preview.artifacts) {
        const result = journal.results.find(result => result.id === artifact.id);
        if (result.status === 'protected') continue;
        const records = this.records();
        const blocked = this.blockedReason(records, id);
        const record = records.find(record => record.run.id === artifact.runId);
        const reason = blocked ?? (recordHashes.get(artifact.runId) !== fingerprint(record) ? 'The update record changed after review.' : undefined)
          ?? (this.selectedSnapshots(records).has(artifact.runId) && ['snapshot', 'failed-data'].includes(artifact.kind) ? 'Snapshot was selected for restoration after review.' : undefined)
          ?? backupReferenceReason(artifact.path, this.referenceInspector(this.updater));
        if (reason) { result.status = 'skipped'; result.reason = reason; this.writeJournal(journal); continue; }
        try {
          const current = scanBackup(artifact.path, { allowRootLink: artifact.kind === 'previous-artifact' });
          // Earlier eligible hardlink deletion changes nlink and ctime, never identity or contents.
          const stable = tree => ({ ancestors: tree.ancestors, entries: tree.entries.map(({ ctime, nlink, ...entry }) => entry) });
          if (fingerprint(stable(current)) !== fingerprint(stable(artifact.tree))) throw new Error('Backup files changed after review.');
          const finalRecords = this.records();
          const finalRecord = finalRecords.find(value => value.run.id === artifact.runId);
          const finalReason = this.blockedReason(finalRecords, id)
            ?? (recordHashes.get(artifact.runId) !== fingerprint(finalRecord) ? 'The update record changed during the deletion check.' : undefined)
            ?? (this.selectedSnapshots(finalRecords).has(artifact.runId) && ['snapshot', 'failed-data'].includes(artifact.kind) ? 'Snapshot was selected during the deletion check.' : undefined)
            ?? backupReferenceReason(artifact.path, this.referenceInspector(this.updater));
          if (finalReason) { result.status = 'skipped'; result.reason = finalReason; this.writeJournal(journal); continue; }
          result.status = 'deleting';
          this.writeJournal(journal);
          this.recordDeletionIntent(artifact, record, id);
          recordHashes.set(record.run.id, fingerprint(record));
          this.checkpoint('before-delete-backup', artifact);
          let lastSaved = Date.now();
          this.remove(artifact.path, artifact.tree, { checkpoint: this.checkpoint, progress: bytes => {
            result.deletedLogicalBytes += bytes;
            if (Date.now() - lastSaved > 1000) { this.writeJournal(journal); lastSaved = Date.now(); }
          } });
          result.status = 'deleted';
          if (['snapshot', 'failed-data'].includes(artifact.kind)) {
            record.transition[artifact.source].find(snapshot => snapshot.destination === artifact.path).backupCleanup.state = 'deleted';
            this.write(this.updater.recordPath(record.run.id), record);
            recordHashes.set(record.run.id, fingerprint(record));
          }
        } catch (error) {
          if (error.cleanupInterrupted) throw error;
          result.status = error.code === 'ENOENT' && result.status === 'pending' ? 'skipped' : 'failed';
          result.reason = `Deletion stopped; remaining files were retained: ${error.code ?? error.message}`;
        }
        this.writeJournal(journal);
        this.checkpoint('after-delete-backup', artifact);
      }
      journal.state = 'completed';
      journal.finishedAt = new Date().toISOString();
      if (journal.results.some(result => ['failed', 'skipped'].includes(result.status))) journal.recoveryAction = RECOVERY;
      this.measureAfter(journal);
      this.writeJournal(journal);
      this.lock.release(journal.lockToken);
      return this.publicJournal(journal);
    } catch (error) {
      if (error.cleanupInterrupted) throw error;
      this.interrupt(journal, `${error.message} ${RECOVERY}`);
      return this.publicJournal(journal);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [repoRoot, home, dataDir, id] = process.argv.slice(2);
  const { SettingsUpdater } = await import('./settings-update.mjs');
  const updater = new SettingsUpdater({ repoRoot, home, dataDir, serverPid: process.pid, cli: true });
  try { new UpdateBackupCleanup({ updater }).run(id); }
  catch { process.exitCode = 1; }
}

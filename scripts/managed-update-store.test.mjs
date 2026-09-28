import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bundleCoordinator, hashFile, restoreSnapshot, snapshotTree, verifySnapshot, writeUpdateJson, estimateSnapshot, manifestTree, filesystemCapacity, parseQuotaCapacity } from './managed-update-store.mjs';

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('reserves every hardlinked pathname for full copying, including sparse-file expansion', () => {
  const { root, source, backup } = fixture();
  fs.writeFileSync(path.join(source, 'dependency'), Buffer.alloc(1024 * 1024, 7));
  fs.linkSync(path.join(source, 'dependency'), path.join(source, 'dependency-alias'));
  fs.writeFileSync(path.join(source, 'sparse'), '');
  fs.truncateSync(path.join(source, 'sparse'), 2 * 1024 * 1024);
  fs.symlinkSync(root, path.join(source, 'external-link'));
  fs.mkdirSync(path.join(source, 'terminal-runtime'));
  fs.writeFileSync(path.join(source, 'terminal-runtime/ignored'), Buffer.alloc(1024));
  const exclude = relative => relative === 'terminal-runtime';
  const estimate = estimateSnapshot(source, { exclude });
  expect(estimate.fileBytes).toBe(4 * 1024 * 1024 + Buffer.byteLength('original bytes'));
  expect(estimate.bytes).toBeGreaterThanOrEqual(estimate.fileBytes);
  const copy = fs.copyFileSync;
  vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, flags) => copy(from, to, flags & ~fs.constants.COPYFILE_FICLONE));
  const progress = [];
  const manifest = snapshotTree(source, backup, { exclude, progress: value => progress.push(value) });
  verifySnapshot(backup, manifest);
  expect(fs.statSync(path.join(backup, 'dependency')).ino).not.toBe(fs.statSync(path.join(backup, 'dependency-alias')).ino);
  expect(progress.at(-1)).toMatchObject({ files: 4, bytes: estimate.fileBytes });
  expect(estimate.manifestBytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(manifest, null, 2)));
  expect(fs.existsSync(path.join(backup, 'terminal-runtime'))).toBe(false);
});

it('manifests the retained release without creating another build copy', () => {
  const { source, backup } = fixture();
  const copy = vi.spyOn(fs, 'copyFileSync');
  const manifest = manifestTree(source);
  verifySnapshot(source, manifest);
  expect(copy).not.toHaveBeenCalled();
  expect(fs.existsSync(backup)).toBe(false);
});

it('rejects a release directory that changes while its manifest is collected', () => {
  const { source } = fixture();
  const read = fs.readdirSync;
  let changed = false;
  vi.spyOn(fs, 'readdirSync').mockImplementation((directory, ...options) => {
    const names = read(directory, ...options);
    if (!changed && fs.realpathSync(directory) === path.join(source, 'nested')) {
      changed = true;
      fs.writeFileSync(path.join(source, 'nested/unverified'), 'new bytes');
      fs.utimesSync(path.join(source, 'nested'), new Date(), new Date(Date.now() + 1000));
    }
    return names;
  });
  expect(() => manifestTree(source)).toThrow('changed during manifesting');
});

it('limits available space and inodes by unprivileged blocks and both destination quotas', () => {
  const { source } = fixture();
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096, bavail: 100, bfree: 1000, files: 1000, ffree: 900 });
  const quotaCommand = vi.fn((_, args) => ({ status: 0, stdout: `Disk quotas for user example:\nFilesystem blocks quota limit grace files quota limit grace\n/dev/test 10 ${args.includes('--group') ? 20 : 30} 40 0 3 20 30 0\n`, stderr: '' }));
  const capacity = filesystemCapacity(path.join(source, 'not-created'), { quotaCommand });
  expect(capacity).toMatchObject({ availableBytes: 10 * 1024, availableInodes: 17, quotaStatus: 'user checked; destination group checked' });
  expect(quotaCommand).toHaveBeenCalledTimes(2);
  expect(parseQuotaCapacity('/dev/test 50* 20 40 1 31* 20 30 1')).toEqual({ bytes: 0, inodes: 0 });
  expect(() => parseQuotaCapacity('/dev/test invalid quota output')).toThrow('Cannot parse quota');
});

it('reports unavailable quota tools and fails clearly when a quota query fails', () => {
  const { source } = fixture();
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => file === '/proc/self/mountinfo' ? '1 0 8:1 / / rw - ext4 /dev/test rw\n' : read(file, ...args));
  expect(filesystemCapacity(source, { quotaCommand: () => ({ error: { code: 'ENOENT' } }) }).quotaStatus).toContain('not installed');
  expect(() => filesystemCapacity(source, { quotaCommand: () => ({ status: 1, stdout: '', stderr: 'Permission denied' }) })).toThrow('Cannot inspect user quota');
});

it.each([
  'quota: Mountpoint (or device) / not found or has no quota enabled.\nquota: Not all specified mountpoints are using quota.\n',
  'Mountpoint (or device) / not found or has no quota enabled',
])('uses filesystem capacity when quota-tools reports disabled quotas: %s', stderr => {
  const { source } = fixture();
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => file === '/proc/self/mountinfo' ? '1 0 8:1 / / rw - ext4 /dev/test rw\n' : read(file, ...args));
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096, bavail: 100, files: 1000, ffree: 900 });
  const quotaCommand = vi.fn(() => ({ status: 1, stdout: '', stderr }));
  expect(filesystemCapacity(source, { quotaCommand })).toMatchObject({ availableBytes: 409600, availableInodes: 900,
    quotaStatus: 'user not enabled; destination group not enabled' });
  expect(quotaCommand).toHaveBeenCalledTimes(2);
});

it.each(['user', 'group'])('retains %s quota limits when the other quota type is disabled', kind => {
  const { source } = fixture();
  const read = fs.readFileSync;
  const option = kind === 'user' ? 'usrquota' : 'grpquota';
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => file === '/proc/self/mountinfo'
    ? `1 0 8:1 / / rw - ext4 /dev/test rw,${option}\n` : read(file, ...args));
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096, bavail: 100, files: 1000, ffree: 900 });
  const quotaCommand = vi.fn((_, args) => args.includes(`--${kind}`)
    ? { status: 0, stdout: '/dev/test 10 20 30 0 3 20 30 0\n', stderr: '' }
    : { status: 1, stdout: '', stderr: 'quota: Not all specified mountpoints are using quota.\n' });
  expect(filesystemCapacity(source, { quotaCommand })).toMatchObject({ availableBytes: 10240, availableInodes: 17,
    quotaStatus: kind === 'user' ? 'user checked; destination group not enabled' : 'user not enabled; destination group checked' });
});

it.each([
  ['rw,usrquota', 'quota: Not all specified mountpoints are using quota.\n'],
  ['rw', 'quota: Permission denied\nquota: Not all specified mountpoints are using quota.\n'],
  ['rw', 'quota: Mountpoint (or device) /other not found or has no quota enabled.\n'],
])('rejects failed quota inspection with mount options %s and diagnostics %s', (options, stderr) => {
  const { source } = fixture();
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => file === '/proc/self/mountinfo'
    ? `1 0 8:1 / / rw - ext4 /dev/test ${options}\n` : read(file, ...args));
  expect(() => filesystemCapacity(source, { quotaCommand: () => ({ status: 1, stdout: '', stderr }) })).toThrow('Cannot inspect user quota');
});

it('snapshots and restores bytes, modes and links while preserving their external targets', () => {
  const { root, source, backup } = fixture();
  const external = path.join(root, 'external');
  fs.writeFileSync(external, 'outside snapshot');
  fs.symlinkSync(external, path.join(source, 'external-link'));
  fs.chmodSync(path.join(source, 'nested/record'), 0o640);
  const manifest = snapshotTree(source, backup);
  verifySnapshot(backup, manifest);
  fs.writeFileSync(path.join(source, 'nested/record'), 'newer bytes');
  restoreSnapshot(backup, source, manifest);
  expect(fs.readFileSync(path.join(source, 'nested/record'), 'utf8')).toBe('original bytes');
  expect(fs.statSync(path.join(source, 'nested/record')).mode & 0o777).toBe(0o640);
  expect(fs.readlinkSync(path.join(source, 'external-link'))).toBe(external);
  expect(fs.readFileSync(external, 'utf8')).toBe('outside snapshot');
});

it('rejects a symlinked data root before creating a link-only snapshot', () => {
  const { root, source, backup } = fixture();
  const linked = path.join(root, 'linked');
  fs.symlinkSync(source, linked);
  expect(() => snapshotTree(linked, backup)).toThrow();
  expect(fs.existsSync(backup)).toBe(false);
  expect(fs.readFileSync(path.join(source, 'nested/record'), 'utf8')).toBe('original bytes');
});

it('verifies an installed release link only against its explicitly expected release root', () => {
  const { root, source, backup } = fixture();
  const manifest = snapshotTree(source, backup);
  const installed = path.join(root, 'installed');
  fs.symlinkSync(backup, installed);
  expect(() => verifySnapshot(installed, manifest)).toThrow('explicitly expected release link');
  expect(() => verifySnapshot(installed, manifest, { expectedRoot: source })).toThrow('explicitly expected release link');
  expect(() => verifySnapshot(installed, manifest, { expectedRoot: backup })).not.toThrow();
});

it('rejects redirected descendants even when the manifest omits directory entries', () => {
  const { source, backup } = fixture();
  const manifest = snapshotTree(source, backup).filter(entry => entry.type === 'file');
  fs.rmSync(path.join(backup, 'nested'), { recursive: true });
  fs.symlinkSync(path.join(source, 'nested'), path.join(backup, 'nested'));
  expect(() => verifySnapshot(backup, manifest)).toThrow();
});

it.each([
  { path: '../external', type: 'file', mode: 0o600, size: 1, sha256: '0'.repeat(64) },
  { path: 'nested/record', type: 'file', mode: 0o600, size: -1, sha256: '0'.repeat(64) },
  { path: 'unknown', type: 'file', mode: 0o600, size: 1, sha256: 'not-a-digest' },
  { path: '', type: 'link', link: '/tmp' }
])('validates all manifest metadata before opening content or changing destination bytes (%j)', malformed => {
  const { source, backup } = fixture();
  const manifest = snapshotTree(source, backup);
  fs.writeFileSync(path.join(source, 'nested/record'), 'retain current data');
  const read = vi.spyOn(fs, 'readSync');
  expect(() => restoreSnapshot(backup, source, [...manifest, malformed])).toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(source, 'nested/record'), 'utf8')).toBe('retain current data');
});

it('rejects a same-size digest mismatch before restoring any files', () => {
  const { source, backup } = fixture();
  const manifest = snapshotTree(source, backup);
  fs.writeFileSync(path.join(backup, 'nested/record'), 'modified bytes');
  fs.writeFileSync(path.join(source, 'nested/record'), 'retain current data');
  expect(() => restoreSnapshot(backup, source, manifest)).toThrow('digest verification failed');
  expect(fs.readFileSync(path.join(source, 'nested/record'), 'utf8')).toBe('retain current data');
});

it('rejects special files from metadata without opening a blocking fifo', () => {
  const { source, backup } = fixture();
  const manifest = snapshotTree(source, backup);
  fs.unlinkSync(path.join(backup, 'nested/record'));
  execFileSync('mkfifo', [path.join(backup, 'nested/record')]);
  const read = vi.spyOn(fs, 'readSync');
  expect(() => verifySnapshot(backup, manifest)).toThrow('metadata verification failed');
  expect(read).not.toHaveBeenCalled();
  expect(() => hashFile(path.join(backup, 'nested/record'))).toThrow('regular file');
});

it('refuses a redirected destination parent before replacing existing data', () => {
  const { root, source, backup } = fixture();
  const manifest = snapshotTree(source, backup);
  const destination = path.join(root, 'restore');
  fs.mkdirSync(destination);
  fs.symlinkSync(path.join(source, 'nested'), path.join(destination, 'nested'));
  fs.writeFileSync(path.join(source, 'nested/record'), 'external data');
  expect(() => restoreSnapshot(backup, destination, manifest)).toThrow();
  expect(fs.readFileSync(path.join(source, 'nested/record'), 'utf8')).toBe('external data');
});

it('keeps source and previous destination bytes intact when a restore copy is interrupted', () => {
  const { source, backup } = fixture();
  const manifest = snapshotTree(source, backup);
  fs.writeFileSync(path.join(source, 'nested/record'), 'previous destination');
  vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  expect(() => restoreSnapshot(backup, source, manifest)).toThrow('disk full');
  expect(fs.readFileSync(path.join(source, 'nested/record'), 'utf8')).toBe('previous destination');
  expect(fs.readFileSync(path.join(backup, 'nested/record'), 'utf8')).toBe('original bytes');
  expect(fs.readdirSync(path.join(source, 'nested'))).toEqual(['record']);
});

it('flushes restored files and every nested directory before restoration completes', () => {
  const { source, backup } = fixture();
  const manifest = snapshotTree(source, backup);
  const flushed = [];
  const fsync = fs.fsyncSync;
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { flushed.push({ file: fs.readlinkSync(`/proc/self/fd/${fd}`), directory: fs.fstatSync(fd).isDirectory() }); fsync(fd); });
  restoreSnapshot(backup, source, manifest);
  expect(flushed.some(entry => !entry.directory && entry.file.includes('.restore'))).toBe(true);
  for (const directory of [source, path.join(source, 'nested'), path.dirname(source)])
    expect(flushed).toContainEqual({ file: directory, directory: true });
});

it('bundles only validated regular source files and rejects mismatched staged bytes', () => {
  const { source, backup } = fixture();
  expect(() => bundleCoordinator(source, backup, ['../outside'])).toThrow('unique relative');
  expect(fs.existsSync(backup)).toBe(false);
  bundleCoordinator(source, backup, ['nested/record']);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'bundle.json'), 'utf8'));
  verifySnapshot(backup, manifest);
  fs.writeFileSync(path.join(backup, 'nested/record'), 'modified bytes');
  expect(() => verifySnapshot(backup, manifest)).toThrow('digest verification failed');
});

it('writes private durable JSON without replacing a linked state file', () => {
  const { root } = fixture();
  const file = path.join(root, 'state/current.json');
  writeUpdateJson(file, { phase: 'snapshot' });
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ phase: 'snapshot' });
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const linked = path.join(root, 'state/linked.json');
  fs.symlinkSync(file, linked);
  expect(() => writeUpdateJson(linked, { phase: 'unexpected' })).toThrow('regular file');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ phase: 'snapshot' });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-update-store-'));
  roots.push(root);
  const source = path.join(root, 'source'), backup = path.join(root, 'backup');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'nested/record'), 'original bytes');
  return { root, source, backup };
}

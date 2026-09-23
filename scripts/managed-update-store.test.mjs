import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bundleCoordinator, hashFile, restoreSnapshot, snapshotTree, verifySnapshot, writeUpdateJson } from './managed-update-store.mjs';

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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

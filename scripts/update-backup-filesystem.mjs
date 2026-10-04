import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class BackupDirectory {
  constructor(directory) { this.fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
  entry(name) {
    if (!name || name.includes('/') || name === '..') throw new Error('Invalid backup directory entry.');
    return `/proc/self/fd/${this.fd}/${name}`;
  }
  close() { fs.closeSync(this.fd); }
  sync() { fs.fsyncSync(this.fd); }
}

export function backupParent(file, action, { create = false } = {}) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0')) throw new Error('Backup paths must be canonical and absolute.');
  const opened = [new BackupDirectory('/')];
  const ancestors = [];
  try {
    let directory = opened[0], current = '';
    for (const part of path.dirname(file).slice(1).split('/').filter(Boolean)) {
      current += `/${part}`;
      if (create && !fs.lstatSync(directory.entry(part), { throwIfNoEntry: false })) { fs.mkdirSync(directory.entry(part), { mode: 0o700 }); directory.sync(); }
      directory = new BackupDirectory(directory.entry(part));
      opened.push(directory);
      const stat = fs.fstatSync(directory.fd);
      ancestors.push({ path: current, dev: stat.dev, ino: stat.ino });
    }
    return action(directory, path.basename(file), ancestors);
  } finally { for (const directory of opened.reverse()) directory.close(); }
}

export function readBackupJson(file) {
  return backupParent(file, (parent, name) => {
    const fd = fs.openSync(parent.entry(name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('Backup state must be a regular file.');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  });
}

export function writeBackupJson(file, value) {
  const bytes = JSON.stringify(value);
  if (bytes === undefined) throw new Error('Backup state must be JSON serializable.');
  backupParent(file, (parent, name) => {
    const destination = parent.entry(name), temporary = parent.entry(`${name}.${randomUUID()}.tmp`);
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error('Backup state must use a regular file.');
    try {
      fs.writeFileSync(temporary, `${bytes}\n`, { mode: 0o600, flag: 'wx', flush: true });
      fs.renameSync(temporary, destination);
      parent.sync();
    } finally { fs.rmSync(temporary, { force: true }); }
  }, { create: true });
}

function identity(stat, relative, link) {
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'link' : 'special';
  if (type === 'special') throw new Error('Backup contains a socket, device or other unsupported file.');
  return { path: relative, type, dev: stat.dev, ino: stat.ino, mode: stat.mode,
    size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, nlink: stat.nlink, blocks: stat.blocks, ...(link === undefined ? {} : { link }) };
}

export function scanBackup(file, { allowRootLink = false } = {}) {
  return backupParent(file, (parent, name, ancestors) => {
    const entries = [];
    function scan(directory, name, relative, device) {
      const stat = fs.lstatSync(directory.entry(name));
      if (device !== undefined && stat.dev !== device) throw new Error('Backup crosses a mounted filesystem.');
      const entry = identity(stat, relative, stat.isSymbolicLink() ? fs.readlinkSync(directory.entry(name)) : undefined);
      if (!relative && entry.type === 'link' && !allowRootLink) throw new Error('Backup root was replaced by a symbolic link.');
      entries.push(entry);
      if (entry.type === 'directory') {
        const child = new BackupDirectory(directory.entry(name));
        try {
          const opened = fs.fstatSync(child.fd);
          if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Backup directory changed while opening it.');
          for (const childName of fs.readdirSync(child.entry('.')).sort()) scan(child, childName, relative ? `${relative}/${childName}` : childName, stat.dev);
        } finally { child.close(); }
      }
    }
    scan(parent, name, '');
    return { ancestors, entries, fingerprint: fingerprint({ ancestors, entries }),
      logicalBytes: entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0),
      allocatedBytes: allocated(entries) };
  });
}

export function allocated(entries) {
  const inodes = new Map(entries.map(entry => [`${entry.dev}:${entry.ino}`, entry.blocks * 512]));
  return [...inodes.values()].reduce((sum, bytes) => sum + bytes, 0);
}
export function fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function sameEntry(actual, expected) {
  return ['type', 'dev', 'ino', 'mode', 'size', 'mtime', 'link'].every(key => actual[key] === expected[key]);
}

export function deleteReviewedBackup(file, tree, { checkpoint = () => {}, progress = () => {} } = {}) {
  return backupParent(file, (parent, name, ancestors) => {
    if (JSON.stringify(ancestors) !== JSON.stringify(tree.ancestors)) throw new Error('Backup parent directories changed since review.');
    const entries = new Map(tree.entries.map(entry => [entry.path, entry]));
    const children = new Map();
    for (const entry of tree.entries) {
      if (!entry.path) continue;
      const parentPath = path.posix.dirname(entry.path);
      const names = children.get(parentPath) ?? [];
      names.push(path.posix.basename(entry.path));
      children.set(parentPath, names);
    }
    function remove(directory, name, relative) {
      const expected = entries.get(relative);
      if (!expected) throw new Error('Backup has an unreviewed entry.');
      const full = directory.entry(name);
      const before = fs.lstatSync(full);
      const actual = identity(before, relative, before.isSymbolicLink() ? fs.readlinkSync(full) : undefined);
      if (!sameEntry(actual, expected)) throw new Error('Backup entry changed since review.');
      checkpoint('before-delete-entry', { path: file, relative });
      if (actual.type === 'directory') {
        const child = new BackupDirectory(full);
        try {
          const stat = fs.fstatSync(child.fd);
          if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error('Backup directory was replaced before deletion.');
          const names = fs.readdirSync(child.entry('.')).sort();
          const reviewed = (children.get(relative || '.') ?? []).sort();
          if (JSON.stringify(names) !== JSON.stringify(reviewed)) throw new Error('Backup directory contents changed since review.');
          for (const childName of names) remove(child, childName, relative ? `${relative}/${childName}` : childName);
          child.sync();
        } finally { child.close(); }
        const current = fs.lstatSync(full);
        if (current.dev !== expected.dev || current.ino !== expected.ino || !current.isDirectory()) throw new Error('Backup directory was replaced during deletion.');
        fs.rmdirSync(full);
      } else {
        const current = fs.lstatSync(full);
        if (!sameEntry(identity(current, relative, current.isSymbolicLink() ? fs.readlinkSync(full) : undefined), expected)) throw new Error('Backup file was replaced before deletion.');
        fs.unlinkSync(full);
        if (actual.type === 'file') progress(actual.size);
      }
      if (actual.type === 'directory') directory.sync();
      checkpoint('after-delete-entry', { path: file, relative });
    }
    remove(parent, name, '');
  });
}

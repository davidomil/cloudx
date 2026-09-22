import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

class Directory {
  constructor(directory) {
    this.fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  }
  entry(name) { return `/proc/self/fd/${this.fd}/${name}`; }
  close() { fs.closeSync(this.fd); }
  sync() { fs.fsyncSync(this.fd); }
}

function inDirectory(root, relative, create, action) {
  const opened = [];
  let directory = root;
  try {
    for (const name of relative ? relative.split(path.sep) : []) {
      if (create && !fs.lstatSync(directory.entry(name), { throwIfNoEntry: false })) {
        fs.mkdirSync(directory.entry(name), { mode: 0o700 });
        directory.sync();
      }
      directory = new Directory(directory.entry(name));
      opened.push(directory);
    }
    return action(directory);
  } finally { for (const directory of opened.reverse()) directory.close(); }
}

function ensureDirectory(directory) {
  const root = new Directory(path.parse(path.resolve(directory)).root);
  try { inDirectory(root, path.resolve(directory).slice(1), true, target => target.sync()); }
  finally { root.close(); }
}

export function syncDirectory(directory) {
  const root = new Directory(directory);
  try { root.sync(); } finally { root.close(); }
}

export function writeUpdateJson(file, value) {
  const bytes = JSON.stringify(value, null, 2);
  if (bytes === undefined) throw new Error('Update state must be JSON serializable.');
  const parent = path.dirname(file);
  ensureDirectory(parent);
  const directory = new Directory(parent);
  const temporary = directory.entry(`${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const target = directory.entry(path.basename(file));
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error('Update state destination must be a regular file.');
    fs.writeFileSync(temporary, `${bytes}\n`, { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, target);
    directory.sync();
  } finally { fs.rmSync(temporary, { force: true }); directory.close(); }
}

// Sockets are live process state. Links are retained as links, never followed.
export function snapshotTree(source, destination, { exclude = () => false } = {}) {
  if (inside(source, destination)) throw new Error('A recovery snapshot must be outside its source directory.');
  const original = new Directory(source);
  let backup;
  const manifest = [];
  function copy(from, to, relative) {
    const before = fs.fstatSync(from.fd);
    const names = fs.readdirSync(from.entry('.')).sort().filter(name => !exclude(path.join(relative, name)));
    manifest.push({ path: relative, type: 'directory', mode: before.mode & 0o777 });
    for (const name of names) {
      const child = path.join(relative, name);
      const stat = fs.lstatSync(from.entry(name));
      if (stat.isSocket()) continue;
      if (stat.isDirectory()) {
        fs.mkdirSync(to.entry(name), { mode: 0o700 });
        const input = new Directory(from.entry(name));
        const output = new Directory(to.entry(name));
        try { copy(input, output, child); } finally { input.close(); output.close(); }
      } else if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(from.entry(name));
        fs.symlinkSync(link, to.entry(name));
        manifest.push({ path: child, type: 'link', link });
      } else if (stat.isFile()) {
        const file = copyRegular(from.entry(name), to.entry(name), 0o600);
        manifest.push({ path: child, type: 'file', mode: stat.mode & 0o777, ...file });
      } else throw new Error(`Recovery source contains an unsupported special file: ${child}`);
    }
    const after = fs.fstatSync(from.fd);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw new Error(`Recovery directory changed during snapshot: ${relative}`);
    to.sync();
  }
  try {
    ensureDirectory(path.dirname(destination));
    fs.mkdirSync(destination, { mode: 0o700 });
    backup = new Directory(destination);
    copy(original, backup, '');
    syncDirectory(path.dirname(destination));
    return manifest;
  } finally { original.close(); backup?.close(); }
}

function copyRegular(source, destination, mode) {
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('Recovery source must be a regular file.');
    fs.copyFileSync(`/proc/self/fd/${fd}`, destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(destination, mode);
    const copied = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let sha256;
    try { fs.fsyncSync(copied); sha256 = hashDescriptor(copied); } finally { fs.closeSync(copied); }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha256 !== hashDescriptor(fd))
      throw new Error('Recovery source changed during copying.');
    return { size: before.size, sha256 };
  } finally { fs.closeSync(fd); }
}

function hashDescriptor(fd) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let offset = 0, size;
  while ((size = fs.readSync(fd, buffer, 0, buffer.length, offset))) { hash.update(buffer.subarray(0, size)); offset += size; }
  return hash.digest('hex');
}

export function hashFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('A recovery digest requires a regular file.');
    return hashDescriptor(fd);
  } finally { fs.closeSync(fd); }
}

function validRelative(relative, root = false) {
  return typeof relative === 'string' && (root && relative === '' || relative !== '' && !path.isAbsolute(relative)
    && !relative.includes('\\') && !relative.includes('\0') && relative.split('/').every(part => part && part !== '.' && part !== '..'));
}

function validateManifest(manifest) {
  if (!Array.isArray(manifest) || !manifest.length) throw new Error('Recovery manifest is empty.');
  const entries = new Map();
  for (const entry of manifest) {
    if (!entry || !validRelative(entry.path, true) || entries.has(entry.path)) throw new Error('Invalid or duplicate recovery manifest path.');
    const mode = Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777;
    if (entry.path === '' && entry.type !== 'directory' ||
      !(entry.type === 'directory' ? mode : entry.type === 'link' ? typeof entry.link === 'string' && !entry.link.includes('\0') :
        entry.type === 'file' && mode && Number.isSafeInteger(entry.size) && entry.size >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256)))
      throw new Error(`Invalid recovery manifest metadata: ${entry.path}`);
    entries.set(entry.path, entry);
  }
  for (const entry of manifest) {
    let parent = path.dirname(entry.path);
    while (parent !== '.') {
      if (entries.has(parent) && entries.get(parent).type !== 'directory') throw new Error('A recovery entry cannot descend through a file or symbolic link.');
      parent = path.dirname(parent);
    }
  }
  return [...manifest].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
}

function snapshotRoot(root, expectedRoot) {
  if (fs.lstatSync(root).isSymbolicLink()) {
    if (!expectedRoot || fs.realpathSync(root) !== fs.realpathSync(expectedRoot))
      throw new Error('Recovery verification root must be a directory or the explicitly expected release link.');
    return fs.realpathSync(root);
  }
  if (expectedRoot && fs.realpathSync(root) !== fs.realpathSync(expectedRoot)) throw new Error('Recovery root does not match its expected release.');
  return root;
}

function withEntry(root, relative, create, action) {
  const parent = path.dirname(relative);
  return inDirectory(root, parent === '.' ? '' : parent, create, directory => action(directory.entry(path.basename(relative) || '.'), directory));
}

function verifyMetadata(root, entries) {
  for (const entry of entries) withEntry(root, entry.path, false, file => {
    const stat = fs.lstatSync(file);
    if (entry.type === 'directory' ? !stat.isDirectory() : entry.type === 'link' ? !stat.isSymbolicLink() || fs.readlinkSync(file) !== entry.link :
      !stat.isFile() || stat.size !== entry.size) throw new Error(`Recovery snapshot metadata verification failed: ${entry.path}`);
  });
}

export function verifySnapshot(root, manifest, { expectedRoot } = {}) {
  const entries = validateManifest(manifest);
  const directory = new Directory(snapshotRoot(root, expectedRoot));
  try {
    verifyMetadata(directory, entries);
    for (const entry of entries.filter(entry => entry.type === 'file')) withEntry(directory, entry.path, false, file => {
      if (hashFile(file) !== entry.sha256) throw new Error(`Recovery snapshot digest verification failed: ${entry.path}`);
    });
  } finally { directory.close(); }
}

export function restoreSnapshot(source, target, manifest) {
  const entries = validateManifest(manifest);
  verifySnapshot(source, entries);
  ensureDirectory(target);
  const original = new Directory(source);
  const restored = new Directory(target);
  const directories = entries.filter(entry => entry.type === 'directory');
  try {
    // Reject existing redirected parents before replacing any destination bytes.
    for (const entry of entries) withEntry(restored, entry.path, true, file => {
      const current = fs.lstatSync(file, { throwIfNoEntry: false });
      if (entry.type === 'directory') {
        if (current && !current.isDirectory()) throw new Error(`Recovery destination is not a directory: ${entry.path}`);
        if (!current) fs.mkdirSync(file, { mode: 0o700 });
      } else if (current?.isDirectory()) throw new Error(`Recovery destination cannot replace a directory with a file: ${entry.path}`);
    });
    for (const entry of entries.filter(entry => entry.type !== 'directory')) withEntry(restored, entry.path, true, (to, parent) => {
      const temporary = `${to}.${randomUUID()}.restore`;
      try {
        if (entry.type === 'link') fs.symlinkSync(entry.link, temporary);
        else withEntry(original, entry.path, false, from => {
          if (copyRegular(from, temporary, entry.mode).sha256 !== entry.sha256) throw new Error(`Recovery source changed after verification: ${entry.path}`);
        });
        fs.renameSync(temporary, to);
        parent.sync();
      } finally { fs.rmSync(temporary, { force: true }); }
    });
    for (const entry of directories.reverse()) inDirectory(restored, entry.path, false, directory => {
      fs.fchmodSync(directory.fd, entry.mode);
      directory.sync();
    });
    restored.sync();
    syncDirectory(path.dirname(target));
  } finally { original.close(); restored.close(); }
}

export function bundleCoordinator(source, destination, files) {
  if (!Array.isArray(files) || !files.length || files.some(file => !validRelative(file)) || new Set(files).size !== files.length)
    throw new Error('Coordinator bundle requires unique relative file paths.');
  const original = new Directory(source);
  let staged;
  const manifest = [];
  try {
    ensureDirectory(destination);
    staged = new Directory(destination);
    if (fs.readdirSync(staged.entry('.')).length) throw new Error('Coordinator bundle directory must be empty.');
    for (const relative of files) withEntry(original, relative, false, from => withEntry(staged, relative, true, (to, parent) => {
      manifest.push({ path: relative, type: 'file', ...copyRegular(from, to, 0o600), mode: 0o600 });
      parent.sync();
    }));
    writeUpdateJson(path.join(destination, 'bundle.json'), manifest);
    staged.sync();
    syncDirectory(path.dirname(destination));
    return destination;
  } finally { original.close(); staged?.close(); }
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

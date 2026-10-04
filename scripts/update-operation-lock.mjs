import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BackupDirectory, backupParent, writeBackupJson } from './update-backup-filesystem.mjs';

export function updateConflict(message) { return Object.assign(new Error(message), { statusCode: 409 }); }
export function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}

export class UpdateOperationLock {
  constructor(stateDir) { this.file = path.join(stateDir, 'operation-lock'); }
  read() {
    try {
      return backupParent(this.file, (parent, name) => {
        const directory = new BackupDirectory(parent.entry(name));
        try {
          const names = fs.readdirSync(directory.entry('.'));
          if (!names.length) {
            if (Date.now() - fs.fstatSync(directory.fd).mtimeMs > 20_000) { fs.rmdirSync(parent.entry(name)); parent.sync(); return null; }
            throw updateConflict('An update operation lock is being created. Check status before continuing.');
          }
          if (names.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(names[0])) throw new Error('Invalid update operation lock.');
          const fd = fs.openSync(directory.entry(names[0]), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          try {
            if (!fs.fstatSync(fd).isFile()) throw new Error('The update operation lock must be a regular file.');
            const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
            if (names[0] !== `${value.token}.json` || !Number.isSafeInteger(value.pid) || value.pid <= 0
              || !/^\d+$/.test(value.processIdentity ?? '') || !Number.isFinite(Date.parse(value.createdAt))
              || value.cleanupId !== undefined && !/^[a-f0-9-]{36}$/.test(value.cleanupId)) throw new Error('Invalid update operation lock owner.');
            return value;
          } finally { fs.closeSync(fd); }
        } finally { directory.close(); }
      });
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  acquire(kind, cleanupId) {
    writeBackupJson(path.join(path.dirname(this.file), 'operation-state.json'), { version: 1 });
    const previous = this.read();
    if (previous) {
      if (previous.cleanupId || processIdentity(previous.pid) === previous.processIdentity) throw updateConflict('An update or backup cleanup operation is in progress. Check its status before continuing.');
      this.release(previous.token);
    }
    const value = { token: randomUUID(), kind, cleanupId, pid: process.pid, processIdentity: processIdentity(process.pid), createdAt: new Date().toISOString() };
    try {
      backupParent(this.file, (parent, name) => {
        fs.mkdirSync(parent.entry(name), { mode: 0o700 });
        parent.sync();
        const directory = new BackupDirectory(parent.entry(name));
        try {
          fs.writeFileSync(directory.entry(`${value.token}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
          directory.sync();
          const current = fs.lstatSync(parent.entry(name)), held = fs.fstatSync(directory.fd);
          if (current.ino !== held.ino || current.dev !== held.dev) throw updateConflict('The operation lock changed during acquisition.');
        } finally { directory.close(); }
      });
    } catch (error) { if (error.code === 'EEXIST') throw updateConflict('An update or backup cleanup operation is in progress.'); throw error; }
    return value.token;
  }
  release(token) {
    if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid operation lock token.');
    backupParent(this.file, (parent, name) => {
      const directory = new BackupDirectory(parent.entry(name));
      try {
        // A unique token filename cannot unlink a replacement owner's lock.
        fs.unlinkSync(directory.entry(`${token}.json`));
        directory.sync();
        const held = fs.fstatSync(directory.fd), current = fs.lstatSync(parent.entry(name));
        if (held.ino !== current.ino || held.dev !== current.dev) throw updateConflict('The operation lock owner changed during release.');
        fs.rmdirSync(parent.entry(name));
        parent.sync();
      } finally { directory.close(); }
    });
  }
}

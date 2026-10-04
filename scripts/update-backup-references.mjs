import fs from 'node:fs';
import path from 'node:path';
import { parseEnvironmentFile } from './installer-environment.mjs';
import { SERVICE_NAMES } from './install-update.mjs';

// Only retain path references, never process environment or command output in public state.
export function inspectBackupReferences(updater) {
  const paths = [];
  const unknown = [];
  const add = (value, reason) => {
    if (typeof value !== 'string' || !value) return;
    const clean = value.replace(/ \(deleted\)$/, '');
    paths.push({ path: clean, reason });
    if (path.isAbsolute(clean)) {
      try { const resolved = fs.realpathSync(clean); if (resolved !== clean) paths.push({ path: resolved, reason }); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) unknown.push('A runtime path reference could not be resolved.'); }
    }
  };
  try {
    const environment = parseEnvironmentFile(fs.readFileSync(updater.paths.envPath, 'utf8'));
    for (const relative of ['node_modules', 'packages/shared/dist', 'packages/plugin-api/dist', 'apps/server/dist', 'apps/web/dist', 'services/asr/.venv', 'services/documentation-indexer/.venv']) {
      const installed = path.join(updater.repoRoot, relative);
      if (fs.lstatSync(installed, { throwIfNoEntry: false })) add(fs.realpathSync(installed), 'The active installation references this runtime.');
    }
    for (const key of ['CLOUDX_INSTALL_ROOT', 'CLOUDX_UPDATE_COORDINATOR_ROOT']) add(environment[key], 'Installed service configuration references this runtime.');
    for (const name of [...SERVICE_NAMES, ...(updater.serviceName ? [updater.serviceName] : [])]) {
      const output = updater.commands.inspect('systemctl', ['--user', 'show', name, '--property=LoadState,ExecStart,WorkingDirectory,EnvironmentFiles,FragmentPath,DropInPaths']);
      add(output, `Installed ${name} launcher references this runtime.`);
      for (const field of output.split('\n')) {
        if (field.startsWith('FragmentPath=') || field.startsWith('DropInPaths=')) {
          for (const file of field.slice(field.indexOf('=') + 1).split(' ').filter(Boolean)) {
            if (!path.isAbsolute(file)) { unknown.push('An installed service launcher path could not be verified.'); continue; }
            add(fs.readFileSync(file, 'utf8'), `Installed ${name} launcher references this runtime.`);
          }
        }
      }
    }
  } catch { unknown.push('Installed service references could not be verified.'); }
  const uid = process.getuid();
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== uid) continue;
      const status = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (status.slice(status.lastIndexOf(')') + 2).startsWith('Z ')) continue;
      const reason = `Live process ${pid} references this backup or runtime.`;
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      add(cwd, reason);
      add(fs.readlinkSync(`/proc/${pid}/exe`), reason);
      const runtimePathKeys = new Set(['PATH', 'NODE_PATH', 'PYTHONPATH', 'VIRTUAL_ENV', 'CLOUDX_INSTALL_ROOT', 'CLOUDX_UPDATE_COORDINATOR_ROOT']);
      for (const variable of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const equal = variable.indexOf('=');
        if (!runtimePathKeys.has(variable.slice(0, equal))) continue;
        for (const directory of variable.slice(equal + 1).split(':').filter(Boolean)) add(path.resolve(cwd, directory), reason);
      }
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      for (const arg of args) {
        if (path.isAbsolute(arg)) add(arg, reason);
        else if (arg.startsWith('./') || /^[\w.-]+\/[\w./-]+$/.test(arg)) add(path.resolve(cwd, arg), reason);
      }
      for (const line of fs.readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n')) {
        const file = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/)?.[1];
        add(file, reason);
      }
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        try { add(fs.readlinkSync(`/proc/${pid}/fd/${fd}`), reason); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      }
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) unknown.push('Live process references could not be completely inspected.'); }
  }
  return { paths, ...(unknown.length ? { uncertainReason: [...new Set(unknown)].join(' ') } : {}) };
}

export function backupReferenceReason(backup, references) {
  if (references.uncertainReason) return references.uncertainReason;
  for (const reference of references.paths) {
    if (reference.path === backup || reference.path.startsWith(`${backup}/`) || reference.path.includes(`${backup}/`)
      || reference.path.includes(`${backup}\"`) || reference.path.includes(`${backup}\n`) || reference.path.endsWith(backup)) return reference.reason;
  }
  return undefined;
}

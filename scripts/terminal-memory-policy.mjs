import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROKER = 'cloudx-terminal.service';

// systemctl prints string arrays with shell_maybe_quote(), without executing a shell.
export function parseSystemdPaths(value) {
  if (Array.isArray(value) && value.every(file => typeof file === 'string')) return [...value];
  if (typeof value !== 'string') throw new Error('The terminal broker drop-in paths are unavailable.');
  const paths = [];
  let current = [], quoted = false, started = false;
  const finish = () => {
    const encoded = Buffer.from(current), decoded = encoded.toString('utf8');
    if (!Buffer.from(decoded).equals(encoded)) throw new Error('The terminal broker drop-in paths contain invalid UTF-8.');
    paths.push(decoded); current = []; started = false;
  };
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/u.test(character)) {
      if (started) finish();
      continue;
    }
    if (character === '\\') {
      const rest = value.slice(index + 1);
      const encoded = /^(?:x([0-9a-fA-F]{2})|([0-7]{3}))/u.exec(rest);
      if (encoded) {
        current.push(parseInt(encoded[1] ?? encoded[2], encoded[1] ? 16 : 8));
        index += encoded[0].length;
      } else {
        const escaped = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', '$': '$', '`': '`', ' ': ' ' }[rest[0]];
        if (escaped === undefined) throw new Error('The terminal broker drop-in paths contain an invalid escape.');
        current.push(...Buffer.from(escaped)); index++;
      }
    } else {
      const literal = String.fromCodePoint(value.codePointAt(index));
      current.push(...Buffer.from(literal)); index += literal.length - 1;
    }
    started = true;
  }
  if (quoted) throw new Error('The terminal broker drop-in paths contain an unfinished quote.');
  if (started) finish();
  if (paths.some(file => !file || /[\x00-\x1f\x7f]/u.test(file))) throw new Error('The terminal broker drop-in paths contain an invalid path.');
  return paths;
}

function assertOwnedFile(file, uid) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.mode & 0o002 || fs.realpathSync(file) !== file)
    throw new Error('The terminal broker configuration must be an owned regular file without linked or world-writable paths.');
  return stat;
}

function assertOwnedDirectory(directory, uid) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o002 || fs.realpathSync(directory) !== directory)
    throw new Error('The terminal broker configuration directory must be owned and have no linked or world-writable paths.');
}

export function assertTerminalMemoryUnit(file, { systemdDir, uid = process.getuid() }) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || path.dirname(file) !== systemdDir ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/u.test(path.basename(file)))
    throw new Error('The terminal broker unit must be inside the user service directory.');
  assertOwnedDirectory(systemdDir, uid);
  return assertOwnedFile(file, uid);
}

function assertMemoryOnly(content) {
  let serviceSection = false, assignments = 0;
  for (const sourceLine of content.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line === '[Service]') { serviceSection = true; continue; }
    const setting = /^(MemoryHigh|MemoryMax)\s*=\s*(infinity|(?:[0-9]+(?:\.[0-9]+)?)(?:[KMGT]|%)?)?$/u.exec(line);
    if (!serviceSection || !setting || setting[2]?.endsWith('%') && Number(setting[2].slice(0, -1)) > 100)
      throw new Error('The terminal broker drop-ins must contain only MemoryHigh and MemoryMax in [Service].');
    assignments++;
  }
  if (!assignments) throw new Error('The terminal broker drop-in has no memory policy.');
}

function policyOptions({
  systemdDir, home = os.homedir(), configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
  runtimeDir = process.env.XDG_RUNTIME_DIR, unitName = BROKER, uid = process.getuid(),
}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/u.test(unitName)) throw new Error('Invalid terminal broker service name.');
  const roots = [...new Set([
    path.join(configHome, 'systemd/user.control'), path.join(path.dirname(systemdDir), 'user.control'),
    ...(runtimeDir ? [path.join(runtimeDir, 'systemd/user.control')] : []),
    path.join(configHome, 'systemd/user'), systemdDir,
    ...(runtimeDir ? [path.join(runtimeDir, 'systemd/user')] : []),
  ])];
  return { roots, systemdDir, home, configHome, runtimeDir, unitName, uid };
}

export function assertTerminalMemoryDropIns(dropInPaths, options) {
  const { roots, unitName, uid } = policyOptions(options);
  const paths = new Set(parseSystemdPaths(dropInPaths));
  for (const root of roots) {
    if (!fs.lstatSync(root, { throwIfNoEntry: false })) continue;
    assertOwnedDirectory(root, uid);
    const directory = path.join(root, `${unitName}.d`);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) continue;
    assertOwnedDirectory(directory, uid);
    for (const name of fs.readdirSync(directory)) if (name.endsWith('.conf')) paths.add(path.join(directory, name));
  }
  for (const file of paths) {
    const directory = path.dirname(file), root = path.dirname(directory);
    if (!path.isAbsolute(file) || path.resolve(file) !== file || !roots.includes(root) ||
        path.basename(directory) !== `${unitName}.d` || !/^[^/\x00-\x1f]+\.conf$/u.test(path.basename(file)))
      throw new Error('The terminal broker memory drop-in must be inside its user service override directory.');
    assertOwnedDirectory(root, uid);
    assertOwnedDirectory(directory, uid);
    const stat = assertOwnedFile(file, uid);
    if (stat.size > 64 * 1024) throw new Error('The terminal broker memory drop-in is too large to inspect.');
    assertMemoryOnly(fs.readFileSync(file, 'utf8'));
  }
  return [...paths];
}

export function assertTerminalMemoryDestination(options) {
  const { configHome, unitName, uid } = policyOptions(options);
  if (!path.isAbsolute(configHome) || path.resolve(configHome) !== configHome)
    throw new Error('The terminal broker configuration home must be an absolute path without linked components.');
  const destination = path.join(configHome, 'systemd/user.control', `${unitName}.d`);
  for (const directory of [configHome, path.join(configHome, 'systemd'), path.dirname(destination), destination]) {
    if (fs.lstatSync(directory, { throwIfNoEntry: false })) assertOwnedDirectory(directory, uid);
  }
  let existing = destination;
  while (!fs.lstatSync(existing, { throwIfNoEntry: false })) existing = path.dirname(existing);
  assertOwnedDirectory(existing, uid);
  try { fs.accessSync(existing, fs.constants.W_OK); }
  catch { throw new Error(`Cannot persist terminal memory limits. Give this user write access to ${existing}.`); }
}

function memoryBytes(value) {
  if (!value || value === 'infinity') return 'infinity';
  const match = /^([0-9]+)(?:\.([0-9]+))?([KMGT]?)$/u.exec(value);
  if (!match) return;
  const scale = 10n ** BigInt(match[2]?.length ?? 0);
  const amount = BigInt(match[1]) * scale + BigInt(match[2] ?? 0);
  const multiplier = 1024n ** BigInt(match[3] ? 'KMGT'.indexOf(match[3]) + 1 : 0);
  return String(amount * multiplier / scale);
}

// Predict the next load, rather than using DropInPaths' append order after set-property.
export function assertTerminalMemoryPersistence(dropInPaths, limits, options) {
  const { roots, configHome, unitName } = policyOptions(options);
  const paths = assertTerminalMemoryDropIns(dropInPaths, options);
  const selected = new Map();
  for (const root of roots) {
    for (const file of paths.filter(file => path.dirname(path.dirname(file)) === root)) {
      const name = path.basename(file);
      if (!selected.has(name)) selected.set(name, { file });
    }
  }
  for (const [property, value] of [['MemoryHigh', limits.memoryHigh], ['MemoryMax', limits.memoryMax]]) {
    const name = `50-${property}.conf`;
    selected.set(name, { file: path.join(configHome, 'systemd/user.control', `${unitName}.d`, name), content: `[Service]\n${property}=${value}\n` });
  }
  const effective = new Map();
  const ordered = [...selected.entries()].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const [, entry] of ordered) {
    for (const line of (entry.content ?? fs.readFileSync(entry.file, 'utf8')).split(/\r?\n/u)) {
      const assignment = /^\s*(MemoryHigh|MemoryMax)\s*=\s*(.*?)\s*$/u.exec(line);
      if (assignment) effective.set(assignment[1], { file: entry.file, value: memoryBytes(assignment[2]) });
    }
  }
  for (const [property, expected] of [['MemoryHigh', limits.memoryHigh], ['MemoryMax', limits.memoryMax]]) {
    const actual = effective.get(property);
    if (actual?.value !== expected) throw new Error(`${property} in ${actual.file} would override the persistent selection after a service reload or reboot. Change that operator override before applying this selection.`);
  }
}

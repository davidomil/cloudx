import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { InstallerRunner, activateManagedServices } from './install-cloudx.mjs';
import { assertTerminalMemoryDestination, assertTerminalMemoryDropIns, assertTerminalMemoryPersistence, assertTerminalMemoryUnit, parseSystemdPaths } from './terminal-memory-policy.mjs';

const roots = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-memory-policy-')); roots.push(home);
  const configHome = path.join(home, 'config'), runtimeDir = path.join(home, 'runtime');
  const systemdDir = path.join(configHome, 'systemd/user');
  const options = { home, configHome, runtimeDir, systemdDir };
  const write = (file, content = '[Service]\nMemoryHigh=24G\nMemoryMax=32G\n') => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
  };
  return { ...options, options, write, file: path.join(systemdDir, 'cloudx-terminal.service.d/operator.conf') };
}

it.each(['systemd/user', 'systemd/user.control', 'runtime/systemd/user', 'runtime/systemd/user.control'])(
  'accepts memory-only operator and generated overrides in %s', directory => {
    const f = fixture();
    const root = directory.startsWith('runtime/') ? f.home : f.configHome;
    const file = f.write(path.join(root, directory, 'cloudx-terminal.service.d/50-MemoryHigh.conf'), '# systemd property\n[Service]\nMemoryHigh=25769803776\n');
    const ceiling = f.write(path.join(path.dirname(file), '50-MemoryMax.conf'), '[Service]\nMemoryMax=infinity\n');
    expect(assertTerminalMemoryDropIns(`${file} ${ceiling}`, f.options)).toEqual([file, ceiling]);
  });

it('accepts a selected unit and paths containing spaces, backslashes and quotes', () => {
  const f = fixture();
  const unitName = 'cloudx-memory-test-unique.service';
  const file = f.write(path.join(f.systemdDir, `${unitName}.d`, 'operator "choice".conf'));
  expect(assertTerminalMemoryDropIns(JSON.stringify(file), { ...f.options, unitName })).toEqual([file]);
  expect(parseSystemdPaths('"/home/operator\\x20name/a.conf" /plain\\040path.conf "/quote\\\"and\\\\slash.conf"'))
    .toEqual(['/home/operator name/a.conf', '/plain path.conf', '/quote"and\\slash.conf']);
  expect(parseSystemdPaths('')).toEqual([]);
  expect(parseSystemdPaths('"/home/\\303\\274ser/\\360\\237\\230\\200.conf" /home/üser/😀.conf'))
    .toEqual(['/home/üser/😀.conf', '/home/üser/😀.conf']);
});

it.each(['"unfinished', '/bad\\q.conf', '/bad\\x00.conf', undefined])('refuses invalid systemctl paths %s', value => {
  expect(() => parseSystemdPaths(value)).toThrow(/paths/);
});

it.each(['24G', '1.5M', '50%', 'infinity', ''])('accepts an existing operator memory value %s', value => {
  const f = fixture(); f.write(f.file, `; chosen policy\n[Service]\nMemoryHigh=${value}\n`);
  expect(assertTerminalMemoryDropIns([f.file], f.options)).toEqual([f.file]);
});

it.each([
  '[Service]\nExecStart=/another/broker\n', '[Unit]\nConditionPathExists=/another/path\n',
  '[Service]\nMemoryHigh=24G\nEnvironment=UNSAFE=1\n', '[Service]\nMemoryHigh=24G\\\nExecStart=/unsafe\n',
  '[Service]\nMemoryHigh=101%\n', '[Service]\nMemoryMax=$LIMIT\n', '# no policy\n',
  '[Service]\nMemoryHigh=24G\n[Install]\n',
])('refuses configuration outside the memory-only contract: %s', content => {
  const f = fixture(); f.write(f.file, content);
  expect(() => assertTerminalMemoryDropIns([f.file], f.options)).toThrow(/terminal broker/);
});

it.each(['other unit', 'outside root', 'nested directory', 'not conf', 'relative', 'parent traversal'])(
  'refuses an override with %s', boundary => {
    const f = fixture();
    const files = {
      'other unit': path.join(f.systemdDir, 'other.service.d/override.conf'),
      'outside root': path.join(f.home, 'outside/cloudx-terminal.service.d/override.conf'),
      'nested directory': path.join(f.systemdDir, 'cloudx-terminal.service.d/nested/override.conf'),
      'not conf': f.file.replace('.conf', '.txt'), relative: 'cloudx-terminal.service.d/override.conf',
      'parent traversal': `${f.systemdDir}/cloudx-terminal.service.d/../cloudx-terminal.service.d/operator.conf`,
    };
    if (boundary !== 'relative') f.write(files[boundary]);
    expect(() => assertTerminalMemoryDropIns([files[boundary]], f.options)).toThrow(/override directory/);
  });

it.each(['symlink file', 'symlink parent', 'hardlink', 'writable file', 'writable directory', 'foreign owner', 'large file'])(
  'refuses an override with %s', boundary => {
    const f = fixture(); f.write(f.file);
    if (boundary === 'symlink file') { fs.renameSync(f.file, `${f.file}.source`); fs.symlinkSync(`${f.file}.source`, f.file); }
    if (boundary === 'symlink parent') { const dir = path.dirname(f.file); fs.renameSync(dir, `${dir}.source`); fs.symlinkSync(`${dir}.source`, dir); }
    if (boundary === 'hardlink') fs.linkSync(f.file, `${f.file}.link`);
    if (boundary === 'writable file') fs.chmodSync(f.file, 0o666);
    if (boundary === 'writable directory') fs.chmodSync(path.dirname(f.file), 0o777);
    if (boundary === 'foreign owner') f.options.uid = process.getuid() + 1;
    if (boundary === 'large file') fs.appendFileSync(f.file, '#'.repeat(64 * 1024));
    expect(() => assertTerminalMemoryDropIns([f.file], f.options)).toThrow();
  });

it('requires an owned unit fragment independently from the memory-only overrides', () => {
  const f = fixture(), unit = path.join(f.systemdDir, 'cloudx-terminal.service'); f.write(unit, '[Service]\nExecStart=/owned/broker\n');
  expect(assertTerminalMemoryUnit(unit, f.options).isFile()).toBe(true);
  expect(() => assertTerminalMemoryUnit(unit, { ...f.options, uid: process.getuid() + 1 })).toThrow(/owned/);
  expect(() => assertTerminalMemoryUnit(f.write(path.join(f.home, 'outside.service')), f.options)).toThrow(/user service directory/);
  fs.linkSync(unit, path.join(f.home, 'linked.service'));
  expect(() => assertTerminalMemoryUnit(unit, f.options)).toThrow(/owned regular/);
});

it('preserves operator memory overrides when the installer refreshes units for a managed release', () => {
  const f = fixture(), systemdDir = path.join(f.home, '.config/systemd/user');
  const files = [
    f.write(path.join(systemdDir, 'cloudx-terminal.service.d/operator.conf')),
    f.write(path.join(f.home, '.config/systemd/user.control/cloudx-terminal.service.d/50-MemoryHigh.conf'), '[Service]\nMemoryHigh=25769803776\n'),
    f.write(path.join(f.runtimeDir, 'systemd/user.control/cloudx-terminal.service.d/50-MemoryMax.conf'), '[Service]\nMemoryMax=34359738368\n'),
  ];
  const saved = files.map(file => fs.readFileSync(file, 'utf8'));
  const repoRoot = path.join(f.home, 'checkout'), releaseRoot = path.join(f.home, 'release');
  f.write(path.join(f.home, '.config/cloudx/cloudx.env'), 'CLOUDX_PORT=3001\n');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  activateManagedServices({ repoRoot, releaseRoot, home: f.home, envConfig: { CLOUDX_PORT: '3001' },
    runner: new InstallerRunner({ cwd: f.home, log() {} }) });
  expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(saved);
  const unit = fs.readFileSync(path.join(systemdDir, 'cloudx-terminal.service'), 'utf8');
  expect(unit).toContain(`WorkingDirectory=${repoRoot}`);
  expect(unit).not.toMatch(/Memory(?:High|Max)=/);
});

it('predicts persistent systemctl settings without creating the property files', () => {
  const f = fixture(), chosen = { memoryHigh: '1073741824', memoryMax: 'infinity' };
  expect(() => assertTerminalMemoryPersistence([], chosen, f.options)).not.toThrow();
  expect(fs.existsSync(path.join(f.configHome, 'systemd/user.control'))).toBe(false);
});

it('rejects a later operator assignment before changing any file', () => {
  const f = fixture(); f.write(f.file);
  const original = fs.readFileSync(f.file, 'utf8');
  expect(() => assertTerminalMemoryPersistence([f.file], { memoryHigh: '1073741824', memoryMax: 'infinity' }, f.options))
    .toThrow(`MemoryHigh in ${f.file} would override the persistent selection`);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(original);
});

it('deduplicates override filenames by directory priority before lexical application', () => {
  const f = fixture();
  const persistent = f.write(path.join(f.configHome, 'systemd/user.control/cloudx-terminal.service.d/90-operator.conf'), '[Service]\nMemoryHigh=1.5G\nMemoryMax=infinity\n');
  const runtime = f.write(path.join(f.runtimeDir, 'systemd/user.control/cloudx-terminal.service.d/90-operator.conf'));
  const oldProperty = f.write(path.join(f.runtimeDir, 'systemd/user.control/cloudx-terminal.service.d/50-MemoryHigh.conf'));
  const early = f.write(path.join(f.systemdDir, 'cloudx-terminal.service.d/10-budget.conf'), '[Service]\nMemoryHigh=50%\n');
  const chosen = { memoryHigh: '1610612736', memoryMax: 'infinity' };
  expect(() => assertTerminalMemoryPersistence([runtime, persistent, early, oldProperty], chosen, f.options)).not.toThrow();
  expect(() => assertTerminalMemoryPersistence([persistent, early, oldProperty, runtime], chosen, f.options)).not.toThrow();
});

it.each(['50%', ''])('reports a later reset or relative operator assignment %s when it conflicts', value => {
  const f = fixture(); f.write(f.file, `[Service]\nMemoryHigh=${value}\n`);
  expect(() => assertTerminalMemoryPersistence([f.file], { memoryHigh: '1073741824', memoryMax: 'infinity' }, f.options))
    .toThrow(f.file);
});

it('uses the final repeated assignment and accepts byte-exact decimal sizes and resets', () => {
  const f = fixture(); f.write(f.file, '[Service]\nMemoryHigh=10G\nMemoryHigh=1.5M\nMemoryMax=\n');
  expect(() => assertTerminalMemoryPersistence([f.file], { memoryHigh: '1572864', memoryMax: 'infinity' }, f.options)).not.toThrow();
});

it('includes a new operator file before systemd has loaded it', () => {
  const f = fixture();
  const file = f.write(path.join(f.systemdDir, 'cloudx-terminal.service.d/90-budget.conf'));
  const original = fs.readFileSync(file, 'utf8');
  expect(assertTerminalMemoryDropIns('', f.options)).toEqual([file]);
  expect(() => assertTerminalMemoryPersistence('', { memoryHigh: '1073741824', memoryMax: 'infinity' }, f.options)).toThrow(file);
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
});

it('accepts unloaded runtime and persistent generated files with the same names', () => {
  const f = fixture();
  const files = [
    f.write(path.join(f.runtimeDir, 'systemd/user.control/cloudx-terminal.service.d/50-MemoryHigh.conf'), '[Service]\nMemoryHigh=256M\n'),
    f.write(path.join(f.configHome, 'systemd/user.control/cloudx-terminal.service.d/50-MemoryHigh.conf'), '[Service]\nMemoryHigh=512M\n'),
  ];
  expect(assertTerminalMemoryDropIns('', f.options)).toEqual(expect.arrayContaining(files));
  expect(() => assertTerminalMemoryPersistence('', { memoryHigh: '1073741824', memoryMax: 'infinity' }, f.options)).not.toThrow();
});

it.each(['symlink', 'dangling symlink', 'world writable', 'foreign owner', 'regular file'])(
  'refuses an unsafe empty disk override directory: %s', boundary => {
    const f = fixture(), directory = path.dirname(f.file);
    fs.mkdirSync(f.systemdDir, { recursive: true });
    if (boundary === 'symlink' || boundary === 'dangling symlink') {
      const target = path.join(f.home, 'outside');
      if (boundary === 'symlink') fs.mkdirSync(target);
      fs.symlinkSync(target, directory);
    } else if (boundary === 'regular file') fs.writeFileSync(directory, 'not a directory');
    else {
      fs.mkdirSync(directory);
      if (boundary === 'world writable') fs.chmodSync(directory, 0o777);
      if (boundary === 'foreign owner') f.options.uid = process.getuid() + 1;
    }
    expect(() => assertTerminalMemoryDropIns('', f.options)).toThrow(/configuration directory/);
  });

it('allows a safe destination without creating missing configuration directories', () => {
  const f = fixture();
  expect(() => assertTerminalMemoryDestination(f.options)).not.toThrow();
  expect(fs.existsSync(f.configHome)).toBe(false);
});

it.each(['config home', 'systemd', 'user.control', 'unit directory'])(
  'refuses a linked destination at %s before the property files exist', boundary => {
    const f = fixture();
    const directories = {
      'config home': f.configHome, systemd: path.join(f.configHome, 'systemd'),
      'user.control': path.join(f.configHome, 'systemd/user.control'),
      'unit directory': path.join(f.configHome, 'systemd/user.control/cloudx-terminal.service.d'),
    };
    const directory = directories[boundary], target = path.join(f.home, 'outside');
    fs.mkdirSync(path.dirname(directory), { recursive: true }); fs.mkdirSync(target); fs.symlinkSync(target, directory);
    expect(() => assertTerminalMemoryDestination(f.options)).toThrow(/configuration directory/);
    expect(fs.readdirSync(target)).toEqual([]);
  });

it('refuses a world-writable or inaccessible persistence destination', () => {
  const f = fixture(); fs.mkdirSync(f.configHome, { mode: 0o700 });
  fs.chmodSync(f.configHome, 0o777);
  expect(() => assertTerminalMemoryDestination(f.options)).toThrow(/configuration directory/);
  fs.chmodSync(f.configHome, 0o700);
  vi.spyOn(fs, 'accessSync').mockImplementation(() => { throw new Error('EACCES'); });
  expect(() => assertTerminalMemoryDestination(f.options)).toThrow(`write access to ${f.configHome}`);
});

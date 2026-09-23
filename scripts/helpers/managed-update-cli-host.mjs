// Preloaded only by the CLI regression: keep the real installer and staged
// coordinator, but intercept every host command before it can change services.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const home = process.env.CLOUDX_TEST_UPDATE_HOME;
const repoRoot = process.env.CLOUDX_INSTALL_ROOT;
if (!home || !repoRoot || path.dirname(home) !== path.dirname(repoRoot)) throw new Error('Missing isolated update fixture.');
const unitFile = path.join(home, 'update-unit.json');
const stateDir = path.join(home, '.local/state/cloudx/settings-update');
const spawnSync = childProcess.spawnSync;
const readFileSync = fs.readFileSync;
os.homedir = () => home;
// The mocked service owns a named cgroup even when the host's namespace root is '/'.
fs.readFileSync = (file, ...options) => readFileSync(
  file === '/proc/self/cgroup' || file === `/proc/${process.pid}/cgroup`
    ? path.join(home, 'update-cgroup') : file, ...options);

function commandResult(command, args, options = {}) {
  fs.appendFileSync(path.join(home, 'commands.jsonl'), JSON.stringify({ command, args, cwd: options.cwd }) + '\n');
  if (command === 'systemctl' && args[0] === '--user' && args[1] === 'show') {
    const name = args[2];
    const unit = name === 'cloudx-settings-update.service'
      ? fs.existsSync(unitFile) ? JSON.parse(fs.readFileSync(unitFile, 'utf8')) : { LoadState: 'not-found', ActiveState: 'inactive' }
      : {
        Id: name, LoadState: 'loaded', ActiveState: 'inactive', MainPID: '0', ControlGroup: '',
        WorkingDirectory: repoRoot, EnvironmentFiles: `${home}/.config/cloudx/cloudx.env (ignore_errors=no)`,
        FragmentPath: `${home}/.config/systemd/user/${name}`, NeedDaemonReload: 'no', DropInPaths: '',
        ...(process.env.CLOUDX_TEST_UPDATE_ACTIVE === name ? {
          ActiveState: 'active', MainPID: '123', ControlGroup: `/user.slice/${name}`,
          InvocationID: 'd'.repeat(32), KillMode: 'control-group', SendSIGKILL: 'yes',
        } : {}),
      };
    const fields = args.find(arg => arg.startsWith('--property=')).slice(11).split(',');
    return result(fields.map(key => `${key}=${unit[key] ?? ''}`).join('\n'));
  }
  if (command === 'systemd-run') {
    const group = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').find(line => line.startsWith('0::')).slice(3);
    fs.writeFileSync(unitFile, JSON.stringify({ LoadState: 'loaded', ActiveState: 'active', ControlGroup: group,
      Description: args.find(arg => arg.startsWith('--description=')).slice(14) }));
    const [executable, ...workerArgs] = args.slice(args.indexOf('--') + 1);
    const worker = commandResult(executable, workerArgs, options);
    fs.unlinkSync(unitFile);
    // systemd-run confirms launch; the durable record contains the worker outcome.
    return result('', worker.stderr);
  }
  if (command === process.execPath && args[0]?.startsWith(`${stateDir}${path.sep}`)) {
    const output = spawnSync(command, args, { ...options, timeout: 10000 });
    fs.appendFileSync(path.join(home, 'commands.jsonl'), JSON.stringify({ command, args, status: output.status }) + '\n');
    return output;
  }
  if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return result(repoRoot);
  if (command === 'git' && args.join(' ') === 'rev-parse HEAD')
    return process.env.CLOUDX_TEST_UPDATE_FAILURE === 'git'
      ? result('fixture partial output', 'fixture preparation failure', 42)
      : result((options.cwd === repoRoot ? 'b' : 'a').repeat(40));
  if (command === 'git') {
    if (args[0] === 'write-tree') return result('c'.repeat(40));
    if (args[0] === 'status') return result('');
    if (args[0] === 'clone') {
      fs.mkdirSync(args.at(-1), { recursive: true });
      return result('');
    }
    if (args.join(' ') === 'remote get-url origin') return result(repoRoot);
    if (args.join(' ') === `rev-parse ${'a'.repeat(40)}^{commit}`) return result('a'.repeat(40));
    if (['remote', 'fetch', 'checkout', 'read-tree'].includes(args[0])) return result('');
    if (args[0] === 'diff') {
      const output = args.find(arg => arg.startsWith('--output='));
      if (output) fs.writeFileSync(output.slice(9), '');
      return result('');
    }
  }
  const release = path.join(stateDir, JSON.parse(fs.readFileSync(path.join(stateDir, 'latest.json'), 'utf8')).id, 'release');
  if (['node', 'npm', 'python3', path.join(release, '.update-tools/uv/bin/pip'), path.join(release, '.update-tools/uv/bin/uv')].includes(command)) {
    if (options.cwd !== release) throw new Error(`Preparation command escaped staged release: ${options.cwd}`);
    if (command === 'npm' && args.join(' ') === 'run build') {
      if (process.env.CLOUDX_TEST_UPDATE_FAILURE === 'build') return result('', 'fixture build failure', 42);
      const server = path.join(release, 'apps/server/dist');
      fs.mkdirSync(server, { recursive: true });
      fs.writeFileSync(path.join(server, 'index.js'), '// fixture server entry\n');
      fs.writeFileSync(path.join(server, 'server.js'), '// fixture /api/ready/terminals\n');
      fs.writeFileSync(path.join(release, 'package-lock.json'), '{}');
      return result('fixture build complete');
    }
    return result('');
  }
  throw new Error(`Unexpected fixture host command: ${command} ${args.join(' ')}`);
}

function result(stdout, stderr = '', status = 0) { return { stdout, stderr, status, signal: null }; }

childProcess.spawnSync = commandResult;
childProcess.execFileSync = (command, args, options) => {
  const output = commandResult(command, args, options);
  if (output.status !== 0) throw Object.assign(new Error(output.stderr), output);
  return output.stdout;
};
syncBuiltinESMExports();

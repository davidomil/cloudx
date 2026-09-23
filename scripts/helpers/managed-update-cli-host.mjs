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
os.homedir = () => home;

function commandResult(command, args, options = {}) {
  if (command === 'systemctl' && args[0] === '--user' && args[1] === 'show') {
    const name = args[2];
    const unit = name === 'cloudx-settings-update.service'
      ? fs.existsSync(unitFile) ? JSON.parse(fs.readFileSync(unitFile, 'utf8')) : { LoadState: 'not-found', ActiveState: 'inactive' }
      : {
        Id: name, LoadState: 'loaded', ActiveState: 'inactive', MainPID: '0', ControlGroup: '',
        WorkingDirectory: repoRoot, EnvironmentFiles: `${home}/.config/cloudx/cloudx.env (ignore_errors=no)`,
        FragmentPath: `${home}/.config/systemd/user/${name}`, NeedDaemonReload: 'no', DropInPaths: '',
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
    return spawnSync(command, args, { ...options, timeout: 10000 });
  }
  if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return result(repoRoot);
  if (command === 'git' && args.join(' ') === 'rev-parse HEAD')
    return result('fixture partial output', 'fixture preparation failure', 42);
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

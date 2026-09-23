#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { SettingsUpdater } from './settings-update.mjs';
import { InstallerRunner } from './install-cloudx.mjs';
import { parseEnvironmentFile } from './installer-environment.mjs';
import { updateCommit } from './install-update.mjs';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseUpdateArguments(argv) {
  const options = {};
  const values = new Map([['--checkout', 'repoRoot'], ['--target-commit', 'targetCommit'], ['--resume', 'resumeRunId'], ['--restore-snapshot', 'restoreSnapshotRunId'], ['--service', 'service'], ['--port', 'port'], ['--host', 'host']]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (values.has(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
      options[values.get(flag)] = value;
    } else if (flag === '--confirm-interruption' || flag === '--migrate-terminals') options.confirmInterruption = true;
    else if (flag === '--status') options.status = true;
    else if (flag === '--non-interactive') options.nonInteractive = true;
    else if (flag === '--verbose') options.verbose = true;
    else if (flag === '--update' || flag === '--yes') continue;
    else throw new Error(`Unsupported managed update option: ${flag}`);
  }
  if (options.targetCommit) updateCommit(options.targetCommit);
  for (const key of ['resumeRunId', 'restoreSnapshotRunId']) if (options[key] && !RUN_ID.test(options[key])) throw new Error(`Invalid ${key}.`);
  if (options.repoRoot && !path.isAbsolute(options.repoRoot)) throw new Error('--checkout must be absolute.');
  if (!!options.service !== !!options.port || options.host && !options.service) throw new Error('A custom update requires --service and --port.');
  return options;
}

export async function launchManagedUpdate(options = {}) {
  options = { ...options, verbose: options.verbose === true || process.env.CLOUDX_INSTALL_VERBOSE === '1' };
  const repoRoot = fs.realpathSync(options.repoRoot ?? process.cwd());
  const home = options.home ?? os.homedir();
  const commands = new InstallerRunner({ cwd: repoRoot, nonInteractive: true, verbose: options.verbose,
    log: options.verbose ? console.error : () => {} });
  let envPath = path.join(home, '.config/cloudx/cloudx.env');
  let dataDir, savedRecord;
  let selection = options;
  const history = new SettingsUpdater({ repoRoot, home, serverPid: process.pid, commands, cli: true });
  const savedId = options.resumeRunId ?? (options.status ? history.pointer('latest')?.id : undefined);
  if (savedId) {
    savedRecord = options.resumeRunId ? history.read(savedId) : history.readRecord(savedId);
    if (!options.resumeRunId && savedRecord.repoRoot !== repoRoot) savedRecord = undefined;
  }
  if (savedRecord) {
    if (!path.isAbsolute(savedRecord.dataDir ?? '') || !path.isAbsolute(savedRecord.envPath ?? '') || savedRecord.home !== home)
      throw new Error('The saved update has no valid configuration identity for this user.');
    if (options.resumeRunId && options.targetCommit && options.targetCommit !== savedRecord.targetCommit)
      throw new Error('A resumed update must retain its recorded target commit.');
    dataDir = savedRecord.dataDir;
    envPath = savedRecord.envPath;
    selection = { ...options, service: savedRecord.service, port: savedRecord.port, host: savedRecord.host };
  } else {
    if (options.service) {
      const output = commands.inspect('systemctl', ['--user', 'show', options.service, '--property=EnvironmentFiles']);
      const match = /^EnvironmentFiles=(.+) \(ignore_errors=no\)$/.exec(output);
      if (!match || !path.isAbsolute(match[1])) throw new Error('Custom service must have one explicit EnvironmentFile.');
      envPath = match[1];
    }
    const env = parseEnvironmentFile(fs.readFileSync(envPath, 'utf8'));
    dataDir = env.CLOUDX_DATA_DIR ?? path.join(repoRoot, '.cloudx');
  }
  const updater = new SettingsUpdater({ repoRoot, home, dataDir, serverPid: process.pid,
    commands, cli: true, service: selection.service, port: selection.port, host: selection.host });
  updater.paths.envPath = envPath;
  if (options.status) { const status = updater.status(); console.log(JSON.stringify(status, null, 2)); return status; }
  const target = options.resumeRunId ? savedRecord.targetCommit : options.targetCommit ??
    commands.inspect('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).split(/\s/)[0];
  updateCommit(target);
  let status = updater.start(target, options);
  if (status.confirmation && !options.nonInteractive && process.stdin.isTTY) {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(status.confirmation.message);
      const answer = await prompt.question('Type yes to confirm the disclosed interruption or data restoration: ');
      if (answer === 'yes') status = updater.start(target, { ...options, confirmInterruption: true,
        restoreSnapshotRunId: status.confirmation.restoreSnapshotRunId });
    } finally { prompt.close(); }
  }
  console.log(JSON.stringify(status, null, 2));
  if (status.run?.id) console.log(`Update ${status.run.id}: use --status for progress and --resume ${status.run.id} after resolving a failure. The coordinator continues if this terminal disconnects.`);
  if (!status.available || status.confirmation) process.exitCode = 1;
  return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) launchManagedUpdate(parseUpdateArguments(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });

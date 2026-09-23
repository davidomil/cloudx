#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDataCompatibility, inspectSnapshotCompatibility, inspectTargetRuntime } from './managed-update-data.mjs';
import { MANAGED_INTEGRATION_FILES, prepareManagedIntegration } from './managed-update-integration.mjs';
import { writeRuntimeBuild } from './write-runtime-build.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { InstallerRunner, prepareManagedRelease, activateManagedServices, waitForHealth } from './install-cloudx.mjs';
import { inspectUpdateTarget, updateCommit, documentationReadinessUrl, updatePort, SERVICE_NAMES } from './install-update.mjs';
import { inspectRuntimeUpdate, prepareRuntimeUpdate, assertUpdaterOutsideServices, assertStoppedService, inspectTerminalService } from './install-runtime.mjs';
import { assertTerminalMigrationSafe } from './terminal-upgrade-recovery.mjs';
import { parseEnvironmentFile, updateEnvironmentFile } from './installer-environment.mjs';
import { writeUpdateJson, snapshotTree, verifySnapshot, restoreSnapshot, syncDirectory, hashFile } from './managed-update-store.mjs';

const GENERATED = ['node_modules', 'packages/shared/dist', 'packages/plugin-api/dist', 'apps/server/dist', 'apps/web/dist', 'services/asr/.venv', 'services/documentation-indexer/.venv'];
const PHASES = ['prepare', 'quiesce', 'snapshot', 'activate', 'start', 'verify'];
const FORGE_WORKFLOW_FILE = `plugin-data/forge-${createHash('sha256').update('forge').digest('hex')}.json`;
export const CURRENT_TERMINAL_CONTRACT = { brokerProtocol: 1, supervisorContract: 'execution-json-v1', persistentSessions: true };
const runtimeData = relative => /^(terminal-runtime|terminal-broker|terminal-recovery-[^/]+|terminal-upgrade-backup-[^/]+)(\/|$)/u.test(relative);

export class ManagedUpdate {
  constructor({ record, save, host, checkpoint = () => {} }) {
    this.record = record;
    this.save = save;
    this.host = host;
    this.checkpoint = checkpoint;
  }

  persist() { this.save(this.record); }

  async run() {
    const record = this.record;
    record.transition ??= { completed: [] };
    const transition = record.transition;
    if (record.run.state === 'succeeded') return record.run;
    // A lost process after quiescing is restored before any new transition.
    // Never repeat startup migrations on top of a partially migrated profile.

    record.run = { ...record.run, state: 'running', resumable: false };
    delete record.run.finishedAt;
    delete record.run.cause;
    try {
      if (transition.mutating) {
        await this.restore();
        transition.completed = transition.completed.filter(phase => phase === 'prepare');
      }
      for (const phase of PHASES) {
        if (transition.completed.includes(phase)) continue;

        record.run.phase = phase;
        record.run.component = phase;
        record.run.message = `CloudX update: ${phase}.`;
        this.persist();
        this.checkpoint(`before:${phase}`);
        await this.host[phase](record);
        transition.completed.push(phase);
        this.persist();
        this.checkpoint(`after:${phase}`);
      }
      transition.mutating = false;
      record.run = { ...record.run, state: 'succeeded', phase: 'complete', resumable: false,
        message: 'The selected CloudX build is running and its services passed readiness checks.', finishedAt: new Date().toISOString() };
      delete record.run.recoveryAction;
      this.persist();
    } catch (error) {
      // Detailed command output stays in the private coordinator log.
      console.error(error);
      const failedPhase = record.run.phase;
      let restored = !transition.mutating;
      let restorationError = failedPhase === 'restore' ? error : undefined;
      if (transition.mutating && failedPhase !== 'restore') {
        try { await this.restore(); restored = true; }
        catch (restoreError) { restorationError = restoreError; console.error('Restoration failed:', restoreError); }
      }
      const blocker = restorationError ?? error;
      record.run = { ...record.run, state: 'failed', phase: failedPhase, component: blocker.component ?? failedPhase,
        cause: failureCause(blocker, record.run.component ?? failedPhase),
        resumable: true, finishedAt: new Date().toISOString(),
        message: restored ? 'Update stopped; the previous installation is retained.' : 'Update stopped; restoration needs to continue.',
        recoveryAction: restored ? `Resolve the blocker and resume update ${record.run.id}. Details: ~/.local/state/cloudx/settings-update/${record.run.id}.log. Verified recovery data is retained.` :
          `${restorationError ? `${failureCause(restorationError, 'Restoration')} ` : ''}Resume this update to finish restoring its verified snapshot before another activation. Keep its recovery directory.` };
      if (restored) transition.completed = error.reprepare ? [] : transition.completed.filter(phase => phase === 'prepare');
      this.persist();
    }
    return record.run;
  }

  async restore() {
    this.record.run.phase = 'restore';
    this.persist();
    await this.host.restore(this.record);
    this.record.transition.mutating = false;
    this.persist();
  }
}

export class UpdateHost {
  constructor({ repoRoot, home = os.homedir(), dataDir, service, port, host, runDir, commands, verbose = false, save = () => {}, prepareRelease = prepareManagedRelease, recovery }) {
    this.home = home;
    this.runDir = runDir;
    this.save = save;
    this.prepareRelease = prepareRelease;
    this.paths = { repoRoot: fs.realpathSync(repoRoot), dataDir, envPath: path.join(home, '.config/cloudx/cloudx.env'), systemdDir: path.join(home, '.config/systemd/user') };
    this.runner = commands ?? new InstallerRunner({ cwd: this.paths.repoRoot, nonInteractive: true, verbose });
    this.target = recovery?.mutating ? recovery.serviceTarget : inspectUpdateTarget({ paths: this.paths, commands: this.runner, service, port, host });
    if (!this.target || !['standard', 'web'].includes(this.target.kind) || !Array.isArray(this.target.serviceNames)) throw new Error('Invalid saved update service target.');
    if (recovery?.mutating) {
      for (const name of this.target.serviceNames) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(name)) throw new Error('Invalid saved service name.');
        const state = Object.fromEntries(this.runner.inspect('systemctl', ['--user', 'show', name, '--property=LoadState,WorkingDirectory']).split('\n').map(line => line.split('=')));
        if (state.LoadState !== 'not-found' && state.WorkingDirectory !== this.paths.repoRoot) throw new Error('The recovery service belongs to another checkout.');
      }
    }
    if (service) {
      const properties = this.runner.inspect('systemctl', ['--user', 'show', service, '--property=EnvironmentFiles']);
      const match = /^EnvironmentFiles=(.+) \(ignore_errors=no\)$/u.exec(properties);
      if (!match || !path.isAbsolute(match[1])) throw new Error('A custom service update requires one explicit EnvironmentFile with CLOUDX_DATA_DIR.');
      this.paths.envPath = match[1];
    }
    this.envConfig = recovery?.mutating ? recovery.environment : parseEnvironmentFile(fs.readFileSync(this.paths.envPath, 'utf8'));
    if (!this.envConfig || typeof this.envConfig !== 'object') throw new Error('Saved update configuration is unavailable.');
    this.paths.dataDir = this.envConfig.CLOUDX_DATA_DIR ?? path.join(this.paths.repoRoot, '.cloudx');
    if (dataDir && path.resolve(dataDir) !== path.resolve(this.paths.dataDir)) throw new Error('The requested data directory differs from the selected service configuration.');
    if (!path.isAbsolute(this.paths.dataDir)) throw new Error('CloudX data directory must be absolute.');
    if (fs.existsSync(this.paths.dataDir) && fs.realpathSync(this.paths.dataDir) !== this.paths.dataDir) throw new Error('CloudX data root must be a real directory without symlink components.');
    if (service && !this.envConfig.CLOUDX_DATA_DIR) throw new Error('Custom service EnvironmentFile must explicitly declare CLOUDX_DATA_DIR.');
    if (recovery?.mutating && recovery.directBroker) this.inspectOwnedBrokerConfiguration(recovery.directBroker.file);
  }

  git(args, cwd = this.paths.repoRoot) { return this.runner.inspect('git', args, { cwd }); }

  prepare(record) {
    const transition = record.transition;
    const root = this.paths.repoRoot;
    delete transition.sourceFiles;
    delete transition.targetFiles;
    delete transition.directBroker;
    if (this.git(['rev-parse', '--show-toplevel']) !== root) throw new Error('Update requires the installed checkout root.');
    transition.sourceCommit = this.git(['rev-parse', 'HEAD']);
    transition.sourceIndex = this.git(['write-tree']);
    const release = path.join(this.runDir, 'release');
    // Only an uncommitted preparation directory is disposable.
    fs.rmSync(release, { recursive: true, force: true });
    this.runner.run('git', ['clone', '--no-hardlinks', '--no-checkout', '--', root, release]);
    const origin = this.git(['remote', 'get-url', 'origin']);
    this.git(['remote', 'set-url', 'origin', origin], release);
    this.runner.run('git', ['fetch', '--no-tags', 'origin', record.targetCommit], { cwd: release });
    if (this.git(['rev-parse', `${record.targetCommit}^{commit}`], release) !== record.targetCommit) throw new Error('Fetched target is not the selected commit.');
    this.git(['checkout', '--detach', record.targetCommit], release);
    // Fetch objects without advancing the installed checkout or branch.
    this.runner.run('git', ['fetch', '--no-tags', release, record.targetCommit]);
    try { this.git(['read-tree', '--dry-run', '-m', '-u', transition.sourceCommit, record.targetCommit]); }
    catch (error) { throw publicFailure('checkout', 'Local changes conflict with the selected target. Commit or move the conflicting paths shown in the private log, then resume. No local work was removed.', error); }
    for (const relative of this.changedPaths(transition.sourceCommit, record.targetCommit, 'A')) {
      if (optionalStat(path.join(root, relative), root) && !this.changedPaths(transition.sourceCommit, record.targetCommit, 'D').some(removed => removed.startsWith(`${relative}/`)))
        throw publicFailure('checkout', `An untracked or ignored path conflicts with the target: ${relative}. Move it aside and resume; it was preserved.`);
    }
    const patch = this.localChanges();
    transition.localPatch = patch;
    if (patch) {
      const patchFile = path.join(this.runDir, 'local-work.patch');
      fs.writeFileSync(patchFile, patch, { mode: 0o600, flush: true });
      this.git(['apply', '--binary', '--whitespace=nowarn', patchFile], release);
    }
    transition.targetRuntime = inspectTargetRuntime(release);
    transition.runtimePlan = inspectRuntimeUpdate({ paths: this.paths, commands: this.runner, target: this.target, targetRuntime: transition.targetRuntime });
    if (transition.runtimePlan.blockers.length) throw publicFailure('terminals', transition.runtimePlan.blockers.map(blocker => blocker.message ?? blocker).join(' '));
    if (transition.runtimePlan.requiresInterruption && !record.confirmInterruption) this.requireInterruption(record, transition.runtimePlan);
    transition.release = release;
    transition.environment = this.envConfig;
    transition.environmentText = fs.readFileSync(this.paths.envPath, 'utf8');
    transition.serviceTarget = this.target;
    transition.serviceStates = Object.fromEntries(this.target.serviceNames.map(service => [service, this.runner.inspect('systemctl', ['--user', 'show', service, '--property=ActiveState,MainPID,InvocationID'])]));
    transition.targetFiles = this.captureCheckout(transition.sourceCommit, record.targetCommit, release);
    transition.integration = prepareManagedIntegration(release, record.coordinator);
    this.prepareDirectBroker(record);
    this.prepareRelease({ releaseRoot: release, home: this.home, envConfig: this.envConfig, standard: this.target.kind === 'standard',
      runner: new InstallerRunner({ cwd: release, nonInteractive: true, verbose: this.runner.verbose }),
      progress: (component, message) => { record.run.component = component; record.run.message = message; this.save(record); } });
    writeRuntimeBuild({ repoRoot: release, commit: record.targetCommit });
    const server = path.join(release, 'apps/server/dist/server.js');
    const source = fs.readFileSync(server, 'utf8');
    if (!source.includes('/api/ready/terminals') && !transition.integration.independentReadiness)
      throw publicFailure('target', 'The target has neither terminal readiness nor a buildable terminal integration. The installed version is unchanged.');
    this.planData(record);
    transition.artifacts = GENERATED.filter(relative => fs.existsSync(path.join(release, relative)));
    for (const relative of transition.artifacts) {
      // Manifest the actual built bytes, independently of checkout HEAD.
      {
        const destination = path.join(this.runDir, 'prepared-evidence', relative);
        fs.rmSync(destination, { recursive: true, force: true });
        transition.buildManifests ??= {};
        transition.buildManifests[relative] = snapshotTree(path.join(release, relative), destination);
      }
    }
    this.save(record);
  }

  requireInterruption(record, plan) {
    writeUpdateJson(path.join(path.dirname(this.runDir), 'confirmation.json'), { repoRoot: record.repoRoot, targetCommit: record.targetCommit,
      message: 'This update needs to interrupt terminal processes. Saved tabs, layouts and known conversations remain recoverable. Commands and prompts will not be replayed. ' + (plan.recovery?.warnings ?? []).join(' ') });
    throw publicFailure('terminals', 'Confirm the disclosed terminal interruption before continuing this update.');
  }

  inspectOwnedBrokerConfiguration(expectedFile) {
    const service = 'cloudx-terminal.service';
    const state = inspectTerminalService(this.runner, service);
    if (!expectedFile && (state.LoadState === 'not-found' || state.WorkingDirectory !== this.paths.repoRoot)) return;
    if (state.LoadState !== 'loaded' || state.WorkingDirectory !== this.paths.repoRoot)
      throw publicFailure('services', 'The terminal broker configuration no longer belongs to this checkout.');
    const config = Object.fromEntries(this.runner.inspect('systemctl', ['--user', 'show', service, '--property=FragmentPath,DropInPaths']).split('\n').map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    if (config.DropInPaths !== '' || !path.isAbsolute(config.FragmentPath ?? ''))
      throw publicFailure('services', 'The direct-terminal target requires one owned terminal broker unit without drop-ins.');
    const file = fs.realpathSync(config.FragmentPath);
    if (expectedFile && file !== expectedFile)
      throw publicFailure('services', 'The direct-terminal target requires one owned terminal broker unit without drop-ins.');
    assertOwnedBrokerFile(file, this.paths.systemdDir);
    return { file, state: Object.entries(state).map(([key, value]) => `${key}=${value}`).join('\n') };
  }

  prepareDirectBroker(record) {
    const t = record.transition;
    if (this.target.kind !== 'web' || t.integration?.terminalMode !== 'direct') return;
    const broker = this.inspectOwnedBrokerConfiguration();
    if (broker) t.directBroker = { ...broker, sha256: hashFile(broker.file) };
  }

  assertDirectBrokerUnchanged(transition) {
    if (!transition.directBroker) return;
    const { file, sha256 } = transition.directBroker;
    this.inspectOwnedBrokerConfiguration(file);
    if (hashFile(file) !== sha256)
      throw Object.assign(publicFailure('services', 'The terminal broker unit changed during preparation. Resume to prepare against its current configuration.'), { reprepare: true });
  }

  guardDirectBroker(transition) {
    if (!transition.directBroker) return;
    this.assertDirectBrokerUnchanged(transition);
    const file = transition.directBroker.file;
    const content = fs.readFileSync(file, 'utf8');
    const condition = `\n[Unit]\nConditionPathExists=${path.join(this.paths.repoRoot, 'apps/server/dist/terminal/broker.js')}\n`;
    if (!content.endsWith(condition)) writeBrokerConfiguration(file, `${content}${content.endsWith('\n') ? '' : '\n'}${condition}`, this.paths.systemdDir);
  }

  planData(record) {
    const t = record.transition;
    t.dataCompatibility = inspectDataCompatibility(t.release, this.envConfig, this.paths.dataDir);
    if (t.dataCompatibility.compatible && !record.restoreSnapshotRunId) return;
    const candidates = fs.readdirSync(path.dirname(this.runDir)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    let selected;
    for (const name of candidates) {
      const candidate = readJson(path.join(path.dirname(this.runDir), name));
      if (candidate?.repoRoot !== record.repoRoot || candidate?.dataDir !== record.dataDir ||
          candidate?.transition?.sourceCommit !== record.targetCommit || !candidate.transition.snapshots?.length) continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate.run?.id ?? '') || name !== `${candidate.run.id}.json`)
        throw new Error('Invalid historical snapshot record identity.');
      if (candidate.run.id === record.run.id || record.restoreSnapshotRunId && candidate.run.id !== record.restoreSnapshotRunId) continue;
      validateSavedTransition(candidate, path.join(path.dirname(this.runDir), candidate.run.id));
      if (!selected || candidate.run.startedAt > selected.run.startedAt) selected = candidate;
    }
    if (!selected) throw publicFailure('data', `${t.dataCompatibility.message} No compatible pre-transition snapshot is available for this target. Select a version that can read the active profile; newer data was left unchanged.`);
    for (const snapshot of selected.transition.snapshots) {
      verifySnapshot(snapshot.destination, snapshot.manifest);
      if (snapshot.root === this.paths.dataDir && JSON.stringify(forgeRecords(snapshot.destination)) !== JSON.stringify(forgeRecords(this.paths.dataDir)))
        throw publicFailure('forge', 'Forge ownership or publication records changed since this snapshot. Restoring it could repeat published work. Select a target compatible with the active profile; current records are preserved.');
    }
    const compatibility = inspectSnapshotCompatibility(t.release, this.envConfig, this.paths.dataDir, selected.transition.snapshots);
    if (!compatibility.compatible) throw publicFailure('data', `The offered snapshot cannot be read by this target. ${compatibility.message}`);
    const confirmation = { repoRoot: record.repoRoot, targetCommit: record.targetCommit, restoreSnapshotRunId: selected.run.id,
      requiresInterruption: true,
      message: `This target needs the saved profile from update ${selected.run.id}, captured ${selected.run.startedAt}. Restoring it replaces active workspace, session, Forge and archive state. Newer data will first be preserved in this update's verified snapshot. Terminals must be interrupted before restoring session ownership. Commands and prompts will not be replayed.` };
    if (record.restoreSnapshotRunId !== selected.run.id) {
      writeUpdateJson(path.join(path.dirname(this.runDir), 'confirmation.json'), confirmation);
      throw publicFailure('data', 'Confirm the disclosed profile restoration in Settings, or pass --restore-snapshot with the offered update ID in the CLI.');
    }
    t.restoreData = selected.transition.snapshots;
    // Reverting session and Forge ownership while preserving live terminals is unsafe.
    if (!record.confirmInterruption) {
      confirmation.requiresInterruption = true;
      writeUpdateJson(path.join(path.dirname(this.runDir), 'confirmation.json'), confirmation);
      throw publicFailure('terminals', 'Profile restoration also requires confirmation to stop live terminals.');
    }
    t.targetRuntime = undefined;
  }

  quiesce(record) {
    const t = record.transition;
    for (const [relative, manifest] of Object.entries(t.buildManifests)) verifySnapshot(path.join(t.release, relative), manifest);
    this.planData(record);
    if (fs.readFileSync(this.paths.envPath, 'utf8') !== t.environmentText) throw Object.assign(publicFailure('configuration', 'Saved configuration changed during preparation. Resume to prepare a fresh release using the current configuration.'), { reprepare: true });
    this.assertDirectBrokerUnchanged(t);
    if (this.git(['rev-parse', 'HEAD']) !== t.sourceCommit || this.localChanges() !== t.localPatch || this.git(['write-tree']) !== t.sourceIndex)
      throw Object.assign(publicFailure('checkout', 'Local work changed while the release was building. Resume to prepare a fresh release with the current local work.'), { reprepare: true });
    assertUpdaterOutsideServices(inspectRuntimeUpdate({ paths: this.paths, commands: this.runner, target: this.target, targetRuntime: t.targetRuntime }).services.map(({ service, state }) => [service, state]), fs.readFileSync);
    assertTerminalMigrationSafe({ dataDir: this.paths.dataDir });
    const currentPlan = inspectRuntimeUpdate({ paths: this.paths, commands: this.runner, target: this.target, targetRuntime: t.targetRuntime });
    if (currentPlan.requiresInterruption && !record.confirmInterruption) this.requireInterruption(record, currentPlan);
    t.restored = false;
    t.mutating = true;
    this.save(record);
    const migration = prepareRuntimeUpdate({ paths: this.paths, commands: this.runner, target: this.target,
      targetRuntime: t.targetRuntime, interruptionConfirmed: record.confirmInterruption });
    t.runtimePlan = migration.plan;
    t.terminalRecovery = migration?.recoverySnapshot;
    this.save(record);
    this.stopWriters();
    assertTerminalMigrationSafe({ dataDir: this.paths.dataDir });
    const preservedBroker = t.runtimePlan.services.some(({ role, service, state }) => role === 'broker' &&
      state.ActiveState === 'active' && !t.runtimePlan.stopServices.includes(service));
    t.preservedSessionIds = preservedBroker ? this.probeTerminals(record, 'capture') : [];
    this.save(record);
    this.planData(record);
  }

  snapshot(record) {
    const t = record.transition;
    const backup = path.join(this.runDir, `snapshot-${randomUUID()}`);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const documentation = this.envConfig.CLOUDX_DOCUMENTATION_DATA_DIR ?? path.join(this.paths.dataDir, 'documentation');
    const roots = [this.paths.dataDir, ...(this.target.kind === 'standard' && !inside(this.paths.dataDir, documentation) ? [documentation] : [])];
    if (roots.some(root => !path.isAbsolute(root) || root === '/' || inside(root, this.runDir) || fs.existsSync(root) && fs.realpathSync(root) !== root)) throw new Error('Recovery directory must be outside persisted data roots.');
    t.snapshots = [];
    for (const [index, root] of roots.entries()) {
      if (!fs.existsSync(root)) continue;
      const destination = path.join(backup, `data-${index}`);
      const manifest = snapshotTree(root, destination, { exclude: runtimeData });
      verifySnapshot(destination, manifest);
      t.snapshots.push({ root, destination, manifest });
    }
    this.assertDirectBrokerUnchanged(t);
    const configuration = [...new Set([this.paths.envPath, ...this.target.serviceNames.map(name => path.join(this.paths.systemdDir, name)), ...(t.directBroker ? [t.directBroker.file] : [])])];
    t.configuration = configuration.map(file => ({ file, content: fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null }));
    t.replaced = [];
    t.activationIndex = undefined;
    t.failedData = [];
    delete t.profileRestoration;
    delete t.snapshotApplication;
    t.snapshotVerified = true;
    this.save(record);
  }

  activate(record) {
    const t = record.transition;
    for (const [relative, manifest] of Object.entries(t.buildManifests)) verifySnapshot(path.join(t.release, relative), manifest);
    for (const snapshot of t.snapshots) verifySnapshot(snapshot.destination, snapshot.manifest);
    this.git(['update-ref', `refs/cloudx/updates/${record.run.id}`, t.sourceCommit]);
    t.sourceFiles = this.captureCheckout(t.sourceCommit, record.targetCommit);
    t.activationIntent = true;
    this.save(record);
    this.git(['read-tree', '-m', '-u', t.sourceCommit, record.targetCommit]);
    t.activationIndex = this.git(['write-tree']);
    this.save(record);
    this.git(['update-ref', 'HEAD', record.targetCommit, t.sourceCommit]);
    t.codeActivated = true;
    this.save(record);
    if (t.restoreData) {
      t.snapshotApplication = [];
      for (const [index, snapshot] of t.restoreData.entries()) {
        if (!t.snapshots.some(saved => saved.root === snapshot.root)) throw new Error('Restoration snapshot belongs to another data configuration.');
        verifySnapshot(snapshot.destination, snapshot.manifest);
        if (snapshot.root === this.paths.dataDir && JSON.stringify(forgeRecords(snapshot.destination)) !== JSON.stringify(forgeRecords(snapshot.root)))
          throw publicFailure('forge', 'Forge ownership or publication records changed since the selected snapshot. Snapshot application stopped to prevent repeating published work.');
        t.snapshotApplication[index] = 'copying';
        this.save(record);
        clearProfile(snapshot.root, snapshot.manifest);
        restoreSnapshot(snapshot.destination, snapshot.root, snapshot.manifest);
        verifySnapshot(snapshot.root, snapshot.manifest);
        t.snapshotApplication[index] = 'applied';
        this.save(record);
      }
    }
    for (const relative of t.artifacts) {
      const installed = path.join(this.paths.repoRoot, relative);
      const previous = `${installed}.cloudx-previous-${record.run.id}`;
      if (fs.lstatSync(previous, { throwIfNoEntry: false })) throw new Error('A previous artifact backup already exists for this operation; resume restoration before another activation.');
      const existed = !!fs.lstatSync(installed, { throwIfNoEntry: false });
      t.replaced.push({ installed, previous, existed });
      this.save(record);
      fs.mkdirSync(path.dirname(previous), { recursive: true, mode: 0o700 });
      if (existed) { fs.renameSync(installed, previous); syncDirectory(path.dirname(previous)); syncDirectory(path.dirname(installed)); }
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.symlinkSync(path.join(t.release, relative), installed);
      syncDirectory(path.dirname(installed));
    }
    if (this.target.kind === 'standard') activateManagedServices({ repoRoot: this.paths.repoRoot, releaseRoot: t.release, home: this.home, envConfig: this.envConfig, runner: this.runner, runtimeLaunch: { script: path.join(record.coordinator, 'scripts/managed-runtime-launch.mjs'), buildFile: path.join(t.release, 'apps/server/dist/runtime-build.json'), receiptFile: path.join(this.runDir, 'runtime.json') } });
    this.guardDirectBroker(t);
    if (this.target.kind === 'web') fs.writeFileSync(this.paths.envPath, updateEnvironmentFile(fs.readFileSync(this.paths.envPath, 'utf8'), {
      CLOUDX_INSTALL_ROOT: this.paths.repoRoot, CLOUDX_DATA_DIR: this.paths.dataDir,
      ...(record.coordinator ? { CLOUDX_UPDATE_COORDINATOR_ROOT: record.coordinator } : {}),
    }), { mode: 0o600, flush: true });
    this.runner.run('systemctl', ['--user', 'daemon-reload']);
  }

  start(record) {
    const t = record.transition;
    delete t.snapshotApplication;
    const broker = t.runtimePlan.services.find(({ role }) => role === 'broker');
    if (broker) t.brokerStartup = {
      preservedInvocationId: broker.state.ActiveState === 'active' && !t.runtimePlan.stopServices.includes(broker.service) ? broker.state.InvocationID : null,
    };
    t.targetStarted = true;
    this.save(record);
    for (const service of this.target.serviceNames) {
      if (t.integration?.terminalMode === 'direct' && service === 'cloudx-terminal.service') continue;
      this.runner.run('systemctl', ['--user', 'start', service]);
      if (broker) {
        const state = inspectTerminalService(this.runner, broker.service);
        if (/^[a-f0-9]{32}$/.test(state.InvocationID)) {
          t.brokerStartup.invocationId = state.InvocationID;
          this.save(record);
        }
      }
    }
  }

  verify(record) {
    const port = updatePort(this.envConfig.CLOUDX_PORT ?? 3001);
    const origin = this.target.origin ?? `https://127.0.0.1:${port}`;
    if (this.target.kind === 'standard') {
      waitForHealth(this.runner, { label: 'ASR', url: `${this.envConfig.CLOUDX_ASR_URL ?? 'http://127.0.0.1:7810'}/ready` });
      waitForHealth(this.runner, { label: 'Documentation', url: documentationReadinessUrl(this.envConfig) });
    }
    waitForHealth(this.runner, { label: 'CloudX web', url: `${origin}/api/ready`, insecure: true });
    const t = record.transition;
    if (t.integration?.independentReadiness) {
      try {
        const result = JSON.parse(this.runner.inspect(process.execPath, [path.join(record.coordinator, 'scripts/managed-update-readiness.mjs'), t.release, this.paths.dataDir], { timeout: 60000 }));
        const expectedBroker = t.integration.terminalMode === 'direct' ? 'not-applicable' : 'ready';
        if (result.broker !== expectedBroker || result.direct !== 'ready') throw new Error('Incomplete terminal readiness result.');
      } catch (error) {
        throw publicFailure('terminals', 'The historical target did not pass supervised terminal creation and cleanup. Check the private log for its supervisor or broker failure before resuming.', error);
      }
    } else waitForHealth(this.runner, { label: 'Supervised terminal creation and cleanup', url: `${origin}/api/ready/terminals`, insecure: true, requestTimeoutSeconds: 60 });
    for (const [relative, manifest] of Object.entries(t.buildManifests)) verifySnapshot(path.join(t.release, relative), manifest);
    this.planData(record);
    if (this.git(['rev-parse', 'HEAD']) !== record.targetCommit) throw new Error('Checkout changed during readiness verification.');
    const service = this.target.kind === 'web' ? this.target.serviceNames[0] : 'cloudx.service';
    const state = this.runner.inspect('systemctl', ['--user', 'show', service, '--property=ActiveState,MainPID,InvocationID,ControlGroup']);
    const oldInvocation = Object.fromEntries(t.serviceStates[service].split('\n').map(line => line.split('='))).InvocationID;
    const newInvocation = Object.fromEntries(state.split('\n').map(line => line.split('='))).InvocationID;
    if (!state.includes('ActiveState=active') || !/^[a-f0-9]{32}$/.test(newInvocation) || newInvocation === oldInvocation) throw new Error('The selected web service has not entered a new running invocation.');
    for (const [relative, manifest] of Object.entries(t.buildManifests)) verifySnapshot(path.join(this.paths.repoRoot, relative), manifest, { expectedRoot: path.join(t.release, relative) });
    const built = readJson(path.join(t.release, 'apps/server/dist/runtime-build.json'));
    const live = this.target.kind === 'standard' ? readJson(path.join(this.runDir, 'runtime.json')) :
      JSON.parse(this.runner.inspect('curl', ['--fail', '--silent', '--show-error', '--insecure', '--max-time', '10', `${origin}/api/runtime`]));
    const properties = Object.fromEntries(state.split('\n').map(line => line.split('=')));
    if (live?.build?.commit !== record.targetCommit || live?.build?.artifactSha256 !== built.artifactSha256 || live?.verification !== 'verified' ||
        live.invocationId !== properties.InvocationID || !Number.isSafeInteger(live.pid) || live.pid <= 0 ||
        this.target.kind === 'standard' && Number(properties.MainPID) !== live.pid)
      throw new Error('The running service does not attest the selected prepared build and invocation.');
    const groups = fs.readFileSync(`/proc/${live.pid}/cgroup`, 'utf8').split('\n').map(line => line.split(':')[2]);
    if (!properties.ControlGroup || !groups.some(group => group === properties.ControlGroup || group?.startsWith(`${properties.ControlGroup}/`))) throw new Error('The ready endpoint belongs to another service.');
    const started = fs.readFileSync(`/proc/${live.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (live.processStarted !== started || live.bootId !== boot) throw new Error('The runtime receipt is stale.');
    if (t.preservedSessionIds?.length) this.probeTerminals(record, 'verify');
    t.verifiedRuntime = live;

  }

  probeTerminals(record, mode) {
    const args = [path.join(record.coordinator, 'scripts/managed-update-terminals.mjs'), mode, record.transition.release, this.paths.dataDir];
    if (mode === 'verify') {
      const input = path.join(this.runDir, 'preserved-terminals.json');
      writeUpdateJson(input, { sessionIds: record.transition.preservedSessionIds });
      args.push(input);
    }
    try {
      const result = JSON.parse(this.runner.inspect(process.execPath, args, { timeout: 60000 }));
      if (!validSessionIds(result.sessionIds)) throw new Error('Invalid terminal attachment result.');
      if (mode === 'verify' && JSON.stringify(result.sessionIds) !== JSON.stringify(record.transition.preservedSessionIds)) throw new Error('The terminal attachment result changed its requested identities.');
      return result.sessionIds;
    } catch (error) {
      throw publicFailure('terminals', 'The preserved terminal sessions could not be attached. No commands were replayed. Check the private log and broker before resuming.', error);
    }
  }

  changedPaths(source, target, filter) {
    const fields = this.git(['diff', '--no-renames', '--name-status', '-z', ...(filter ? [`--diff-filter=${filter}`] : []), source, target]).split('\0');
    const paths = [];
    for (let index = 0; index + 1 < fields.length; index += 2) paths.push(fields[index + 1]);
    return paths;
  }

  localChanges() {
    const file = path.join(this.runDir, 'current-local-work.patch');
    this.git(['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `--output=${file}`, 'HEAD']);
    return fs.readFileSync(file, 'utf8');
  }

  captureCheckout(sourceCommit, targetCommit, root = this.paths.repoRoot) {
    const names = this.changedPaths(sourceCommit, targetCommit);
    return names.map(relative => {
      const file = path.join(root, relative);
      const stat = optionalStat(file, root);
      if (stat && !stat.isFile() && !stat.isSymbolicLink() && !stat.isDirectory()) throw new Error('Checkout transition includes an unsupported file boundary.');
      return { relative, mode: stat?.mode, type: !stat ? 'absent' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file',
        content: stat?.isSymbolicLink() ? fs.readlinkSync(file) : stat?.isFile() ? fs.readFileSync(file).toString('base64') : undefined };
    });
  }

  assertCheckoutRestorable(record) {
    const t = record.transition;
    const head = this.git(['rev-parse', 'HEAD']);
    if (![t.sourceCommit, record.targetCommit].includes(head)) throw new Error('Checkout changed externally; restoration stopped to preserve local work.');
    if (!t.activationIntent) return head;
    if (!Array.isArray(t.sourceFiles) || !Array.isArray(t.targetFiles) || t.sourceFiles.length !== t.targetFiles.length ||
        t.sourceFiles.some((entry, index) => entry.relative !== t.targetFiles[index].relative))
      throw publicFailure('checkout', 'The saved expected checkout is incomplete. Keep the recovery directory and restore its checkout evidence before resuming.');
    const targets = new Map(t.targetFiles.map(entry => [entry.relative, entry]));
    const recoveryPaths = new Set(t.sourceFiles.map(file => file.relative));
    for (const entry of t.sourceFiles.filter(entry => entry.type === 'file' || entry.type === 'link')) {
      const relative = checkoutTemporaryPath(entry.relative, record.run.id);
      if (recoveryPaths.has(relative)) throw new Error(`Checkout recovery conflict: ${relative} is reserved by the source checkout.`);
      const temporary = path.join(this.paths.repoRoot, relative);
      const stat = optionalStat(temporary, this.paths.repoRoot);
      if (!stat) continue;
      if (t.checkoutRestoration !== 'copying' || !checkoutTemporaryMatches(temporary, stat, entry))
        throw new Error(`Checkout recovery conflict: ${relative}. Preserve the unexpected temporary file before resuming.`);
      recoveryPaths.add(relative);
    }
    // Build integration changes live only in the release, never in this checkout.
    for (const entry of t.sourceFiles) {
      const file = path.join(this.paths.repoRoot, entry.relative);
      const stat = optionalStat(file, this.paths.repoRoot);
      if (!stat) continue;
      const expected = [entry, targets.get(entry.relative)];
      if (stat.isDirectory()) {
        if (!expected.some(file => file.type === 'directory') ||
            !containsOnlyRecoveryPaths(file, entry.relative, recoveryPaths)) throw new Error(`Checkout recovery conflict: ${entry.relative}`);
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Checkout recovery conflict: ${entry.relative}`);
      const type = stat.isSymbolicLink() ? 'link' : 'file';
      const actual = stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('base64');
      if (!expected.some(file => file.type === type && file.content === actual &&
          (type === 'link' || (file.mode & 0o777) === (stat.mode & 0o777))))
        throw new Error(`Checkout recovery conflict: ${entry.relative}. Preserve the new local edit before resuming.`);
    }
    return head;
  }

  restoreCheckout(record) {
    const t = record.transition;
    const head = this.assertCheckoutRestorable(record);
    if (!t.activationIntent) return;
    t.checkoutRestoration = 'copying';
    this.save(record);
    for (const entry of t.sourceFiles.filter(entry => entry.type === 'file' || entry.type === 'link')) {
      const temporary = path.join(this.paths.repoRoot, checkoutTemporaryPath(entry.relative, record.run.id));
      if (optionalStat(temporary, this.paths.repoRoot)) {
        fs.unlinkSync(temporary);
        syncDirectory(path.dirname(temporary));
      }
    }
    for (const entry of [...t.sourceFiles].sort((a, b) => b.relative.length - a.relative.length)) {
      const file = path.join(this.paths.repoRoot, entry.relative);
      const stat = optionalStat(file, this.paths.repoRoot);
      if (stat?.isDirectory()) { if (!fs.readdirSync(file).length) fs.rmdirSync(file); }
      else if (stat && !['file', 'link'].includes(entry.type)) fs.unlinkSync(file);
      if (stat) syncDirectory(path.dirname(file));
    }
    for (const entry of [...t.sourceFiles].sort((a, b) => a.relative.length - b.relative.length)) {
      const file = path.join(this.paths.repoRoot, entry.relative);
      if (entry.type === 'absent') continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (entry.type === 'directory') fs.mkdirSync(file, { recursive: true, mode: entry.mode & 0o777 });
      else restoreCheckoutFile(file, entry, record.run.id);
      syncDirectory(path.dirname(file));
    }
    this.git(['read-tree', t.sourceIndex]);
    if (head !== t.sourceCommit) this.git(['update-ref', 'HEAD', t.sourceCommit, head]);
    delete t.checkoutRestoration;
    this.save(record);
  }

  stopWriters() {
    const names = this.target.serviceNames.filter(name => name !== 'cloudx-terminal.service');
    const states = names.map(service => [service, Object.fromEntries(this.runner.inspect('systemctl', ['--user', 'show', service, '--property=LoadState,ActiveState,MainPID,ControlGroup,KillMode,SendSIGKILL']).split('\n').map(line => line.split('=')))]);
    assertUpdaterOutsideServices(states);
    for (const [service, state] of states) {
      if (state.LoadState === 'not-found') continue;
      if (!["inactive", "failed"].includes(state.ActiveState) && (!["control-group", "mixed"].includes(state.KillMode) || state.SendSIGKILL !== 'yes'))
        throw publicFailure('services', `${service} must terminate its full control group before update snapshots can be taken.`);
      this.runner.run('systemctl', ['--user', 'stop', service]);
      assertStoppedService(this.runner, service, state.ControlGroup);
    }
  }

  stopStartedBroker(transition) {
    if (!transition.targetStarted || !transition.runtimePlan.services.some(({ role }) => role === 'broker')) return;
    const service = 'cloudx-terminal.service';
    const state = inspectTerminalService(this.runner, service);
    if (state.LoadState === 'not-found') return;
    if (state.WorkingDirectory !== this.paths.repoRoot) throw publicFailure('services', 'The terminal broker belongs to another checkout; restoration stopped before changing its runtime.');
    if (state.ActiveState === 'active' && /^[a-f0-9]{32}$/.test(transition.brokerStartup?.preservedInvocationId ?? '') && state.InvocationID === transition.brokerStartup.preservedInvocationId) return;
    assertUpdaterOutsideServices([[service, state]]);
    if (!["inactive", "failed"].includes(state.ActiveState) && (!["control-group", "mixed"].includes(state.KillMode) || state.SendSIGKILL !== 'yes'))
      throw publicFailure('services', `${service} must terminate its full control group before its runtime can be restored.`);
    this.runner.run('systemctl', ['--user', 'stop', service]);
    assertStoppedService(this.runner, service, state.ControlGroup);
  }

  restore(record) {
    const t = record.transition;
    if (t.restored) { this.restartPrevious(t); return; }
    const copyingProfile = t.snapshots?.some((snapshot, index) => snapshot.root === this.paths.dataDir && t.profileRestoration?.[index] === 'copying');
    if (t.targetStarted && !copyingProfile) {
      try { assertTerminalMigrationSafe({ dataDir: this.paths.dataDir }); }
      catch (error) { throw publicFailure('forge', 'Forge work became active after startup. Pause or finish it before resuming restoration; its ownership records were preserved.', error); }
    }
    this.stopWriters();
    if (t.targetStarted && !copyingProfile) {
      try { assertTerminalMigrationSafe({ dataDir: this.paths.dataDir }); }
      catch (error) { throw publicFailure('forge', 'Forge ownership changed while services stopped. Recover the worker before resuming restoration; its records were preserved.', error); }
    }
    this.stopStartedBroker(t);
    this.assertCheckoutRestorable(record);
    if (t.snapshotVerified) {
      for (const snapshot of t.snapshots) verifySnapshot(snapshot.destination, snapshot.manifest);
      if (t.targetStarted || t.restoreData && t.activationIntent) {
        for (const [index, snapshot] of t.snapshots.entries()) {
          if (snapshot.root !== this.paths.dataDir) continue;
          const applyingIndex = t.restoreData?.findIndex(selected => selected.root === snapshot.root);
          const applying = !t.profileRestoration?.[index] && t.snapshotApplication?.[applyingIndex] === 'copying';
          const copying = t.profileRestoration?.[index] === 'copying' || applying;
          const copyingSnapshot = applying ? t.restoreData[applyingIndex] : snapshot;
          if (applying) verifySnapshot(copyingSnapshot.destination, copyingSnapshot.manifest);
          const expected = forgeRecords(snapshot.destination);
          const current = forgeRecords(snapshot.root, copying ? new Set(copyingSnapshot.manifest.filter(entry => entry.type === 'file').map(entry => entry.path)) : undefined);
          const changed = copying ? Object.entries(current).some(([file, state]) => state !== expected[file]) : JSON.stringify(expected) !== JSON.stringify(current);
          if (changed) throw publicFailure('forge', 'Forge ownership or publication records changed after the recovery snapshot. Restoration stopped to prevent repeating published work; the current profile and runtime remain intact. Preserve these records before resuming recovery.');
        }
        // Preserve post-activation bytes before restoring the coherent old profile.
        t.failedData ??= [];
        t.profileRestoration ??= [];
        for (const [index, snapshot] of t.snapshots.entries()) {
          if (!t.profileRestoration[index]) {
            const newer = path.join(this.runDir, `failed-data-${index}-${randomUUID()}`);
            const manifest = snapshotTree(snapshot.root, newer, { exclude: runtimeData });
            verifySnapshot(newer, manifest);
            if (t.failedData[index]) t.retainedFailedData = [...(t.retainedFailedData ?? []), t.failedData[index]];
            t.failedData[index] = { destination: newer, manifest };
            t.profileRestoration[index] = 'copying';
            this.save(record);
          }
          const newer = t.failedData[index];
          verifySnapshot(newer.destination, newer.manifest);
          if (t.profileRestoration[index] === 'restored') {
            // Forge ownership was checked above; disposal may refresh updatedAt.
            const manifest = snapshot.root === this.paths.dataDir ? snapshot.manifest.filter(entry => entry.path !== FORGE_WORKFLOW_FILE) : snapshot.manifest;
            verifySnapshot(snapshot.root, manifest);
            continue;
          }
          clearProfile(snapshot.root, snapshot.manifest);
          restoreSnapshot(snapshot.destination, snapshot.root, snapshot.manifest);
          verifySnapshot(snapshot.root, snapshot.manifest);
          t.profileRestoration[index] = 'restored';
          this.save(record);
        }
      }
      for (const { installed, previous, existed } of [...t.replaced].reverse()) {
        if (fs.lstatSync(previous, { throwIfNoEntry: false })) {
          fs.rmSync(installed, { recursive: true, force: true });
          fs.renameSync(previous, installed);
          syncDirectory(path.dirname(installed));
          syncDirectory(path.dirname(previous));
        } else if (!existed) fs.rmSync(installed, { recursive: true, force: true });
      }
      this.restoreCheckout(record);
      for (const { file, content } of t.configuration) {
        if (file === t.directBroker?.file) {
          this.inspectOwnedBrokerConfiguration(file);
          writeBrokerConfiguration(file, Buffer.from(content, 'base64'), this.paths.systemdDir);
          continue;
        }
        if (content === null) fs.rmSync(file, { force: true });
        else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(content, 'base64'), { mode: 0o600, flush: true }); }
      }
      this.runner.run('systemctl', ['--user', 'daemon-reload']);
    }
    t.restored = true;
    t.activationIntent = false;
    t.targetStarted = false;
    delete t.brokerStartup;
    t.snapshotVerified = false;
    t.retainedFailedData = [...(t.retainedFailedData ?? []), ...(t.failedData ?? [])];
    t.failedData = undefined;
    delete t.profileRestoration;
    delete t.snapshotApplication;
    t.replaced = [];
    this.save(record);
    this.restartPrevious(t);
  }

  restartPrevious(transition) {
    if (transition.directBroker?.state.includes('ActiveState=active')) {
      this.inspectOwnedBrokerConfiguration(transition.directBroker.file);
      this.runner.run('systemctl', ['--user', 'start', 'cloudx-terminal.service']);
    }
    for (const [service, state] of Object.entries(transition.serviceStates ?? {})) if (state.includes('ActiveState=active')) this.runner.run('systemctl', ['--user', 'start', service]);
  }
}

function brokerConfigurationPath(file, systemdDir) {
  return typeof file === 'string' && path.dirname(file) === systemdDir && path.resolve(file) === file &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(path.basename(file));
}

function assertOwnedBrokerFile(file, systemdDir) {
  if (!brokerConfigurationPath(file, systemdDir)) throw publicFailure('services', 'The terminal broker unit must be inside the user service directory.');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || fs.realpathSync(file) !== file)
    throw publicFailure('services', 'The terminal broker unit must be an owned regular file without linked paths.');
  return stat;
}

function writeBrokerConfiguration(file, content, systemdDir) {
  const stat = assertOwnedBrokerFile(file, systemdDir);
  const temporary = `${file}.${randomUUID()}.update`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: stat.mode & 0o777, flush: true });
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}

function optionalStat(file, root) {
  let parent = root;
  for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    if (!fs.lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  }
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function checkoutTemporaryPath(file, runId) {
  return path.join(path.dirname(file), `.cloudx-restore-${runId}-${createHash('sha256').update(path.basename(file)).digest('hex')}`);
}

function checkoutTemporaryMatches(file, stat, entry) {
  if (entry.type === 'link') return stat.isSymbolicLink() && fs.readlinkSync(file) === entry.content;
  if (!stat.isFile() || stat.nlink !== 1 || ![0o600, entry.mode & 0o777].includes(stat.mode & 0o777)) return false;
  const expected = Buffer.from(entry.content, 'base64');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const current = fs.fstatSync(fd);
    return current.ino === stat.ino && current.dev === stat.dev && current.size <= expected.length &&
      fs.readFileSync(fd).equals(expected.subarray(0, current.size));
  } finally { fs.closeSync(fd); }
}

function restoreCheckoutFile(file, entry, runId) {
  const temporary = checkoutTemporaryPath(file, runId);
  if (entry.type === 'link') fs.symlinkSync(entry.content, temporary);
  else {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, Buffer.from(entry.content, 'base64'));
      fs.fchmodSync(fd, entry.mode & 0o777);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  fs.renameSync(temporary, file);
}

function containsOnlyRecoveryPaths(directory, relative, paths) {
  return fs.readdirSync(directory).every(name => {
    const child = path.join(directory, name), childRelative = path.join(relative, name);
    return fs.lstatSync(child).isDirectory() ? containsOnlyRecoveryPaths(child, childRelative, paths) : paths.has(childRelative);
  });
}

function failureCause(error, component) {
  if (error.publicMessage) return error.publicMessage;
  if (['ENOSPC', 'EDQUOT'].includes(error.code)) return `${component}: insufficient disk space (${error.code}). Free space before resuming.`;
  if (['ENETUNREACH', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code)) return `${component}: the required network service is unavailable (${error.code}). Restore access before resuming.`;
  return `${component} failed${Number.isInteger(error.status) ? ` with exit status ${error.status}` : error.code ? ` (${error.code})` : ''}. The private log contains the underlying command error.`;
}

function forgeRecords(root, restoringFiles = new Set()) {
  const records = {};
  function inspect(relative) {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('Forge ownership recovery cannot follow symlinks.');
    if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) inspect(path.join(relative, name));
    else if (stat.isFile()) {
      const restoring = /^(.*\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.restore$/u.exec(relative);
      if (restoring && restoringFiles.has(restoring[1])) return;
      if (!relative.endsWith('.json')) throw new Error('Forge ownership state contains an unsupported file.');
      if (relative !== FORGE_WORKFLOW_FILE) { records[relative] = hashFile(full); return; }
      const workers = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!Array.isArray(workers)) throw new Error('Invalid saved Forge worker list.');
      // Forge initializes an absent workflow store to an empty list on startup.
      if (!workers.length) return;
      records[relative] = JSON.stringify(workers.map(worker => {
        // ForgeWorkflowService.persist refreshes this metadata on load and disposal.
        // Publication, retry and completion timestamps remain part of the comparison.
        if (!['paused', 'awaiting_review', 'stopped', 'completed', 'failed'].includes(worker?.status) ||
            typeof worker.updatedAt !== 'string' || !Number.isFinite(Date.parse(worker.updatedAt))) return worker;
        const { updatedAt, ...ownership } = worker;
        return ownership;
      }));
    }
    else throw new Error('Forge ownership state contains an unsupported file.');
  }
  const pluginData = path.join(root, 'plugin-data');
  if (fs.existsSync(pluginData)) for (const name of fs.readdirSync(pluginData).sort()) if (name.startsWith('forge-')) inspect(path.join('plugin-data', name));
  for (const directory of ['workspaces', 'tabs', 'executions', 'turns', 'history']) inspect(path.join('forge-workers', directory));
  return records;
}

function clearProfile(root, manifest) {
  const directories = new Set(manifest.filter(entry => entry.type === 'directory').map(entry => entry.path));
  function clear(directory, relative) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      for (const name of fs.readdirSync(`/proc/self/fd/${fd}`)) {
        const child = path.join(relative, name), file = `/proc/self/fd/${fd}/${name}`;
        if (runtimeData(child)) continue;
        // Forge and Codex ownership records retain directory inode and creation time.
        if (directories.has(child) && fs.lstatSync(file).isDirectory()) clear(file, child);
        else fs.rmSync(file, { recursive: true, force: true });
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  clear(root, '');
}

function readJson(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; }
function inside(parent, child) { return child === parent || child.startsWith(`${parent}${path.sep}`); }
function publicFailure(component, message, cause) { return Object.assign(new Error(message, { cause }), { component, publicMessage: message }); }
function validSessionIds(value) { return Array.isArray(value) && value.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) && new Set(value).size === value.length; }

export function validateSavedTransition(record, runDir) {
  const canonicalPath = value => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) &&
    value !== path.parse(value).root && path.resolve(value) === value;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (![record.repoRoot, record.dataDir, record.home, runDir, record.envPath ?? path.join(record.home ?? '', '.config/cloudx/cloudx.env')].every(canonicalPath))
    throw new Error('Invalid saved installation path.');
  const t = record.transition;
  if (!t) return;
  if (t.integration !== undefined && (!object(t.integration) || t.integration.version !== 1 ||
      typeof t.integration.independentReadiness !== 'boolean' || !Array.isArray(t.integration.files) ||
      t.integration.terminalMode !== undefined && (t.integration.terminalMode !== 'direct' || !t.integration.independentReadiness) ||
      t.integration.files.some(file => !MANAGED_INTEGRATION_FILES.includes(file)))) throw new Error('Invalid saved managed integration.');
  if (t.preservedSessionIds !== undefined && !validSessionIds(t.preservedSessionIds)) throw new Error('Invalid saved terminal session identities.');
  if (t.brokerStartup !== undefined && (!object(t.brokerStartup) ||
      t.brokerStartup.preservedInvocationId !== null && !/^[a-f0-9]{32}$/.test(t.brokerStartup.preservedInvocationId ?? '') ||
      t.brokerStartup.invocationId !== undefined && !/^[a-f0-9]{32}$/.test(t.brokerStartup.invocationId)))
    throw new Error('Invalid saved broker invocation identity.');
  const expectedServices = record.service ? [record.service] : SERVICE_NAMES;
  if (expectedServices.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(name)) ||
      t.serviceTarget && (JSON.stringify(t.serviceTarget.serviceNames) !== JSON.stringify(expectedServices) ||
      t.serviceTarget.kind !== (record.service ? 'web' : 'standard'))) throw new Error('Invalid saved service selection.');
  if (t.serviceStates !== undefined && (!object(t.serviceStates) || Object.entries(t.serviceStates).some(([name, state]) => !expectedServices.includes(name) || typeof state !== 'string')))
    throw new Error('Invalid saved service state.');
  if (t.directBroker !== undefined && (!object(t.directBroker) || !record.service || t.integration?.terminalMode !== 'direct' ||
      !brokerConfigurationPath(t.directBroker.file, path.join(record.home, '.config/systemd/user')) ||
      typeof t.directBroker.state !== 'string' || !/^[a-f0-9]{64}$/.test(t.directBroker.sha256 ?? '')))
    throw new Error('Invalid saved direct-terminal broker configuration.');
  for (const commit of [t.sourceCommit, t.sourceIndex].filter(Boolean)) updateCommit(commit);
  const environment = t.environment ?? {};
  if (!object(environment) || Object.values(environment).some(value => typeof value !== 'string') ||
      environment.CLOUDX_DATA_DIR !== undefined && environment.CLOUDX_DATA_DIR !== record.dataDir) throw new Error('Invalid saved environment.');
  const documentation = environment.CLOUDX_DOCUMENTATION_DATA_DIR ?? path.join(record.dataDir, 'documentation');
  if (!canonicalPath(documentation)) throw new Error('Invalid saved documentation path.');
  const roots = [record.dataDir, ...(!record.service && !inside(record.dataDir, documentation) ? [documentation] : [])];
  const validateSnapshots = (snapshots, owner) => {
    if (!Array.isArray(snapshots) || snapshots.some(snapshot => !snapshot || !roots.includes(snapshot.root) ||
        !canonicalPath(snapshot.destination) || !inside(owner, snapshot.destination) || snapshot.destination === owner))
      throw new Error('Saved recovery data does not belong to its update.');
  };
  validateSnapshots(t.snapshots ?? [], runDir);
  if (t.profileRestoration !== undefined && (!Array.isArray(t.profileRestoration) || !t.snapshotVerified ||
      t.profileRestoration.length && (t.mutating !== true || t.restored === true || !(t.targetStarted === true || t.restoreData && t.activationIntent === true)) ||
      t.profileRestoration.length > (t.snapshots?.length ?? 0) || t.profileRestoration.some((state, index) =>
        !['copying', 'restored'].includes(state) || !t.failedData?.[index] ||
        !canonicalPath(t.failedData[index].destination) || !inside(runDir, t.failedData[index].destination) ||
        t.failedData[index].destination === runDir || !Array.isArray(t.failedData[index].manifest))))
    throw new Error('Invalid saved profile restoration progress.');
  if (t.restoreData !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.restoreSnapshotRunId ?? '') || record.restoreSnapshotRunId === record.run.id)
      throw new Error('Invalid saved restoration snapshot selection.');
    validateSnapshots(t.restoreData, path.join(path.dirname(runDir), record.restoreSnapshotRunId));
  }
  if (t.snapshotApplication !== undefined && (!Array.isArray(t.snapshotApplication) || !t.snapshotVerified ||
      t.mutating !== true || t.restored === true || t.activationIntent !== true || !Array.isArray(t.restoreData) ||
      t.snapshotApplication.length > t.restoreData.length || t.snapshotApplication.some((state, index) =>
        !['copying', 'applied'].includes(state) || state === 'copying' && (index !== t.snapshotApplication.length - 1 || t.targetStarted === true) ||
        !t.snapshots?.some(snapshot => snapshot.root === t.restoreData[index].root))))
    throw new Error('Invalid saved downgrade snapshot application progress.');
  if (t.artifacts !== undefined && (!Array.isArray(t.artifacts) || t.artifacts.some(relative => !GENERATED.includes(relative))) ||
      t.buildManifests !== undefined && (!object(t.buildManifests) || Object.keys(t.buildManifests).some(relative => !GENERATED.includes(relative))))
    throw new Error('Invalid saved runtime artifacts.');
  if (t.replaced !== undefined && !Array.isArray(t.replaced)) throw new Error('Invalid saved runtime replacement.');
  for (const artifact of t.replaced ?? []) {
    if (!artifact || !GENERATED.some(relative => artifact.installed === path.join(record.repoRoot, relative)) ||
        artifact.previous !== `${artifact.installed}.cloudx-previous-${record.run.id}` || typeof artifact.existed !== 'boolean')
      throw new Error('Invalid saved runtime replacement.');
  }
  const configFiles = [record.envPath ?? path.join(record.home, '.config/cloudx/cloudx.env'), ...expectedServices.map(name => path.join(record.home, '.config/systemd/user', name)), ...(t.directBroker ? [t.directBroker.file] : [])];
  if (t.configuration !== undefined && !Array.isArray(t.configuration)) throw new Error('Invalid saved service configuration.');
  for (const config of t.configuration ?? []) if (!config || !configFiles.includes(config.file) || config.content !== null && typeof config.content !== 'string') throw new Error('Invalid saved service configuration.');
  if (t.directBroker && t.snapshotVerified) {
    const configuration = t.configuration?.find(config => config.file === t.directBroker.file);
    if (typeof configuration?.content !== 'string' || createHash('sha256').update(Buffer.from(configuration.content, 'base64')).digest('hex') !== t.directBroker.sha256)
      throw new Error('The saved terminal broker configuration does not match its recovery snapshot.');
  }
  for (const files of [t.sourceFiles, t.targetFiles]) {
    if (files === undefined) continue;
    if (!Array.isArray(files) || new Set(files.map(file => file?.relative)).size !== files.length) throw new Error('Invalid saved checkout recovery path.');
    for (const file of files) if (!file || typeof file.relative !== 'string' || !file.relative || file.relative.includes('\0') || path.isAbsolute(file.relative) ||
        file.relative.split(/[\\/]/).some(part => ['.', '..', '', '.git'].includes(part)) || !['absent', 'directory', 'file', 'link'].includes(file.type) ||
        file.type !== 'absent' && !Number.isInteger(file.mode) || ['file', 'link'].includes(file.type) && typeof file.content !== 'string')
      throw new Error('Invalid saved checkout recovery path.');
  }
  if (t.sourceFiles && t.targetFiles && (t.sourceFiles.length !== t.targetFiles.length ||
      t.sourceFiles.some((file, index) => file.relative !== t.targetFiles[index].relative))) throw new Error('Saved checkout recovery paths do not match the expected target.');
  if (t.checkoutRestoration !== undefined && (t.checkoutRestoration !== 'copying' || !t.snapshotVerified ||
      t.mutating !== true || t.restored === true || t.activationIntent !== true || !Array.isArray(t.sourceFiles) || !Array.isArray(t.targetFiles) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.run.id)))
    throw new Error('Invalid saved checkout restoration progress.');
}

export async function runManagedUpdate(recordPath) {
  const record = readJson(recordPath);
  if (!record || !path.isAbsolute(record.repoRoot) || !path.isAbsolute(record.dataDir) || !record.run?.id) throw new Error('Invalid managed update record.');
  updateCommit(record.targetCommit);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.run.id)) throw new Error('Invalid update run identity.');
  const stateDir = path.join(record.home ?? os.homedir(), '.local/state/cloudx/settings-update');
  if (path.dirname(recordPath) !== stateDir) throw new Error('Update record is outside its private state directory.');
  const runDir = path.join(stateDir, record.run.id);
  if (record.coordinator !== path.join(runDir, 'coordinator') || record.transition?.release && record.transition.release !== path.join(runDir, 'release')) throw new Error('Invalid staged update paths.');
  const unit = execFileSync('systemctl', ['--user', 'show', 'cloudx-settings-update.service', '--property=Description,ControlGroup'], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  const properties = Object.fromEntries(unit.trim().split('\n').map(line => line.split('=')));
  const group = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').find(line => line.startsWith('0::'))?.slice(3);
  if (properties.Description !== `CloudX Settings update ${record.run.id}` || !properties.ControlGroup || group !== properties.ControlGroup && !group?.startsWith(`${properties.ControlGroup}/`)) throw new Error('The coordinator must run in its managed update service.');
  if (recordPath !== path.join(path.dirname(recordPath), `${record.run.id}.json`)) throw new Error('Invalid managed update record identity.');
  validateSavedTransition(record, runDir);
  const save = value => writeUpdateJson(recordPath, value);
  try {
    const host = new UpdateHost({ repoRoot: record.repoRoot, home: record.home, dataDir: record.dataDir,
      service: record.service, port: record.port, host: record.host, runDir, save, recovery: record.transition, verbose: record.verbose === true });
    return await new ManagedUpdate({ record, save, host }).run();
  } catch (error) {
    console.error(error);
    record.run = { ...record.run, state: 'failed', resumable: true, phase: record.transition?.mutating ? 'restore' : 'preflight',
      component: 'services', cause: failureCause(error, 'Service ownership verification'),
      message: 'The managed update could not validate its next operation.',
      recoveryAction: `Correct the service or configuration conflict shown in ~/.local/state/cloudx/settings-update/${record.run.id}.log, then resume this run. Its recovery data remains intact.`, finishedAt: new Date().toISOString() };
    save(record);
    return record.run;
  }

}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runManagedUpdate(process.argv[2]).then(run => { if (run.state !== 'succeeded') process.exitCode = 1; }).catch(error => { console.error(error); process.exitCode = 1; });
}

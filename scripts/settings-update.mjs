#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectUpdateTarget,
  SERVICE_NAMES,
  updateCommit,
} from "./install-update.mjs";
import { bundleCoordinator, syncDirectory, verifySnapshot, writeUpdateJson } from "./managed-update-store.mjs";
import { inspectRuntimeUpdate } from "./install-runtime.mjs";
import { CURRENT_TERMINAL_CONTRACT } from "./managed-update.mjs";
import { parseEnvironmentFile } from "./installer-environment.mjs";

export const UPDATE_UNIT = "cloudx-settings-update.service";
export const UPDATE_TIMEOUT_MS = 60 * 60 * 1000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUNNING_STATES = new Set([
  "activating",
  "active",
  "reloading",
  "deactivating",
]);
const UNSUPPORTED =
  "Settings updates require the standard installed CloudX user services running from this checkout. Use the installer manually for development or custom services.";
const DESCRIPTION = "CloudX Settings update ";

function properties(output) {
  return Object.fromEntries(
    output
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const equal = line.indexOf("=");
        return [line.slice(0, equal), line.slice(equal + 1)];
      }),
  );
}

export function processBelongsToService(cgroupText, serviceGroup) {
  if (!serviceGroup?.startsWith("/") || serviceGroup === "/") return false;
  return cgroupText.split(/\r?\n/).some((line) => {
    const [, controllers, group] = line.split(":");
    return (
      (controllers === "" ||
        controllers?.split(",").includes("name=systemd")) &&
      (group === serviceGroup || group?.startsWith(`${serviceGroup}/`))
    );
  });
}

function inspect(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error("Host command failed.");
  return result.stdout?.trim() ?? "";
}

function systemdArgument(value) {
  return value.replaceAll("%", "%%").replaceAll("$", "$$");
}

export class SettingsUpdater {
  constructor({
    repoRoot = ROOT,
    home = os.homedir(),
    dataDir,
    serverPid,
    commands,
    readCgroup = (pid) => fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"),
    now = () => new Date(),
    runtimeInspector = inspectRuntimeUpdate,
    stageCoordinator,
    cli = false,
    service, port, host,
  } = {}) {
    this.repoRoot = fs.realpathSync(repoRoot);
    this.dataDir = dataDir;
    this.serverPid = Number(serverPid);
    this.commands = commands === undefined ? { inspect: (command, args, options) => inspect(command, args, { cwd: this.repoRoot, ...options }) } : commands;
    this.readCgroup = readCgroup;
    this.now = now;
    this.home = home;
    this.runtimeInspector = runtimeInspector;
    this.stageCoordinator = stageCoordinator;
    this.cli = cli;
    this.serviceName = service;
    this.port = port;
    this.host = host;
    this.paths = {
      repoRoot: this.repoRoot,
      envPath: path.join(home, ".config/cloudx/cloudx.env"),
      systemdDir: path.join(home, ".config/systemd/user"),
    };
    this.stateDir = path.join(home, ".local/state/cloudx/settings-update");
  }

  preflight() {
    try {
      if (
        !Number.isSafeInteger(this.serverPid) ||
        this.serverPid <= 0 ||
        !path.isAbsolute(this.dataDir ?? "")
      )
        throw new Error();
      inspectUpdateTarget({ paths: this.paths, commands: this.commands, service: this.serviceName, port: this.port, host: this.host });
      if (this.serviceName) {
        const definition = this.service(this.serviceName, "EnvironmentFiles");
        const environment = /^(.*) \(ignore_errors=no\)$/.exec(definition.EnvironmentFiles ?? "")?.[1];
        if (!path.isAbsolute(environment ?? "")) throw new Error();
        this.paths.envPath = environment;
      }
      const saved = parseEnvironmentFile(
        fs.readFileSync(this.paths.envPath, "utf8"),
      );
      const savedDataDir =
        saved.CLOUDX_DATA_DIR ?? path.join(this.repoRoot, ".cloudx");
      if (
        !path.isAbsolute(savedDataDir) ||
        path.resolve(savedDataDir) !== path.resolve(this.dataDir)
      )
        throw new Error();
      const service = this.service(
        this.serviceName ?? "cloudx.service",
        "ActiveState,MainPID,ControlGroup",
      );
      if (!this.cli && (
        service.ActiveState !== "active" ||
        !Number.isSafeInteger(Number(service.MainPID)) ||
        Number(service.MainPID) <= 0 ||
        !processBelongsToService(
          this.readCgroup(this.serverPid),
          service.ControlGroup,
        )
      ))
        throw new Error();
    } catch {
      return UNSUPPORTED;
    }
    return undefined;
  }

  selectSavedInstallation(record) {
    if (record.repoRoot !== this.repoRoot || record.dataDir !== this.dataDir || !path.isAbsolute(record.envPath ?? "")
      || record.home !== this.home || record.service && !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(record.service))
      throw new Error("The saved update belongs to another installation.");
    this.paths.envPath = record.envPath;
    this.serviceName = record.service;
    this.port = record.port;
    this.host = record.host;
  }

  recoveryPreflight(record) {
    try {
      this.selectSavedInstallation(record);
      const target = record.transition.serviceTarget;
      const names = record.service ? [record.service] : SERVICE_NAMES;
      if (!target || target.kind !== (record.service ? "web" : "standard")
        || JSON.stringify(target.serviceNames) !== JSON.stringify(names)
        || typeof record.transition.environmentText !== "string") throw new Error();
      const saved = parseEnvironmentFile(record.transition.environmentText);
      if ((saved.CLOUDX_DATA_DIR ?? path.join(this.repoRoot, ".cloudx")) !== record.dataDir) throw new Error();
      const runDir = path.join(this.stateDir, record.run.id);
      if (!record.coordinator?.startsWith(`${runDir}${path.sep}`) || fs.realpathSync(record.coordinator) !== record.coordinator) throw new Error();
      for (const name of names) {
        const state = this.service(name, "Id,LoadState,WorkingDirectory,EnvironmentFiles,FragmentPath,ActiveState,MainPID,ControlGroup");
        if (state.LoadState === "not-found" && !Number(state.MainPID)) {
          if (!this.cli && name === (record.service ?? "cloudx.service")) throw new Error();
          continue;
        }
        if (state.Id !== name || state.WorkingDirectory !== this.repoRoot
          || state.EnvironmentFiles !== `${record.envPath} (ignore_errors=no)`
          || !record.service && state.FragmentPath !== path.join(this.paths.systemdDir, name)) throw new Error();
        if (!this.cli && name === (record.service ?? "cloudx.service")
          && !processBelongsToService(this.readCgroup(this.serverPid), state.ControlGroup)) throw new Error();
      }
      return undefined;
    } catch {
      return "The interrupted update's saved service ownership could not be verified. Restore the selected installation's service identity before resuming.";
    }
  }

  launchEnvironment(record) {
    if (!record.transition?.mutating) return this.paths.envPath;
    const file = path.join(this.stateDir, record.run.id, "recovery.env");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, record.transition.environmentText, { mode: 0o600, flag: "wx", flush: true });
      fs.renameSync(temporary, file);
      syncDirectory(path.dirname(file));
    } finally { fs.rmSync(temporary, { force: true }); }
    return file;
  }

  service(name, fields) {
    return properties(
      this.commands.inspect("systemctl", [
        "--user",
        "show",
        name,
        `--property=${fields}`,
      ]),
    );
  }

  unit() {
    const unit = this.service(
      UPDATE_UNIT,
      "LoadState,ActiveState,Description,ControlGroup",
    );
    const id = unit.Description?.startsWith(DESCRIPTION)
      ? unit.Description.slice(DESCRIPTION.length)
      : undefined;
    return {
      ...unit,
      id: RUN_ID.test(id ?? "") ? id : undefined,
      running: RUNNING_STATES.has(unit.ActiveState),
    };
  }

  recordPath(id) {
    if (!RUN_ID.test(id)) throw new Error("Invalid update run identifier.");
    return path.join(this.stateDir, `${id}.json`);
  }

  readRecord(id) {
    const record = JSON.parse(fs.readFileSync(this.recordPath(id), "utf8"));
    const run = record.run;
    if (
      typeof record.repoRoot !== "string" ||
      !path.isAbsolute(record.repoRoot) ||
      run?.id !== id ||
      !["running", "succeeded", "failed"].includes(run.state) ||
      typeof run.message !== "string" ||
      !Number.isFinite(Date.parse(run.startedAt)) ||
      (run.finishedAt !== undefined &&
        !Number.isFinite(Date.parse(run.finishedAt)))
    )
      throw new Error("Invalid stored update status.");
    return record;
  }

  read(id) {
    const record = this.readRecord(id);
    if (record.repoRoot !== this.repoRoot)
      throw new Error("Invalid stored update status.");
    return record;
  }

  write(file, value) {
    writeUpdateJson(file, value);
  }

  save(record) {
    this.write(this.recordPath(record.run.id), record);
  }

  publish(record) {
    this.save(record);
    this.write(path.join(this.stateDir, "latest.json"), { id: record.run.id });
  }

  finish(record, state, message) {
    record.run = {
      ...record.run,
      state,
      message,
      finishedAt: this.now().toISOString(),
    };
    this.save(record);
    return record;
  }

  current(unit) {
    let id = unit.running && unit.id;
    if (!id) {
      const latest = this.pointer("latest");
      const attempt = this.pointer("attempt");
      id =
        attempt && attempt.previousRunId === latest?.id
          ? attempt.id
          : latest?.id;
      if (!id) return undefined;
    }
    const record = this.readRecord(id);
    if (record.repoRoot !== this.repoRoot) {
      if (unit.running || record.run.state === "running")
        throw new Error("Invalid stored update status.");
      return undefined;
    }
    if (
      record.run.state === "running" &&
      !(unit.running && unit.id === id) &&
      this.now().getTime() - Date.parse(record.run.startedAt) > 20000
    ) {
      record.run.resumable = true;
      record.run.targetCommit = record.targetCommit;
      this.finish(
        record,
        "failed",
        "The update was interrupted. Resume it to restore or continue from its verified recovery data.",
      );
    }
    return record;
  }

  pointer(name) {
    const file = path.join(this.stateDir, `${name}.json`);
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : undefined;
  }

  status() {
    let unit;
    try {
      unit = this.unit();
    } catch {
      const unavailableReason = this.preflight();
      if (unavailableReason) return { available: false, unavailableReason };
      throw new Error("Could not inspect the update service.");
    }
    const record = this.current(unit);
    const run = record?.run;
    const unavailableReason = record?.transition?.mutating && run?.resumable
      ? this.recoveryPreflight(record) : this.preflight();
    const confirmation = this.pointer("confirmation");
    return {
      available: !unavailableReason,
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(run ? { run } : {}),
      ...(confirmation?.repoRoot === this.repoRoot ? { confirmation: { targetCommit: confirmation.targetCommit, message: confirmation.message, ...(confirmation.restoreSnapshotRunId ? { restoreSnapshotRunId: confirmation.restoreSnapshotRunId, requiresInterruption: confirmation.requiresInterruption } : {}) } } : {}),
    };
  }

  start(targetCommit, { confirmInterruption = false, resumeRunId, restoreSnapshotRunId } = {}) {
    updateCommit(targetCommit);
    if (restoreSnapshotRunId && !RUN_ID.test(restoreSnapshotRunId)) throw new Error("Invalid snapshot identifier.");
    let saved;
    if (resumeRunId) {
      saved = this.read(resumeRunId);
      this.selectSavedInstallation(saved);
      if (saved.targetCommit !== targetCommit) throw new Error("The selected update cannot be resumed.");
    }
    const previousRunId = this.pointer("latest")?.id;
    const status = this.status();
    if (!status.available || status.run?.state === "running") return status;
    if (resumeRunId && status.run?.id !== resumeRunId) throw new Error("The selected update is no longer the current run and cannot be resumed.");
    if (!resumeRunId && status.run?.resumable && this.read(status.run.id).transition?.mutating)
      return { ...status, available: false, unavailableReason: "Resume the interrupted update to restore the installation before starting another update." };
    const unit = this.unit();
    if (unit.running)
      return {
        available: false,
        unavailableReason:
          "Another CloudX update service is already running. Wait for it to finish.",
      };
    if (resumeRunId) {
      saved = this.read(resumeRunId);
      if (saved.run.state !== "failed" || !saved.run.resumable) throw new Error("The selected update cannot be resumed.");
    }
    if (!saved?.transition?.mutating) {
      const runtimePlan = this.runtimeInspector({ paths: { ...this.paths, dataDir: this.dataDir }, commands: this.commands,
        target: { kind: this.serviceName ? "web" : "standard", serviceNames: this.serviceName ? [this.serviceName] : SERVICE_NAMES }, targetRuntime: CURRENT_TERMINAL_CONTRACT });
      if (runtimePlan.blockers.length) return { ...status, available: false, unavailableReason: runtimePlan.blockers.map(item => item.message).join(" ") };
      if (runtimePlan.requiresInterruption && !confirmInterruption && !saved?.confirmInterruption) {
        const restoration = status.confirmation?.targetCommit === targetCommit && status.confirmation.restoreSnapshotRunId ? status.confirmation : undefined;
        const confirmation = restoration ? { ...restoration, requiresInterruption: true } : {
          targetCommit, message: "This update must interrupt terminal processes. Saved tabs, layouts and exact saved conversations will be preserved for explicit recovery. Commands and prompts will not be replayed. " + (runtimePlan.recovery?.warnings ?? []).join(" "),
        };
        this.write(path.join(this.stateDir, "confirmation.json"), { ...confirmation, repoRoot: this.repoRoot });
        return { ...status, confirmation };
      }
    }
    const record = saved ?? {
      home: this.home, cli: this.cli, service: this.serviceName, port: this.port, host: this.host,
      confirmInterruption, restoreSnapshotRunId, envPath: this.paths.envPath,
      repoRoot: this.repoRoot,
      dataDir: this.dataDir,
      serverPid: this.serverPid,
      targetCommit,
      run: {
        id: randomUUID(),
        targetCommit,
        state: "running",
        message:
          "Updating CloudX. This page will reconnect after the services restart.",
        startedAt: this.now().toISOString(),
      },
    };
    if (resumeRunId) {
      if (record.targetCommit !== targetCommit || record.run.state !== "failed" || !record.run.resumable) throw new Error("The selected update cannot be resumed.");
      record.run.state = "running";
      record.run.resumable = false;
      record.run.startedAt = this.now().toISOString();
      record.run.message = "Resuming the saved CloudX update and its verified recovery plan.";
      delete record.run.finishedAt;
      delete record.run.cause;
      delete record.run.component;
      delete record.run.recoveryAction;
      record.serverPid = this.serverPid;
      record.confirmInterruption ||= confirmInterruption;
      if (restoreSnapshotRunId) record.restoreSnapshotRunId = restoreSnapshotRunId;
    }
    this.stage(record);
    const environmentFile = this.launchEnvironment(record);
    fs.rmSync(path.join(this.stateDir, "confirmation.json"), { force: true });
    this.save(record);
    this.write(path.join(this.stateDir, "attempt.json"), {
      id: record.run.id,
      previousRunId,
    });
    try {
      this.commands.inspect("systemd-run", [
        "--user",
        "--quiet",
        "--collect",
        `--unit=${UPDATE_UNIT}`,
        "--property=Type=exec",
        `--description=${DESCRIPTION}${record.run.id}`,
        `--property=WorkingDirectory=${record.coordinator.replaceAll("%", "%%")}`,
        `--property=EnvironmentFile=${environmentFile.replaceAll("%", "%%")}`,
        "--property=UMask=0077",
        "--property=StandardInput=null",
        "--property=StandardOutput=null",
        "--property=StandardError=null",
        `--property=RuntimeMaxSec=${UPDATE_TIMEOUT_MS / 1000}`,
        "--property=TimeoutStopSec=15s",
        "--property=KillMode=control-group",
        "--",
        systemdArgument(process.execPath),
        systemdArgument(
          path.join(record.coordinator, "scripts/settings-update.mjs"),
        ),
        "run",
        record.run.id,
      ]);
    } catch {
      const saved = this.read(record.run.id);
      if (saved.run.state !== "running")
        return { available: true, run: saved.run };
      let active;
      try {
        active = this.unit();
      } catch {
        return { available: true, run: saved.run };
      }
      if (active.running && active.id === record.run.id)
        return { available: true, run: saved.run };
      record.run.resumable = true;
      this.finish(
        record,
        "failed",
        "The update service could not start. Check the user systemd service in a terminal.",
      );
      if (active.running && active.id && active.id !== record.run.id)
        return { available: true, run: this.read(active.id).run };
    }
    return { available: true, run: this.read(record.run.id).run };
  }

  stage(record) {
    if (record.coordinator) {
      verifySnapshot(record.coordinator, JSON.parse(fs.readFileSync(path.join(record.coordinator, "bundle.json"), "utf8")));
      return;
    }
    if (this.stageCoordinator) { record.coordinator = this.stageCoordinator(record); return; }
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const files = ["settings-update.mjs", "managed-update.mjs", "managed-update-store.mjs", "managed-update-data.mjs", "managed-update-terminals.mjs", "managed-runtime-launch.mjs", "write-runtime-build.mjs", "install-cloudx.mjs", "install-update.mjs", "install-runtime.mjs", "install-terminal-upgrade.mjs", "terminal-upgrade-recovery.mjs", "installer-environment.mjs"];
    record.coordinator = bundleCoordinator(source, path.join(this.stateDir, record.run.id, "coordinator"), files.map(file => `scripts/${file}`));
  }

  run(id) {
    const record = this.read(id);
    updateCommit(record.targetCommit);
    const unit = this.unit();
    if (record.run.state !== "running" || unit.id !== id || !unit.running ||
      !processBelongsToService(this.readCgroup(process.pid), unit.ControlGroup))
      throw new Error("Update worker must run in its managed service.");
    this.dataDir = record.dataDir;
    this.serverPid = record.serverPid;
    this.publish(record);
    // Resume must work after the web process dies. Ownership is revalidated by
    // the coordinator independently of the initiating server PID.
    const log = fs.openSync(path.join(this.stateDir, `${id}.log`), "a", 0o600);
    try {
      this.commands.inspect(process.execPath, [path.join(record.coordinator, "scripts/managed-update.mjs"), this.recordPath(id)], {
        cwd: record.coordinator, env: { ...process.env }, stdio: ["ignore", log, log],
        timeout: UPDATE_TIMEOUT_MS - 30000, killSignal: "SIGKILL",
      });
    } catch {
      // The durable child record owns phase outcomes, including restored failures.
    } finally { fs.closeSync(log); }
    const completed = this.read(id);
    if (completed.run.state === "running") {
      completed.run.resumable = true;
      this.finish(completed, "failed", "The update coordinator was interrupted. Resume this update to restore or continue from verified recovery data.");
    }
    this.publish(completed);
    return completed.run;
  }

}

function main() {
  const [action, dataDir, serverPid, targetCommit, ...flags] = process.argv.slice(2);
  if (action === "run" && RUN_ID.test(dataDir ?? "") && serverPid === undefined) {
    const initial = new SettingsUpdater();
    const record = initial.readRecord(dataDir);
    const updater = new SettingsUpdater({ repoRoot: record.repoRoot, home: record.home, dataDir: record.dataDir, serverPid: record.serverPid,
      cli: record.cli, service: record.service, port: record.port, host: record.host });
    if (record.envPath) updater.paths.envPath = record.envPath;
    const run = updater.run(dataDir);
    if (run.state !== "succeeded") process.exitCode = 1;
    return;
  }
  if (!["status", "start"].includes(action) || !dataDir || !/^\d+$/.test(serverPid ?? "") ||
      action === "status" && (targetCommit !== undefined || flags.length) || action === "start" && !targetCommit ||
      flags.some(flag => flag !== "--confirm-interruption" && !/^--(?:resume|restore-snapshot)=[0-9a-f-]{36}$/.test(flag))) throw new Error("Invalid updater invocation.");
  const updater = new SettingsUpdater({ dataDir, serverPid });
  const options = { confirmInterruption: flags.includes("--confirm-interruption"), resumeRunId: flags.find(flag => flag.startsWith("--resume="))?.slice(9), restoreSnapshotRunId: flags.find(flag => flag.startsWith("--restore-snapshot="))?.slice(19) };
  if (options.resumeRunId && !RUN_ID.test(options.resumeRunId)) throw new Error("Invalid resume identifier.");
  console.log(JSON.stringify(action === "status" ? updater.status() : updater.start(targetCommit, options)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    console.log(
      JSON.stringify({
        available: false,
        unavailableReason:
          "The installed updater could not verify its status. Run the installer manually in a terminal.",
      }),
    );
    process.exitCode = process.argv[2] === "run" ? 1 : 0;
  }
}

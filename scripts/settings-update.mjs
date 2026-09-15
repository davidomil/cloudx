#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectUpdateCheckout,
  inspectUpdateTarget,
  SERVICE_NAMES,
} from "./install-update.mjs";
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
    commands = { inspect },
    readCgroup = (pid) => fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"),
    now = () => new Date(),
  } = {}) {
    this.repoRoot = fs.realpathSync(repoRoot);
    this.dataDir = dataDir;
    this.serverPid = Number(serverPid);
    this.commands = commands;
    this.readCgroup = readCgroup;
    this.now = now;
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
      if (
        !SERVICE_NAMES.every((name) =>
          fs.existsSync(path.join(this.paths.systemdDir, name)),
        )
      )
        throw new Error();
      inspectUpdateTarget({ paths: this.paths, commands: this.commands });
      const saved = parseEnvironmentFile(
        fs.readFileSync(this.paths.envPath, "utf8"),
      );
      const savedDataDir =
        saved.CLOUDX_DATA_DIR ?? path.join(this.repoRoot, ".cloudx");
      if (
        !path.isAbsolute(savedDataDir) ||
        fs.realpathSync(savedDataDir) !== fs.realpathSync(this.dataDir)
      )
        throw new Error();
      const service = this.service(
        "cloudx.service",
        "ActiveState,MainPID,ControlGroup",
      );
      if (
        service.ActiveState !== "active" ||
        !Number.isSafeInteger(Number(service.MainPID)) ||
        Number(service.MainPID) <= 0 ||
        !processBelongsToService(
          this.readCgroup(this.serverPid),
          service.ControlGroup,
        )
      )
        throw new Error();
    } catch {
      return UNSUPPORTED;
    }
    try {
      this.commands.inspect("sudo", ["-n", "true"]);
    } catch {
      return "Settings updates require non-interactive sudo for installer prerequisites. Run the installer manually in a terminal.";
    }
    return undefined;
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

  read(id) {
    const record = JSON.parse(fs.readFileSync(this.recordPath(id), "utf8"));
    const run = record.run;
    if (
      record.repoRoot !== this.repoRoot ||
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

  write(file, value) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, file);
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
    const record = this.read(id);
    if (
      record.run.state === "running" &&
      !(unit.running && unit.id === id) &&
      this.now().getTime() - Date.parse(record.run.startedAt) > 20000
    ) {
      this.finish(
        record,
        "failed",
        "The update was interrupted before completion. Check the installer in a terminal before starting another update.",
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
    const unavailableReason = this.preflight();
    let unit;
    try {
      unit = this.unit();
    } catch {
      if (unavailableReason) return { available: false, unavailableReason };
      throw new Error("Could not inspect the update service.");
    }
    const run = this.current(unit)?.run;
    return {
      available: !unavailableReason,
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(run ? { run } : {}),
    };
  }

  start() {
    const previousRunId = this.pointer("latest")?.id;
    const status = this.status();
    if (!status.available || status.run?.state === "running") return status;
    const unit = this.unit();
    if (unit.running)
      return {
        available: false,
        unavailableReason:
          "Another CloudX update service is already running. Wait for it to finish.",
      };
    try {
      inspectUpdateCheckout(this.commands, this.repoRoot);
    } catch {
      return {
        ...status,
        available: false,
        unavailableReason:
          "The checkout must be clean before updating. Commit or move local changes and run the installer from a terminal if Git needs attention.",
      };
    }
    const record = {
      repoRoot: this.repoRoot,
      dataDir: this.dataDir,
      serverPid: this.serverPid,
      run: {
        id: randomUUID(),
        state: "running",
        message:
          "Updating CloudX. This page will reconnect after the services restart.",
        startedAt: this.now().toISOString(),
      },
    };
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
        `--property=WorkingDirectory=${this.repoRoot.replaceAll("%", "%%")}`,
        `--property=EnvironmentFile=${this.paths.envPath.replaceAll("%", "%%")}`,
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
          path.join(this.repoRoot, "scripts/settings-update.mjs"),
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

  run(id) {
    const record = this.read(id);
    const unit = this.unit();
    if (
      record.run.state !== "running" ||
      unit.id !== id ||
      !unit.running ||
      !processBelongsToService(this.readCgroup(process.pid), unit.ControlGroup)
    )
      throw new Error("Update worker must run in its managed service.");
    this.dataDir = record.dataDir;
    this.serverPid = record.serverPid;
    this.publish(record);
    const unavailableReason = this.preflight();
    if (unavailableReason)
      return this.finish(record, "failed", unavailableReason).run;
    const answersPath = path.join(this.stateDir, `${id}.answers.json`);
    this.write(answersPath, { runCodexLogin: false, restartServices: true });
    const log = fs.openSync(path.join(this.stateDir, `${id}.log`), "ax", 0o600);
    try {
      const env = { ...process.env };
      delete env.CLOUDX_INSTALL_BOOTSTRAPPED;
      delete env.CLOUDX_INSTALL_UPDATED_COMMIT;
      this.commands.inspect(
        process.execPath,
        [
          path.join(this.repoRoot, "scripts/install-cloudx.mjs"),
          "--update",
          "--yes",
          "--non-interactive",
          "--answers",
          answersPath,
        ],
        {
          cwd: this.repoRoot,
          env,
          stdio: ["ignore", log, log],
          timeout: UPDATE_TIMEOUT_MS - 30000,
          killSignal: "SIGKILL",
        },
      );
      this.finish(
        record,
        "succeeded",
        "CloudX was updated and its services passed readiness checks.",
      );
    } catch {
      this.finish(
        record,
        "failed",
        "The installer failed. Review the private update log in ~/.local/state/cloudx/settings-update before starting another update.",
      );
    } finally {
      fs.closeSync(log);
      fs.rmSync(answersPath);
    }
    this.publish(record);
    return record.run;
  }
}

function main() {
  const [action, dataDir, serverPid, ...extra] = process.argv.slice(2);
  if (
    action === "run" &&
    RUN_ID.test(dataDir ?? "") &&
    serverPid === undefined
  ) {
    const run = new SettingsUpdater().run(dataDir);
    if (run.state !== "succeeded") process.exitCode = 1;
    return;
  }
  if (
    !["status", "start"].includes(action) ||
    !dataDir ||
    !/^\d+$/.test(serverPid ?? "") ||
    extra.length
  )
    throw new Error("Invalid updater invocation.");
  const updater = new SettingsUpdater({ dataDir, serverPid });
  console.log(JSON.stringify(updater[action]()));
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

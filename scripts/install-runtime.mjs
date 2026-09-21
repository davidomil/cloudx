import fs from "node:fs";
import path from "node:path";
import { assertTerminalMigrationSafe, snapshotTerminalRecovery } from "./terminal-upgrade-recovery.mjs";

const properties = "LoadState,ActiveState,MainPID,InvocationID,ControlGroup,KillMode,SendSIGKILL,WorkingDirectory";

export function inspectTerminalService(commands, service) {
  return Object.fromEntries(commands.inspect("systemctl", [
    "--user", "show", service, `--property=${properties}`,
  ]).split(/\r?\n/).filter(line => line.includes("=")).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

export function assertPinnedTerminalRuntime({ dataDir, role, service, state, readFile = fs.readFileSync }) {
  if (state.LoadState === "not-found") return;
  if (["inactive", "failed"].includes(state.ActiveState) && state.MainPID === "0") {
    assertEmptyControlGroup(service, state.ControlGroup, readFile);
    return;
  }
  try {
    if (state.ActiveState !== "active" || !/^\d+$/.test(state.MainPID) || Number(state.MainPID) <= 0 || !state.ControlGroup) {
      throw new Error("Service is not in a stable running state.");
    }
    const receipt = JSON.parse(readFile(path.join(dataDir, "terminal-runtime", `${role}.json`), "utf8"));
    if (receipt.version !== 1 || receipt.role !== role || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0
      || receipt.brokerProtocol !== 1 || receipt.supervisor?.pinned !== true
      || receipt.supervisor.contract !== "execution-json-v1" || !/^[a-f0-9]{64}$/.test(receipt.supervisor.sourceSha256)) {
      throw new Error("Running terminal runtime has no compatible pinned helper receipt.");
    }
    const stat = readFile(`/proc/${receipt.pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = readFile("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const groups = readFile(`/proc/${receipt.pid}/cgroup`, "utf8").trim().split("\n").map(line => line.split(":")[2]);
    if (receipt.started !== started || receipt.bootId !== boot || !groups.includes(state.ControlGroup)
      || !/^[a-f0-9]{32}$/.test(state.InvocationID) || receipt.invocationId !== state.InvocationID
      || role === "broker" && receipt.pid !== Number(state.MainPID)) {
      throw new Error("Runtime receipt does not identify the process in the current service invocation.");
    }
  } catch (error) {
    throw new Error(`${service} cannot safely survive an in-place update: ${error.message} ` +
      "The update cannot proceed. For standard services, run --update --migrate-terminals explicitly to back up recovery state and interrupt terminals. " +
      "For custom services, follow docs/TERMINAL_UPGRADES.md and stop the affected services before updating.", { cause: error });
  }
}

export function prepareRuntimeUpdate({ paths, commands, target, migrateTerminals = false, dryRun = false, log = console.warn, readFile = fs.readFileSync }) {
  const webService = target.kind === "web" ? target.serviceNames[0] : "cloudx.service";
  const web = inspectTerminalService(commands, webService);
  const broker = inspectTerminalService(commands, "cloudx-terminal.service");
  const ownBroker = broker.LoadState === "not-found" || broker.WorkingDirectory === paths.repoRoot;
  if (!ownBroker && target.kind === "standard") throw new Error("The terminal broker belongs to another checkout.");
  if (!migrateTerminals) {
    assertPinnedTerminalRuntime({ dataDir: paths.dataDir, role: "web", service: webService, state: web });
    if (ownBroker) assertPinnedTerminalRuntime({ dataDir: paths.dataDir, role: "broker", service: "cloudx-terminal.service", state: broker });
    return;
  }
  if (target.kind !== "standard") throw new Error("--migrate-terminals requires the standard CloudX services.");
  for (const state of [web, broker]) {
    if (state.LoadState !== "not-found" && (state.KillMode !== "control-group" || state.SendSIGKILL !== "yes")) {
      throw new Error("Terminal migration requires KillMode=control-group and SendSIGKILL=yes for both CloudX services.");
    }
    if (state.LoadState !== "not-found" && !["inactive", "failed"].includes(state.ActiveState)
      && (!state.ControlGroup?.startsWith("/") || state.ControlGroup === "/" || state.ControlGroup.split("/").includes(".."))) {
      throw new Error("Terminal migration requires the original service control group to verify cleanup.");
    }
  }
  assertTerminalMigrationSafe({ dataDir: paths.dataDir });
  log("Terminal migration will interrupt all terminal processes. Tabs and layouts remain saved; shells and exact saved Codex conversations must be recovered explicitly. No commands or prompts will be replayed.");
  commands.run("systemctl", ["--user", "stop", webService]);
  if (!dryRun) {
    assertStoppedService(commands, webService, web.ControlGroup, readFile);
    snapshotTerminalRecovery({ dataDir: paths.dataDir, log });
  } else log("Dry run: would verify a private recovery snapshot after the web service stops and before stopping the broker.");
  commands.run("systemctl", ["--user", "stop", "cloudx-terminal.service"]);
  if (!dryRun) assertStoppedService(commands, "cloudx-terminal.service", broker.ControlGroup, readFile);
}

export function assertStoppedService(commands, service, previousControlGroup, readFile = fs.readFileSync) {
  const state = inspectTerminalService(commands, service);
  if (state.LoadState === "not-found") return;
  if (!["inactive", "failed"].includes(state.ActiveState) || state.MainPID !== "0") {
    throw new Error(`${service} did not stop; terminal migration stopped before changing the checkout.`);
  }
  for (const group of new Set([previousControlGroup, state.ControlGroup].filter(Boolean))) {
    assertEmptyControlGroup(service, group, readFile);
  }
}

function assertEmptyControlGroup(service, group, readFile) {
  if (!group) return;
  if (!group.startsWith("/") || group === "/" || group.split("/").includes("..")) throw new Error("Invalid service control group.");
  try {
    const events = readFile(path.join("/sys/fs/cgroup", group, "cgroup.events"), "utf8");
    if (!/^populated 0$/m.test(events)) throw new Error(`${service} still owns processes; recovery state was left unchanged.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (fs.existsSync(path.join("/sys/fs/cgroup", group))) {
      throw new Error(`${service} cleanup requires unified cgroup.events evidence; its control group still exists.`);
    }
  }
}

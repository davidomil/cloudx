import fs from "node:fs";
import path from "node:path";
import { inspectTerminalRecovery, snapshotTerminalRecovery } from "./terminal-upgrade-recovery.mjs";

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
    if (role === "broker" && receipt.attachmentExitBeforeReady !== true) {
      throw new Error("The running broker lacks ordered attachment exit reporting. A confirmed terminal interruption is needed to distinguish exited shells from live sessions safely.");
    }
  } catch (error) {
    throw new Error(`${service} cannot safely survive an in-place update: ${error.message} ` +
      "The managed update requires confirmation to preserve recovery state and interrupt terminals.", { cause: error });
  }
}

export function inspectRuntimeUpdate({ paths, commands, target, targetRuntime, readFile = fs.readFileSync }) {
  const webService = target.kind === "web" ? target.serviceNames[0] : "cloudx.service";
  const web = inspectTerminalService(commands, webService);
  const broker = inspectTerminalService(commands, "cloudx-terminal.service");
  const ownBroker = broker.LoadState === "not-found" || broker.WorkingDirectory === paths.repoRoot;
  const services = [{ service: webService, role: "web", state: web }];
  if (ownBroker) services.push({ service: "cloudx-terminal.service", role: "broker", state: broker });
  const plan = { requiresInterruption: false, reasons: [], blockers: [], services, stopServices: [], recovery: undefined };
  if (web.LoadState !== "not-found" && web.WorkingDirectory !== paths.repoRoot)
    plan.blockers.push({ service: webService, message: "The web service belongs to another checkout." });
  if (!ownBroker && target.kind === "standard")
    plan.blockers.push({ service: "cloudx-terminal.service", message: "The terminal broker belongs to another checkout." });
  for (const { service, role, state } of services) {
    try {
      assertPinnedTerminalRuntime({ dataDir: paths.dataDir, role, service, state, readFile });
      if (serviceIsRunning(state) && !supportsPinnedRuntime(targetRuntime))
        throw new Error("The selected target has no compatible persistent terminal runtime contract.");
    } catch (error) {
      plan.reasons.push({ service, role, message: error.message });
    }
  }
  plan.requiresInterruption = plan.reasons.length > 0;
  if (plan.requiresInterruption) {
    plan.stopServices = services.filter(entry => entry.state.LoadState !== "not-found" &&
      (entry.role === "web" || plan.reasons.some(reason => reason.service === entry.service))).map(entry => entry.service);
    for (const entry of services.filter(entry => plan.stopServices.includes(entry.service))) {
      try { assertMigrationService(entry); }
      catch (error) { plan.blockers.push({ service: entry.service, message: error.message }); }
    }
    if (!plan.blockers.length) {
      try { plan.recovery = inspectTerminalRecovery({ dataDir: paths.dataDir, allowLegacyState: true }); }
      catch (error) { plan.blockers.push({ service: "recovery", message: error.message }); }
    }
  }
  return plan;
}

export function prepareRuntimeUpdate(options) {
  const { paths, commands, migrateTerminals = false, interruptionConfirmed = false, dryRun = false,
    log = console.warn, readFile = fs.readFileSync } = options;
  const plan = inspectRuntimeUpdate(options);
  if (plan.blockers.length) {
    throw Object.assign(new Error(plan.blockers.map(blocker => blocker.message).join("\n")), { code: "CLOUDX_TERMINAL_MIGRATION_BLOCKED", plan });
  }
  if (!plan.requiresInterruption) return { plan };
  if (!interruptionConfirmed && !migrateTerminals) {
    throw Object.assign(new Error(plan.reasons.map(reason => reason.message).join("\n") +
      " Confirm terminal interruption in the update flow to continue."), { code: "CLOUDX_TERMINAL_CONFIRMATION_REQUIRED", plan });
  }
  assertUpdaterOutsideServices(plan.services.filter(entry => plan.stopServices.includes(entry.service)).map(({ service, state }) => [service, state]), readFile);
  log("Terminal migration will interrupt terminal processes. Saved tabs and layouts remain recoverable; shells and exact saved Codex conversations must be recovered explicitly. No commands or prompts will be replayed.");
  for (const warning of plan.recovery?.warnings ?? []) log(warning);
  if (dryRun) {
    log("Dry run: would stop the selected web service, verify a private recovery snapshot, and stop its terminal broker.");
    return { plan };
  }
  const web = plan.services.find(entry => entry.role === "web");
  stopRuntimeService(commands, web, readFile);
  const recoverySnapshot = snapshotTerminalRecovery({ dataDir: paths.dataDir, log, allowLegacyState: true });
  const broker = plan.services.find(entry => entry.role === "broker");
  if (broker && plan.stopServices.includes(broker.service)) stopRuntimeService(commands, broker, readFile);
  return { plan, recoverySnapshot };
}

function supportsPinnedRuntime(runtime) {
  return runtime?.brokerProtocol === 1 && runtime.supervisorContract === "execution-json-v1" && runtime.persistentSessions === true;
}

function serviceIsRunning(state) {
  return state.LoadState !== "not-found" && !(["inactive", "failed"].includes(state.ActiveState) && state.MainPID === "0");
}

function assertMigrationService({ service, state }) {
  if (state.LoadState === "not-found") return;
  if (state.LoadState !== "loaded" || !["active", "inactive", "failed"].includes(state.ActiveState))
    throw new Error(`${service} is not stable; wait for its current service operation to finish before resuming the update.`);
  if (!serviceIsRunning(state)) return;
  if (!["control-group", "mixed"].includes(state.KillMode) || state.SendSIGKILL !== "yes")
    throw new Error(`${service}: terminal migration requires KillMode=control-group or mixed and SendSIGKILL=yes. Update this service's termination policy before resuming.`);
  if (!state.ControlGroup?.startsWith("/") || state.ControlGroup === "/" || state.ControlGroup.split("/").includes(".."))
    throw new Error("Terminal migration requires the original service control group to verify cleanup.");
}

function stopRuntimeService(commands, { service, state }, readFile) {
  if (state.LoadState === "not-found") return;
  commands.run("systemctl", ["--user", "stop", service]);
  assertStoppedService(commands, service, state.ControlGroup, readFile);
}

export function assertUpdaterOutsideServices(services, readFile = fs.readFileSync) {
  let callerGroup;
  try {
    const groups = readFile("/proc/self/cgroup", "utf8").trim().split("\n").filter(line => line.startsWith("0::"));
    callerGroup = groups[0]?.slice(3);
    if (groups.length !== 1 || !callerGroup.startsWith("/") || callerGroup.split("/").includes("..")) {
      throw new Error("Expected one absolute unified cgroup path in /proc/self/cgroup.");
    }
  } catch (error) {
    throw new Error(`Cannot verify the updater's control group; no services were stopped. ${error.message}`, { cause: error });
  }
  for (const [service, state] of services) {
    const group = state.ControlGroup;
    if (state.LoadState !== "not-found" && group && (callerGroup === group || callerGroup.startsWith(`${group}/`))) {
      throw new Error(`Terminal migration cannot run inside ${service}'s control group. Run the updater from an external terminal outside CloudX; no services were stopped.`);
    }
  }
}

export function assertStoppedService(commands, service, previousControlGroup, readFile = fs.readFileSync) {
  const state = inspectTerminalService(commands, service);
  if (state.LoadState === "not-found") {
    assertEmptyControlGroup(service, previousControlGroup, readFile);
    return;
  }
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

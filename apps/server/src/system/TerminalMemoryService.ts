import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseTerminalMemoryLimits, type TerminalMemoryLimits, type TerminalMemoryStatus } from "@cloudx/shared";
import { assertTerminalMemoryDestination, assertTerminalMemoryDropIns, assertTerminalMemoryPersistence, assertTerminalMemoryUnit, parseSystemdPaths } from "../../../../scripts/terminal-memory-policy.mjs";

const executeFile = promisify(execFile);
const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const properties = "LoadState,ActiveState,WorkingDirectory,FragmentPath,DropInPaths,MemoryHigh,MemoryMax,ControlGroup,MainPID,InvocationID";
const unlimited = "18446744073709551615";

type SystemctlCommand = (file: string, args: string[], options: {
  encoding: "utf8"; timeout: number; maxBuffer: number; killSignal: "SIGKILL";
}) => Promise<{ stdout: string }>;

interface TerminalMemoryOptions {
  repoRoot?: string;
  home?: string;
  configHome?: string;
  runtimeDir?: string;
  unitName?: string;
  cgroupRoot?: string;
  platform?: NodeJS.Platform;
  execute?: SystemctlCommand;
}

export class TerminalMemoryError extends Error {
  constructor(message: string, readonly statusCode = 503) { super(message); }
}

/** Systemd owns the persisted policy. CloudX only validates, applies and observes it. */
export class TerminalMemoryService {
  private readonly repoRoot: string;
  private readonly home: string;
  private readonly configHome: string;
  private readonly runtimeDir: string | undefined;
  private readonly unitName: string;
  private readonly cgroupRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly execute: SystemctlCommand;
  private changing = false;

  constructor(options: TerminalMemoryOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.env.CLOUDX_INSTALL_ROOT ?? defaultRepoRoot;
    this.home = options.home ?? os.homedir();
    this.configHome = options.configHome ?? process.env.XDG_CONFIG_HOME ?? path.join(this.home, ".config");
    this.runtimeDir = options.runtimeDir ?? process.env.XDG_RUNTIME_DIR;
    this.unitName = options.unitName ?? "cloudx-terminal.service";
    this.cgroupRoot = path.resolve(options.cgroupRoot ?? "/sys/fs/cgroup");
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? executeFile;
  }

  async status(): Promise<TerminalMemoryStatus> {
    if (this.platform !== "linux") return this.unavailable("Terminal memory controls require a Linux systemd user service and cgroup v2.");
    let state: Record<string, string>;
    try { state = await this.show(); }
    catch (error) { return this.unavailable(`Cannot inspect the terminal service. Check systemctl and access to your systemd user manager. ${errorText(error)}`); }
    let paths: string[];
    let pathError: Error | undefined;
    try { paths = parseSystemdPaths(state.DropInPaths ?? ""); }
    catch (error) { paths = []; pathError = error as Error; }
    const status = this.describe(state, paths);
    if (pathError) return { ...status, manageable: false, reason: pathError.message };
    try { status.dropInPaths = this.assertManageable(state); }
    catch (error) { status.manageable = false; status.reason = (error as Error).message; }
    return status;
  }

  async apply(value: unknown): Promise<TerminalMemoryStatus> {
    let limits: TerminalMemoryLimits;
    try { limits = parseTerminalMemoryLimits(value); }
    catch (error) { throw new TerminalMemoryError((error as Error).message, 400); }
    if (this.changing) throw new TerminalMemoryError("A terminal memory change is in progress. Refresh when it finishes.", 409);
    this.changing = true;
    try {
      if (this.platform !== "linux") throw new TerminalMemoryError("Terminal memory controls require a Linux systemd user service.", 409);
      const before = await this.show();
      this.assertManageable(before);
      this.assertPersistenceOrder(before, limits);
      await this.command(["set-property", this.unitName, `MemoryHigh=${limits.memoryHigh}`, `MemoryMax=${limits.memoryMax}`]);
      const after = await this.show();
      const dropInPaths = this.assertManageable(after);
      if (limitValue(after.MemoryHigh) !== limits.memoryHigh || limitValue(after.MemoryMax) !== limits.memoryMax)
        throw new Error("Systemd did not read back the requested MemoryHigh and MemoryMax values.");
      this.assertPersisted(limits);
      this.assertPersistenceOrder(after, limits);
      if (before.MainPID !== after.MainPID || before.InvocationID !== after.InvocationID)
        throw new Error("The terminal service changed process identity while the limits were applied.");
      const status = this.describe(after, dropInPaths);
      if (after.ActiveState === "active" && (status.effective.memoryHigh === null || status.effective.memoryMax === null))
        throw new Error("The effective cgroup memory limits could not be read. Check read access to the service cgroup and its ancestors.");
      return status;
    } catch (error) {
      if (error instanceof TerminalMemoryError) throw error;
      throw new TerminalMemoryError(`Could not apply and verify persistent terminal memory limits. ${errorText(error)} ` +
        "Check access to the systemd user manager and its user.control directory, then refresh to inspect the current values. Some values may already have changed.");
    } finally { this.changing = false; }
  }

  private async command(args: string[]): Promise<string> {
    const result = await this.execute("systemctl", ["--user", "--no-pager", ...args], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, killSignal: "SIGKILL"
    });
    return result.stdout;
  }

  private async show(): Promise<Record<string, string>> {
    return Object.fromEntries((await this.command(["show", this.unitName, `--property=${properties}`]))
      .trim().split("\n").filter(line => line.includes("=")).map(line => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
  }

  private assertManageable(state: Record<string, string>): string[] {
    if (state.LoadState !== "loaded") throw new TerminalMemoryError("The persistent terminal service is not installed or loaded. Install the CloudX terminal user service first.", 409);
    if (state.WorkingDirectory !== this.repoRoot)
      throw new TerminalMemoryError("The terminal service belongs to another installation. Open Settings in the installation that owns this service.", 409);
    if (!["active", "inactive", "failed"].includes(state.ActiveState ?? ""))
      throw new TerminalMemoryError("Wait for the terminal service to finish its current start or stop operation.", 409);
    if (limitValue(state.MemoryHigh) === null || limitValue(state.MemoryMax) === null)
      throw new TerminalMemoryError("This systemd manager does not expose terminal MemoryHigh and MemoryMax controls.", 409);
    const systemdDir = path.join(this.configHome, "systemd", "user");
    if (state.FragmentPath !== path.join(systemdDir, this.unitName))
      throw new TerminalMemoryError("The terminal service must use the owned CloudX user unit. Inspect its FragmentPath before changing memory limits.", 409);
    assertTerminalMemoryUnit(state.FragmentPath, { systemdDir });
    const dropInPaths = assertTerminalMemoryDropIns(state.DropInPaths ?? "", {
      systemdDir, home: this.home, configHome: this.configHome, runtimeDir: this.runtimeDir, unitName: this.unitName
    });
    assertTerminalMemoryDestination({ systemdDir, home: this.home, configHome: this.configHome,
      runtimeDir: this.runtimeDir, unitName: this.unitName });
    if (!fs.existsSync(path.join(this.cgroupRoot, "cgroup.controllers")))
      throw new TerminalMemoryError("Terminal memory controls require cgroup v2. Enable the unified cgroup hierarchy before applying limits.", 409);
    if (state.ActiveState === "active") {
      const group = this.groupPath(state.ControlGroup);
      if (!group || !fs.existsSync(path.join(group, "memory.high")) || !fs.existsSync(path.join(group, "memory.max")))
        throw new TerminalMemoryError("The terminal service has no accessible cgroup v2 memory controller. Enable memory delegation for the systemd user manager.", 409);
    }
    return dropInPaths;
  }

  private assertPersisted(limits: TerminalMemoryLimits): void {
    const directory = path.join(this.configHome, "systemd", "user.control", `${this.unitName}.d`);
    for (const [property, expected] of [["MemoryHigh", limits.memoryHigh], ["MemoryMax", limits.memoryMax]] as const) {
      const file = path.join(directory, `50-${property}.conf`);
      assertTerminalMemoryDropIns([file], { systemdDir: path.join(this.configHome, "systemd", "user"), home: this.home,
        configHome: this.configHome, runtimeDir: this.runtimeDir, unitName: this.unitName });
      const assignments = fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim().startsWith(`${property}=`));
      if (assignments.length !== 1 || limitValue(assignments[0]!.trim().slice(property.length + 1)) !== expected)
        throw new Error(`The persistent ${property} drop-in does not contain the requested value. Inspect ${file}.`);
    }
  }

  private assertPersistenceOrder(state: Record<string, string>, limits: TerminalMemoryLimits): void {
    assertTerminalMemoryPersistence(state.DropInPaths ?? "", limits, {
      systemdDir: path.join(this.configHome, "systemd", "user"), home: this.home,
      configHome: this.configHome, runtimeDir: this.runtimeDir, unitName: this.unitName
    });
  }

  private describe(state: Record<string, string>, dropInPaths = parseSystemdPaths(state.DropInPaths ?? "")): TerminalMemoryStatus {
    const group = this.groupPath(state.ControlGroup);
    return {
      service: this.unitName, manageable: true,
      limits: { memoryHigh: limitValue(state.MemoryHigh), memoryMax: limitValue(state.MemoryMax) },
      effective: { memoryHigh: group ? this.effectiveLimit(group, "memory.high") : null,
        memoryMax: group ? this.effectiveLimit(group, "memory.max") : null },
      usageBytes: group ? counter(readOptional(path.join(group, "memory.current"))) : null,
      pressure: group ? pressure(readOptional(path.join(group, "memory.pressure"))) : null,
      events: group ? memoryEvents(readOptional(path.join(group, "memory.events"))) : null,
      fragmentPath: state.FragmentPath || null, dropInPaths,
      controlGroup: state.ControlGroup || null, activeState: state.ActiveState || null
    };
  }

  private groupPath(controlGroup: string | undefined): string | null {
    if (!controlGroup || !controlGroup.startsWith("/") || controlGroup === "/"
      || controlGroup.split("/").some(part => part === "." || part === "..")) return null;
    return path.join(this.cgroupRoot, controlGroup);
  }

  private effectiveLimit(group: string, property: string): string | null {
    let bytes = BigInt(os.totalmem());
    for (let current = group; ; current = path.dirname(current)) {
      const file = path.join(current, property);
      if (current === this.cgroupRoot && !fs.existsSync(file)) break;
      const limit = limitValue(readOptional(file)?.trim());
      if (limit === null) return null;
      if (limit !== "infinity" && BigInt(limit) < bytes) bytes = BigInt(limit);
      if (current === this.cgroupRoot) break;
    }
    return String(bytes);
  }

  private unavailable(reason: string): TerminalMemoryStatus {
    return { service: this.unitName, manageable: false, reason, limits: { memoryHigh: null, memoryMax: null },
      effective: { memoryHigh: null, memoryMax: null }, usageBytes: null, pressure: null, events: null,
      fragmentPath: null, dropInPaths: [], controlGroup: null, activeState: null };
  }
}

function limitValue(value: string | undefined): string | null {
  if (value === "infinity" || value === "max" || value === unlimited) return "infinity";
  return value && /^\d+$/.test(value) && BigInt(value) < BigInt(unlimited) ? BigInt(value).toString() : null;
}

function readOptional(file: string): string | undefined {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return undefined; }
}

function counter(value: string | undefined): number | null {
  const number = value?.trim() && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function pressure(text: string | undefined): TerminalMemoryStatus["pressure"] {
  const values = ["some", "full"].map(kind => {
    const match = text?.match(new RegExp(`^${kind} avg10=(\\d+(?:\\.\\d+)?) `, "m"));
    return match ? Number(match[1]) : NaN;
  });
  return values.every(value => Number.isFinite(value) && value >= 0 && value <= 100)
    ? { someAvg10: values[0]!, fullAvg10: values[1]! } : null;
}

function memoryEvents(text: string | undefined): TerminalMemoryStatus["events"] {
  const events = Object.fromEntries((text ?? "").trim().split("\n").map(line => line.split(" ")));
  const high = counter(events.high), oom = counter(events.oom), oomKill = counter(events.oom_kill);
  return high !== null && oom !== null && oomKill !== null ? { high, oom, oomKill } : null;
}

function errorText(error: unknown): string {
  const detail = error as { stderr?: string; message?: string };
  return (detail.stderr?.trim() || detail.message || "Systemd inspection failed.").slice(0, 2000);
}

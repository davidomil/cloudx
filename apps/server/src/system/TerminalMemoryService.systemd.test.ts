import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

import { DurableTerminalProcessFactory, terminalSocketPath } from "../terminal/DurableTerminalProcess.js";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { TerminalMemoryService } from "./TerminalMemoryService.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const supportedHost = process.platform === "linux"
  && fs.existsSync("/sys/fs/cgroup/cgroup.controllers")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5000 }).status === 0;

it.skipIf(!supportedHost)("raises terminal memory limits live with the same broker and shell, then preserves them through unit refresh and restart", async () => {
  const fixture = await TerminalMemoryFixture.create();
  try {
    const memory = new TerminalMemoryService({ repoRoot, unitName: fixture.unit });
    const initial = await memory.status();
    expect(initial.manageable, initial.reason).toBe(true);
    expect(initial.activeState).toBe("active");
    fixture.systemctl("set-property", fixture.unit, "--runtime", "MemoryHigh=256M", "MemoryMax=512M");
    expect((await memory.status()).dropInPaths.some(file => file.startsWith(process.env.XDG_RUNTIME_DIR!))).toBe(true);
    expect(fixture.cgroupLimits()).toEqual({ memoryHigh: String(256 * 1024 ** 2), memoryMax: String(512 * 1024 ** 2) });
    const original = fixture.identity();
    const shell = await fixture.terminals.spawn("/bin/bash", ["--noprofile", "--norc"], {
      cwd: fixture.directory, env: process.env, cols: 100, rows: 30, sessionId: "memory-policy-shell"
    });
    let output = "";
    shell.onData(data => { output += data; });
    const disconnected = vi.fn();
    shell.onDisconnect!(disconnected);
    shell.write("stty -echo; PS1=''; printf '\\nBEFORE_MEMORY_CHANGE=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(output).toMatch(/BEFORE_MEMORY_CHANGE=\d+/u));
    const shellPid = Number(/BEFORE_MEMORY_CHANGE=(\d+)/u.exec(output)![1]);
    const shellCgroup = fs.readFileSync(`/proc/${shellPid}/cgroup`, "utf8");
    expect(shellCgroup).toContain(`0::${original.ControlGroup}\n`);

    const chosen = { memoryHigh: String(512 * 1024 ** 2), memoryMax: String(768 * 1024 ** 2) };
    const applied = await memory.apply({ memoryHigh: "512 MiB", memoryMax: "768 MiB" });
    expect(applied).toMatchObject({ manageable: true, limits: chosen, effective: chosen });
    expect(applied.usageBytes).toBeGreaterThan(0);
    expect(applied.pressure).toEqual({ someAvg10: expect.any(Number), fullAvg10: expect.any(Number) });
    expect(applied.events).toEqual({ high: expect.any(Number), oom: expect.any(Number), oomKill: expect.any(Number) });
    expect(applied.dropInPaths.length).toBeGreaterThan(0);
    expect(applied.dropInPaths.some(file => file.startsWith(path.join(fixture.configHome, "systemd/user.control", `${fixture.unit}.d/`)))).toBe(true);
    expect(fixture.cgroupLimits()).toEqual(chosen);
    expect(fixture.identity()).toEqual(original);
    shell.write("printf '\\nAFTER_MEMORY_CHANGE=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(output).toContain(`AFTER_MEMORY_CHANGE=${shellPid}`));
    expect(disconnected).not.toHaveBeenCalled();

    await fixture.refreshUnit();
    expect((await new TerminalMemoryService({ repoRoot, unitName: fixture.unit }).status()).limits).toEqual(chosen);
    expect(fixture.cgroupLimits()).toEqual(chosen);
    expect(fixture.identity()).toEqual(original);
    shell.write("printf '\\nAFTER_UNIT_REFRESH=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(output).toContain(`AFTER_UNIT_REFRESH=${shellPid}`));
    expect(disconnected).not.toHaveBeenCalled();
    await shell.terminate();

    fixture.systemctl("restart", fixture.unit);
    const restarted = fixture.identity();
    expect(restarted.MainPID).not.toBe(original.MainPID);
    expect(restarted.InvocationID).not.toBe(original.InvocationID);
    expect((await new TerminalMemoryService({ repoRoot, unitName: fixture.unit }).status()).limits).toEqual(chosen);
    expect(fixture.cgroupLimits()).toEqual(chosen);
    const afterRestart = await fixture.terminals.spawn("/bin/bash", ["--noprofile", "--norc"], {
      cwd: fixture.directory, env: process.env, cols: 100, rows: 30, sessionId: "persisted-policy-shell"
    });
    let restartedOutput = "";
    afterRestart.onData(data => { restartedOutput += data; });
    afterRestart.write("printf '\\nPERSISTED_POLICY_SHELL_READY\\n'\n");
    await vi.waitFor(() => expect(restartedOutput).toContain("\r\nPERSISTED_POLICY_SHELL_READY\r\n"));
    await afterRestart.terminate();
  } catch (error) {
    const journal = spawnSync("journalctl", ["--user", "--no-pager", "-n", "60", "-u", fixture.unit], { encoding: "utf8", timeout: 5000 });
    throw new Error(`${error instanceof Error ? error.message : error}\nIsolated terminal fixture journal:\n${journal.stdout}`, { cause: error });
  } finally {
    fixture.close();
  }
}, 45_000);

it.skipIf(!supportedHost)("refuses a memory change that a later persistent operator override would shadow", async () => {
  const fixture = await TerminalMemoryFixture.create();
  try {
    fs.mkdirSync(`${fixture.unitPath}.d`, { mode: 0o700 });
    const operatorPolicy = path.join(`${fixture.unitPath}.d`, "90-budget.conf");
    const operatorContents = "[Service]\nMemoryHigh=256M\nMemoryMax=512M\n";
    fs.writeFileSync(operatorPolicy, operatorContents, { mode: 0o600 });
    fixture.systemctl("daemon-reload");
    const memory = new TerminalMemoryService({ repoRoot, unitName: fixture.unit });
    const before = await memory.status();
    expect(before.manageable, before.reason).toBe(true);
    const original = fixture.identity();
    await expect(memory.apply({ memoryHigh: "512 MiB", memoryMax: "768 MiB" })).rejects.toThrow(/90-budget\.conf/u);
    expect(fs.existsSync(path.join(fixture.configHome, "systemd/user.control", `${fixture.unit}.d`, "50-MemoryHigh.conf"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.configHome, "systemd/user.control", `${fixture.unit}.d`, "50-MemoryMax.conf"))).toBe(false);
    expect((await memory.status()).limits).toEqual(before.limits);
    expect(fixture.identity()).toEqual(original);
    expect(fs.readFileSync(operatorPolicy, "utf8")).toBe(operatorContents);
    fixture.systemctl("daemon-reload");
    expect((await memory.status()).limits).toEqual(before.limits);
    expect(fixture.identity()).toEqual(original);
  } finally { fixture.close(); }
}, 30_000);

class TerminalMemoryFixture {
  private unitInstalled = false;
  readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-terminal-memory-"));
  readonly unit = `cloudx-terminal-memory-${randomUUID()}.service`;
  readonly configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  readonly unitPath = path.join(this.configHome, "systemd/user", this.unit);
  readonly envPath = path.join(this.directory, "broker.env");
  readonly dataDir = path.join(this.directory, "profile");
  readonly socketPath = terminalSocketPath(this.dataDir);
  readonly terminals = new DurableTerminalProcessFactory(this.socketPath, new NodePtyTerminalProcessFactory());

  static async create(): Promise<TerminalMemoryFixture> {
    const fixture = new TerminalMemoryFixture();
    try {
      if (!fs.existsSync(path.join(repoRoot, "apps/server/dist/terminal/broker.js"))) {
        throw new Error("Build the shared, plugin-api, and server workspaces before running the real systemd terminal memory check.");
      }
      fs.mkdirSync(path.dirname(fixture.unitPath), { recursive: true });
      fs.writeFileSync(fixture.envPath, `CLOUDX_DATA_DIR=${fixture.dataDir}\n`, { mode: 0o600, flag: "wx" });
      await fixture.refreshUnit();
      fixture.systemctl("start", fixture.unit);
      return fixture;
    } catch (error) {
      fixture.close();
      throw error;
    }
  }

  async refreshUnit(): Promise<void> {
    const { renderTerminalService } = await import(new URL("../../../../scripts/install-cloudx.mjs", import.meta.url).href);
    fs.writeFileSync(this.unitPath, renderTerminalService({ repoRoot, envPath: this.envPath, nodePath: process.execPath }), { mode: 0o600 });
    this.unitInstalled = true;
    this.systemctl("daemon-reload");
  }

  identity(): Record<string, string> {
    return Object.fromEntries(this.systemctl("show", this.unit, "--property=MainPID,InvocationID,ControlGroup,ActiveEnterTimestampMonotonic")
      .trim().split("\n").map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
  }

  cgroupLimits(): { memoryHigh: string; memoryMax: string } {
    const directory = path.join("/sys/fs/cgroup", this.identity().ControlGroup!);
    return {
      memoryHigh: fs.readFileSync(path.join(directory, "memory.high"), "utf8").trim(),
      memoryMax: fs.readFileSync(path.join(directory, "memory.max"), "utf8").trim()
    };
  }

  systemctl(...args: string[]): string {
    if (["start", "stop", "restart", "set-property", "reset-failed"].includes(args[0]!) && args[1] !== this.unit) {
      throw new Error("The terminal memory integration check may only mutate its uniquely named fixture service.");
    }
    return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
  }

  close(): void {
    if (this.unitInstalled) {
      const stopped = spawnSync("systemctl", ["--user", "stop", this.unit], { encoding: "utf8", timeout: 15_000 });
      if (stopped.status !== 0) {
        throw new Error(`Could not stop ${this.unit}. Retained fixture files at ${this.directory} and ${this.unitPath}. ${stopped.stderr?.trim() ?? stopped.error?.message ?? ""}`);
      }
      fs.rmSync(this.unitPath, { force: true });
      fs.rmSync(`${this.unitPath}.d`, { recursive: true, force: true });
      for (const base of [this.configHome, process.env.XDG_RUNTIME_DIR].filter((value): value is string => Boolean(value))) {
        fs.rmSync(path.join(base, "systemd/user.control", `${this.unit}.d`), { recursive: true, force: true });
      }
      spawnSync("systemctl", ["--user", "reset-failed", this.unit], { stdio: "ignore", timeout: 5000 });
      this.systemctl("daemon-reload");
    }
    fs.rmSync(path.dirname(this.socketPath), { recursive: true, force: true });
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}

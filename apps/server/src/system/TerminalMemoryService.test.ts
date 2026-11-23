import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalMemoryService } from "./TerminalMemoryService.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-memory-")); roots.push(home);
  const repoRoot = path.join(home, "checkout");
  const configHome = path.join(home, ".config");
  const unitName = "cloudx-terminal.service";
  const fragment = path.join(configHome, "systemd", "user", unitName);
  const cgroupRoot = path.join(home, "cgroup");
  const group = path.join(cgroupRoot, "user.slice", "broker");
  const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  write(fragment, `[Service]\nWorkingDirectory=${repoRoot}\n`);
  write(path.join(cgroupRoot, "cgroup.controllers"), "memory");
  for (const current of [group, path.dirname(group)]) {
    write(path.join(current, "memory.high"), "max"); write(path.join(current, "memory.max"), "max");
  }
  write(path.join(group, "memory.current"), "1024\n");
  write(path.join(group, "memory.pressure"), "some avg10=96.22 avg60=0.00 avg300=0.00 total=123\nfull avg10=95.73 avg60=0.00 avg300=0.00 total=123\n");
  write(path.join(group, "memory.events"), "low 0\nhigh 2260\nmax 0\noom 2\noom_kill 1\n");
  const state: Record<string, string> = { LoadState: "loaded", ActiveState: "active", WorkingDirectory: repoRoot,
    FragmentPath: fragment, DropInPaths: "", MemoryHigh: "18446744073709551615", MemoryMax: "18446744073709551615",
    ControlGroup: "/user.slice/broker", MainPID: "42", InvocationID: "invocation" };
  const execute = vi.fn(async (_file: string, args: string[]) => {
    if (args.includes("show")) return { stdout: Object.entries(state).map(([key, value]) => `${key}=${value}`).join("\n") };
    for (const assignment of args.slice(-2)) {
      const [property, value] = assignment.split("=") as [string, string]; state[property] = value;
      const file = path.join(configHome, "systemd", "user.control", `${unitName}.d`, `50-${property}.conf`);
      write(file, `# Created by systemctl\n[Service]\n${property}=${value}\n`);
      write(path.join(group, property === "MemoryHigh" ? "memory.high" : "memory.max"), value === "infinity" ? "max" : value);
    }
    state.DropInPaths = ["MemoryHigh", "MemoryMax"].map(property => path.join(configHome, "systemd", "user.control", `${unitName}.d`, `50-${property}.conf`)).join(" ");
    return { stdout: "" };
  });
  const options = { repoRoot, home, configHome, runtimeDir: path.join(home, "runtime"), cgroupRoot, platform: "linux" as const, execute };
  const service = new TerminalMemoryService(options);
  return { service, state, execute, options, write, group, fragment, configHome, home };
}

describe("terminal memory policy", () => {
  it("reports service usage, inherited limits, existing overrides and pressure independently of machine free RAM", async () => {
    const f = fixture();
    f.write(path.join(path.dirname(f.group), "memory.high"), "4096");
    f.write(path.join(path.dirname(f.group), "memory.max"), "8192");
    const override = path.join(f.configHome, "systemd/user", "cloudx-terminal.service.d/operator.conf");
    f.write(override, "[Service]\nMemoryHigh=24G\nMemoryMax=32G\n"); f.state.DropInPaths = override;
    expect(await f.service.status()).toMatchObject({ manageable: true, limits: { memoryHigh: "infinity", memoryMax: "infinity" },
      effective: { memoryHigh: "4096", memoryMax: "8192" }, usageBytes: 1024,
      pressure: { someAvg10: 96.22, fullAvg10: 95.73 }, events: { high: 2260, oom: 2, oomKill: 1 }, dropInPaths: [override] });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("applies both canonical values in one live persistent operation and verifies the files and readback", async () => {
    const f = fixture();
    const status = await f.service.apply({ memoryHigh: "55GiB", memoryMax: "64GiB" });
    expect(status.limits).toEqual({ memoryHigh: "59055800320", memoryMax: "68719476736" });
    expect(f.execute.mock.calls[1]![1]).toEqual(["--user", "--no-pager", "set-property", "cloudx-terminal.service", "MemoryHigh=59055800320", "MemoryMax=68719476736"]);
    expect(f.execute.mock.calls.flatMap(call => call[1])).not.toEqual(expect.arrayContaining(["restart", "--runtime"]));
    const reloaded = new TerminalMemoryService(f.options);
    expect((await reloaded.status()).limits).toEqual(status.limits);
    expect(f.state.MainPID).toBe("42");
    expect((await f.service.apply({ memoryHigh: "infinity", memoryMax: "infinity" })).limits).toEqual({ memoryHigh: "infinity", memoryMax: "infinity" });
  });

  it.each([
    { memoryHigh: "2GiB", memoryMax: "1GiB" }, { memoryHigh: "0B", memoryMax: "1GiB" },
    { memoryHigh: "1G; reboot", memoryMax: "infinity" }, { memoryHigh: "1GiB", memoryMax: "infinity", other: true }, null
  ])("rejects invalid input before reading or changing systemd: %j", async input => {
    const f = fixture();
    await expect(f.service.apply(input)).rejects.toMatchObject({ statusCode: 400 });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["foreign installation", "missing unit", "unsafe override", "unsupported controller", "transitioning", "unknown limits"])("disables management for %s without hiding available observations", async failure => {
    const f = fixture();
    if (failure === "foreign installation") f.state.WorkingDirectory = "/another-installation";
    if (failure === "missing unit") f.state.LoadState = "not-found";
    if (failure === "transitioning") f.state.ActiveState = "activating";
    if (failure === "unknown limits") delete f.state.MemoryHigh;
    if (failure === "unsupported controller") fs.unlinkSync(path.join(f.group, "memory.high"));
    if (failure === "unsafe override") {
      const file = path.join(f.configHome, "systemd/user/cloudx-terminal.service.d/exec.conf");
      f.write(file, "[Service]\nExecStart=/bin/false\n"); f.state.DropInPaths = file;
    }
    const status = await f.service.status();
    expect(status.manageable).toBe(false); expect(status.reason).toBeTruthy(); expect(status.usageBytes).toBe(1024);
    await expect(f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" })).rejects.toThrow();
    expect(f.execute.mock.calls.every(call => call[1].includes("show"))).toBe(true);
  });

  it("makes missing telemetry unknown rather than zero or unlimited", async () => {
    const f = fixture();
    f.write(path.join(f.group, "memory.pressure"), "full avg10=101 avg60=0 total=1\n");
    f.write(path.join(f.group, "memory.events"), "high invalid\n");
    fs.unlinkSync(path.join(path.dirname(f.group), "memory.max"));
    f.state.ControlGroup = "/../../outside";
    const invalid = await f.service.status();
    expect(invalid.manageable).toBe(false); expect(invalid.effective.memoryMax).toBeNull();
    f.state.ControlGroup = "/user.slice/broker";
    expect(await f.service.status()).toMatchObject({ effective: { memoryMax: null }, pressure: null, events: null });
  });

  it("includes a constrained visible cgroup mount root in effective limits", async () => {
    const f = fixture();
    f.write(path.join(f.options.cgroupRoot, "memory.high"), "2048");
    f.write(path.join(f.options.cgroupRoot, "memory.max"), "4096");
    expect((await f.service.status()).effective).toEqual({ memoryHigh: "2048", memoryMax: "4096" });
  });

  it("reports unrepresentable override paths as unavailable while retaining telemetry", async () => {
    const f = fixture(); f.state.DropInPaths = '"/unsafe/new\\nline.conf"';
    expect(await f.service.status()).toMatchObject({ manageable: false, reason: expect.stringContaining("invalid path"), usageBytes: 1024 });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("persists limits for an inactive broker without starting it", async () => {
    const f = fixture();
    Object.assign(f.state, { ActiveState: "inactive", MainPID: "0", InvocationID: "", ControlGroup: "" });
    const result = await f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" });
    expect(result).toMatchObject({ manageable: true, activeState: "inactive", usageBytes: null, effective: { memoryHigh: null, memoryMax: null } });
    expect(f.execute.mock.calls.every(call => call[1].includes("show") || call[1].includes("set-property"))).toBe(true);
  });

  it("refuses a later operator override before changing either live or persisted limits", async () => {
    const f = fixture();
    const file = path.join(f.configHome, "systemd/user/cloudx-terminal.service.d/90-budget.conf");
    f.write(file, "[Service]\nMemoryHigh=256M\nMemoryMax=512M\n"); f.state.DropInPaths = file;
    await expect(f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" })).rejects.toThrow("90-budget.conf");
    expect(f.execute.mock.calls.every(call => call[1].includes("show"))).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("[Service]\nMemoryHigh=256M\nMemoryMax=512M\n");
  });

  it("checks operator files on disk even before systemd has loaded them", async () => {
    const f = fixture();
    const file = path.join(f.configHome, "systemd/user/cloudx-terminal.service.d/90-budget.conf");
    f.write(file, "[Service]\nMemoryHigh=256M\nMemoryMax=512M\n");
    expect(f.state.DropInPaths).toBe("");
    await expect(f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" })).rejects.toThrow("90-budget.conf");
    expect(f.execute.mock.calls.every(call => call[1].includes("show"))).toBe(true);
  });


  it("shows missing persistence permissions before an apply request", async () => {
    const f = fixture();
    const access = vi.spyOn(fs, "accessSync").mockImplementation(() => { throw new Error("EACCES"); });
    try {
      expect(await f.service.status()).toMatchObject({ manageable: false, reason: expect.stringContaining("write access") });
      await expect(f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" })).rejects.toThrow("write access");
      expect(f.execute.mock.calls.every(call => call[1].includes("show"))).toBe(true);
    } finally { access.mockRestore(); }
  });

  it("reports failure if the active cgroup effective limits cannot be read back", async () => {
    const f = fixture(), execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (file, args) => {
      const result = await execute(file, args);
      if (args.includes("set-property")) fs.unlinkSync(path.join(path.dirname(f.group), "memory.max"));
      return result;
    });
    await expect(f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" })).rejects.toThrow("effective cgroup memory limits could not be read");
  });

  it("shows unsupported hosts and user-bus failures as unavailable", async () => {
    const f = fixture();
    expect(await new TerminalMemoryService({ ...f.options, platform: "darwin" }).status()).toMatchObject({ manageable: false, reason: expect.stringContaining("Linux") });
    f.execute.mockRejectedValue(new Error("Failed to connect to bus"));
    expect(await f.service.status()).toMatchObject({ manageable: false, reason: expect.stringContaining("connect to bus"), usageBytes: null });
  });

  it.each(["permission", "persistence", "readback", "identity"])("reports actionable %s failures and never restarts the broker", async failure => {
    const f = fixture();
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (file, args) => {
      if (!args.includes("set-property")) return execute(file, args);
      if (failure === "permission") throw { stderr: "Access denied writing user.control" };
      const result = await execute(file, args);
      if (failure === "persistence") fs.unlinkSync(path.join(f.configHome, "systemd/user.control/cloudx-terminal.service.d/50-MemoryMax.conf"));
      if (failure === "readback") f.state.MemoryHigh = "1024";
      if (failure === "identity") f.state.InvocationID = "restarted";
      return result;
    });
    await expect(f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" })).rejects.toThrow(/refresh to inspect the current values/);
    expect(f.execute.mock.calls.every(call => call[1].includes("show") || call[1].includes("set-property"))).toBe(true);
  });

  it("rejects overlapping changes and releases the guard after failure", async () => {
    const f = fixture();
    let release!: () => void;
    f.execute.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error("inspection failed"); });
    const pending = f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" });
    await expect(f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" })).rejects.toMatchObject({ statusCode: 409 });
    release(); await expect(pending).rejects.toThrow("inspection failed");
    await expect(f.service.apply({ memoryHigh: "1GiB", memoryMax: "2GiB" })).resolves.toMatchObject({ manageable: true });
  });
});

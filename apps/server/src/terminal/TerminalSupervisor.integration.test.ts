import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodePtyTerminalProcessFactory } from "./NodePtyTerminalProcess.js";
import type { TerminalExecutionBinding, TerminalProcess } from "./TerminalProcess.js";

const fixtures: DetachedTerminalFixture[] = [];
const terminals: TerminalProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const terminal of terminals.splice(0)) await terminal.terminate();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("terminal descendant ownership", () => {
  it.each([
    ["legacy broker arguments", ["/bin/sh", "-c", "exit 0"], "A stale CloudX broker/server may be using incompatible supervisor arguments"],
    ["missing execution JSON", [], "execution JSON argument is missing"],
    ["malformed execution JSON", ["{", "/bin/true"], "execution JSON is invalid"],
    ["missing command", ["null"], "command is missing"],
    ["empty command", ["null", ""], "command is missing"],
    ["invalid execution binding", ["{}", "/bin/true"], "execution binding is invalid"],
    ["non-object execution binding", ["[]", "/bin/true"], "execution binding is invalid"]
  ])("writes an error without readiness for %s", async (_reason, arguments_, message) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-invalid-arguments-test-"));
    directories.push(directory);
    const helper = fileURLToPath(new URL("../../helpers/terminal-supervisor.py", import.meta.url));

    const result = spawnSync("python3", ["-I", "-S", helper, directory, String(process.pid), ...arguments_], {
      encoding: "utf8", timeout: 5_000
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(125);
    expect(result.stderr).toBe("");
    expect(await fs.readdir(directory)).toEqual(["error.json"]);
    expect(JSON.parse(await fs.readFile(path.join(directory, "error.json"), "utf8")))
      .toEqual({ pid: result.pid, message: expect.stringContaining(message) });
  });

  it.each(["alive", "exited"] as const)("stops a detached orphan when the command is %s, preserving an unrelated process", async (mode) => {
    const fixture = await DetachedTerminalFixture.create(mode);
    const daemon = await fixture.process("daemon");
    const command = await fixture.process("command");
    await fixture.launcherExited();
    if (mode === "exited") await waitUntil(async () => !await isRunning(command));

    await fixture.terminal.terminate();

    expect(await isRunning(command)).toBe(false);
    expect(await isRunning(daemon)).toBe(false);
    expect(fixture.unrelated.exitCode).toBeNull();
    expect(fixture.unrelated.signalCode).toBeNull();
    await expect(fixture.terminal.terminate()).resolves.toBeUndefined();
  });

  it("reports the command's exit only after its detached descendants have stopped", async () => {
    const fixture = await DetachedTerminalFixture.create("exited");
    const event = await terminalExit(fixture.terminal);

    expect(event).toEqual({ exitCode: 23 });
    expect(await isRunning(await fixture.process("daemon"))).toBe(false);
    await expect(fixture.terminal.terminate()).resolves.toBeUndefined();
  });

  it("preserves output and status from a command that exits during startup", async () => {
    const terminal = await startTerminal(process.execPath, ["-e", "process.stdout.write('early output'); process.exit(17)"]);
    let output = "";
    terminal.onData((data) => { output += data; });

    expect(await terminalExit(terminal)).toEqual({ exitCode: 17 });
    expect(output).toBe("early output");
  });

  it("preserves a command's terminating signal", async () => {
    const terminal = await startTerminal(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]);
    expect(await terminalExit(terminal)).toEqual({ exitCode: 0, signal: 15 });
  });

  it("cleans detached descendants through the synchronous cancellation entry point", async () => {
    const fixture = await DetachedTerminalFixture.create("alive");
    const daemon = await fixture.process("daemon");
    await fixture.launcherExited();

    fixture.terminal.kill();
    await terminalExit(fixture.terminal);

    expect(await isRunning(daemon)).toBe(false);
    await expect(fixture.terminal.terminate()).resolves.toBeUndefined();
  });

  it("can cancel immediately after startup without leaving the command alive", async () => {
    const terminal = await startTerminal(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    terminal.kill();
    await expect(terminal.terminate()).resolves.toBeUndefined();
  });

  it.each(["ephemeral", "durable"])("reaps descendants after SIGKILL of the Node host with %s receipts", async (retention) => {
    const directory = await DetachedTerminalFixture.prepareCommand();
    const execution = retention === "durable" ? await executionBinding(directory) : undefined;
    const harnessFile = path.join(directory, "host.mjs");
    await fs.writeFile(harnessFile, `import fs from 'node:fs';
      import { NodePtyTerminalProcessFactory } from ${JSON.stringify(new URL("./NodePtyTerminalProcess.ts", import.meta.url).href)};
      const terminal = await new NodePtyTerminalProcessFactory().spawn(process.execPath, [${JSON.stringify(path.join(directory, "command.mjs"))}, ${JSON.stringify(directory)}, 'alive'], {
        cwd: ${JSON.stringify(directory)}, env: process.env, cols: 100, rows: 30,
        execution: ${JSON.stringify(execution ?? null)}
      });
      fs.writeFileSync(${JSON.stringify(path.join(directory, "supervisor-directory"))}, terminal.supervisor.directory);
      setTimeout(() => process.exit(0), 15000);
    `);
    const host = spawn(process.execPath, ["--import", "tsx", harnessFile], { stdio: "ignore" });
    let supervisor: ProcessIdentity | undefined;
    try {
      const command = await readRecordedProcess(directory, "command");
      const daemon = await readRecordedProcess(directory, "daemon");
      supervisor = await readProcess(command.parent);
      expect(supervisor?.parent).toBe(host.pid);
      const receiptDirectory = await fs.readFile(path.join(directory, "supervisor-directory"), "utf8");
      directories.push(receiptDirectory);
      const ready = JSON.parse(await fs.readFile(path.join(receiptDirectory, "ready.json"), "utf8"));
      if (execution) expect(ready).toEqual({
        executionId: execution.executionId, bootId: execution.bootId, pidNamespace: execution.pidNamespace,
        pid: supervisor!.pid, started: supervisor!.started
      });

      await stopChild(host);
      expect(host.signalCode).toBe("SIGKILL");

      await waitUntil(async () => !await isRunning(command) && !await isRunning(daemon) && !await isRunning(supervisor!));
      if (execution) {
        expect(JSON.parse(await fs.readFile(path.join(receiptDirectory, "complete.json"), "utf8")))
          .toEqual({ ...ready, exitCode: 0, signal: 9 });
        expect(JSON.parse(await fs.readFile(path.join(receiptDirectory, "ready.json"), "utf8"))).toEqual(ready);
      } else await expect(fs.access(receiptDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await stopChild(host);
      await stopRecordedProcesses(directory);
      if (supervisor) await stopProcess(supervisor);
    }
  });

  it("retains bound receipts after ordinary completion and rejects reuse of the execution directory", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-durable-test-"));
    directories.push(directory);
    const execution = await executionBinding(directory);
    const options = { cwd: directory, env: process.env, cols: 100, rows: 30, execution };
    const terminal = await new NodePtyTerminalProcessFactory().spawn(process.execPath, ["-e", "process.exit(19)"], options);
    terminals.push(terminal);

    expect(await terminalExit(terminal)).toEqual({ exitCode: 19 });
    await terminal.terminate();
    const ready = JSON.parse(await fs.readFile(path.join(execution.directory, "ready.json"), "utf8"));
    expect(ready).toMatchObject({ executionId: execution.executionId, bootId: execution.bootId, pidNamespace: execution.pidNamespace });
    expect(JSON.parse(await fs.readFile(path.join(execution.directory, "complete.json"), "utf8"))).toEqual({ ...ready, exitCode: 19 });

    await expect(new NodePtyTerminalProcessFactory().spawn(process.execPath, ["-e", ""], options)).rejects.toThrow("must be empty before launch");
    expect(await fs.readdir(execution.directory)).toEqual(["complete.json", "ready.json"]);
  });

  it.each(["bootId", "pidNamespace"] as const)("refuses a changed %s before launching and retains the error receipt", async (changed) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-invalid-binding-test-"));
    directories.push(directory);
    const execution = { ...await executionBinding(directory), [changed]: "unexpected-environment" };
    const commandMarker = path.join(directory, "command-started");

    await expect(new NodePtyTerminalProcessFactory().spawn(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(commandMarker)}, 'started')`], {
      cwd: directory, env: process.env, cols: 100, rows: 30, execution
    })).rejects.toThrow("Terminal execution binding does not match the current boot and PID namespace");
    await expect(fs.access(commandMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(execution.directory)).toEqual(["error.json"]);
    expect(JSON.parse(await fs.readFile(path.join(execution.directory, "error.json"), "utf8")))
      .toMatchObject({ executionId: execution.executionId, message: "Terminal execution binding does not match the current boot and PID namespace" });
  });

  it.each(["ephemeral", "durable"])("refuses quiescence after unexpected supervisor death with %s receipts", async (retention) => {
    const fixture = await DetachedTerminalFixture.create("alive", retention === "durable");
    await fixture.launcherExited();
    const command = await fixture.process("command");
    expect(command.parent).not.toBe(process.pid);
    process.kill(command.parent, "SIGKILL");

    await expect(fixture.terminal.terminate()).rejects.toThrow("without confirming its descendants stopped");
    expect(await isRunning(await fixture.process("daemon"))).toBe(true);
    if (fixture.execution) {
      await expect(fs.access(path.join(fixture.execution.directory, "ready.json"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(fixture.execution.directory, "complete.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves the durable execution directory when Python cannot start", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-missing-python-test-"));
    directories.push(directory);
    const execution = await executionBinding(directory);

    await expect(new NodePtyTerminalProcessFactory().spawn(process.execPath, ["-e", ""], {
      cwd: directory, env: { ...process.env, PATH: "/cloudx-test-no-executables" }, cols: 100, rows: 30, execution
    })).rejects.toThrow("Python 3.9 or newer");
    expect(await fs.readdir(execution.directory)).toEqual([]);
  });

  it("fails clearly and removes launch receipts when Python is unavailable", async () => {
    const createdDirectories: string[] = [];
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
      const directory = await mkdtemp(prefix, options) as string;
      createdDirectories.push(directory);
      return directory;
    });

    await expect(new NodePtyTerminalProcessFactory().spawn(process.execPath, ["-e", ""], {
      cwd: os.tmpdir(), env: { ...process.env, PATH: "/cloudx-test-no-executables" }, cols: 100, rows: 30
    })).rejects.toThrow("Python 3.9 or newer");
    expect(createdDirectories).toHaveLength(1);
    await expect(fs.access(createdDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["subreaper registration is unavailable", "ctypes.CDLL = lambda *args, **kwargs: types.SimpleNamespace(prctl=rejected)"],
    ["Python is older than 3.9", "sys.version_info = (3, 8, 20)"],
    ["kernel child enumeration is unavailable", "pathlib.Path.read_text = missing_children"]
  ])("fails before launching the command when %s", async (_reason, rejectRequirement) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-prctl-test-"));
    directories.push(directory);
    await fs.writeFile(path.join(directory, "python3"), `#!/usr/bin/python3
import ctypes, pathlib, sys, types
def rejected(*args):
    ctypes.set_errno(1)
    return -1
def missing_children(*args, **kwargs):
    raise FileNotFoundError('Linux child enumeration is unavailable')
${rejectRequirement}
source = sys.argv[4]
sys.argv = ['-c', *sys.argv[5:]]
exec(compile(source, '<terminal-supervisor>', 'exec'))
`, { mode: 0o755 });
    const commandMarker = path.join(directory, "command-started");

    await expect(new NodePtyTerminalProcessFactory().spawn(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(commandMarker)}, 'started')`], {
      cwd: directory, env: { ...process.env, PATH: directory }, cols: 100, rows: 30
    })).rejects.toThrow("Linux subreaper support");
    await expect(fs.access(commandMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps input, foreground job control, interrupts, and resize working", async () => {
    const terminal = await startTerminal("/bin/bash", ["--noprofile", "--norc", "-i"]);
    let output = "";
    terminal.onData((data) => { output += data; });
    terminal.write("printf '\\n__SHELL_READY__\\n'\r");
    await waitUntil(async () => output.includes("\r\n__SHELL_READY__\r\n"));

    terminal.resize(123, 45);
    terminal.write("stty size\r");
    await waitUntil(async () => output.includes("45 123\r\n"));
    terminal.write("sleep 30\r");
    await waitUntil(async () => output.includes("sleep 30\r\n"));
    terminal.write("\x1a");
    await waitUntil(async () => /Stopped\s+sleep 30/u.test(output));
    terminal.write("fg\r");
    await waitUntil(async () => output.includes("\rsleep 30\r\n"));
    terminal.write("\x03");
    terminal.write("printf '\\n__SHELL_INTERRUPTED__\\n'\r");
    await waitUntil(async () => output.includes("\r\n__SHELL_INTERRUPTED__\r\n"));
    terminal.write("exit 19\r");

    expect(await terminalExit(terminal)).toEqual({ exitCode: 19 });
  });
});

async function executionBinding(directory: string): Promise<TerminalExecutionBinding> {
  const receipts = path.join(directory, "execution-receipts");
  await fs.mkdir(receipts);
  return {
    executionId: "test-durable-execution", directory: receipts,
    bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    pidNamespace: await fs.readlink("/proc/self/ns/pid")
  };
}

async function startTerminal(command: string, args: string[]) {
  const terminal = await new NodePtyTerminalProcessFactory().spawn(command, args, {
    cwd: os.tmpdir(), env: process.env, cols: 100, rows: 30
  });
  terminals.push(terminal);
  return terminal;
}

function terminalExit(terminal: TerminalProcess): Promise<{ exitCode: number; signal?: number }> {
  return new Promise((resolve) => terminal.onExit(resolve));
}

interface ProcessIdentity { pid: number; started: string; parent: number }

class DetachedTerminalFixture {
  private constructor(
    readonly directory: string,
    readonly terminal: TerminalProcess,
    readonly unrelated: ChildProcess,
    readonly execution?: TerminalExecutionBinding
  ) {}

  static async prepareCommand() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ownership-test-"));
    directories.push(directory);
    const record = `import fs from 'node:fs'; import path from 'node:path';
      const directory = process.argv[2];
      function record(name) {
        const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8').split(') ')[1].split(' ');
        fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify({ pid: process.pid, started: stat[19], parent: Number(stat[1]) }));
      }
      setTimeout(() => process.exit(0), 15_000);
    `;
    await fs.writeFile(path.join(directory, "daemon.mjs"), `${record}
      record('daemon');
      process.on('SIGTERM', () => {});
      setInterval(() => fs.writeFileSync(path.join(directory, 'heartbeat'), String(Date.now())), 10);
    `);
    await fs.writeFile(path.join(directory, "launcher.mjs"), `${record}
      import { spawn } from 'node:child_process';
      record('launcher');
      const daemon = spawn(process.execPath, [path.join(directory, 'daemon.mjs'), directory], { detached: true, stdio: 'ignore' });
      daemon.unref();
      setInterval(() => { if (fs.existsSync(path.join(directory, 'daemon.json'))) process.exit(0); }, 5);
    `);
    await fs.writeFile(path.join(directory, "command.mjs"), `${record}
      import { spawn } from 'node:child_process';
      record('command');
      const launcher = spawn(process.execPath, [path.join(directory, 'launcher.mjs'), directory], { stdio: 'ignore' });
      launcher.on('exit', () => {
        fs.writeFileSync(path.join(directory, 'launcher-exited'), 'yes');
        if (process.argv[3] === 'exited') process.exit(23);
      });
      setInterval(() => {}, 1000);
    `);
    return directory;
  }

  static async create(mode: "alive" | "exited", durable = false) {
    const directory = await this.prepareCommand();
    const execution = durable ? await executionBinding(directory) : undefined;
    const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { stdio: "ignore" });
    try {
      const terminal = await new NodePtyTerminalProcessFactory().spawn(process.execPath, [path.join(directory, "command.mjs"), directory, mode], {
        cwd: directory, env: process.env, cols: 100, rows: 30, execution
      });
      const fixture = new DetachedTerminalFixture(directory, terminal, unrelated, execution);
      fixtures.push(fixture);
      return fixture;
    } catch (error) {
      unrelated.kill("SIGKILL");
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async process(name: "command" | "launcher" | "daemon"): Promise<ProcessIdentity> {
    return readRecordedProcess(this.directory, name);
  }

  async launcherExited() {
    await waitUntil(async () => fs.access(path.join(this.directory, "launcher-exited")).then(() => true, () => false));
  }

  async dispose() {
    await this.terminal.terminate().catch(() => {});
    await stopRecordedProcesses(this.directory);
    await stopChild(this.unrelated);
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}

async function readRecordedProcess(directory: string, name: string): Promise<ProcessIdentity> {
  const file = path.join(directory, `${name}.json`);
  await waitUntil(async () => fs.access(file).then(() => true, () => false));
  return JSON.parse(await fs.readFile(file, "utf8")) as ProcessIdentity;
}

async function readProcess(pid: number): Promise<ProcessIdentity & { state: string } | undefined> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, parent: Number(fields[1]), started: fields[19]!, state: fields[0]! };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

async function isRunning(expected: ProcessIdentity): Promise<boolean> {
  const current = await readProcess(expected.pid);
  return Boolean(current && current.started === expected.started && !["Z", "X"].includes(current.state));
}

async function stopRecordedProcesses(directory: string): Promise<void> {
  for (const name of ["command", "launcher", "daemon"]) {
    const receipt = await fs.readFile(path.join(directory, `${name}.json`), "utf8").catch(() => undefined);
    if (receipt) await stopProcess(JSON.parse(receipt) as ProcessIdentity);
  }
}

async function stopProcess(identity: ProcessIdentity): Promise<void> {
  if (!await isRunning(identity)) return;
  try { process.kill(identity.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  await waitUntil(async () => !await isRunning(identity));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the terminal fixture.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startTerminalBroker } from "../../../../scripts/test-terminal-broker.mjs";
import { DurableTerminalProcessFactory } from "./DurableTerminalProcess.js";
import { NodePtyTerminalProcessFactory } from "./NodePtyTerminalProcess.js";
import { TerminalBroker } from "./TerminalBroker.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe.skipIf(process.platform !== "linux")("broker-owned terminal processes", () => {
  it("keeps a 64 MiB printable burst recoverable with subsequent input and the same shell PID", async () => {
    const directory = await temporaryDirectory();
    const socketPath = path.join(directory, "broker.sock");
    const nativeFactory = new NodePtyTerminalProcessFactory();
    const broker = new TerminalBroker(socketPath, nativeFactory);
    await broker.start();
    cleanups.push(() => broker.stop());
    const factory = new DurableTerminalProcessFactory(socketPath, nativeFactory);
    const original = await factory.spawn("/bin/bash", ["--noprofile", "--norc"], {
      cwd: directory, env: process.env, cols: 100, rows: 30, sessionId: "printable-burst"
    });
    original.onScreen!(() => {});
    const disconnected = vi.fn();
    original.onDisconnect!(disconnected);
    let output = "";
    let printableBytes = 0;
    original.onData((data) => {
      printableBytes += data.length - data.replaceAll("@", "").length;
      output = (output + data).slice(-4096);
    });
    original.write("stty -echo; PS1=''; printf '\\nREADY_PID=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(output).toMatch(/READY_PID=\d+/u));
    const pid = Number(/READY_PID=(\d+)/u.exec(output)![1]);
    original.write("python3 -c \"import os; [os.write(1, b'@' * 65536) for _ in range(1024)]\"; printf '\\nBURST_DONE=%s\\n' \"$$\"\n");
    // Coverage workers can share one CPU while the full burst drains through the PTY.
    await vi.waitFor(() => expect(output).toContain(`BURST_DONE=${pid}`), { timeout: 120_000 });
    expect(printableBytes).toBe(64 * 1024 * 1024);
    expect(disconnected).not.toHaveBeenCalled();
    original.write("printf '\\nAFTER_BURST=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(output).toContain(`AFTER_BURST=${pid}`));
    original.detach!();

    const restored = await factory.attach("printable-burst");
    restored.onScreen!(() => {});
    let restoredOutput = "";
    restored.onData((data) => { restoredOutput += data; });
    expect(restoredOutput).toContain(`BURST_DONE=${pid}`);
    restored.write("printf '\\nRESTORED_PID=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(restoredOutput).toContain(`RESTORED_PID=${pid}`));
    await restored.terminate();
    expect(await running(pid)).toBe(false);
  }, 135_000);

  it("restores the same shell, working directory, and output produced while the web client was detached", async () => {
    const directory = await temporaryDirectory();
    const socketPath = path.join(directory, "broker.sock");
    const broker = new TerminalBroker(socketPath, new NodePtyTerminalProcessFactory());
    await broker.start();
    cleanups.push(() => broker.stop());
    const factory = new DurableTerminalProcessFactory(socketPath, new NodePtyTerminalProcessFactory());
    const original = await factory.spawn("/bin/bash", ["--noprofile", "--norc"], {
      cwd: directory, env: process.env, cols: 100, rows: 30, sessionId: "shell"
    });
    let originalOutput = "";
    original.onData((data) => { originalOutput += data; });
    original.write("stty -echo; cd /; printf '\\nSHELL_PID=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(originalOutput).toMatch(/SHELL_PID=\d+/u));
    const pid = Number(/SHELL_PID=(\d+)/u.exec(originalOutput)![1]);
    original.write("sleep 0.1; printf 'OUTPUT_WHILE_AWAY\\n'\n");
    original.detach!();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const restored = await factory.attach("shell");
    let restoredOutput = "";
    restored.onData((data) => { restoredOutput += data; });
    restored.write("printf '\\nRESTORED=%s:%s\\n' \"$$\" \"$PWD\"\n");
    await vi.waitFor(() => expect(restoredOutput).toContain(`RESTORED=${pid}:/`));
    expect(restoredOutput).toContain("OUTPUT_WHILE_AWAY");
    await restored.terminate();
    expect(await running(pid)).toBe(false);
  });

  it.each([0, 1_250])("survives web-process death and explicitly stops the command plus its detached descendant after %ims web startup", async startupDelay => {
    const directory = await temporaryDirectory();
    const socketPath = path.join(directory, "broker.sock");
    const brokerScript = path.join(directory, "broker.mjs");
    await fs.writeFile(brokerScript, `
      import { TerminalBroker } from ${moduleUrl("TerminalBroker")};
      import { NodePtyTerminalProcessFactory } from ${moduleUrl("NodePtyTerminalProcess")};
      const broker = new TerminalBroker(${JSON.stringify(socketPath)}, new NodePtyTerminalProcessFactory());
      await broker.start();
      process.on('SIGTERM', () => void broker.stop());
      process.send({ type: 'ready' });
    `);
    const broker = await startOwner(brokerScript);

    await fs.writeFile(path.join(directory, "daemon.mjs"), `
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(path.join(directory, "daemon-pid"))}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    await fs.writeFile(path.join(directory, "command.mjs"), `
      import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      fs.writeFileSync(${JSON.stringify(path.join(directory, "command-pid"))}, String(process.pid));
      const daemon = spawn(process.execPath, [${JSON.stringify(path.join(directory, "daemon.mjs"))}], { detached: true, stdio: 'ignore' });
      daemon.unref();
      process.stdin.on('data', () => process.stdout.write('CONTINUED_WORK\\n'));
      setInterval(() => {}, 1000);
    `);
    const webScript = path.join(directory, "web.mjs");
    await fs.writeFile(webScript, `
      import { DurableTerminalProcessFactory } from ${moduleUrl("DurableTerminalProcess")};
      import { NodePtyTerminalProcessFactory } from ${moduleUrl("NodePtyTerminalProcess")};
      await new Promise(resolve => setTimeout(resolve, ${startupDelay}));
      await new DurableTerminalProcessFactory(${JSON.stringify(socketPath)}, new NodePtyTerminalProcessFactory()).spawn(
        process.execPath, [${JSON.stringify(path.join(directory, "command.mjs"))}],
        { cwd: ${JSON.stringify(directory)}, env: process.env, cols: 100, rows: 30, sessionId: 'codex-work' }
      );
      process.send({ type: 'ready' });
    `);
    const web = await startOwner(webScript);
    await vi.waitFor(async () => expect(await exists(path.join(directory, "daemon-pid"))).toBe(true), { timeout: 10_000 });
    const commandPid = Number(await fs.readFile(path.join(directory, "command-pid"), "utf8"));
    const daemonPid = Number(await fs.readFile(path.join(directory, "daemon-pid"), "utf8"));
    const supervisorPid = (await processState(commandPid))!.parent;
    expect((await processState(supervisorPid))!.parent).toBe(broker.pid);

    await stopChild(web, "SIGKILL");
    expect(await running(commandPid)).toBe(true);
    expect(await running(daemonPid)).toBe(true);
    const restored = await new DurableTerminalProcessFactory(socketPath, new NodePtyTerminalProcessFactory()).attach("codex-work");
    let output = "";
    restored.onData((data) => { output += data; });
    restored.write("continue\n");
    await vi.waitFor(() => expect(output).toContain("CONTINUED_WORK"));

    await restored.terminate();
    expect(await running(commandPid)).toBe(false);
    expect(await running(daemonPid)).toBe(false);
    expect(await running(supervisorPid)).toBe(false);
    expect(broker.exitCode).toBeNull();
  }, 30_000);

  it("reports child startup errors instead of waiting for a missing readiness marker", async () => {
    const directory = await temporaryDirectory();
    const script = path.join(directory, "failed-owner.mjs");
    await fs.writeFile(script, "throw new Error('fixture startup failed');");
    await expect(startOwner(script)).rejects.toThrow("fixture startup failed");
  });
});

async function startOwner(script: string): Promise<ChildProcess> {
  let errors = "";
  try {
    return await startTerminalBroker(script, {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      onSpawn(child: ChildProcess) {
        cleanups.push(() => stopChild(child));
        child.stderr!.on("data", data => { errors = (errors + data).slice(-4096); });
      }
    });
  } catch (error) {
    throw new Error(`${path.basename(script)} failed to start: ${error instanceof Error ? error.message : String(error)}\n${errors}`, { cause: error });
  }
}

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-durable-test-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function moduleUrl(name: string) { return JSON.stringify(new URL(`./${name}.ts`, import.meta.url).href); }

async function exists(file: string) { return fs.access(file).then(() => true, () => false); }

async function processState(pid: number) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], parent: Number(fields[1]) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function running(pid: number) {
  const state = await processState(pid);
  return Boolean(state && state.state !== "Z" && state.state !== "X");
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(signal);
  await exited;
}

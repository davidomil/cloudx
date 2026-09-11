import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableTerminalProcessFactory } from "./DurableTerminalProcess.js";
import { NodePtyTerminalProcessFactory } from "./NodePtyTerminalProcess.js";
import { TerminalBroker } from "./TerminalBroker.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe.skipIf(process.platform !== "linux")("broker-owned terminal processes", () => {
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

  it("survives web-process death and explicitly stops the command plus its detached descendant", async () => {
    const directory = await temporaryDirectory();
    const socketPath = path.join(directory, "broker.sock");
    const brokerScript = path.join(directory, "broker.mjs");
    await fs.writeFile(brokerScript, `
      import fs from 'node:fs';
      import { TerminalBroker } from ${moduleUrl("TerminalBroker")};
      import { NodePtyTerminalProcessFactory } from ${moduleUrl("NodePtyTerminalProcess")};
      const broker = new TerminalBroker(${JSON.stringify(socketPath)}, new NodePtyTerminalProcessFactory());
      await broker.start();
      fs.writeFileSync(${JSON.stringify(path.join(directory, "ready"))}, 'ready');
      process.on('SIGTERM', () => void broker.stop());
    `);
    const broker = spawn(process.execPath, ["--import", "tsx", brokerScript], { stdio: "ignore" });
    cleanups.push(() => stopChild(broker));
    await vi.waitFor(async () => expect(await exists(path.join(directory, "ready"))).toBe(true));

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
      import fs from 'node:fs';
      import { DurableTerminalProcessFactory } from ${moduleUrl("DurableTerminalProcess")};
      import { NodePtyTerminalProcessFactory } from ${moduleUrl("NodePtyTerminalProcess")};
      await new DurableTerminalProcessFactory(${JSON.stringify(socketPath)}, new NodePtyTerminalProcessFactory()).spawn(
        process.execPath, [${JSON.stringify(path.join(directory, "command.mjs"))}],
        { cwd: ${JSON.stringify(directory)}, env: process.env, cols: 100, rows: 30, sessionId: 'codex-work' }
      );
      fs.writeFileSync(${JSON.stringify(path.join(directory, "web-ready"))}, 'ready');
    `);
    const web = spawn(process.execPath, ["--import", "tsx", webScript], { stdio: "ignore" });
    cleanups.push(() => stopChild(web));
    await vi.waitFor(async () => expect(await exists(path.join(directory, "web-ready"))).toBe(true));
    await vi.waitFor(async () => expect(await exists(path.join(directory, "daemon-pid"))).toBe(true));
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
  }, 15_000);
});

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

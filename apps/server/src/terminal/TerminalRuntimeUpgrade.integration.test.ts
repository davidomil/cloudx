import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableTerminalProcessFactory } from "./DurableTerminalProcess.js";
import { NodePtyTerminalProcessFactory } from "./NodePtyTerminalProcess.js";
import type { TerminalExecutionBinding, TerminalProcess } from "./TerminalProcess.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe.skipIf(process.platform !== "linux")("running terminal owners across an in-place helper upgrade", () => {
  it("keeps the existing shell PID and launches new broker sessions and direct workers with the pinned helper", async () => {
    const installation = await runningInstallation();
    const original = await installation.terminals.spawn("/bin/bash", ["--noprofile", "--norc"], {
      cwd: installation.directory, env: process.env, cols: 100, rows: 30, sessionId: "existing-shell"
    });
    let output = "";
    original.onData((data) => { output += data; });
    original.write("stty -echo; printf '\\nORIGINAL_PID=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(output).toMatch(/ORIGINAL_PID=\d+/u));
    const pid = Number(/ORIGINAL_PID=(\d+)/u.exec(output)![1]);
    original.detach!();

    await fs.writeFile(installation.helper, 'CLOUDX_TERMINAL_SUPERVISOR_CONTRACT = "execution-json-v2"\nraise RuntimeError("The next helper has an incompatible argument contract")\n');

    const restored = await installation.terminals.attach("existing-shell");
    let restoredOutput = "";
    restored.onData((data) => { restoredOutput += data; });
    restored.write("printf '\\nRESTORED_PID=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(restoredOutput).toContain(`RESTORED_PID=${pid}`));
    expect(restoredOutput).toContain(`ORIGINAL_PID=${pid}`);

    const fresh = await installation.terminals.spawn("/bin/sh", ["-c", "printf NEW_BROKER_SESSION"], {
      cwd: installation.directory, env: process.env, cols: 100, rows: 30, sessionId: "new-shell"
    });
    let freshOutput = "";
    fresh.onData((data) => { freshOutput += data; });
    expect(await terminalExit(fresh)).toEqual({ exitCode: 0 });
    expect(freshOutput).toBe("NEW_BROKER_SESSION");
    await fresh.terminate();

    const execution = await executionBinding(installation.directory);
    const worker = await launchWorker(installation.web, execution);
    expect(worker).toEqual({ event: { exitCode: 0 }, output: "NEW_DIRECT_WORKER" });
    const ready = JSON.parse(await fs.readFile(path.join(execution.directory, "ready.json"), "utf8"));
    expect(ready).toMatchObject({ executionId: execution.executionId, bootId: execution.bootId, pidNamespace: execution.pidNamespace });
    expect(JSON.parse(await fs.readFile(path.join(execution.directory, "complete.json"), "utf8"))).toEqual({ ...ready, exitCode: 0 });

    await restored.terminate();
    await expect(fs.access(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(installation.broker.exitCode).toBeNull();
    expect(installation.web.exitCode).toBeNull();
  }, 20_000);

  it("requires explicit session recovery after a coordinated owner restart", async () => {
    const installation = await runningInstallation();
    const options = { cwd: installation.directory, env: process.env, cols: 100, rows: 30, sessionId: "recoverable-shell" };
    const original = await installation.terminals.spawn("/bin/bash", ["--noprofile", "--norc"], options);
    let output = "";
    original.onData((data) => { output += data; });
    original.write("stty -echo; printf '\\nORIGINAL_PID=%s\\n' \"$$\"\n");
    await vi.waitFor(() => expect(output).toMatch(/ORIGINAL_PID=\d+/u));
    const pid = Number(/ORIGINAL_PID=(\d+)/u.exec(output)![1]);

    original.detach!();
    await stopOwner(installation.web);
    await stopOwner(installation.broker);
    await expect(fs.access(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
    const source = await fs.readFile(installation.helper, "utf8");
    await fs.writeFile(installation.helper, `# Updated compatible supervisor build\n${source}`);
    await installation.restartBroker();

    await expect(installation.terminals.attach(options.sessionId)).rejects.toThrow("It was not restarted");
    const recovered = await installation.terminals.spawn("/bin/sh", ["-c", "printf 'RECOVERED_PID=%s' \"$$\""], options);
    let recoveredOutput = "";
    recovered.onData((data) => { recoveredOutput += data; });
    expect(await terminalExit(recovered)).toEqual({ exitCode: 0 });
    expect(recoveredOutput).toMatch(/^RECOVERED_PID=\d+$/u);
    expect(recoveredOutput).not.toBe(`RECOVERED_PID=${pid}`);
    await recovered.terminate();
  }, 20_000);
});

async function runningInstallation() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-runtime-upgrade-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const modules = path.join(directory, "src", "terminal");
  await fs.mkdir(modules, { recursive: true });
  await fs.mkdir(path.join(directory, "helpers"));
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  const require = createRequire(import.meta.url);
  await fs.symlink(path.dirname(path.dirname(require.resolve("node-pty/package.json"))), path.join(directory, "node_modules"));
  for (const name of ["NodePtyTerminalProcess", "TerminalSupervisor", "TerminalSupervisorRuntime"]) {
    await fs.copyFile(new URL(`./${name}.ts`, import.meta.url), path.join(modules, `${name}.ts`));
  }
  const helper = path.join(directory, "helpers", "terminal-supervisor.py");
  await fs.copyFile(new URL("../../helpers/terminal-supervisor.py", import.meta.url), helper);
  const factoryModule = JSON.stringify(pathToFileURL(path.join(modules, "NodePtyTerminalProcess.ts")).href);
  const socket = path.join(directory, "broker.sock");
  const brokerSource = `
    import { NodePtyTerminalProcessFactory } from ${factoryModule};
    import { TerminalBroker } from ${JSON.stringify(new URL("./TerminalBroker.ts", import.meta.url).href)};
    const broker = new TerminalBroker(${JSON.stringify(socket)}, new NodePtyTerminalProcessFactory());
    await broker.start();
    process.on('SIGTERM', () => void broker.stop());
  `;
  const broker = await startOwner(directory, "broker", brokerSource);
  const web = await startOwner(directory, "web", `
    import { NodePtyTerminalProcessFactory } from ${factoryModule};
    import { DurableTerminalProcessFactory } from ${JSON.stringify(new URL("./DurableTerminalProcess.ts", import.meta.url).href)};
    const terminals = new DurableTerminalProcessFactory(${JSON.stringify(socket)}, new NodePtyTerminalProcessFactory());
    process.on('message', async (execution) => {
      try {
        const terminal = await terminals.spawn('/bin/sh', ['-c', 'printf NEW_DIRECT_WORKER'], {
          cwd: ${JSON.stringify(directory)}, env: process.env, cols: 100, rows: 30, execution
        });
        let output = '';
        terminal.onData((data) => { output += data; });
        const event = await new Promise((resolve) => terminal.onExit(resolve));
        await terminal.terminate();
        process.send({ event, output });
      } catch (error) { process.send({ error: String(error) }); }
    });
  `);
  return {
    directory, helper, broker, web,
    terminals: new DurableTerminalProcessFactory(socket, new NodePtyTerminalProcessFactory()),
    restartBroker: () => startOwner(directory, "broker", brokerSource)
  };
}

async function startOwner(directory: string, name: string, source: string): Promise<ChildProcess> {
  const script = path.join(directory, `${name}.mjs`);
  const ready = path.join(directory, `${name}-ready`);
  await fs.rm(ready, { force: true });
  await fs.writeFile(script, `import fs from 'node:fs';\n${source}\nfs.writeFileSync(${JSON.stringify(ready)}, 'ready');`);
  const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "";
  child.stderr!.on("data", (data) => { errors += data; });
  cleanups.push(() => stopOwner(child));
  await vi.waitFor(async () => {
    expect(child.exitCode, errors).toBeNull();
    expect(await fs.access(ready).then(() => true, () => false), errors).toBe(true);
  }, { timeout: 5_000 });
  return child;
}

async function stopOwner(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.disconnect();
  child.kill("SIGTERM");
  await exited;
}

function terminalExit(terminal: TerminalProcess) {
  return new Promise<{ exitCode: number; signal?: number }>((resolve) => terminal.onExit(resolve));
}

async function executionBinding(directory: string): Promise<TerminalExecutionBinding> {
  const receipts = path.join(directory, "worker-receipts");
  await fs.mkdir(receipts);
  return {
    executionId: "post-upgrade-worker", directory: receipts,
    bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    pidNamespace: await fs.readlink("/proc/self/ns/pid")
  };
}

function launchWorker(web: ChildProcess, execution: TerminalExecutionBinding): Promise<unknown> {
  return new Promise((resolve, reject) => {
    web.once("message", resolve);
    web.send(execution, (error) => { if (error) reject(error); });
  });
}

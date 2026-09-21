import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { DurableTerminalProcessFactory } from "../apps/server/src/terminal/DurableTerminalProcess.ts";
import { NodePtyTerminalProcessFactory } from "../apps/server/src/terminal/NodePtyTerminalProcess.ts";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.skipIf(process.platform !== "linux")("refuses migration from a broker-owned terminal before stopping services or changing saved state", async context => {
  const membership = fs.readFileSync("/proc/self/cgroup", "utf8");
  const controlGroup = /^0::(\/.+)$/m.exec(membership)?.[1];
  if (!controlGroup) context.skip("Requires a non-root unified cgroup to represent the fixture broker's service.");
  const installation = await isolatedInstallation(controlGroup);
  const updater = writeUpdater(installation);
  const terminal = await installation.terminals.spawn("/bin/bash", ["--noprofile", "--norc", "-c",
    'printf "SHELL_PID=%s\\n" "$$"; "$1" "$2"; exec /bin/bash --noprofile --norc',
    "migration-shell", process.execPath, updater,
  ], { cwd: installation.root, env: process.env, cols: 100, rows: 30, sessionId: "migration-shell" });
  cleanups.push(() => terminal.detach());
  let output = "";
  terminal.onData(data => { output += data; });
  await vi.waitFor(() => expect(fs.existsSync(installation.result), output).toBe(true), { timeout: 5_000 });

  const result = JSON.parse(fs.readFileSync(installation.result, "utf8"));
  expect(result.membership).toBe(fs.readFileSync(`/proc/${installation.broker.pid}/cgroup`, "utf8"));
  expect(result.error).toMatch(/cloudx-terminal\.service.*external terminal.*no services were stopped/u);
  expect(fs.readFileSync(installation.stopRequests, "utf8")).toBe("");
  expect(fs.readdirSync(installation.dataDir).sort()).toEqual([...installation.saved.keys()].sort());
  for (const [relative, bytes] of installation.saved)
    expect(fs.readFileSync(path.join(installation.dataDir, relative))).toEqual(bytes);
  expect(installation.broker.exitCode).toBeNull();
  expect(installation.broker.signalCode).toBeNull();
  expect(installation.web.exitCode).toBeNull();
  expect(installation.web.signalCode).toBeNull();

  terminal.write("stty -echo; printf '\\nSTILL_RUNNING_PID=%s\\n' \"$$\"\n");
  await vi.waitFor(() => expect(output).toMatch(/STILL_RUNNING_PID=\d+/u));
  expect(/STILL_RUNNING_PID=(\d+)/u.exec(output)[1]).toBe(/SHELL_PID=(\d+)/u.exec(output)[1]);
  await terminal.terminate();
}, 15_000);

async function isolatedInstallation(controlGroup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-migration-caller-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = path.join(root, "broker.sock");
  const source = name => new URL(`../apps/server/src/terminal/${name}.ts`, import.meta.url).href;
  const broker = await startOwner(root, "broker", `
    import { TerminalBroker } from ${JSON.stringify(source("TerminalBroker"))};
    import { NodePtyTerminalProcessFactory } from ${JSON.stringify(source("NodePtyTerminalProcess"))};
    const broker = new TerminalBroker(${JSON.stringify(socket)}, new NodePtyTerminalProcessFactory());
    await broker.start();
    process.on('SIGTERM', () => void broker.stop());
  `);
  const web = await startOwner(root, "web", "setInterval(() => {}, 1000);");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const tab = { id: "migration-shell", pluginId: "terminal", title: "My migration shell", cwd: root,
    createdAt: "then", updatedAt: "now", status: "running", indicator: { color: "green", label: "Running", updatedAt: "now" } };
  const saved = new Map(Object.entries({
    "sessions.json": { version: 1, activeTabId: tab.id, sessions: [{ tab }] },
    "workspace.json": { activeWindowId: "window", windows: [{ id: "window", name: "Saved window", defaultCwd: root,
      layout: { activePaneId: "pane", root: { type: "pane", pane: { id: "pane", tabIds: [tab.id], activeTabId: tab.id } } } }] },
  }).map(([relative, value]) => [relative, Buffer.from(JSON.stringify(value))]));
  for (const [relative, bytes] of saved) fs.writeFileSync(path.join(dataDir, relative), bytes);
  const stopRequests = path.join(root, "stop-requests");
  fs.writeFileSync(stopRequests, "");
  return { root, dataDir, broker, web, controlGroup, saved, stopRequests, result: path.join(root, "updater-result.json"),
    terminals: new DurableTerminalProcessFactory(socket, new NodePtyTerminalProcessFactory()) };
}

function writeUpdater(installation) {
  const script = path.join(installation.root, "updater.mjs");
  const runtime = new URL("./install-runtime.mjs", import.meta.url).href;
  const config = { ...installation, broker: { pid: installation.broker.pid }, web: { pid: installation.web.pid } };
  delete config.terminals;
  delete config.saved;
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import { prepareRuntimeUpdate } from ${JSON.stringify(runtime)};
    const installation = ${JSON.stringify(config)};
    const services = {
      'cloudx.service': { pid: installation.web.pid, group: '/cloudx-caller-fixture-web-' + installation.web.pid },
      'cloudx-terminal.service': { pid: installation.broker.pid, group: installation.controlGroup },
    };
    const commands = {
      inspect(_command, args) {
        const service = services[args[2]];
        return Object.entries({ LoadState: 'loaded', ActiveState: 'active', MainPID: service.pid,
          WorkingDirectory: installation.root, ControlGroup: service.group, InvocationID: 'test-invocation',
          KillMode: 'control-group', SendSIGKILL: 'yes' }).map(([key, value]) => key + '=' + value).join('\\n');
      },
      run(_command, args) {
        fs.appendFileSync(installation.stopRequests, JSON.stringify(args) + '\\n');
        throw new Error('Fixture service stop attempted');
      },
    };
    const result = { membership: fs.readFileSync('/proc/self/cgroup', 'utf8') };
    try {
      prepareRuntimeUpdate({ paths: { repoRoot: installation.root, dataDir: installation.dataDir }, commands, target: { kind: 'standard' },
        migrateTerminals: true, log() {} });
    } catch (error) { result.error = error.message; }
    fs.writeFileSync(installation.result, JSON.stringify(result));
  `);
  return script;
}

async function startOwner(root, name, source) {
  const script = path.join(root, `${name}.mjs`);
  const ready = path.join(root, `${name}-ready`);
  fs.writeFileSync(script, `import fs from 'node:fs';\n${source}\nfs.writeFileSync(${JSON.stringify(ready)}, 'ready');`);
  const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  });
  await vi.waitFor(() => {
    expect(child.exitCode, errors).toBeNull();
    expect(fs.existsSync(ready), errors).toBe(true);
  }, { timeout: 5_000 });
  return child;
}

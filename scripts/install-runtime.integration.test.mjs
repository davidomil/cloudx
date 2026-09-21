import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

import { DurableTerminalProcessFactory } from "../apps/server/src/terminal/DurableTerminalProcess.ts";
import { NodePtyTerminalProcessFactory } from "../apps/server/src/terminal/NodePtyTerminalProcess.ts";
import { prepareRuntimeUpdate } from "./install-runtime.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.skipIf(process.platform !== "linux")("gates a live legacy broker before mutation, then snapshots and explicitly recovers across the helper contract upgrade", async () => {
  const installation = await legacyInstallation();
  const options = { cwd: installation.root, env: process.env, cols: 100, rows: 30, sessionId: "saved-shell" };
  const original = await installation.terminals.spawn("/bin/bash", ["--noprofile", "--norc"], options);
  let output = "";
  original.onData(data => { output += data; });
  original.write("stty -echo; printf '\\nORIGINAL_PID=%s\\n' \"$$\"\n");
  await vi.waitFor(() => expect(output).toMatch(/ORIGINAL_PID=\d+/u));
  const pid = Number(/ORIGINAL_PID=(\d+)/u.exec(output)[1]);
  const saved = saveRecoveryState(installation);
  const migration = migrationAdapter(installation, () => {
    expect(running(installation.web.pid)).toBe(false);
    expect(running(pid)).toBe(true);
    const backups = fs.readdirSync(installation.dataDir).filter(name => name.startsWith("terminal-recovery-"));
    expect(backups).toHaveLength(1);
    for (const [relative, bytes] of saved.files)
      expect(fs.readFileSync(path.join(installation.dataDir, backups[0], relative))).toEqual(bytes);
  });
  const legacySource = fs.readFileSync(installation.helper);

  expect(() => prepareRuntimeUpdate(migration)).toThrow("cannot safely survive an in-place update");
  expect(migration.actions).toEqual([]);
  expect(fs.readFileSync(installation.helper)).toEqual(legacySource);
  expect(running(pid)).toBe(true);
  const beforeUpgrade = await installation.terminals.spawn("/bin/sh", ["-c", "printf LEGACY_STILL_WORKS"], { ...options, sessionId: "preflight-refused" });
  await expectSuccessfulOutput(beforeUpgrade, "LEGACY_STILL_WORKS");

  original.detach();
  prepareRuntimeUpdate({ ...migration, migrateTerminals: true });
  expect(migration.actions).toEqual(["cloudx.service", "cloudx-terminal.service"]);
  expect(running(pid)).toBe(false);
  expect(fs.readFileSync(installation.helper)).toEqual(legacySource);
  for (const [relative, bytes] of saved.originals)
    expect(fs.readFileSync(path.join(installation.dataDir, relative))).toEqual(bytes);

  installation.installCurrentRuntime();
  await installation.startBroker();
  await expect(installation.terminals.attach(options.sessionId)).rejects.toThrow("It was not restarted");
  const recovered = await installation.terminals.spawn("/bin/sh", ["-c", "printf RECOVERED_EXPLICITLY"], options);
  await expectSuccessfulOutput(recovered, "RECOVERED_EXPLICITLY");
  expect(fs.existsSync(path.join(installation.root, "replayed-command"))).toBe(false);
}, 20_000);

async function legacyInstallation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-legacy-upgrade-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const modules = path.join(root, "src", "terminal");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(modules, { recursive: true });
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(root, "helpers"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const require = createRequire(import.meta.url);
  fs.symlinkSync(path.dirname(path.dirname(require.resolve("node-pty/package.json"))), path.join(root, "node_modules"));
  const source = name => new URL(`../apps/server/src/terminal/${name}.ts`, import.meta.url);
  const factoryPath = path.join(modules, "NodePtyTerminalProcess.ts");
  const factorySource = fs.readFileSync(source("NodePtyTerminalProcess"), "utf8");
  // Reproduce the pre-execution-binding caller: it loads a mutable helper path
  // and passes the command immediately after the parent PID.
  const legacyFactory = factorySource
    .replace('import { terminalSupervisorSource } from "./TerminalSupervisorRuntime.js";', 'import { fileURLToPath } from "node:url";')
    .replace('["-I", "-S", "-c", terminalSupervisorSource, directory, String(process.pid), JSON.stringify(options.execution ?? null), command, ...args]',
      '["-I", "-S", fileURLToPath(new URL("../../helpers/terminal-supervisor.py", import.meta.url)), directory, String(process.pid), command, ...args]');
  expect(legacyFactory).not.toContain("terminalSupervisorSource");
  expect(legacyFactory).not.toContain("JSON.stringify(options.execution");
  fs.writeFileSync(factoryPath, legacyFactory);
  fs.copyFileSync(source("TerminalSupervisor"), path.join(modules, "TerminalSupervisor.ts"));
  const helper = path.join(root, "helpers", "terminal-supervisor.py");
  const currentHelper = fs.readFileSync(new URL("../apps/server/helpers/terminal-supervisor.py", import.meta.url), "utf8");
  fs.writeFileSync(helper, `${currentHelper.slice(0, currentHelper.indexOf('if __name__ == "__main__":'))}
if __name__ == "__main__":
    supervisor = TerminalSupervisor(sys.argv[1], int(sys.argv[2]), None, sys.argv[3:])
    try:
        sys.exit(supervisor.run())
    except Exception as error:
        supervisor.write_receipt("error", {**supervisor.identity, "message": str(error)})
        sys.exit(125)
`);
  const socket = path.join(root, "broker.sock");
  const factoryImport = `import { NodePtyTerminalProcessFactory } from ${JSON.stringify(pathToFileURL(factoryPath).href)};`;
  const startBroker = () => startOwner(root, "broker", `${factoryImport}
    import { TerminalBroker } from ${JSON.stringify(source("TerminalBroker").href)};
    const broker = new TerminalBroker(${JSON.stringify(socket)}, new NodePtyTerminalProcessFactory());
    await broker.start();
    process.on('SIGTERM', () => void broker.stop());
  `);
  const broker = await startBroker();
  const web = await startOwner(root, "web", `${factoryImport}\nnew NodePtyTerminalProcessFactory();\nsetInterval(() => {}, 1000);`);
  return {
    root, dataDir, helper, broker, web, startBroker,
    terminals: new DurableTerminalProcessFactory(socket, new NodePtyTerminalProcessFactory()),
    installCurrentRuntime() {
      fs.writeFileSync(helper, currentHelper);
      fs.writeFileSync(factoryPath, factorySource);
      fs.copyFileSync(source("TerminalSupervisorRuntime"), path.join(modules, "TerminalSupervisorRuntime.ts"));
    }
  };
}

function saveRecoveryState(installation) {
  const files = new Map();
  const write = (relative, value) => {
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    const destination = path.join(installation.dataDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    files.set(relative, bytes);
    return destination;
  };
  const conversation = "12345678-1234-1234-1234-123456789abc";
  const tab = { id: "saved-shell", pluginId: "terminal", title: "Keep my shell title", cwd: installation.root, createdAt: "then", updatedAt: "now",
    status: "running", indicator: { color: "green", label: "Running", updatedAt: "now" } };
  write("sessions.json", { version: 1, activeTabId: tab.id, sessions: [
    { tab, initialInput: { command: `touch ${path.join(installation.root, "replayed-command")}` } },
    { tab: { ...tab, id: "saved-codex", pluginId: "codex-terminal", title: "Exact conversation" }, initialInput: { resume: { mode: "session", sessionId: conversation } } }
  ] });
  write("workspace.json", { activeWindowId: "window-1", windows: [{ id: "window-1", name: "Preserved window", defaultCwd: installation.root,
    createdAt: "then", updatedAt: "now", layout: { activePaneId: "pane-1", root: { type: "pane", pane: { id: "pane-1", tabIds: [tab.id, "saved-codex"], activeTabId: tab.id } } } }] });
  const transcriptRelative = `codex-home/sessions/rollout-${conversation}.jsonl`;
  const transcript = write(transcriptRelative, `${JSON.stringify({ type: "session_meta", payload: { id: conversation, cwd: tab.cwd } })}\n{"type":"event_msg","payload":{"message":"exact recoverable history"}}\n`);
  const home = path.join(installation.dataDir, "codex-home");
  const stat = fs.statSync(home);
  write("codex-launches/saved-codex/.cloudx-source.json", { version: 1, sourceId: "shared", home, dev: String(stat.dev), ino: String(stat.ino) });
  write("codex-launches/saved-codex/.cloudx-conversation.json", { sessionId: conversation, cwd: tab.cwd, transcriptPath: transcript });
  const originals = new Map(files);
  files.set("transcripts/saved-codex.jsonl", files.get(transcriptRelative));
  files.delete(transcriptRelative);
  return { files, originals };
}

function migrationAdapter(installation, beforeBrokerStop) {
  const children = { "cloudx.service": installation.web, "cloudx-terminal.service": installation.broker };
  const actions = [];
  return {
    paths: { repoRoot: installation.root, dataDir: installation.dataDir }, target: { kind: "standard" }, actions,
    commands: {
      inspect(_command, args) {
        const child = children[args[2]];
        const active = running(child.pid);
        return Object.entries({ LoadState: "loaded", ActiveState: active ? "active" : "inactive", MainPID: active ? String(child.pid) : "0",
          WorkingDirectory: installation.root, ControlGroup: `/cloudx-upgrade-test-${child.pid}.service`, InvocationID: "test-invocation",
          KillMode: "control-group", SendSIGKILL: "yes" }).map(([key, value]) => `${key}=${value}`).join("\n");
      },
      run(_command, args) {
        expect(args.slice(0, 2)).toEqual(["--user", "stop"]);
        if (args[2] === "cloudx-terminal.service") beforeBrokerStop();
        actions.push(args[2]);
        stopSynchronously(children[args[2]]);
      }
    },
    // Only systemd metadata/cgroup removal are simulated. Brokers, helpers,
    // terminals, snapshots, process death, and recovery run through real paths.
    readFile(file, encoding) {
      if (file.startsWith("/sys/fs/cgroup/cloudx-upgrade-test-")) throw Object.assign(new Error("Removed fixture cgroup"), { code: "ENOENT" });
      return fs.readFileSync(file, encoding);
    },
    log() {}
  };
}

async function startOwner(root, name, source) {
  const script = path.join(root, `${name}.mjs`);
  const ready = path.join(root, `${name}-ready`);
  fs.rmSync(ready, { force: true });
  fs.writeFileSync(script, `import fs from 'node:fs';\n${source}\nfs.writeFileSync(${JSON.stringify(ready)}, 'ready');`);
  const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await ended;
  });
  await vi.waitFor(() => {
    expect(child.exitCode, errors).toBeNull();
    expect(fs.existsSync(ready), errors).toBe(true);
  }, { timeout: 5_000 });
  return child;
}

function running(pid) {
  try { return !["Z", "X"].includes(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0]); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function stopSynchronously(child) {
  execFileSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const pid = Number(process.argv[1]);
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (true) {
      try { if (['Z', 'X'].includes(fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[0])) break; }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (Date.now() >= deadline) throw new Error('Fixture owner did not stop');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  `, String(child.pid)]);
}

async function expectSuccessfulOutput(terminal, expected) {
  let output = "";
  terminal.onData(data => { output += data; });
  const event = await new Promise(resolve => terminal.onExit(resolve));
  expect(event).toEqual({ exitCode: 0 });
  expect(output).toBe(expected);
  await terminal.terminate();
}

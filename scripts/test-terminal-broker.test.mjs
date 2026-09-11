import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { terminalSocketPath } from "../apps/server/src/terminal/TerminalBrokerProtocol.js";
import { AutomationRepository } from "../apps/server/src/automation/AutomationRepository.js";
import { startTerminalBroker, stopTestProcess } from "./test-terminal-broker.mjs";

const children = [];
const directories = [];
const execute = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => {
  for (const child of children.splice(0)) await stopTestProcess(child);
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function startBroker(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-launcher-"));
  directories.push(root);
  const dataDir = path.join(root, "data");
  const child = await startTerminalBroker("apps/server/src/terminal/broker.ts", {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLOUDX_DATA_DIR: dataDir,
      CLOUDX_ALLOWED_ROOTS: root,
      ...overrides
    },
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    onSpawn(child) { children.push(child); }
  });
  return { child, socketPath: terminalSocketPath(dataDir) };
}

describe("test terminal broker lifecycle", () => {
  it.each(["0", "65536", "bad", "3002.5"])("rejects invalid test port %s before seeding", async (port) => {
    await expect(execute(process.execPath, [path.join(repoRoot, "scripts/setup-test-environment.mjs")], {
      env: { ...process.env, CLOUDX_TEST_PORT: port }
    })).rejects.toMatchObject({ stderr: expect.stringContaining("CLOUDX_TEST_PORT must be an integer between 1 and 65535") });
  });

  it("waits for the production broker socket and closes the launcher IPC without stopping the broker", async () => {
    const { child, socketPath } = await startBroker();
    expect(child.connected).toBe(false);
    expect(child.exitCode).toBeNull();
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.once("connect", () => socket.write('{"type":"attach","sessionId":"missing"}\n'));
      socket.once("data", (data) => { socket.destroy(); resolve(JSON.parse(data)); });
    });
    expect(response).toEqual({ type: "missing" });

    await stopTestProcess(child);
    expect(child.exitCode).toBe(0);
    await expect(fs.stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await stopTestProcess(child);
  });

  it("fails startup when the broker exits before readiness and leaves no running child", async () => {
    await expect(startBroker({ CLOUDX_TERMINAL_REPLAY_BYTES: "0" })).rejects.toThrow("exited before readiness");
    expect(children.at(-1).exitCode).toBe(1);
  });

  it("stops the child when its launcher cannot register ownership", async () => {
    await expect(startTerminalBroker("apps/server/src/terminal/broker.ts", {
      cwd: repoRoot,
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      onSpawn(child) { children.push(child); throw new Error("Cannot persist broker pid"); }
    })).rejects.toThrow("Cannot persist broker pid");
    expect(children.at(-1).signalCode).toBe("SIGTERM");
  });

  it("refuses to reseed a broker that outlived its web server and explicitly stops it through testenv:stop", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-testenv-"));
    directories.push(root);
    const scripts = path.join(root, "scripts");
    await fs.mkdir(scripts);
    for (const name of ["setup-test-environment.mjs", "test-terminal-broker.mjs"]) {
      await fs.copyFile(path.join(repoRoot, "scripts", name), path.join(scripts, name));
    }
    const port = "45678";
    const env = { ...process.env, CLOUDX_TEST_PORT: port };
    const environment = path.join(root, `.cloudx-test-${port}`);
    const dataDir = path.join(environment, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const saved = path.join(dataDir, "sessions.json");
    await fs.writeFile(saved, "saved running terminal");
    const child = await startTerminalBroker("apps/server/src/terminal/broker.ts", {
      cwd: repoRoot,
      env: { ...process.env, CLOUDX_DATA_DIR: dataDir, CLOUDX_ALLOWED_ROOTS: root },
      detached: true,
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      onSpawn(child) { children.push(child); }
    });
    const pidPath = path.join(environment, "broker.pid");
    await fs.writeFile(pidPath, String(child.pid));
    const script = path.join(scripts, "setup-test-environment.mjs");
    await expect(execute(process.execPath, [script], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining("Managed test terminal broker is already running")
    });
    expect(await fs.readFile(saved, "utf8")).toBe("saved running terminal");

    const stopped = await execute(process.execPath, [script, "--stop"], { env });
    expect(stopped.stdout).toContain("Stopped managed CloudX test terminal broker process group");
    expect(child.exitCode).toBe(0);
    await expect(fs.stat(pidPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(terminalSocketPath(dataDir))).rejects.toMatchObject({ code: "ENOENT" });
    await execute(process.execPath, [script], { env });
    await expect(new AutomationRepository(dataDir).listGroups()).resolves.toHaveLength(5);
    expect(await fs.readFile(path.join(environment, "env.sh"), "utf8")).toContain("export CLOUDX_TEST_PORT='45678'");
    await expect(fs.stat(path.join(root, ".cloudx-test-3002"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

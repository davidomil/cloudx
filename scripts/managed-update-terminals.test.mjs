import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PluginSessionMissingError } from "@cloudx/plugin-api";
import { afterEach, expect, it, vi } from "vitest";
import { DurableTerminalProcessFactory, terminalSocketPath } from "../apps/server/src/terminal/DurableTerminalProcess.ts";
import { NodePtyTerminalProcessFactory } from "../apps/server/src/terminal/NodePtyTerminalProcess.ts";
import { TerminalBroker } from "../apps/server/src/terminal/TerminalBroker.ts";
import { SessionStateStore } from "../apps/server/src/workspace/SessionStateStore.ts";
import { SessionStore } from "../apps/server/src/sessionStore.ts";
import { PluginRegistry } from "../apps/server/src/pluginRegistry.ts";
import { PathPolicy } from "../apps/server/src/pathPolicy.ts";
import { TabContextService } from "../apps/server/src/context/TabContextService.ts";
import { StandardTerminalPlugin } from "../apps/server/src/plugins/StandardTerminalPlugin.ts";
import { parseTerminalProbeArguments, probeTerminalAttachments } from "./managed-update-terminals.mjs";

const cleanups = [];
const releaseRoot = fileURLToPath(new URL("..", import.meta.url));
const probeFile = fileURLToPath(new URL("./managed-update-terminals.mjs", import.meta.url));
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("captures only saved unowned terminal sessions, omitting typed missing sessions and detaching successes", async () => {
  const detach = vi.fn();
  const factory = { attach: vi.fn(async id => {
    if (id === "missing") throw new PluginSessionMissingError("Already closed");
    return { detach, onExit: () => () => {}, write: () => { throw new Error("No input allowed"); } };
  }) };
  const result = await probeTerminalAttachments({ mode: "capture" }, {
    factory, readSessions: async () => ({ version: 1, sessions: [saved("shell"), saved("codex", "codex-terminal"), saved("missing"),
      saved("document", "document-viewer"), { tab: { ...saved("owned").tab, ownerPluginId: "automation" } }] }),
    isMissingSession: error => error instanceof PluginSessionMissingError,
  });
  expect(result).toEqual({ sessionIds: ["shell", "codex"] });
  expect(factory.attach.mock.calls).toEqual([["shell"], ["codex"], ["missing"]]);
  expect(detach).toHaveBeenCalledTimes(2);
});

it("omits retained exits after observing their notification and detaches every attachment", async () => {
  const detach = vi.fn(), unsubscribe = vi.fn();
  const original = { version: 1, sessions: [saved("exited"), saved("live")] };
  expect(await probeTerminalAttachments({ mode: "capture" }, {
    factory: { attach: async id => ({ detach, onExit(listener) {
      if (id === "exited") queueMicrotask(() => listener({ exitCode: 0 }));
      return unsubscribe;
    } }) }, readSessions: async () => original, isMissingSession: () => false,
  })).toEqual({ sessionIds: ["live"] });
  expect(detach).toHaveBeenCalledTimes(2);
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(original.sessions.map(({ tab }) => tab.id)).toEqual(["exited", "live"]);
});

it.each(["capture", "verify"])("fails %s when attachment fails without disclosing terminal error text", async mode => {
  const factory = { attach: vi.fn(async () => { throw new Error("private broker error"); }) };
  await expect(probeTerminalAttachments({ mode, ...(mode === "verify" ? { sessionIds: ["shell"] } : {}) }, {
    factory, readSessions: async () => ({ version: 1, sessions: [saved("shell")] }), isMissingSession: () => false,
  })).rejects.toThrow(/^Terminal attachment could not be verified for saved session shell\.$/u);
});

it("fails verification when a previously captured session is now missing", async () => {
  await expect(probeTerminalAttachments({ mode: "verify", sessionIds: ["shell"] }, {
    factory: { attach: async () => { throw new PluginSessionMissingError("Gone"); } }, isMissingSession: () => true,
  })).rejects.toThrow("saved session shell");
});

it("does not disclose unreadable saved state and validates capture before attaching", async () => {
  const factory = { attach: vi.fn() };
  await expect(probeTerminalAttachments({ mode: "capture" }, {
    factory, readSessions: async () => { throw new Error("private saved input in invalid JSON"); },
  })).rejects.toThrow(/^Saved terminal sessions could not be read\.$/u);
  for (const saved of [null, { version: 2, sessions: [] }, { version: 1, sessions: [null] }]) {
    await expect(probeTerminalAttachments({ mode: "capture" }, { factory, readSessions: async () => saved })).rejects.toThrow("sessions are invalid");
  }
  await expect(probeTerminalAttachments({ mode: "capture", sessionIds: [] }, { factory })).rejects.toThrow("reads saved sessions");
  expect(await probeTerminalAttachments({ mode: "capture" }, { factory, readSessions: async () => undefined })).toEqual({ sessionIds: [] });
  expect(factory.attach).not.toHaveBeenCalled();
});

it.each([undefined, ["../shell"], ["shell", "shell"], ["x".repeat(129)], Array.from({ length: 257 }, (_, i) => String(i))])(
  "rejects invalid or unbounded expected IDs before touching the broker: %j", async sessionIds => {
    const factory = { attach: vi.fn() };
    await expect(probeTerminalAttachments({ mode: "verify", sessionIds }, { factory })).rejects.toThrow("unique saved session IDs");
    expect(factory.attach).not.toHaveBeenCalled();
  });

it("accepts a bounded private expected list and rejects unsafe paths, modes, and file contents", () => {
  const root = directory();
  const list = path.join(root, "ids.json");
  fs.writeFileSync(list, JSON.stringify({ sessionIds: ["shell"] }), { mode: 0o600 });
  expect(parseTerminalProbeArguments(["verify", root, root, list])).toEqual({ mode: "verify", releaseRoot: root, dataDir: root, sessionIds: ["shell"] });
  for (const args of [["other", root, root], ["capture", root, root, list], ["verify", root, root], ["capture", ".", root]])
    expect(() => parseTerminalProbeArguments(args)).toThrow();
  fs.symlinkSync(root, path.join(root, "linked"));
  expect(() => parseTerminalProbeArguments(["capture", path.join(root, "linked"), root])).toThrow("without symbolic links");
  fs.symlinkSync(list, path.join(root, "linked.json"));
  expect(() => parseTerminalProbeArguments(["verify", root, root, path.join(root, "linked.json")])).toThrow();
  fs.chmodSync(list, 0o644);
  expect(() => parseTerminalProbeArguments(["verify", root, root, list])).toThrow("private regular file");
  fs.chmodSync(list, 0o600);
  for (const value of [{ sessionIds: ["shell"], extra: true }, { sessionIds: ["../shell"] }, "x".repeat(65536)]) {
    fs.writeFileSync(list, JSON.stringify(value));
    expect(() => parseTerminalProbeArguments(["verify", root, root, list])).toThrow();
  }
});

it.skipIf(process.platform !== "linux")("reattaches through a real broker without input, new processes, resizing, or termination", async () => {
  const f = await liveTerminal();
  const dependencies = { factory: f.factory, readSessions: () => new SessionStateStore(f.root).read(),
    isMissingSession: error => error instanceof PluginSessionMissingError };
  const captured = await probeTerminalAttachments({ mode: "capture" }, dependencies);
  expect(captured).toEqual({ sessionIds: ["preserved-shell"] });
  expect(await probeTerminalAttachments({ mode: "verify", ...captured }, dependencies)).toEqual(captured);
  f.assertUntouched();
  const attached = await f.factory.attach("preserved-shell");
  await attached.terminate();
  await expect(probeTerminalAttachments({ mode: "verify", ...captured }, dependencies)).rejects.toThrow("saved session preserved-shell");
}, 15_000);

it.skipIf(process.platform !== "linux")("preserves a live shell while startup retires its already-exited neighbor into saved-tab recovery", async () => {
  const f = await liveTerminal({ exitedShell: true });
  const savedSessions = new SessionStateStore(f.root);
  const before = await savedSessions.read();
  const dependencies = { factory: f.factory, readSessions: () => savedSessions.read(),
    isMissingSession: error => error instanceof PluginSessionMissingError };
  const captured = await probeTerminalAttachments({ mode: "capture" }, dependencies);
  expect(captured).toEqual({ sessionIds: ["preserved-shell"] });
  expect(await savedSessions.read()).toEqual(before);
  f.assertUntouched();

  const plugins = new PluginRegistry();
  plugins.register(new StandardTerminalPlugin(f.factory));
  const sessions = new SessionStore(plugins, new PathPolicy([f.root]), new TabContextService(f.root),
    undefined, undefined, undefined, undefined, savedSessions);
  cleanups.push(() => sessions.dispose());
  await sessions.restore();
  expect(sessions.getTab("preserved-shell").status).toBe("running");
  expect(sessions.getTab("exited-shell").recovery?.state).toBe("missing");
  expect(await f.factory.attach("exited-shell").catch(error => error)).toBeInstanceOf(PluginSessionMissingError);
  expect(await probeTerminalAttachments({ mode: "verify", ...captured }, dependencies)).toEqual(captured);
  const recovered = (await savedSessions.read()).sessions.find(({ tab }) => tab.id === "exited-shell");
  expect(recovered.tab.cwd).toBe(f.root);
  expect(recovered.initialInput).toEqual({ command: "MUST_NOT_REPLAY" });
  f.assertLiveShellUntouched();
}, 15_000);

it.skipIf(process.platform !== "linux")("excludes an exited shell when every broker message arrives in separate delayed fragments", async () => {
  const f = await liveTerminal({ exitedShell: true });
  const proxy = await fragmentedBroker(terminalSocketPath(f.root));
  const captured = await probeTerminalAttachments({ mode: "capture" }, {
    factory: proxy.factory, readSessions: () => new SessionStateStore(f.root).read(),
    isMissingSession: error => error instanceof PluginSessionMissingError,
  });
  expect(captured).toEqual({ sessionIds: ["preserved-shell"] });
  expect(proxy.messages.some(messages => messages.slice(-2).join(",") === "exit,ready")).toBe(true);
  f.assertUntouched();
}, 15_000);

it.skipIf(process.platform !== "linux" || !fs.existsSync(path.join(releaseRoot, "apps/server/dist/terminal/DurableTerminalProcess.js")))(
  "runs the production probe child against the built release and a live terminal, returning JSON without terminal output", async () => {
    const f = await liveTerminal();
    const run = (...args) => promisify(execFile)(process.execPath, [probeFile, ...args], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const captured = await run("capture", releaseRoot, f.root);
    expect(captured).toEqual({ stdout: '{"sessionIds":["preserved-shell"]}\n', stderr: "" });
    const list = path.join(f.root, "expected.json");
    fs.writeFileSync(list, captured.stdout, { mode: 0o600 });
    expect(await run("verify", releaseRoot, f.root, list)).toEqual(captured);
    f.assertUntouched();
    const attached = await f.factory.attach("preserved-shell");
    await attached.terminate();
    await expect(run("verify", releaseRoot, f.root, list)).rejects.toMatchObject({ code: 1, stdout: "",
      stderr: "Terminal attachment could not be verified for saved session preserved-shell.\n" });
  }, 20_000);

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-attachment-probe-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function saved(id, pluginId = "standard-terminal", cwd = "/tmp") {
  return { tab: { id, pluginId, title: "Preserved tab", cwd, createdAt: "then", updatedAt: "now", status: "running",
    indicator: { color: "green", label: "Running", updatedAt: "now" } }, initialInput: { command: "MUST_NOT_REPLAY" } };
}

async function fragmentedBroker(socketPath) {
  const root = directory(), proxyPath = path.join(root, "proxy.sock");
  const sockets = new Set(), timers = new Set(), messages = [];
  const server = net.createServer(client => {
    const broker = net.createConnection(socketPath);
    sockets.add(client); sockets.add(broker);
    client.pipe(broker);
    client.on("close", () => broker.destroy());
    broker.on("error", () => client.destroy());
    const delivered = []; messages.push(delivered);
    let pending = "", forwarding = Promise.resolve();
    broker.setEncoding("utf8");
    broker.on("data", chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end + 1); pending = pending.slice(end + 1);
        delivered.push(JSON.parse(line).type);
        forwarding = forwarding.then(() => new Promise(resolve => {
          if (client.destroyed) return resolve();
          client.write(line.slice(0, -1));
          const delayed = { resolve, timer: setTimeout(() => {
            timers.delete(delayed);
            if (!client.destroyed) client.write("\n");
            resolve();
          }, 10) };
          timers.add(delayed);
        }));
      }
    });
  });
  await new Promise(resolve => server.listen(proxyPath, resolve));
  fs.chmodSync(proxyPath, 0o600);
  cleanups.push(async () => {
    for (const { timer, resolve } of timers) { clearTimeout(timer); resolve(); }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { messages, factory: new DurableTerminalProcessFactory(proxyPath, { spawn() { throw new Error("The attachment proxy cannot create terminals."); } }) };
}

async function liveTerminal({ exitedShell = false } = {}) {
  const root = directory();
  const socket = terminalSocketPath(root);
  cleanups.push(() => fs.rmSync(path.dirname(socket), { recursive: true, force: true }));
  const native = new NodePtyTerminalProcessFactory();
  const mutations = [];
  const spawn = vi.fn(async (...args) => {
    const terminal = await native.spawn(...args);
    for (const method of ["write", "resize", "kill", "terminate"]) mutations.push(vi.spyOn(terminal, method));
    return terminal;
  });
  const broker = new TerminalBroker(socket, { spawn });
  await broker.start();
  cleanups.push(() => broker.stop());
  const factory = new DurableTerminalProcessFactory(socket, { spawn: () => { throw new Error("Direct spawn is forbidden"); } });
  const pidFile = path.join(root, "pid");
  const launches = path.join(root, "launches");
  const script = path.join(root, "terminal.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(launches)}, 'launched\\n');
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('PRIVATE_TERMINAL_OUTPUT\\n'); setInterval(() => {}, 1000);`);
  const terminal = await factory.spawn(process.execPath, [script], { cwd: root, env: process.env, cols: 100, rows: 30, sessionId: "preserved-shell" });
  let output = "";
  terminal.onData(data => { output += data; });
  await vi.waitFor(() => expect(output).toContain("PRIVATE_TERMINAL_OUTPUT"));
  terminal.detach();
  const liveMutations = [...mutations];
  if (exitedShell) {
    const exited = await factory.spawn(process.execPath, ["-e", "process.exit(0)"], { cwd: root, env: process.env, cols: 100, rows: 30, sessionId: "exited-shell" });
    await new Promise(resolve => exited.onExit(resolve));
    exited.detach();
  }
  await new SessionStateStore(root).save({ version: 1, sessions: [saved("preserved-shell", "standard-terminal", root),
    exitedShell ? saved("exited-shell", "standard-terminal", root) : saved("already-closed", "codex-terminal", root)] });
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  const assertLiveShellUntouched = () => {
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(fs.readFileSync(launches, "utf8")).toBe("launched\n");
    expect(spawn).toHaveBeenCalledTimes(exitedShell ? 2 : 1);
    for (const method of liveMutations) expect(method).not.toHaveBeenCalled();
  };
  return { root, factory, assertLiveShellUntouched, assertUntouched() {
    assertLiveShellUntouched();
    for (const method of mutations) expect(method).not.toHaveBeenCalled();
  } };
}

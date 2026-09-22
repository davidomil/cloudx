import { execFile } from "node:child_process";
import fs from "node:fs";
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
import { parseTerminalProbeArguments, probeTerminalAttachments } from "./managed-update-terminals.mjs";

const cleanups = [];
const releaseRoot = fileURLToPath(new URL("..", import.meta.url));
const probeFile = fileURLToPath(new URL("./managed-update-terminals.mjs", import.meta.url));
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("captures only saved unowned terminal sessions, omitting typed missing sessions and detaching successes", async () => {
  const detach = vi.fn();
  const factory = { attach: vi.fn(async id => {
    if (id === "missing") throw new PluginSessionMissingError("Already closed");
    return { detach, write: () => { throw new Error("No input allowed"); } };
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

async function liveTerminal() {
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
  await new SessionStateStore(root).save({ version: 1, sessions: [saved("preserved-shell", "standard-terminal", root), saved("already-closed", "codex-terminal", root)] });
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  return { root, factory, assertUntouched() {
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(fs.readFileSync(launches, "utf8")).toBe("launched\n");
    expect(spawn).toHaveBeenCalledTimes(1);
    for (const method of mutations) expect(method).not.toHaveBeenCalled();
  } };
}

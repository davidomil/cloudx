import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@cloudx/shared";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexTerminalSession } from "./CodexTerminalPlugin.js";
import type { TerminalProcess } from "../terminal/TerminalProcess.js";
import type { TerminalExit } from "../terminal/TerminalSupervisor.js";

const helper = new URL("../../helpers/codex-worker-bridge.mjs", import.meta.url);
const { CodexWorkerTurn, saveTurnReceipt } = await import(helper.href);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
const binding = { workerId: "worker", attemptId: "attempt", receiptPath: "/unused" };
const start = { id: 4, method: "turn/start", params: { threadId: "thread" } };
const response = { id: 4, result: { turn: { id: "turn", status: "inProgress" } } };
const complete = (status = "completed", threadId = "thread", turnId = "turn") => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });

it.each(["completed", "interrupted", "failed"])("pins the actual turn/start identity and records native %s once", status => {
  const saved: unknown[] = [];
  const owner = new CodexWorkerTurn(binding, (value: unknown) => saved.push(value));
  owner.fromServer(complete());
  owner.fromClient(start);
  owner.fromServer(response);
  owner.fromServer({ id: 4, result: { turn: { id: "unrelated-turn", status: "inProgress" } } });
  owner.fromServer(complete("completed", "subagent"));
  owner.fromServer(complete("completed", "thread", "earlier-turn"));
  owner.fromServer(complete("inProgress"));
  owner.fromServer({ method: "turn/completed", params: { turn: { status: "completed" } } });
  expect(saved).toEqual([{ workerId: "worker", attemptId: "attempt", threadId: "thread", turnId: "turn", status: "running" }]);
  owner.fromServer(complete(status));
  owner.fromServer(complete());
  expect(saved).toHaveLength(2);
  expect(saved[1]).toMatchObject({ status, attemptId: "attempt" });
  expect(() => owner.fromClient({ ...start, id: 5 })).toThrow("another Codex turn");
});

it("handles completion before the start reply and retains the native error", () => {
  const saved: unknown[] = [];
  const owner = new CodexWorkerTurn(binding, (value: unknown) => saved.push(value));
  owner.fromClient(start);
  owner.fromServer({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "failed", error: { message: "Provider rejected the turn." } } } });
  expect(saved).toHaveLength(0);
  owner.fromServer(response);
  expect(saved.at(-1)).toMatchObject({ status: "failed", error: "Provider rejected the turn." });
});

it("preserves only native final messages from the pinned worker turn", () => {
  const finals: unknown[] = [];
  const owner = new CodexWorkerTurn(binding, () => undefined, (value: unknown) => finals.push(value));
  owner.fromClient(start);
  owner.fromServer(response);
  const item = { type: "agentMessage", phase: "final_answer", text: "Owned final response." };
  owner.fromServer({ method: "item/completed", params: { threadId: "subagent", turnId: "turn", item } });
  owner.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: "old-turn", item } });
  owner.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { ...item, phase: "commentary" } } });
  expect(finals).toEqual([]);
  owner.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item } });
  expect(finals).toEqual([{ workerId: "worker", attemptId: "attempt", threadId: "thread", turnId: "turn", status: "running", text: item.text }]);
  owner.fromServer(complete());
  owner.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { ...item, text: "Later output." } } });
  expect(finals).toHaveLength(1);
});

it("rejects a changed resumed thread and invalid native turn identity", () => {
  const owner = new CodexWorkerTurn({ ...binding, expectedThreadId: "review-thread" }, () => undefined);
  expect(() => owner.fromClient(start)).toThrow("different conversation");
  const malformed = new CodexWorkerTurn(binding, () => undefined);
  expect(() => malformed.fromClient({ method: "turn/start", params: {} })).toThrow("missing");
  malformed.fromClient(start);
  expect(() => malformed.fromServer({ id: 4, result: { turn: { status: "completed" } } })).toThrow("missing turn identity");
});

it("atomically retains completion proof for a fresh reader after process restart", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-turn-receipt-"));
  directories.push(directory);
  const receiptPath = path.join(directory, "attempt.json");
  const owner = new CodexWorkerTurn(binding, (value: unknown) => saveTurnReceipt(receiptPath, value));
  owner.fromClient(start);
  owner.fromServer(response);
  owner.fromServer(complete());
  expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toEqual({ workerId: "worker", attemptId: "attempt", threadId: "thread", turnId: "turn", status: "completed" });
  expect(await fs.readdir(directory)).toEqual(["attempt.json"]);
});

it.each(["signalled exit", "cancellation before exit", "cancellation during cleanup"])("never marks a native handoff completed after %s", async scenario => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-cancelled-handoff-"));
  directories.push(directory);
  const nativeTurn = { ...binding, receiptPath: path.join(directory, "turn.json") };
  await fs.writeFile(nativeTurn.receiptPath, JSON.stringify({ ...binding, threadId: "thread", turnId: "turn", status: "completed" }));
  const exitListeners = new Set<(event: TerminalExit) => void>();
  let exited = false;
  const exit = (event: TerminalExit) => { exited = true; for (const listener of [...exitListeners]) listener(event); };
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const terminate = vi.fn(async () => {
    if (scenario === "cancellation during cleanup" && terminate.mock.calls.length === 1) return cleanup;
    if (!exited) exit({ exitCode: 0, signal: 9 });
  });
  const terminal: TerminalProcess = {
    onData: () => () => undefined,
    onExit: listener => { exitListeners.add(listener); return () => { exitListeners.delete(listener); }; },
    write: vi.fn(), resize: () => undefined, kill: () => exit({ exitCode: 0, signal: 9 }), terminate
  };
  const tab: WorkspaceTab = { id: "owned", pluginId: "codex-terminal", title: "Owned", cwd: directory, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
  const session = new CodexTerminalSession(tab, terminal, undefined, { closeOnExit: false, nativeTurn });
  const finish = Promise.resolve(session.handleAction("finish", { threadId: "thread", turnId: "turn" }));
  const rejection = expect(finish).rejects.toThrow(scenario === "signalled exit" ? "signal 15" : "cancelled");
  await vi.waitFor(() => expect(terminal.write).toHaveBeenCalledWith("\u0015/quit"));
  if (scenario === "signalled exit") exit({ exitCode: 0, signal: 15 });
  else {
    if (scenario === "cancellation during cleanup") {
      exit({ exitCode: 0 });
      await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    }
    await session.handleAction("stop", {});
    releaseCleanup();
  }
  await rejection;
  expect(session.snapshot().status).toBe(scenario === "signalled exit" ? "failed" : "stopped");
});

it("retains the native final response even when the visible client exits before rendering it and reaps descendants", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-bridge-"));
  directories.push(directory);
  const command = path.join(directory, "codex.mjs");
  const receiptPath = path.join(directory, "turn.json");
  const reportPath = path.join(directory, "report.json");
  const releasePath = path.join(directory, "release-final");
  const childPath = path.join(directory, "child.pid");
  const ws = pathToFileURL(createRequire(import.meta.url).resolve("ws")).href;
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import WebSocket from ${JSON.stringify(ws)};
if (process.argv.includes('app-server')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(childPath)}, String(child.pid));
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method !== 'turn/start') return;
    send({ id: message.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
    fs.writeFileSync(${JSON.stringify(reportPath)}, '{}');
    const release = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
      clearInterval(release);
      send({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'The delayed final response is preserved.' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    }, 10);
  });
} else {
  const socket = new WebSocket(process.argv[process.argv.indexOf('--remote') + 1], { headers: { Authorization: 'Bearer ' + process.env.CLOUDX_CODEX_WORKER_TOKEN } });
  socket.on('open', () => socket.send(JSON.stringify(${JSON.stringify(start)})));
  // Intentionally omit rendering the final event: shutdown must retain it anyway.
  socket.on('message', () => {});
  process.stdin.setRawMode(true);
  process.stdin.on('data', data => { if (data.toString().includes('/quit')) { process.stdout.write('Native conversation closed.\\r\\n', () => process.exit(0)); } });
}
`);
  await fs.chmod(command, 0o755);
  const terminal = await new NodePtyTerminalProcessFactory().spawn(process.execPath, [fileURLToPath(helper), JSON.stringify({
    binding: { ...binding, receiptPath }, command, serverArgs: ["app-server"], tuiArgs: []
  })], { cwd: directory, env: process.env, cols: 100, rows: 30 });
  const tab: WorkspaceTab = { id: "owned", pluginId: "codex-terminal", title: "Owned", cwd: directory, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
  const session = new CodexTerminalSession(tab, terminal, undefined, { closeOnExit: false, nativeTurn: { ...binding, receiptPath } });
  try {
    await expect.poll(async () => fs.access(reportPath).then(() => true, () => false)).toBe(true);
    await expect.poll(async () => fs.readFile(receiptPath, "utf8").then(text => JSON.parse(text).status, () => undefined)).toBe("running");
    await expect(session.handleAction("finish", { threadId: "thread", turnId: "turn" })).rejects.toThrow("not completed successfully");
    expect(session.hasExited()).toBe(false);
    await fs.writeFile(releasePath, "release");
    await expect.poll(async () => JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe("completed");
    await expect(session.handleAction("finish", { threadId: "thread", turnId: "old-turn" })).rejects.toThrow("not completed successfully");
    await session.handleAction("finish", { threadId: "thread", turnId: "turn" });
    expect(session.snapshot()).toMatchObject({ status: "completed" });
    expect(session.snapshot().recentOutput).toContain("The delayed final response is preserved.");
    const screen = await session.attachTerminal(() => undefined);
    expect(screen.screen.data).toContain("The delayed final response is preserved.");
    screen.dispose();
    const child = (await fs.readFile(childPath, "utf8")).trim();
    await expect(fs.access(`/proc/${child}`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await terminal.terminate(); }
}, 10_000);

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import type { TerminalExit } from "../terminal/TerminalSupervisor.js";

const { CodexConversationSelection } = await import(new URL("../../helpers/codex-conversation-selection.mjs", import.meta.url).href);
const { CodexConversationForks, MAX_CONVERSATION_FORKS } = await import(new URL("../../helpers/codex-conversation-forks.mjs", import.meta.url).href);
const bridge = new URL("../../helpers/codex-worker-bridge.mjs", import.meta.url);
const sourceId = "01a08470-d118-7b72-b1df-439e72e5c744";
const childId = "01a08470-d118-7b72-b1df-439e72e5c745";
const executionId = "01a08470-d118-7b72-b1df-439e72e5c746";
const binding = { tabId: "source-tab", executionId, receiptPath: "/tmp/forks.json", resumeArgs: ["--config", "skills.bundled.enabled=false"] };
const selectionBinding = { ...binding, receiptPath: "/tmp/source.json" };
const forkRequest = { id: 4, method: "thread/fork", params: { threadId: sourceId } };
const reply = { id: 4, result: { thread: { id: childId, cwd: "/fork", path: "/fork/child.jsonl" } } };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

function sourceSelection() {
  const save = vi.fn();
  const selection = new CodexConversationSelection(selectionBinding, save);
  selection.fromClient({ id: 1, method: "thread/resume", params: { threadId: sourceId } });
  selection.fromServer({ id: 1, result: { thread: { id: sourceId, cwd: "/source" } } });
  return { selection, save };
}

it("separates a correlated confirmed child from the original conversation without publishing before retirement", () => {
  const { selection, save: saveSource } = sourceSelection();
  const save = vi.fn();
  const forks = new CodexConversationForks(binding, selection, save);
  expect(forks.fromClient(forkRequest)).toBe(true);
  expect(forks.fromServer({ ...reply, id: "4" })).toBeUndefined();
  expect(forks.fromServer({ method: "thread/started", params: reply.result })).toBeUndefined();
  const fork = forks.fromServer(reply);
  expect(fork).toEqual({ sourceId, sourceCwd: "/source", sessionId: childId, cwd: "/fork", transcriptPath: "/fork/child.jsonl" });
  expect(save).not.toHaveBeenCalled();
  expect(selection.selectedThreadId).toBe(sourceId);
  expect(saveSource).toHaveBeenCalledTimes(1);
  forks.publish(fork);
  forks.publish(fork);
  expect(forks.fromServer(reply)).toBeUndefined();
  expect(save).toHaveBeenCalledExactlyOnceWith({ version: 1, tabId: binding.tabId, executionId,
    forks: [{ sessionId: childId, cwd: "/fork", transcriptPath: "/fork/child.jsonl" }] });
});

it("preserves failed forks and startup picker choices without publishing a child", () => {
  const { selection } = sourceSelection();
  const save = vi.fn();
  const forks = new CodexConversationForks(binding, selection, save);
  forks.fromClient(forkRequest);
  expect(forks.fromServer({ id: 4, error: { message: "Cancelled" } })).toBeUndefined();
  expect(forks.fromServer(reply)).toBeUndefined();
  selection.selectedThreadId = undefined;
  expect(forks.fromClient(forkRequest)).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

it.each([
  { thread: { ...reply.result.thread, id: sourceId } },
  { thread: { ...reply.result.thread, id: "not-a-session" } },
  { thread: { ...reply.result.thread, cwd: "relative" } },
  { thread: { ...reply.result.thread, path: "relative" } },
  { thread: { ...reply.result.thread, ephemeral: true } },
])("rejects malformed child identities without changing the source: %j", result => {
  const { selection } = sourceSelection();
  const forks = new CodexConversationForks(binding, selection, vi.fn());
  forks.fromClient(forkRequest);
  expect(() => forks.fromServer({ id: 4, result })).toThrow("invalid child identity");
  expect(selection.selectedThreadId).toBe(sourceId);
});


it("preserves the visible source when native forks another saved session", () => {
  const { selection } = sourceSelection();
  const forks = new CodexConversationForks(binding, selection, vi.fn());
  forks.fromClient({ ...forkRequest, params: { threadId: executionId, cwd: "/fork" } });
  expect(forks.fromServer(reply)).toMatchObject({ sourceId, sourceCwd: "/source", sessionId: childId });
  expect(selection.selectedThreadId).toBe(sourceId);
});

it("bounds pending fork requests and the durable fork journal explicitly", () => {
  const { selection } = sourceSelection();
  const forks = new CodexConversationForks(binding, selection, vi.fn());
  forks.fromClient(forkRequest);
  expect(() => forks.fromClient(forkRequest)).toThrow("reused request");
  forks.forks = Array.from({ length: MAX_CONVERSATION_FORKS }, (_, index) => ({ sessionId: `existing-${index}`, cwd: "/fork" }));
  expect(() => forks.fromClient({ ...forkRequest, id: 5 })).toThrow("exceeded their limit");
});

it("rejects an oversized fork journal before changing the saved entries", () => {
  const { selection } = sourceSelection();
  const save = vi.fn();
  const forks = new CodexConversationForks(binding, selection, save);
  expect(() => forks.publish({ sessionId: childId, cwd: `/${"x".repeat(2 * 1024 * 1024)}` })).toThrow("size limit");
  expect(save).not.toHaveBeenCalled();
  expect(forks.forks).toEqual([]);
});

it("rejects an unconfirmed cached source with a correlated error and no native fork", () => {
  const { selection } = sourceSelection();
  const forks = new CodexConversationForks(binding, selection, vi.fn());
  selection.invalidate();
  expect(forks.fromClient(forkRequest)).toEqual({ error: { code: -32600,
    message: "Select a saved session before opening a fork in another CloudX tab." } });
  expect(forks.pending.size).toBe(0);
  expect(selection.unconfirmed).toBe(true);
});

it.each(["success", "failed", "cancelled", "unconfirmed"])("keeps the source usable and retires native owners before the %s fork handoff", async outcome => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fork-bridge-"));
  directories.push(directory);
  const command = path.join(directory, "codex.mjs");
  const processPath = path.join(directory, "processes.jsonl");
  const receiptPath = path.join(directory, "source.json");
  const forkPath = path.join(directory, "forks.json");
  const observedPath = path.join(directory, "observed.json");
  const ws = pathToFileURL(createRequire(import.meta.url).resolve("ws")).href;
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { once } from 'node:events';
import WebSocket from ${JSON.stringify(ws)};
const backend = process.argv.includes('app-server');
const previous = fs.existsSync(${JSON.stringify(processPath)}) ? fs.readFileSync(${JSON.stringify(processPath)}, 'utf8').trim().split('\\n').map(JSON.parse) : [];
const launches = previous.filter(entry => entry.backend === false).length;
if (backend) for (const old of previous.filter(entry => entry.backend)) {
  try { process.kill(old.pid, 0); throw new Error('Old backend still alive'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
fs.appendFileSync(${JSON.stringify(processPath)}, JSON.stringify({ pid: process.pid, backend, args: process.argv.slice(2) }) + '\\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
if (backend) {
  const reader = readline.createInterface({ input: process.stdin });
  reader.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId, cwd: ${JSON.stringify(directory)} } } });
    else if (message.method === 'thread/fork') {
      if (${JSON.stringify(outcome)} === 'unconfirmed') throw new Error('Unconfirmed fork reached backend');
      if (${JSON.stringify(outcome)} === 'failed') send({ id: message.id, error: { code: -32000, message: 'Fork rejected' } });
      else {
        const child = launches === 1 ? ${JSON.stringify(childId)} : '01a08470-d118-7b72-b1df-439e72e5c747';
        const response = { id: message.id, result: { thread: { id: child, cwd: ${JSON.stringify(directory)}, path: ${JSON.stringify(path.join(directory, "child.jsonl"))} } } };
        send({ method: 'thread/started', params: response.result }); send(response); send(response);
      }
    } else if (message.method === 'turn/start') {
      if (message.params.threadId !== (${JSON.stringify(outcome)} === 'unconfirmed' ? ${JSON.stringify(childId)} : ${JSON.stringify(sourceId)})) throw new Error('Source changed to child');
      send({ id: message.id, result: { turn: { id: 'source-turn', status: 'inProgress' } } });
      send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'source-turn', status: 'completed' } } });
    }
  });
  reader.on('close', () => setTimeout(() => process.exit(0), 75));
} else {
  if (launches > 0 && (!process.argv.includes('resume') || process.argv.at(-1) !== ${JSON.stringify(sourceId)} || process.argv.includes('DO NOT REPLAY'))) throw new Error('Invalid parent resume arguments');
  const socket = new WebSocket(process.argv[process.argv.indexOf('--remote') + 1], { headers: { Authorization: 'Bearer ' + process.env.CLOUDX_CODEX_WORKER_TOKEN } });
  socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: ${JSON.stringify(sourceId)} } })));
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.id === 1) {
      if (JSON.parse(fs.readFileSync(${JSON.stringify(receiptPath)}, 'utf8')).sessionId !== ${JSON.stringify(sourceId)}) throw new Error('Source receipt changed');
      if (${JSON.stringify(outcome)} === 'unconfirmed') socket.send(JSON.stringify({ id: 2, method: 'thread/resume', params: { threadId: ${JSON.stringify(childId)} } }));
      else if (${JSON.stringify(outcome)} === 'success' && launches < 2 || ${JSON.stringify(outcome)} === 'failed') socket.send(JSON.stringify({ id: 4, method: 'thread/fork', params: { threadId: ${JSON.stringify(sourceId)} } }));
      else socket.send(JSON.stringify({ id: 5, method: 'turn/start', params: { threadId: ${JSON.stringify(sourceId)} } }));
    } else if (message.id === 2) {
      socket.send(JSON.stringify({ id: 3, method: 'thread/read', params: { threadId: ${JSON.stringify(sourceId)} } }));
      socket.send(JSON.stringify({ id: 4, method: 'thread/fork', params: { threadId: ${JSON.stringify(childId)} } }));
    } else if (message.id === 4) {
      if (!message.error) throw new Error('Source TUI received child success');
      if (${JSON.stringify(outcome)} === 'unconfirmed' && !message.error.message.includes('Select a saved session')) throw new Error('Missing source selection instruction');
      socket.send(JSON.stringify({ id: 5, method: 'turn/start', params: { threadId: ${JSON.stringify(outcome)} === 'unconfirmed' ? ${JSON.stringify(childId)} : ${JSON.stringify(sourceId)} } }));
    } else if (message.method === 'turn/completed') {
      const forks = fs.existsSync(${JSON.stringify(forkPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(forkPath)}, 'utf8')).forks : [];
      fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ sourceUsable: true, forks }));
      socket.close(); setTimeout(() => process.exit(0), 50);
    }
  });
}
`, { mode: 0o755 });
  const terminal = await new NodePtyTerminalProcessFactory().spawn(process.execPath, [fileURLToPath(bridge), JSON.stringify({
    selection: { tabId: binding.tabId, executionId, receiptPath },
    forks: { ...binding, receiptPath: forkPath, resumeArgs: [] },
    command, serverArgs: ["app-server"], tuiArgs: ["--", "DO NOT REPLAY"]
  })], { cwd: directory, env: { PATH: process.env.PATH }, cols: 100, rows: 30 });
  let output = "";
  let exit: TerminalExit | undefined;
  terminal.onData(chunk => { output = (output + chunk).slice(-8192); });
  terminal.onExit(event => { exit = event; });
  try {
    await expect.poll(() => exit ?? output, { timeout: 10_000 }).toMatchObject({ exitCode: 0 });
    const observed = JSON.parse(await fs.readFile(observedPath, "utf8"));
    expect(observed.sourceUsable).toBe(true);
    expect(observed.forks.map((fork: { sessionId: string }) => fork.sessionId)).toEqual(outcome === "success" ? [childId, "01a08470-d118-7b72-b1df-439e72e5c747"] : []);
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject(outcome === "unconfirmed"
      ? { authority: "unconfirmed", executionId } : { sessionId: sourceId, executionId });
    const processes = (await fs.readFile(processPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(processes.filter(entry => !entry.backend)).toHaveLength(outcome === "success" ? 3 : 1);
    for (const entry of processes) await expect(fs.access(`/proc/${entry.pid}`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await terminal.terminate(); }
}, 15_000);

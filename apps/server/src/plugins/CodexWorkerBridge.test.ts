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
const { CodexRemotePermissions } = await import(new URL("../../helpers/codex-remote-permissions.mjs", import.meta.url).href);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
const binding = { workerId: "worker", attemptId: "attempt", receiptPath: "/unused" };
const start = { id: 4, method: "turn/start", params: { threadId: "thread" } };
const response = { id: 4, result: { turn: { id: "turn", status: "inProgress" } } };
const complete = (status = "completed", threadId = "thread", turnId = "turn") => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
const titleThreadStart = { id: "temporary-structured-thread", method: "thread/start", params: { threadSource: "system", ephemeral: true } };
const titleThreadResponse = { id: titleThreadStart.id, result: { thread: { id: "title-thread" } } };
const titleTurnStart = { id: "temporary-structured-turn", method: "turn/start", params: { threadId: "title-thread", outputSchema: { type: "object", properties: { title: { type: "string" } } } } };

it.each([true, false])("preserves native writable roots and applies the selected fresh-thread YOLO policy %s", yoloMode => {
  const request = { id: 1, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project", "/existing-writable"], approvalPolicy: "on-request", sandbox: "workspace-write", permissions: null } };
  new CodexRemotePermissions({ yoloMode, additionalWritableRoots: ["/cloudx-skills", "/existing-writable"] }).fromClient(request);
  expect(request.params).toEqual({
    runtimeWorkspaceRoots: ["/project", "/existing-writable", "/cloudx-skills"],
    approvalPolicy: yoloMode ? "never" : "on-request", sandbox: yoloMode ? "danger-full-access" : "workspace-write", permissions: null
  });
});

it.each(["thread/resume", "thread/fork"])("keeps native saved permission selection during %s", method => {
  const request = { id: 1, method, params: { threadId: "saved", runtimeWorkspaceRoots: ["/project"], approvalPolicy: null, sandbox: null, permissions: null } };
  const permissions = new CodexRemotePermissions({ yoloMode: true, additionalWritableRoots: ["/cloudx-skills"] });
  permissions.fromClient(request);
  expect(request.params).toEqual({ threadId: "saved", runtimeWorkspaceRoots: ["/project", "/cloudx-skills"], approvalPolicy: null, sandbox: null, permissions: null });
  const rejoin = { id: 2, method, params: { threadId: "loaded" } };
  permissions.fromClient(rejoin);
  expect(rejoin.params).toEqual({ threadId: "loaded" });
});

it("keeps auxiliary thread permissions native and rejects unresolved new-thread roots", () => {
  const permissions = new CodexRemotePermissions({ yoloMode: true, additionalWritableRoots: ["/cloudx-skills"] });
  const auxiliary = structuredClone(titleThreadStart);
  permissions.fromClient(auxiliary);
  expect(auxiliary).toEqual(titleThreadStart);
  expect(() => permissions.fromClient({ method: "thread/start", params: {} })).toThrow("resolved workspace roots");
  expect(() => permissions.fromClient({ method: "thread/start", params: { runtimeWorkspaceRoots: ["relative"] } })).toThrow("workspace roots are invalid");
  expect(() => new CodexRemotePermissions({ yoloMode: true, additionalWritableRoots: ["relative"] })).toThrow("Invalid Codex launch permissions");
  const initial = { id: 1, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"] } };
  permissions.fromClient(initial);
  expect(initial.params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
});

it.each(["thread/resume", "thread/fork"])("preserves native permissions on new threads after initial %s", method => {
  const permissions = new CodexRemotePermissions({ yoloMode: true, additionalWritableRoots: ["/cloudx-skills"] });
  permissions.fromClient({ method: "initialize", params: {} });
  permissions.fromClient({ id: 1, method, params: { runtimeWorkspaceRoots: ["/project"] } });
  permissions.fromServer({ id: 1, result: { thread: { id: "saved" } } });
  for (const policy of [
    { approvalPolicy: "on-request", sandbox: "workspace-write", permissions: null },
    { approvalPolicy: "on-request", sandbox: null, permissions: ":workspace" }
  ]) {
    const next = { method: "thread/start", params: { ...policy, runtimeWorkspaceRoots: ["/project", "/cloudx-skills"] } };
    permissions.fromClient(next);
    expect(next.params).toEqual({ ...policy, runtimeWorkspaceRoots: ["/project", "/cloudx-skills"] });
  }
});

it.each([true, false])("retains launch YOLO choice %s across native new-thread requests until permissions change", yoloMode => {
  const permissions = new CodexRemotePermissions({ yoloMode, additionalWritableRoots: ["/cloudx-skills"] });
  for (const id of [1, 2, 3]) {
    const next = { id, method: "thread/start", params: { approvalPolicy: "on-request", sandbox: "read-only", permissions: null, runtimeWorkspaceRoots: ["/project"] } };
    permissions.fromClient(next);
    permissions.fromServer({ id, result: { thread: { id: `thread-${id}` } } });
    expect(next.params).toEqual({ approvalPolicy: yoloMode ? "never" : "on-request", sandbox: yoloMode ? "danger-full-access" : "read-only", permissions: null, runtimeWorkspaceRoots: ["/project", "/cloudx-skills"] });
  }
});

function launchedPermissions() {
  const permissions = new CodexRemotePermissions({ yoloMode: true, additionalWritableRoots: ["/cloudx-skills"] });
  permissions.fromClient({ id: 1, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"] } });
  permissions.fromServer({ id: 1, result: { thread: { id: "selected" } } });
  return permissions;
}

it.each([
  { approvalPolicy: "on-request" },
  { sandboxPolicy: { type: "workspace-write", writableRoots: ["/project"] } },
  { permissions: ":workspace" },
  { permissions: "custom-profile" },
  { approvalsReviewer: "user" }
])("preserves confirmed native policy changes through later new-thread requests: %j", policy => {
  const permissions = launchedPermissions();
  const update = { id: 2, method: "thread/settings/update", params: { threadId: "selected", ...policy } };
  const original = structuredClone(update);
  permissions.fromClient(update);
  expect(update).toEqual(original);
  permissions.fromServer({ id: 2, method: "thread/settings/updated", params: {} });
  permissions.fromServer({ id: 2, result: {} });
  for (const id of [3, 4]) {
    const next = { id, method: "thread/start", params: { approvalPolicy: "on-request", sandbox: "workspace-write", runtimeWorkspaceRoots: ["/project"] } };
    permissions.fromClient(next);
    expect(next.params).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write", runtimeWorkspaceRoots: ["/project", "/cloudx-skills"] });
  }
});

it("ignores pending policy changes for a conversation that is no longer selected", () => {
  const permissions = launchedPermissions();
  permissions.fromClient({ id: 2, method: "thread/settings/update", params: { threadId: "selected", permissions: ":workspace" } });
  permissions.fromClient({ id: 3, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"] } });
  permissions.fromServer({ id: 3, result: { thread: { id: "next" } } });
  permissions.fromServer({ id: 2, result: {} });
  const next = { id: 4, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"], approvalPolicy: "on-request", sandbox: "read-only" } };
  permissions.fromClient(next);
  expect(next.params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  permissions.fromServer({ id: 4, error: { message: "Cannot create thread." } });
  permissions.fromClient({ id: 5, method: "thread/settings/update", params: { threadId: "next", permissions: ":workspace" } });
  permissions.fromServer({ id: 5, result: {} });
  const restricted = { id: 6, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"], approvalPolicy: "on-request", sandbox: "workspace-write" } };
  permissions.fromClient(restricted);
  expect(restricted.params).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
});

it("bounds pending permission requests and releases failed and successful responses", () => {
  const permissions = launchedPermissions();
  const selection = (id?: number) => ({ id, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"] } });
  expect(() => permissions.fromClient(selection())).toThrow("missing its identity");
  for (let id = 2; id < 34; id++) permissions.fromClient(selection(id));
  expect(() => permissions.fromClient(selection(2))).toThrow("reused a pending identity");
  expect(() => permissions.fromClient(selection(34))).toThrow("pending limit");
  permissions.fromServer({ id: 2, error: { message: "Thread unavailable." } });
  expect(() => permissions.fromClient(selection(34))).not.toThrow();
  permissions.fromServer({ id: 34, result: { thread: { id: "next" } } });
  expect(() => permissions.fromClient(selection(35))).not.toThrow();
  expect(() => permissions.fromServer({ id: 35, result: {} })).toThrow("no thread identity");
});

it("keeps launch permissions after failed, unrelated and auxiliary settings updates", () => {
  const permissions = launchedPermissions();
  permissions.fromClient({ id: 2, method: "thread/settings/update", params: { threadId: "selected", permissions: ":workspace" } });
  permissions.fromServer({ id: 2, error: { message: "Permission profile is unavailable." } });
  permissions.fromServer({ id: 2, result: {} });
  permissions.fromClient({ id: 3, method: "thread/settings/update", params: { threadId: "selected", model: "native-model", approvalPolicy: null, permissions: null } });
  permissions.fromServer({ id: 3, result: {} });
  permissions.fromClient(titleThreadStart);
  permissions.fromServer(titleThreadResponse);
  permissions.fromClient({ id: 4, method: "thread/settings/update", params: { threadId: "title-thread", permissions: ":workspace" } });
  permissions.fromServer({ id: 4, result: {} });
  permissions.fromServer({ method: "thread/settings/updated", params: { threadId: "selected", permissions: ":workspace" } });
  const next = { id: 5, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"], approvalPolicy: "on-request", sandbox: "read-only" } };
  permissions.fromClient(next);
  expect(next.params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
});

it.each(["thread/resume", "thread/fork"])("retains saved native permissions on subsequent new threads after %s", method => {
  const permissions = launchedPermissions();
  permissions.fromClient({ id: 2, method: "thread/resume", params: { threadId: "missing" } });
  permissions.fromServer({ id: 2, error: { message: "No saved conversation." } });
  const afterFailure = { id: 3, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"], approvalPolicy: "on-request", sandbox: "read-only" } };
  permissions.fromClient(afterFailure);
  expect(afterFailure.params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  permissions.fromServer({ id: 3, error: { message: "New conversation unavailable." } });
  permissions.fromClient({ id: 4, method, params: { threadId: "resumed" } });
  permissions.fromServer({ id: 4, result: { thread: { id: "resumed" } } });
  const next = { id: 5, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"], approvalPolicy: "on-request", sandbox: "read-only" } };
  permissions.fromClient(next);
  expect(next.params).toMatchObject({ approvalPolicy: "on-request", sandbox: "read-only" });
  const restricted = { id: 7, method: "thread/start", params: { runtimeWorkspaceRoots: ["/project"], approvalPolicy: "on-request", sandbox: "workspace-write" } };
  permissions.fromClient(restricted);
  expect(restricted.params).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
});

it("makes each selected conversation durable before its native TUI receives the reply", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-selection-bridge-"));
  directories.push(directory);
  const command = path.join(directory, "codex.mjs");
  const receiptPath = path.join(directory, "selected.json");
  const observedPath = path.join(directory, "observed.json");
  const firstId = "01a08470-d118-7b72-b1df-439e72e5c744";
  const secondId = "01a08470-d118-7b72-b1df-439e72e5c745";
  const selection = { tabId: "visible-tab", executionId: firstId, receiptPath };
  const ws = pathToFileURL(createRequire(import.meta.url).resolve("ws")).href;
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import WebSocket from ${JSON.stringify(ws)};
if (process.argv.includes('app-server')) {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (!['thread/start', 'thread/resume'].includes(request.method)) throw new Error('Unexpected request');
    const thread = { id: request.id === 1 ? ${JSON.stringify(firstId)} : ${JSON.stringify(secondId)}, cwd: process.cwd() };
    process.stdout.write(JSON.stringify({ id: request.id, result: { thread } }) + '\\n');
  });
} else {
  const socket = new WebSocket(process.argv[process.argv.indexOf('--remote') + 1], { headers: { Authorization: 'Bearer ' + process.env.CLOUDX_CODEX_WORKER_TOKEN } });
  const observed = [];
  socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} })));
  socket.on('message', data => {
    const reply = JSON.parse(data.toString());
    const receipt = JSON.parse(fs.readFileSync(${JSON.stringify(receiptPath)}, 'utf8'));
    if (receipt.sessionId !== reply.result.thread.id || receipt.executionId !== ${JSON.stringify(firstId)} || receipt.tabId !== 'visible-tab')
      throw new Error('TUI received selection before its bound receipt was durable');
    observed.push(receipt.sessionId);
    if (reply.id === 1) socket.send(JSON.stringify({ id: 2, method: 'thread/resume', params: { threadId: ${JSON.stringify(secondId)} } }));
    else fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify(observed));
  });
}
`, { mode: 0o755 });
  const terminal = await new NodePtyTerminalProcessFactory().spawn(process.execPath, [fileURLToPath(helper), JSON.stringify({
    selection, command, serverArgs: ["app-server"], tuiArgs: []
  })], { cwd: directory, env: process.env, cols: 100, rows: 30 });
  try {
    await expect.poll(async () => fs.readFile(observedPath, "utf8").then(JSON.parse, () => undefined)).toEqual([firstId, secondId]);
  } finally { await terminal.terminate(); }
}, 10_000);

it.each(["before worker start", "before worker reply", "during worker turn", "after worker completion"])("keeps title generation separate %s", timing => {
  const saved: unknown[] = [];
  const finals: unknown[] = [];
  const owner = new CodexWorkerTurn({ ...binding, expectedThreadId: "thread" }, (value: unknown) => saved.push(value), (value: unknown) => finals.push(value));
  if (timing !== "before worker start") owner.fromClient(start);
  if (["during worker turn", "after worker completion"].includes(timing)) owner.fromServer(response);
  if (timing === "after worker completion") owner.fromServer(complete());
  const workerEvidence = [...saved];
  owner.fromClient(titleThreadStart);
  owner.fromServer(titleThreadResponse);
  owner.fromClient(titleTurnStart);
  owner.fromServer({ id: titleTurnStart.id, result: { turn: { id: "title-turn", status: "inProgress" } } });
  owner.fromServer({ method: "turn/started", params: { threadId: "title-thread", turn: { id: "title-turn", status: "inProgress" } } });
  const item = { type: "agentMessage", phase: "final_answer", text: '{"title":"Auxiliary title"}' };
  owner.fromServer({ method: "item/completed", params: { threadId: "title-thread", turnId: "title-turn", item } });
  for (const status of ["failed", "interrupted", "completed"]) {
    const completion = complete(status, "title-thread", "title-turn");
    owner.fromServer({ ...completion, params: { ...completion.params, turn: { ...completion.params.turn, items: [item], error: { message: "Auxiliary failure" } } } });
  }
  expect(saved).toEqual(workerEvidence);
  expect(finals).toEqual([]);
  if (timing === "before worker start") owner.fromClient(start);
  if (["before worker start", "before worker reply"].includes(timing)) owner.fromServer(response);
  owner.fromServer(complete());
  expect(saved).toEqual([
    { workerId: "worker", attemptId: "attempt", threadId: "thread", turnId: "turn", status: "running" },
    { workerId: "worker", attemptId: "attempt", threadId: "thread", turnId: "turn", status: "completed" }
  ]);
  expect(() => owner.fromClient({ ...start, id: 5 })).toThrow("another Codex turn");
});

it("correlates auxiliary creation by request identity regardless of request ID spelling", () => {
  const saved = vi.fn();
  const owner = new CodexWorkerTurn(binding, saved);
  owner.fromClient(start);
  owner.fromClient({ ...titleThreadStart, id: 7 });
  owner.fromServer({ ...titleThreadResponse, id: "7" });
  expect(() => owner.fromClient(titleTurnStart)).toThrow("another Codex turn");
  owner.fromServer({ ...titleThreadResponse, id: 7 });
  owner.fromClient({ ...titleTurnStart, id: 8 });
  owner.fromServer({ id: 8, error: { message: "Title generation unavailable" } });
  expect(saved).not.toHaveBeenCalled();
  owner.fromServer(response);
  owner.fromServer(complete());
  expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "thread", turnId: "turn", status: "completed" }));
});

it.each([
  { name: "unconfirmed creation", request: titleThreadStart, reply: undefined },
  { name: "unrelated response", request: titleThreadStart, reply: { ...titleThreadResponse, id: "unrelated" } },
  { name: "creation notification", request: titleThreadStart, reply: { ...titleThreadResponse, method: "thread/started" } },
  { name: "failed creation", request: titleThreadStart, reply: { id: titleThreadStart.id, error: { message: "Start failed" } } },
  { name: "malformed creation", request: titleThreadStart, reply: { id: titleThreadStart.id, result: { thread: { id: "" } } } },
  { name: "persistent system thread", request: { ...titleThreadStart, params: { threadSource: "system", ephemeral: false } }, reply: titleThreadResponse },
  { name: "ephemeral user thread", request: { ...titleThreadStart, params: { threadSource: "cli", ephemeral: true } }, reply: titleThreadResponse },
  { name: "missing system source", request: { ...titleThreadStart, params: { ephemeral: true } }, reply: titleThreadResponse },
  { name: "missing ephemeral flag", request: { ...titleThreadStart, params: { threadSource: "system" } }, reply: titleThreadResponse },
  { name: "non-boolean ephemeral flag", request: { ...titleThreadStart, params: { threadSource: "system", ephemeral: "true" } }, reply: titleThreadResponse }
])("rejects unknown turns with title-like IDs after $name", ({ request, reply }) => {
  const owner = new CodexWorkerTurn(binding, () => undefined);
  owner.fromClient(start);
  owner.fromServer(response);
  owner.fromClient(request);
  if (reply) owner.fromServer(reply);
  expect(() => owner.fromClient(titleTurnStart)).toThrow("another Codex turn");
});

it("does not reclassify the worker thread as an auxiliary thread", () => {
  const owner = new CodexWorkerTurn(binding, () => undefined);
  owner.fromClient(start);
  owner.fromServer(response);
  owner.fromClient(titleThreadStart);
  expect(() => owner.fromServer({ id: titleThreadStart.id, result: { thread: { id: "thread" } } })).toThrow("worker thread");
  expect(() => owner.fromClient({ ...start, id: titleTurnStart.id })).toThrow("another Codex turn");
});

it("forgets failed auxiliary creation and unsubscribed auxiliary threads", () => {
  const owner = new CodexWorkerTurn(binding, () => undefined);
  owner.fromClient(start);
  owner.fromServer(response);
  owner.fromClient(titleThreadStart);
  owner.fromServer({ id: titleThreadStart.id, error: { message: "Start failed" } });
  owner.fromServer(titleThreadResponse);
  expect(() => owner.fromClient(titleTurnStart)).toThrow("another Codex turn");
  owner.fromClient({ ...titleThreadStart, id: "next-creation" });
  owner.fromServer({ ...titleThreadResponse, id: "next-creation" });
  owner.fromClient(titleTurnStart);
  owner.fromClient({ id: "unsubscribe", method: "thread/unsubscribe", params: { threadId: "title-thread" } });
  expect(() => owner.fromClient({ ...titleTurnStart, id: "next-turn" })).toThrow("another Codex turn");
});

it("requires request identities for auxiliary threads and their turns", () => {
  const owner = new CodexWorkerTurn(binding, () => undefined);
  expect(() => owner.fromClient({ ...titleThreadStart, id: undefined })).toThrow("missing its request identity");
  owner.fromClient(titleThreadStart);
  owner.fromServer(titleThreadResponse);
  expect(() => owner.fromClient({ ...titleTurnStart, id: undefined })).toThrow("missing its request or thread identity");
});

it.each([false, true])("bounds auxiliary tracking and releases capacity (confirmed=%s)", confirmed => {
  const owner = new CodexWorkerTurn(binding, () => undefined);
  for (let id = 0; id < 32; id++) {
    owner.fromClient({ ...titleThreadStart, id });
    if (confirmed) owner.fromServer({ id, result: { thread: { id: `auxiliary-${id}` } } });
  }
  expect(() => owner.fromClient(titleThreadStart)).toThrow("tracking exceeded its limit");
  if (confirmed) owner.fromClient({ id: "unsubscribe", method: "thread/unsubscribe", params: { threadId: "auxiliary-0" } });
  else owner.fromServer({ id: 0, error: { message: "Start failed" } });
  expect(() => owner.fromClient(titleThreadStart)).not.toThrow();
});

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

it("waits past auxiliary completion, retains the worker final response before rendering, and reaps descendants", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-bridge-"));
  directories.push(directory);
  const command = path.join(directory, "codex.mjs");
  const receiptPath = path.join(directory, "turn.json");
  const reportPath = path.join(directory, "report.json");
  const releasePath = path.join(directory, "release-final");
  const titleCompletedPath = path.join(directory, "title-completed");
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
    if (message.method === 'thread/start') {
      send(${JSON.stringify(titleThreadResponse)});
      return;
    }
    if (message.method !== 'turn/start') return;
    if (message.params.threadId === 'title-thread') {
      send({ id: message.id, result: { turn: { id: 'title-turn', status: 'inProgress' } } });
      send({ method: 'item/completed', params: { threadId: 'title-thread', turnId: 'title-turn', item: { type: 'agentMessage', phase: 'final_answer', text: '{"title":"Auxiliary title"}' } } });
      send(${JSON.stringify(complete("completed", "title-thread", "title-turn"))});
      return;
    }
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
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.id === 4) socket.send(JSON.stringify(${JSON.stringify(titleThreadStart)}));
    if (message.id === ${JSON.stringify(titleThreadStart.id)}) socket.send(JSON.stringify(${JSON.stringify(titleTurnStart)}));
    if (message.method === 'turn/completed' && message.params.threadId === 'title-thread')
      fs.writeFileSync(${JSON.stringify(titleCompletedPath)}, 'completed');
  });
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
    await expect.poll(async () => fs.access(titleCompletedPath).then(() => true, () => false)).toBe(true);
    await expect.poll(async () => fs.readFile(receiptPath, "utf8").then(text => JSON.parse(text).status, () => undefined)).toBe("running");
    await expect(fs.access(`${receiptPath}.final.json`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(session.handleAction("finish", { threadId: "thread", turnId: "turn" })).rejects.toThrow("not completed successfully");
    expect(session.hasExited()).toBe(false);
    await fs.writeFile(releasePath, "release");
    await expect.poll(async () => JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe("completed");
    await expect(session.handleAction("finish", { threadId: "thread", turnId: "old-turn" })).rejects.toThrow("not completed successfully");
    await session.handleAction("finish", { threadId: "thread", turnId: "turn" });
    expect(session.snapshot()).toMatchObject({ status: "completed" });
    expect(session.snapshot().recentOutput).toContain("The delayed final response is preserved.");
    expect(session.snapshot().recentOutput).not.toContain("Auxiliary title");
    const screen = await session.attachTerminal(() => undefined);
    expect(screen.screen.data).toContain("The delayed final response is preserved.");
    screen.dispose();
    const child = (await fs.readFile(childPath, "utf8")).trim();
    await expect(fs.access(`/proc/${child}`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await terminal.terminate(); }
}, 10_000);

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, it, vi } from "vitest";
import { COOPERATION_LIMITS, type CooperationAsset, type WorkspaceTab } from "@cloudx/shared";

import { AgentCooperationContext, COOPERATION_HELPER_PATH, cooperationLaunchEnv, type CooperationAgentBinding } from "./AgentCooperationContext.js";
import { COOPERATION_RULES, COOPERATION_SKILLS } from "./cooperationContributions.js";
import { NativeAgentFeedbackPort } from "./NativeAgentFeedbackPort.js";

const run = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(endpoint = "http://127.0.0.1:1/api/cooperation/agent") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-coop-context-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  let binding: CooperationAgentBinding | undefined = {
    tabId: "tab-1", boardId: "board-1", assignmentGeneration: 3, providerId: "codex", ownerPluginId: "forge", logicalRunId: "worker-1", attemptId: "attempt-1", executionId: "execution-1"
  };
  const options = { dataDir: root, endpoint: () => endpoint, binding: (tabId: string) => binding?.tabId === tabId ? binding : undefined };
  const contexts = new AgentCooperationContext(options);
  const locator = await contexts.prepare("tab-1");
  return { root, contexts, locator, options, change: (next: CooperationAgentBinding | undefined) => { binding = next; } };
}

it("keeps a stable private locator across restarts and revalidates current membership on every request", async () => {
  const f = await fixture();
  expect((await fs.stat(f.contexts.contextPath("tab-1"))).mode & 0o777).toBe(0o600);
  const restarted = new AgentCooperationContext(f.options);
  expect((await restarted.prepare("tab-1")).capability).toBe(f.locator.capability);
  expect(await restarted.authenticate(f.locator)).toEqual({
    kind: "agent", tabId: "tab-1", assignmentGeneration: 3, providerId: "codex", ownerPluginId: "forge", logicalRunId: "worker-1", attemptId: "attempt-1"
  });
  f.change({ ...f.locator, boardId: "board-2", assignmentGeneration: 4 });
  await expect(restarted.authenticate(f.locator)).rejects.toMatchObject({ code: "ASSIGNMENT_CHANGED" });
  const next = await restarted.prepare("tab-1");
  expect(next.capability).not.toBe(f.locator.capability);
  await expect(restarted.authenticate(f.locator)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await restarted.revoke("tab-1");
  await expect(restarted.authenticate(next)).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("does not infer a board from another tab, even when unassigned or given a path-like tab ID", async () => {
  const f = await fixture();
  f.change({ tabId: "../../tab-2", boardId: null, assignmentGeneration: 0 });
  const locator = await f.contexts.prepare("../../tab-2");
  expect(path.dirname(f.contexts.contextPath(locator.tabId))).toBe(path.join(f.root, "cooperation-agents"));
  expect(locator.boardId).toBeNull();
  await expect(f.contexts.prepare("tab-1")).rejects.toThrow("no longer exists");
  await expect(f.contexts.authenticate({ ...locator, tabId: "tab-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("revokes an in-flight capability when its provider, owner, logical run, attempt, or native execution changes", async () => {
  const f = await fixture();
  let previous = f.locator;
  for (const changed of [
    { providerId: "claude" as const }, { ownerPluginId: "another-owner" }, { logicalRunId: "worker-2" },
    { attemptId: "attempt-2" }, { executionId: "execution-2" }
  ]) {
    f.change({ ...previous, ...changed });
    await expect(f.contexts.authenticate(previous)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const next = await f.contexts.prepare("tab-1");
    expect(next.capability).not.toBe(previous.capability);
    await expect(f.contexts.authenticate(previous)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.contexts.authenticate(next)).toMatchObject({ kind: "agent", tabId: "tab-1" });
    previous = next;
  }
});

it("refuses symlinked or corrupt context files and non-local endpoints", async () => {
  const f = await fixture();
  const target = f.contexts.contextPath("tab-1");
  await fs.rm(target);
  await fs.symlink(path.join(f.root, "outside"), target);
  await expect(f.contexts.prepare("tab-1")).rejects.toThrow();
  await fs.rm(target);
  await fs.writeFile(target, "{}");
  await expect(f.contexts.prepare("tab-1")).rejects.toThrow("invalid");
  const remote = new AgentCooperationContext({ ...f.options, dataDir: path.join(f.root, "remote"), endpoint: () => "https://foreign.example/api" });
  await expect(remote.prepare("tab-1")).rejects.toThrow("local HTTP");
});

it.each(["symlinked", "public"])("refuses a %s native receipt directory", async kind => {
  const f = await fixture();
  const directory = `${f.contexts.contextPath("tab-1")}.native`;
  if (kind === "symlinked") {
    const outside = path.join(f.root, "outside-native");
    await fs.mkdir(outside);
    await fs.rm(directory, { recursive: true });
    await fs.symlink(outside, directory);
  } else await fs.chmod(directory, 0o755);
  await expect(f.contexts.prepare("tab-1")).rejects.toThrow("real private directory");
});

it("gives both provider launches their own locator while preserving the existing runtime context", async () => {
  const f = await fixture();
  const original = { pluginRuntime: { "rules-skills": { template: "selected" } } };
  const tab = { id: "tab-1", pluginId: "codex-terminal" } as WorkspaceTab;
  const context = await f.contexts.augmentRuntimeContext(tab, original);
  expect(context.pluginRuntime?.["rules-skills"]).toEqual(original.pluginRuntime["rules-skills"]);
  expect(cooperationLaunchEnv(context)).toEqual({
    CLOUDX_COOPERATION_CONTEXT: f.contexts.contextPath(tab.id), CLOUDX_COOPERATION_HELPER: COOPERATION_HELPER_PATH,
    CLOUDX_COOPERATION_ASSETS: `${f.contexts.contextPath(tab.id)}.assets`
  });
  expect(original.pluginRuntime).not.toHaveProperty("cooperation");
  expect(await f.contexts.augmentRuntimeContext({ ...tab, pluginId: "terminal" }, original)).toBe(original);
  expect(cooperationLaunchEnv()).toEqual({});
  expect(() => cooperationLaunchEnv({ pluginRuntime: { cooperation: { contextPath: "relative", helperPath: "/helper" } } })).toThrow("invalid");
});

it("ships complete board-first skills and one helper/protocol contract for both providers", () => {
  expect(COOPERATION_SKILLS.map(skill => skill.id)).toEqual(["cooperation-board", "cooperation-feedback", "cooperation-diagram"]);
  expect(COOPERATION_RULES[0].text).toContain("At the start of each turn");
  for (const skill of COOPERATION_SKILLS) {
    expect(skill.instructions).toContain("protocol.md");
    expect(skill.files?.map(file => file.path)).toEqual(["protocol.md", "scripts/cooperation-helper.mjs"]);
    expect(skill.files?.[0].content).toContain("no automatic retries");
  }
});

it("exposes only byte-identical originals in this tab's image directory and clears it on reassignment", async () => {
  const f = await fixture();
  const originalPath = path.join(f.root, "original.png");
  const bytes = await fs.readFile("docs/design/cooperation/examples/assets/reference.png");
  await fs.writeFile(originalPath, bytes);
  const asset: CooperationAsset = { id: "asset-1", mime: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, width: 1200, height: 800, relativePath: "assets/reference.png" };
  const original = await f.contexts.materializeAsset(f.locator, { asset, localPath: originalPath });
  expect(path.dirname(original.localPath)).toBe(f.locator.assetRoot);
  expect((await fs.readFile(original.localPath)).equals(bytes)).toBe(true);
  expect((await fs.stat(original.localPath)).mode & 0o777).toBe(0o400);
  await expect(f.contexts.materializeAsset(f.locator, { asset: { ...asset, sha256: "0".repeat(64) }, localPath: originalPath })).rejects.toThrow("hash changed");
  await fs.chmod(original.localPath, 0o600);
  await fs.writeFile(original.localPath, "modified");
  await expect(f.contexts.materializeAsset(f.locator, { asset, localPath: originalPath })).rejects.toThrow("copy was modified");
  f.change({ ...f.locator, boardId: "board-2", assignmentGeneration: 4 });
  await f.contexts.prepare("tab-1");
  expect(await fs.readdir(f.locator.assetRoot)).toEqual([]);
  await expect(f.contexts.materializeAsset(f.locator, { asset, localPath: originalPath })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("executes the shipped helper with the current capability for reads, original images and bounded writes", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ ...body, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body.action === "read" ? { markdown: "# Board\nOriginal image: asset-1\n" }
      : body.action === "asset" ? { asset: { id: "asset-1", mime: "image/png" }, localPath: "/owned/original.png" }
      : { receipt: { operationId: body.transaction?.operationId } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const f = await fixture(`http://127.0.0.1:${port}/api/cooperation/agent`);
  const env = { PATH: process.env.PATH, CLOUDX_COOPERATION_CONTEXT: f.contexts.contextPath("tab-1") };
  expect((await run(process.execPath, [COOPERATION_HELPER_PATH, "read", "--format", "markdown"], { env })).stdout).toBe("# Board\nOriginal image: asset-1\n");
  expect(JSON.parse((await run(process.execPath, [COOPERATION_HELPER_PATH, "asset", "--id", "asset-1"], { env })).stdout)).toMatchObject({ localPath: "/owned/original.png" });
  const transaction = path.join(f.root, "transaction.json");
  await fs.writeFile(transaction, JSON.stringify({ operationId: "operation-1" }));
  await run(process.execPath, [COOPERATION_HELPER_PATH, "apply", "--file", transaction], { env });
  expect(requests).toHaveLength(3);
  for (const request of requests) expect(request).toMatchObject({ tabId: "tab-1", boardId: "board-1", assignmentGeneration: 3, authorization: `Bearer ${f.locator.capability}` });
  await fs.writeFile(transaction, "x".repeat(256 * 1024 + 1));
  await expect(run(process.execPath, [COOPERATION_HELPER_PATH, "apply", "--file", transaction], { env })).rejects.toThrow("bounded regular file");
  expect(requests).toHaveLength(3);
});

it("rejects oversized, symlink and directory upload sources before contacting the host", async () => {
  const f = await fixture();
  const file = path.join(f.root, "original.bin");
  await fs.writeFile(file, "Original");
  const link = path.join(f.root, "link.bin");
  await fs.symlink(file, link);
  const env = { PATH: process.env.PATH, CLOUDX_COOPERATION_CONTEXT: f.contexts.contextPath("tab-1") };
  const upload = (source: string) => run(process.execPath, [COOPERATION_HELPER_PATH, "upload", "--file", source, "--mime", "application/octet-stream"], { env });
  await expect(upload(link)).rejects.toMatchObject({ stderr: expect.stringContaining("ELOOP") });
  await expect(upload(f.root)).rejects.toMatchObject({ stderr: expect.stringContaining("bounded regular file") });
  await fs.truncate(file, COOPERATION_LIMITS.fileBytes + 1);
  await expect(upload(file)).rejects.toMatchObject({ stderr: expect.stringContaining("bounded regular file") });
  await expect(run(process.execPath, [COOPERATION_HELPER_PATH, "upload", "--file", file], { env })).rejects.toMatchObject({ stderr: expect.stringContaining("--mime requires a value") });
});

it("addresses the existing native owner and retains one native acceptance per event", async () => {
  const f = await fixture();
  const helper = fileURLToPath(new URL("../../helpers/cooperation-native-control.mjs", import.meta.url));
  const { CooperationNativeControl } = await import(helper);
  let sends = 0;
  const control = await new CooperationNativeControl({ contextPath: f.contexts.contextPath("tab-1"), providerId: "codex", tabId: "tab-1", executionId: "execution-1" }, async () => {
    sends += 1;
    return { state: "nativeAccepted", providerTurnId: "turn-1" };
  }).start();
  cleanups.push(() => control.close());
  const native = new NativeAgentFeedbackPort({ contexts: f.contexts });
  cleanups.push(async () => native.close());
  const envelope = { recipientTabId: "tab-1", assignmentGeneration: 3, boardId: "board-1", boardRevision: 2, eventIds: ["event-1"], text: "Read and answer this question." };
  expect(await native.deliver(envelope)).toMatchObject({ state: "nativeAccepted", providerTurnId: "turn-1" });
  expect(await native.deliver(envelope)).toMatchObject({ state: "nativeAccepted", providerTurnId: "turn-1" });
  expect(sends).toBe(1);
  expect(await native.deliver({ ...envelope, text: "Different question with same ID" })).toMatchObject({ state: "unavailable" });
  expect(sends).toBe(1);
  f.change({ ...f.locator, assignmentGeneration: 4, boardId: "board-2" });
  expect(await native.deliver(envelope)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("assignment changed") });
});

it("keeps final native observations monotonic and a retired broker cannot replace its successor's locator", async () => {
  const f = await fixture();
  const { CooperationNativeControl } = await import(fileURLToPath(new URL("../../helpers/cooperation-native-control.mjs", import.meta.url)));
  const binding = { contextPath: f.contexts.contextPath("tab-1"), providerId: "codex", tabId: "tab-1", executionId: "execution-1" };
  const old = await new CooperationNativeControl(binding, async () => ({ state: "nativeAccepted", providerTurnId: "old-turn" })).start();
  cleanups.push(() => old.close());
  const native = new NativeAgentFeedbackPort({ contexts: f.contexts });
  cleanups.push(async () => native.close());
  const boundaries = vi.fn();
  native.onBoundary(boundaries);
  await native.observe("tab-1");
  expect(boundaries).toHaveBeenCalledTimes(1);
  await old.turn({ providerTurnId: "old-turn", status: "running" });
  await old.turn({ providerTurnId: "old-turn", status: "completed" });
  await old.turn({ providerTurnId: "old-turn", status: "running" });
  const oldReceiptPath = await f.contexts.nativeReceiptPath("tab-1");
  expect(JSON.parse(await fs.readFile(oldReceiptPath, "utf8")).currentTurn.status).toBe("completed");
  f.change({ ...f.locator, executionId: "execution-2" });
  await f.contexts.prepare("tab-1");
  await old.turn({ providerTurnId: "retired-turn", status: "running" });
  await old.boundary();
  await old.mark(["retired-event"], "unknown");
  expect(old.currentTurn.providerTurnId).toBe("old-turn");
  await expect(fs.lstat(oldReceiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  const next = await new CooperationNativeControl({ ...binding, executionId: "execution-2" }, async () => ({ state: "nativeAccepted", providerTurnId: "new-turn" })).start();
  cleanups.push(() => next.close());
  await old.close();
  await vi.waitFor(() => expect(boundaries).toHaveBeenCalledTimes(2));
  expect(JSON.parse(await fs.readFile(await f.contexts.nativeReceiptPath("tab-1"), "utf8"))).toMatchObject({ executionId: "execution-2", status: "ready" });
  expect(await native.deliver({ recipientTabId: "tab-1", assignmentGeneration: 3, boardId: "board-1", boardRevision: 1, eventIds: ["new-event"], text: "New addressed question", executionId: "execution-2" }))
    .toMatchObject({ state: "nativeAccepted", providerTurnId: "new-turn" });
});

it("rejects a delayed retired broker before it can displace the replacement native owner", async () => {
  const f = await fixture();
  f.change({ ...f.locator, executionId: "execution-current" });
  await f.contexts.prepare("tab-1");
  const { CooperationNativeControl } = await import(fileURLToPath(new URL("../../helpers/cooperation-native-control.mjs", import.meta.url)));
  const binding = { contextPath: f.contexts.contextPath("tab-1"), providerId: "codex", tabId: "tab-1", executionId: "execution-current" };
  const current = await new CooperationNativeControl(binding, async () => ({ state: "nativeAccepted", providerTurnId: "current-turn" })).start();
  cleanups.push(() => current.close());
  const receiptPath = await f.contexts.nativeReceiptPath("tab-1");
  const currentReceipt = await fs.readFile(receiptPath, "utf8");
  const retired = new CooperationNativeControl({ ...binding, executionId: "execution-retired" }, async () => ({ state: "nativeAccepted" }));
  cleanups.push(() => retired.close());
  await expect(retired.start()).rejects.toThrow("replaced");
  expect(retired.server?.listening ?? false).toBe(false);
  expect(await fs.readFile(receiptPath, "utf8")).toBe(currentReceipt);
  const native = new NativeAgentFeedbackPort({ contexts: f.contexts });
  cleanups.push(async () => native.close());
  expect(await native.deliver({ recipientTabId: "tab-1", assignmentGeneration: 3, boardId: "board-1", boardRevision: 1, eventIds: ["current-event"], text: "Current addressed question", executionId: binding.executionId }))
    .toMatchObject({ state: "nativeAccepted", providerTurnId: "current-turn" });
});

it("releases a native listener when its execution is replaced during startup", async () => {
  const f = await fixture();
  f.change({ ...f.locator, executionId: "execution-1" });
  await f.contexts.prepare("tab-1");
  const { CooperationNativeControl } = await import(fileURLToPath(new URL("../../helpers/cooperation-native-control.mjs", import.meta.url)));
  const control = new CooperationNativeControl({ contextPath: f.contexts.contextPath("tab-1"), providerId: "codex", tabId: "tab-1", executionId: "execution-1" }, async () => ({ state: "nativeAccepted" }));
  cleanups.push(() => control.close());
  const publish = control.publish.bind(control);
  control.publish = async (replace: boolean) => {
    if (replace) {
      f.change({ ...f.locator, executionId: "execution-2" });
      await f.contexts.prepare("tab-1");
    }
    return publish(replace);
  };
  await expect(control.start()).rejects.toThrow("replaced");
  expect(control.server.listening).toBe(false);
  await expect(fs.lstat(control.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(`${f.contexts.contextPath("tab-1")}.native`)).toEqual([]);
});

it.each(["boundary", "startup"])("keeps the replacement reachable when a retired %s publication finishes its rename last", async phase => {
  const f = await fixture();
  f.change({ ...f.locator, executionId: "execution-old" });
  await f.contexts.prepare("tab-1");
  const { CooperationNativeControl } = await import(fileURLToPath(new URL("../../helpers/cooperation-native-control.mjs", import.meta.url)));
  const binding = { contextPath: f.contexts.contextPath("tab-1"), providerId: "codex", tabId: "tab-1", executionId: "execution-old" };
  const old = new CooperationNativeControl(binding, async () => ({ state: "nativeAccepted" }));
  cleanups.push(() => old.close());
  if (phase === "boundary") await old.start();
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  const gated = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (String(target).includes(".native")) {
      const value = JSON.parse(await fs.readFile(source, "utf8"));
      if (value.executionId === binding.executionId && value.boundaryEpoch === (phase === "boundary" ? 1 : 0)) {
        entered.resolve();
        await release.promise;
      }
    }
    return rename(source, target);
  });
  cleanups.push(async () => { release.resolve(); gated.mockRestore(); });
  const pending = phase === "boundary" ? old.boundary() : old.start();
  await entered.promise;
  f.change({ ...f.locator, executionId: "execution-new" });
  await f.contexts.prepare("tab-1");
  const current = await new CooperationNativeControl({ ...binding, executionId: "execution-new" }, async () => ({ state: "nativeAccepted", providerTurnId: "new-turn" })).start();
  cleanups.push(() => current.close());
  await current.turn({ providerTurnId: "new-turn", status: "running" });
  release.resolve();
  if (phase === "startup") {
    await expect(pending).rejects.toThrow("replaced");
    expect(old.server.listening).toBe(false);
    await expect(fs.lstat(old.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  } else await pending;
  await current.boundary();
  await current.turn({ providerTurnId: "new-turn", status: "completed" });
  const native = new NativeAgentFeedbackPort({ contexts: f.contexts });
  cleanups.push(async () => native.close());
  const turns = vi.fn();
  native.onTurn(turns);
  expect(await native.deliver({ recipientTabId: "tab-1", assignmentGeneration: 3, boardId: "board-1", boardRevision: 1, eventIds: ["event-new"], text: "Address the replacement execution.", executionId: "execution-new" }))
    .toMatchObject({ state: "nativeAccepted", providerTurnId: "new-turn" });
  expect(turns).toHaveBeenLastCalledWith(expect.objectContaining({ executionId: "execution-new", status: "completed" }));
  expect(await fs.readdir(`${binding.contextPath}.native`)).toEqual([path.basename(await f.contexts.nativeReceiptPath("tab-1"))]);
});

it("cleans every execution receipt and pending temporary file when a tab is revoked", async () => {
  const f = await fixture();
  const { CooperationNativeControl } = await import(fileURLToPath(new URL("../../helpers/cooperation-native-control.mjs", import.meta.url)));
  const control = await new CooperationNativeControl({ contextPath: f.contexts.contextPath("tab-1"), providerId: "codex", tabId: "tab-1", executionId: "execution-1" }, async () => ({ state: "nativeAccepted" })).start();
  cleanups.push(() => control.close());
  const receiptPath = await f.contexts.nativeReceiptPath("tab-1");
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  const gated = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (target === receiptPath) { entered.resolve(); await release.promise; }
    return rename(source, target);
  });
  cleanups.push(async () => { release.resolve(); gated.mockRestore(); });
  const pending = control.boundary();
  await entered.promise;
  const unrelated = path.join(path.dirname(f.contexts.contextPath("tab-1")), "unrelated.json");
  await fs.writeFile(unrelated, "retained");
  await f.contexts.revoke("tab-1");
  release.resolve();
  await pending;
  await expect(fs.lstat(path.dirname(receiptPath))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(unrelated, "utf8")).toBe("retained");
});

it("removes a failed receipt temporary file without changing the published receipt", async () => {
  const f = await fixture();
  const receiptPath = await f.contexts.nativeReceiptPath("tab-1");
  await fs.writeFile(receiptPath, "original");
  const { writePrivateJson } = await import(fileURLToPath(new URL("../../helpers/cooperation-native-control.mjs", import.meta.url)));
  const error = Object.assign(new Error("receipt commit denied"), { code: "EACCES" });
  const gated = vi.spyOn(fs, "rename").mockRejectedValue(error);
  cleanups.push(async () => gated.mockRestore());
  await expect(writePrivateJson(receiptPath, { version: 1 })).rejects.toBe(error);
  expect(await fs.readdir(path.dirname(receiptPath))).toEqual([path.basename(receiptPath)]);
  expect(await fs.readFile(receiptPath, "utf8")).toBe("original");
});

it("leaves another writer's temporary file intact when exclusive creation fails", async () => {
  const f = await fixture();
  const receiptPath = await f.contexts.nativeReceiptPath("tab-1");
  const { writePrivateJson } = await import(fileURLToPath(new URL("../../helpers/cooperation-native-control.mjs", import.meta.url)));
  const error = Object.assign(new Error("another writer owns this temporary file"), { code: "EEXIST" });
  let temporaryPath = "";
  const open = fs.open.bind(fs);
  const collision = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(`${receiptPath}.`)) {
      temporaryPath = String(args[0]);
      await fs.writeFile(temporaryPath, "another writer's data");
      throw error;
    }
    return open(...args);
  });
  cleanups.push(async () => collision.mockRestore());
  await expect(writePrivateJson(receiptPath, { version: 1 })).rejects.toBe(error);
  expect(await fs.readFile(temporaryPath, "utf8")).toBe("another writer's data");
});

it("keeps Claude delivery unknown when its conversation changes before a native queue acknowledgment", async () => {
  const f = await fixture();
  f.change({ ...f.locator, providerId: "claude", executionId: "execution-1" });
  const locator = await f.contexts.prepare("tab-1");
  const transcript = path.join(f.root, "original.jsonl");
  const replacement = path.join(f.root, "replacement.jsonl");
  const identityPath = path.join(f.root, ".cloudx-conversation.json");
  const identity = { tabId: "tab-1", executionId: "execution-1", sessionId: "session-1", transcriptPath: transcript };
  await Promise.all([fs.writeFile(transcript, ""), fs.writeFile(replacement, ""), fs.writeFile(identityPath, JSON.stringify(identity))]);
  const frames: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", chunk => frames.push(chunk.toString()));
  });
  const socketPath = path.join(f.root, "inbox.sock");
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const { ClaudeCooperationBroker } = await import(fileURLToPath(new URL("../../helpers/cooperation-claude-broker.mjs", import.meta.url)));
  const broker = await new ClaudeCooperationBroker({ configDir: f.root, contextPath: f.contexts.contextPath("tab-1"), tabId: "tab-1", executionId: "execution-1" }, { CLAUDE_CODE_MESSAGING_SOCKET: socketPath }).start();
  cleanups.push(() => broker.close());
  const delivered = broker.control.request({ recipientTabId: "tab-1", assignmentGeneration: 3, boardId: "board-1", eventIds: ["event-switch"], text: "Read this addressed question.", capability: locator.capability });
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  await fs.writeFile(identityPath, JSON.stringify({ ...identity, sessionId: "session-2", transcriptPath: replacement }));
  await broker.readTurn();
  expect(await delivered).toMatchObject({ state: "unknown", reason: expect.stringContaining("conversation changed") });
  expect(broker.control.deliveries.get("event-switch").state).toBe("unknown");
  expect(await fs.readFile(transcript, "utf8")).toBe("");
  expect(await fs.readFile(replacement, "utf8")).toBe("");
  expect(frames).toHaveLength(1);
});

it.each(["running", "completed"])("keeps the original Claude transcript's current prompt when a preceding %s hook receipt arrives late", async status => {
  const f = await fixture();
  f.change({ ...f.locator, providerId: "claude", executionId: "execution-1" });
  await f.contexts.prepare("tab-1");
  const transcript = path.join(f.root, "conversation.jsonl");
  await fs.writeFile(transcript, "");
  await fs.writeFile(path.join(f.root, ".cloudx-conversation.json"), JSON.stringify({ tabId: "tab-1", executionId: "execution-1", sessionId: "session-1", transcriptPath: transcript }));
  const { ClaudeCooperationBroker } = await import(fileURLToPath(new URL("../../helpers/cooperation-claude-broker.mjs", import.meta.url)));
  const broker = await new ClaudeCooperationBroker({ configDir: f.root, contextPath: f.contexts.contextPath("tab-1"), tabId: "tab-1", executionId: "execution-1" }, { CLAUDE_CODE_MESSAGING_SOCKET: "/unused" }).start();
  cleanups.push(() => broker.close());
  const prompt = (promptId: string) => `${JSON.stringify({ type: "user", promptId, message: { role: "user", content: promptId } })}\n`;
  await fs.appendFile(transcript, prompt("feedback-turn") + prompt("submitted-draft"));
  await fs.writeFile(path.join(f.root, ".cloudx-turn.json"), JSON.stringify({ sessionId: "session-1", turnId: "feedback-turn", status }));
  await broker.readTurn();
  expect(broker.control.currentTurn).toMatchObject({ providerTurnId: "submitted-draft", status: "running" });

  await fs.writeFile(path.join(f.root, ".cloudx-turn.json"), JSON.stringify({ sessionId: "session-1", turnId: "submitted-draft", status: "completed" }));
  await broker.readTurn();
  expect(broker.control.currentTurn).toMatchObject({ providerTurnId: "submitted-draft", status: "completed" });
});

it("reconciles a persisted Claude completion when its native prompt arrives after the receipt observation", async () => {
  const f = await fixture();
  f.change({ ...f.locator, providerId: "claude", executionId: "execution-1" });
  await f.contexts.prepare("tab-1");
  const transcript = path.join(f.root, "conversation.jsonl");
  await fs.writeFile(transcript, "");
  await fs.writeFile(path.join(f.root, ".cloudx-conversation.json"), JSON.stringify({ tabId: "tab-1", executionId: "execution-1", sessionId: "session-1", transcriptPath: transcript }));
  const { ClaudeCooperationBroker } = await import(fileURLToPath(new URL("../../helpers/cooperation-claude-broker.mjs", import.meta.url)));
  const broker = await new ClaudeCooperationBroker({ configDir: f.root, contextPath: f.contexts.contextPath("tab-1"), tabId: "tab-1", executionId: "execution-1" }, { CLAUDE_CODE_MESSAGING_SOCKET: "/unused" }).start();
  cleanups.push(() => broker.close());
  // Deliver the receipt notification explicitly; leave the real original
  // transcript watcher active for the later native prompt notification.
  for (const watcher of broker.watchers) watcher.close();
  const prompt = (promptId: string) => `${JSON.stringify({ type: "user", promptId, message: { role: "user", content: promptId } })}\n`;
  await fs.appendFile(transcript, prompt("feedback-turn"));
  await broker.readTurn();
  expect(broker.control.currentTurn).toMatchObject({ providerTurnId: "feedback-turn", status: "running" });
  await fs.writeFile(path.join(f.root, ".cloudx-turn.json"), JSON.stringify({ sessionId: "session-1", turnId: "submitted-draft", status: "completed" }));
  await broker.readTurn();
  await fs.appendFile(transcript, prompt("submitted-draft"));
  await vi.waitFor(() => expect(broker.control.currentTurn).toMatchObject({ providerTurnId: "submitted-draft", status: "completed" }), { timeout: 3_000 });

  await fs.appendFile(transcript, prompt("newer-user-prompt"));
  await vi.waitFor(() => expect(broker.control.currentTurn).toMatchObject({ providerTurnId: "newer-user-prompt", status: "running" }));
  await broker.readTurn();
  expect(broker.control.currentTurn).toMatchObject({ providerTurnId: "newer-user-prompt", status: "running" });
});

it("publishes one complete original when two helpers request the same file together", async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(16 * 1024 * 1024, 0x61);
  const original = await originalFile(f.root, bytes);
  const copies = await Promise.all([
    f.contexts.materializeAsset(f.locator, original),
    f.contexts.materializeAsset(f.locator, original)
  ]);
  expect(copies[0].localPath).toBe(copies[1].localPath);
  expect((await fs.readFile(copies[0].localPath)).equals(bytes)).toBe(true);
  expect((await fs.stat(copies[0].localPath)).mode & 0o777).toBe(0o400);
});

it.each([
  ["execution", { executionId: "execution-replacement" }],
  ["provider", { providerId: "claude" }]
] as const)("rejects original access when the authenticated %s changes", async (_kind, change) => {
  const f = await fixture();
  const original = await originalFile(f.root);
  await f.contexts.authenticate(f.locator);
  f.change({ ...f.locator, ...change });
  await expect(f.contexts.materializeAsset(f.locator, original)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await fs.readdir(f.locator.assetRoot)).toEqual([]);
});

it("stops a growing original before an unbounded file read", async () => {
  const f = await fixture();
  const original = await originalFile(f.root);
  const open = fs.open;
  const unboundedReads: { mock: { calls: unknown[] } }[] = [];
  let grew = false;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (String(file) !== original.localPath) return handle;
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async () => {
      const observed = await stat();
      if (!grew) {
        grew = true;
        await fs.truncate(original.localPath, COOPERATION_LIMITS.fileBytes + 1);
      }
      return observed;
    });
    unboundedReads.push(vi.spyOn(handle, "readFile"));
    return handle;
  });
  try {
    await expect(f.contexts.materializeAsset(f.locator, original)).rejects.toThrow();
    expect(grew).toBe(true);
    expect(unboundedReads).toHaveLength(1);
    expect(unboundedReads.flatMap(read => read.mock.calls)).toEqual([]);
    expect(await fs.readdir(f.locator.assetRoot)).toEqual([]);
  } finally { openSpy.mockRestore(); }
});

async function originalFile(root: string, bytes = Buffer.from("Original")) {
  const localPath = path.join(root, "original.bin");
  await fs.writeFile(localPath, bytes);
  const asset: CooperationAsset = { kind: "file", id: "file-original", name: "original.bin", mime: "application/octet-stream",
    sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, relativePath: "assets/file-original.bin" };
  return { asset, localPath };
}

it("removes a new original copy when its execution ends during publication", async () => {
  const f = await fixture();
  const original = await originalFile(f.root);
  const open = fs.open;
  let changed = false;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (path.basename(String(file)) !== `${original.asset.sha256}.bin` || typeof flags !== "number" || !(flags & constants.O_WRONLY)) return handle;
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      await sync();
      changed = true;
      f.change({ ...f.locator, executionId: "execution-replacement" });
    });
    return handle;
  });
  try {
    await expect(f.contexts.materializeAsset(f.locator, original)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(changed).toBe(true);
    expect(await fs.readdir(f.locator.assetRoot)).toEqual([]);
    expect(await fs.readFile(original.localPath)).toEqual(Buffer.from("Original"));
  } finally { openSpy.mockRestore(); }
});

it("removes an unconfirmed original copy after a storage failure", async () => {
  const f = await fixture();
  const original = await originalFile(f.root);
  const failure = new Error("The original copy could not be flushed.");
  const open = fs.open;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (path.basename(String(file)) === `${original.asset.sha256}.bin` && typeof flags === "number" && flags & constants.O_WRONLY)
      vi.spyOn(handle, "sync").mockRejectedValue(failure);
    return handle;
  });
  try {
    await expect(f.contexts.materializeAsset(f.locator, original)).rejects.toBe(failure);
    expect(await fs.readdir(f.locator.assetRoot)).toEqual([]);
  } finally { openSpy.mockRestore(); }
  const confirmed = await f.contexts.materializeAsset(f.locator, original);
  expect(await fs.readFile(confirmed.localPath)).toEqual(Buffer.from("Original"));
});

it("rejects a locator that redirects original copies outside the managed cache", async () => {
  const f = await fixture();
  const original = await originalFile(f.root);
  const outside = path.join(f.root, "outside-cache");
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(f.contexts.contextPath(f.locator.tabId), JSON.stringify({ ...f.locator, assetRoot: outside }));
  await expect(f.contexts.materializeAsset(f.locator, original)).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
});

it("rejects a symbolic link in place of the original cache directory", async () => {
  const f = await fixture();
  const original = await originalFile(f.root);
  const outside = path.join(f.root, "outside-cache");
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.rm(f.locator.assetRoot, { recursive: true });
  await fs.symlink(outside, f.locator.assetRoot);
  await expect(f.contexts.materializeAsset(f.locator, original)).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
});

it("rejects a replaced cache directory without writing outside it", async () => {
  const f = await fixture();
  const original = await originalFile(f.root);
  const outside = path.join(f.root, "outside-cache");
  const retired = path.join(f.root, "retired-cache");
  await fs.mkdir(outside, { mode: 0o700 });
  const open = fs.open;
  let replaced = false;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (String(file) !== f.locator.assetRoot) return handle;
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async () => {
      const observed = await stat();
      if (!replaced) {
        replaced = true;
        await fs.rename(f.locator.assetRoot, retired);
        await fs.symlink(outside, f.locator.assetRoot);
      }
      return observed;
    });
    return handle;
  });
  try {
    await expect(f.contexts.materializeAsset(f.locator, original)).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readdir(retired)).toEqual([]);
  } finally { openSpy.mockRestore(); }
});

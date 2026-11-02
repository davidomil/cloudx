import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, it, vi } from "vitest";
import type { CooperationAsset, WorkspaceTab } from "@cloudx/shared";

import { AgentCooperationContext, COOPERATION_HELPER_PATH, cooperationLaunchEnv, type CooperationAgentBinding } from "./AgentCooperationContext.js";
import { COOPERATION_RULES, COOPERATION_SKILLS } from "./cooperationContributions.js";
import { NativeAgentFeedbackPort } from "./NativeAgentFeedbackPort.js";

const run = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(endpoint = "http://127.0.0.1:1/api/cooperation/agent") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-coop-context-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  let binding: CooperationAgentBinding | undefined = {
    tabId: "tab-1", boardId: "board-1", assignmentGeneration: 3, providerId: "codex", ownerPluginId: "forge", logicalRunId: "worker-1", attemptId: "attempt-1"
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
  expect(COOPERATION_RULES[0].text).toContain("At the start of every turn");
  for (const skill of COOPERATION_SKILLS) {
    expect(skill.instructions).toContain("coworker");
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
  const original = await f.contexts.materializeAsset("tab-1", 3, { asset, localPath: originalPath });
  expect(path.dirname(original.localPath)).toBe(f.locator.assetRoot);
  expect((await fs.readFile(original.localPath)).equals(bytes)).toBe(true);
  expect((await fs.stat(original.localPath)).mode & 0o777).toBe(0o400);
  await expect(f.contexts.materializeAsset("tab-1", 3, { asset: { ...asset, sha256: "0".repeat(64) }, localPath: originalPath })).rejects.toThrow("hash changed");
  await fs.chmod(original.localPath, 0o600);
  await fs.writeFile(original.localPath, "modified");
  await expect(f.contexts.materializeAsset("tab-1", 3, { asset, localPath: originalPath })).rejects.toThrow("copy was modified");
  f.change({ ...f.locator, boardId: "board-2", assignmentGeneration: 4 });
  await f.contexts.prepare("tab-1");
  expect(await fs.readdir(f.locator.assetRoot)).toEqual([]);
  await expect(f.contexts.materializeAsset("tab-1", 3, { asset, localPath: originalPath })).rejects.toMatchObject({ code: "ASSIGNMENT_CHANGED" });
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
  expect(JSON.parse(await fs.readFile(`${binding.contextPath}.native.json`, "utf8")).currentTurn.status).toBe("completed");
  f.change({ ...f.locator, executionId: "execution-2" });
  await f.contexts.prepare("tab-1");
  await old.turn({ providerTurnId: "retired-turn", status: "running" });
  expect(old.currentTurn.providerTurnId).toBe("old-turn");
  const next = await new CooperationNativeControl({ ...binding, executionId: "execution-2" }, async () => ({ state: "nativeAccepted", providerTurnId: "new-turn" })).start();
  cleanups.push(() => next.close());
  await old.close();
  await vi.waitFor(() => expect(boundaries).toHaveBeenCalledTimes(2));
  expect(JSON.parse(await fs.readFile(`${binding.contextPath}.native.json`, "utf8"))).toMatchObject({ executionId: "execution-2", status: "ready" });
  expect(await native.deliver({ recipientTabId: "tab-1", assignmentGeneration: 3, boardId: "board-1", boardRevision: 1, eventIds: ["new-event"], text: "New addressed question", executionId: "execution-2" }))
    .toMatchObject({ state: "nativeAccepted", providerTurnId: "new-turn" });
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

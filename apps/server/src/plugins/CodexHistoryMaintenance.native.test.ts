import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PreparedAgentLaunch } from "@cloudx/plugin-api";
import { readCodexVersion } from "../../../../scripts/codex-updater.mjs";
import { AgentLaunchRecords } from "../agents/AgentLaunchRecords.js";
import { AppServerClient } from "../appServer/AppServerClient.js";
import { OwnedAppServerTransport } from "../appServer/OwnedAppServerTransport.js";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import type { ReviewConversationBinding } from "../forge/ForgeReviewConversation.js";
import { CodexHistoryMaintenance } from "./CodexHistoryMaintenance.js";
import { CodexStateSources } from "./CodexStateSources.js";

const binary = process.env.CLOUDX_NATIVE_CODEX;
const cleanup: Array<() => Promise<void>> = [];
const admit = <T>(task: () => Promise<T>) => task();
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
async function fixture(providerUrl = "http://127.0.0.1:9/v1") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-storage-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), data = path.join(root, "data");
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, "config.toml"), [
    'check_for_update_on_startup = false', 'model = "cloudx-native"', 'model_provider = "cloudx-native"',
    '[features]', 'background_paginated_rollout_migration = false', 'local_thread_store_compression = false', 'multi_agent = true',
    '[model_providers.cloudx-native]', 'name = "Isolated storage validation"', `base_url = "${providerUrl}"`,
    'wire_api = "responses"', 'requires_openai_auth = false', `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', '',
  ].join("\n"));
  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, CODEX_SQLITE_HOME: home, CLOUDX_ASSISTANT_BIN: binary };
  const sources = new CodexStateSources(data, env);
  cleanup.push(() => sources.dispose());
  const tabId = randomUUID();
  const view = await sources.bind(tabId, await sources.resolve());
  const version = await readCodexVersion(binary!, { env });
  await new AgentLaunchRecords(data).record({ providerId: "codex", tabId, executionId: randomUUID(), command: binary!, version, cwd: root, args: [], env, enforcedEnvironmentKeys: [], configurationPaths: [] });
  const launch: PreparedAgentLaunch = { tabId, cwd: root, command: binary!, configurationArgs: [], env };
  const connect = async () => {
    const transport = await OwnedAppServerTransport.create(launch);
    const client = new AppServerClient(transport);
    let closed = false;
    const close = async () => { if (closed) return; closed = true; client.close(); await transport.terminate(); };
    cleanup.push(close);
    await client.request("initialize", { clientInfo: { name: "cloudx_native_storage", version: "1" }, capabilities: { experimentalApi: true } });
    transport.send({ method: "initialized", params: {} });
    return { client, transport, close };
  };
  const native = await connect();
  const createThread = async (text: string) => {
    const response = await native.client.request("thread/start", { cwd: root, ephemeral: false, approvalPolicy: "never", sandbox: "danger-full-access" }) as { thread: { id: string; path: string } };
    await native.client.request("thread/inject_items", { threadId: response.thread.id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] });
    return response.thread;
  };
  const bind = async (threadId: string): Promise<ReviewConversationBinding> => ({ source: await sources.resolve(), sqliteHome: await readDirectoryIdentity(home, "Native source"), sqliteHomeVerified: true, originView: await readDirectoryIdentity(view, "Native view"), creating: false, threadId });
  const maintenance = new CodexHistoryMaintenance(data, env);
  return { root, data, home, version, env, launch, native, sources, connect, createThread, bind, maintenance };
}

it.skipIf(!binary)("reclaims an owned native rollout through lifecycle locks while retained history still resumes and forks", async () => {
  const f = await fixture(await syntheticProvider(false));
  const owned = await f.createThread("Disposable terminal Forge history. ".repeat(12_000));
  const retained = await f.createThread("Retained interactive user conversation.");
  if (f.version === "0.166.0") {
    await finishTurn(f, owned.id);
    await finishTurn(f, retained.id);
    await f.native.client.request("thread/items/list", { threadId: owned.id, limit: 1 });
    await f.native.client.request("thread/items/list", { threadId: retained.id, limit: 1 });
  }
  for (const threadId of [owned.id, retained.id]) await f.native.client.request("thread/unsubscribe", { threadId });
  await f.native.transport.finish();
  await f.native.close();
  await fs.mkdir(path.join(f.home, "generated_images"));
  await fs.mkdir(path.join(f.home, "memories"));
  await fs.writeFile(path.join(f.home, "generated_images", "keep.png"), "User generated artifact");
  await fs.writeFile(path.join(f.home, "memories", "keep.md"), "User memory");
  const binding = await f.bind(owned.id);
  const projectionBefore = f.version === "0.166.0" ? await projectionRows(f.home, owned.id) : undefined;
  const originalConfig = await fs.readFile(path.join(f.home, "config.toml"), "utf8");
  const foreign = path.join(f.root, "foreign-sqlite");
  if (f.version === "0.166.0") {
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, "state_5.sqlite"), "Unrelated database sentinel; must never be opened for maintenance");
    await fs.writeFile(path.join(f.home, "config.toml"), `sqlite_home = ${JSON.stringify(foreign)}\n${originalConfig}`);
  }
  const result = await f.maintenance.retire("native-worker", binding, async () => {}, admit);
  if (f.version !== "0.166.0") {
    expect(result.state).toBe("retained");
    expect(result.reason).toContain("unverified Codex");
    expect((await fs.stat(owned.path)).size).toBeGreaterThan(0);
  } else {
    expect(result).toMatchObject({ state: "removed", selectedVersion: "0.166.0" });
    expect(result.reclaimedBytes).toBeGreaterThan(100_000);
    expect(projectionBefore).toBeGreaterThan(0);
    expect(await projectionRows(f.home, owned.id)).toBe(0);
    expect(await projectionRows(f.home, retained.id)).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(foreign, "state_5.sqlite"), "utf8")).toBe("Unrelated database sentinel; must never be opened for maintenance");
    await expect(fs.stat(owned.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.maintenance.retire("native-worker", binding, async () => {}, admit)).toEqual(result);
    console.log(JSON.stringify({ nativeVersion: f.version, ...result }));
  }
  await fs.writeFile(path.join(f.home, "config.toml"), originalConfig);
  const reader = await f.connect();
  const resumed = await reader.client.request("thread/resume", { threadId: retained.id, excludeTurns: false }) as { thread: { id: string } };
  expect(resumed.thread.id).toBe(retained.id);
  const forked = await reader.client.request("thread/fork", { threadId: retained.id, cwd: f.root }) as { thread: { id: string } };
  expect(forked.thread.id).not.toBe(retained.id);
  expect(await fs.readFile(path.join(f.home, "generated_images", "keep.png"), "utf8")).toBe("User generated artifact");
  expect(await fs.readFile(path.join(f.home, "memories", "keep.md"), "utf8")).toBe("User memory");
}, 45_000);

async function projectionRows(home: string, threadId: string): Promise<number> {
  const { stdout } = await promisify(execFile)("python3", ["-I", "-S", "-c", [
    "import pathlib, sqlite3, sys",
    "uri = pathlib.Path(sys.argv[1], 'thread_history_1.sqlite').as_uri() + '?mode=ro'",
    "with sqlite3.connect(uri, uri=True) as db:",
    " print(db.execute('SELECT COUNT(*) FROM thread_items WHERE thread_id = ?', (sys.argv[2],)).fetchone()[0])",
  ].join("\n"), home, threadId], { timeout: 5000 });
  return Number(stdout.trim());
}

async function syntheticProvider(spawnChild: boolean): Promise<string> {
  let spawned = false;
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const title = JSON.parse(body).text?.format?.schema?.properties?.title;
      const spawn = spawnChild && !spawned && !title;
      if (spawn) spawned = true;
      const item = spawn ? {
        type: "function_call", id: "fc_spawn_storage", call_id: "call_spawn_storage", namespace: "multi_agent_v1", name: "spawn_agent",
        arguments: JSON.stringify({ message: "Return the synthetic child response.", fork_context: false }),
      } : { type: "message", id: "msg_storage", role: "assistant", phase: "final_answer", status: "completed",
        content: [{ type: "output_text", text: title ? '{"title":"Native storage test"}' : "The synthetic agent finished.", annotations: [] }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_storage", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_storage", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  return `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
}

it.skipIf(!binary)("retains roots with native spawned descendants, including archived children", async () => {
  const f = await fixture(await syntheticProvider(true));
  const root = await f.createThread("Spawn a synthetic child for storage preservation validation.");
  if (f.version !== "0.166.0") {
    expect((await f.maintenance.retire("descendant-worker", await f.bind(root.id), async () => {}, admit)).state).toBe("retained");
    return;
  }
  let completed = false;
  f.native.transport.onMessage(message => { if (message.method === "turn/completed" && (message.params as { threadId?: string })?.threadId === root.id) completed = true; });
  await f.native.client.request("turn/start", { threadId: root.id, input: [{ type: "text", text: "Spawn an agent now." }] });
  await expect.poll(() => completed, { timeout: 15_000 }).toBe(true);
  const children = await f.native.client.request("thread/list", { ancestorThreadId: root.id, archived: false, limit: 1 }) as { data: Array<{ id: string; parentThreadId: string; path: string }> };
  expect(children.data).toHaveLength(1);
  const child = children.data[0]!;
  expect(child.parentThreadId).toBe(root.id);
  await f.native.close();
  const binding = await f.bind(root.id);
  const result = await f.maintenance.retire("descendant-worker", binding, async () => {}, admit);
  expect(result).toMatchObject({ state: "retained", reason: expect.stringContaining("spawned descendants") });
  const archiver = await f.connect();
  await archiver.client.request("thread/archive", { threadId: child.id });
  await archiver.transport.finish(); await archiver.close();
  const archived = await f.maintenance.retire("descendant-worker", binding, async () => {}, admit);
  expect(archived).toMatchObject({ state: "retained", reason: expect.stringContaining("spawned descendants") });
  expect((await fs.stat(root.path)).size).toBeGreaterThan(0);
}, 45_000);

async function finishTurn(f: Awaited<ReturnType<typeof fixture>>, threadId: string) {
  let completed = false;
  f.native.transport.onMessage(message => { if (message.method === "turn/completed" && (message.params as { threadId?: string })?.threadId === threadId) completed = true; });
  await f.native.client.request("turn/start", { threadId, input: [{ type: "text", text: "Return the synthetic result." }] });
  await expect.poll(() => completed, { timeout: 15_000 }).toBe(true);
}

it.skipIf(!binary)("preserves native history when another process still holds its writer lock", async () => {
  const f = await fixture();
  const owned = await f.createThread("A live writer still owns this conversation.");
  const result = await f.maintenance.retire("live-native-worker", await f.bind(owned.id), async () => {}, admit);
  expect(result.state).not.toBe("removed");
  expect((await fs.stat(owned.path)).size).toBeGreaterThan(0);
  if (f.version === "0.166.0") expect(result.reason).toMatch(/writer|in use|owned|lock|loaded/iu);
}, 45_000);

import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { WorkspaceTab } from "@cloudx/shared";

import { afterEach, expect, it, vi } from "vitest";

import { AgentCooperationContext } from "./AgentCooperationContext.js";
import { CooperationFeedbackDelivery } from "./CooperationFeedbackDelivery.js";
import { NativeAgentFeedbackPort } from "./NativeAgentFeedbackPort.js";
import { BlackboardService } from "../cooperation/BlackboardService.js";
import { registerCooperationRoutes } from "../cooperationHost/CooperationRoutes.js";
import type { SessionStore } from "../sessionStore.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-observation-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const boards = new BlackboardService({ rootDir: path.join(root, "boards") });
  await boards.init();
  const board = await boards.createBoard({ title: "Observed turn", tab: { tabId: "tab-1", providerId: "codex", label: "Reviewer" } });
  const binding = () => ({ ...boards.metadataForTab("tab-1"), providerId: "codex" as const, executionId: "execution-1" });
  const contexts = new AgentCooperationContext({ dataDir: root, endpoint: () => "http://127.0.0.1:1/api/cooperation/agent", binding });
  await contexts.prepare("tab-1");
  const native = new NativeAgentFeedbackPort({ contexts });
  cleanups.push(() => native.close());
  const turns = vi.fn();
  native.onTurn(turns);
  const delivery = new CooperationFeedbackDelivery({ boards, contexts, native, lineage: binding });
  cleanups.push(() => delivery.dispose());
  return { contexts, native, turns, boards, board, binding, delivery };
}

function gateSnapshots(binding: { boardId: string | null; assignmentGeneration: number }) {
  const first = deferred();
  const release = deferred();
  const open = fs.open.bind(fs);
  const receiptReads = vi.fn();
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (!String(args[0]).includes(".native")) return open(...args);
    const index = receiptReads.mock.calls.length;
    receiptReads();
    return {
      stat: async () => ({ isFile: () => true, size: 100 }),
      readFile: async () => {
        if (index === 0) { first.resolve(); await release.promise; }
        return JSON.stringify({ version: 1, providerId: "codex", tabId: "tab-1", executionId: "execution-1", status: "ready", deliveries: [],
          currentTurn: { providerTurnId: "turn-1", ...binding, startedAt: "2026-11-02T00:00:00.000Z", status: index === 0 ? "running" : "completed" }
        });
      },
      close: async () => undefined
    } as Awaited<ReturnType<typeof fs.open>>;
  });
  cleanups.push(() => release.resolve());
  return { first: first.promise, release: () => release.resolve(), receiptReads };
}

it("serializes the initial receipt and watcher notifications before publishing a completed turn", async () => {
  const f = await fixture();
  const receiptPath = await f.contexts.nativeReceiptPath("tab-1");
  const gate = gateSnapshots(f.binding());
  const initial = f.delivery.start();
  await gate.first;
  const watcher = vi.mocked(watch).mock.results.at(-1)!.value as FSWatcher;
  watcher.emit("change", "rename", path.basename(receiptPath));
  expect(gate.receiptReads).toHaveBeenCalledTimes(1);
  gate.release();
  await initial;
  await vi.waitFor(() => expect(f.turns).toHaveBeenLastCalledWith(expect.objectContaining({ status: "completed" })));
  expect(f.turns.mock.calls.map(([turn]) => turn.status)).toEqual(["running", "completed"]);
  expect(f.delivery.currentTurn("tab-1")?.status).toBe("completed");
  expect(f.delivery.turnStatus("tab-1")?.state).toBe("incomplete");

  const app = Fastify();
  cleanups.push(() => app.close());
  await app.register(websocket);
  const tab = { id: "tab-1", pluginId: "codex-terminal", title: "Reviewer", cwd: "/tmp", status: "running" } as WorkspaceTab;
  const sessions = { getTab: () => tab, agentProvider: () => "codex" } as unknown as SessionStore;
  await registerCooperationRoutes(app, { boards: f.boards, contexts: f.contexts, sessions, feedback: f.delivery });
  const locator = await f.contexts.prepare("tab-1");
  for (const request of [
    { action: "claim", eventId: "event-1" },
    { action: "apply", transaction: { boardId: f.board.boardId } },
    { action: "complete", completion: { providerTurnId: "turn-1", receiptOperationIds: [], startCursor: 0, noChangeReason: "This turn has ended." } }
  ]) {
    const response = await app.inject({ method: "POST", url: "/api/cooperation/agent", headers: { authorization: `Bearer ${locator.capability}` },
      payload: { ...request, tabId: "tab-1", boardId: locator.boardId, assignmentGeneration: locator.assignmentGeneration } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DELIVERY_UNAVAILABLE");
  }
});

it.each(["forgotten", "errored"])("does not publish a pending read after its watcher is %s and replaced", async lifecycle => {
  const f = await fixture();
  const gate = gateSnapshots(f.binding());
  const retired = f.native.observe("tab-1");
  await gate.first;
  const watcher = vi.mocked(watch).mock.results.at(-1)!.value as FSWatcher;
  if (lifecycle === "forgotten") f.native.forget("tab-1");
  else watcher.emit("error", new Error("retired watcher failed"));
  await f.native.observe("tab-1");
  expect(f.turns).toHaveBeenLastCalledWith(expect.objectContaining({ status: "completed" }));
  const watchCalls = vi.mocked(watch).mock.calls.length;
  watcher.emit("error", new Error("delayed retired watcher error"));
  await f.native.observe("tab-1");
  expect(vi.mocked(watch)).toHaveBeenCalledTimes(watchCalls);
  gate.release();
  await retired;
  expect(f.turns.mock.calls.map(([turn]) => turn.status)).toEqual(["completed"]);
});

it("waits for the same initial observation when a tab is observed twice", async () => {
  const f = await fixture();
  const gate = gateSnapshots(f.binding());
  const initial = f.native.observe("tab-1");
  await gate.first;
  const observed = vi.fn();
  const concurrent = f.native.observe("tab-1").then(observed);
  await Promise.resolve();
  expect(observed).not.toHaveBeenCalled();
  gate.release();
  await Promise.all([initial, concurrent]);
  expect(gate.receiptReads).toHaveBeenCalledTimes(1);
  expect(observed).toHaveBeenCalledTimes(1);
});

it("does not revive observations when a pending read finishes after close", async () => {
  const f = await fixture();
  const gate = gateSnapshots(f.binding());
  const initial = f.native.observe("tab-1");
  await gate.first;
  f.native.close();
  const afterClose = vi.fn();
  f.native.onTurn(afterClose);
  gate.release();
  await initial;
  expect(afterClose).not.toHaveBeenCalled();
  await f.native.observe("tab-1");
  expect(afterClose).not.toHaveBeenCalled();
});

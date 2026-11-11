import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { PluginSessionMissingError, type CreatePluginSessionInput, type PluginSession } from "@cloudx/plugin-api";
import type { HardwareItem, HardwareMutationResult, HardwareStateView, WorkspaceTab } from "@cloudx/shared";
import { DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES, DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES, type AppConfig } from "../config.js";
import { DEFAULT_ASR_TIMEOUT_MS } from "../asrClient.js";
import { DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES } from "../documentation/DocumentationClient.js";
import { buildServer, buildServices } from "../server.js";
import type { HardwareAgentLocator } from "./AgentHardwareContext.js";

const roots = new Set<string>();
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  vi.restoreAllMocks();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

async function fixture(savedRoot?: string) {
  const root = savedRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "hardware-tab-lifecycle-"));
  roots.add(root);
  const config: AppConfig = {
    host: "127.0.0.1", port: 3001, trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"], logLevel: "silent", allowedRoots: [root],
    asrUrl: "http://127.0.0.1:1", asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS, voiceModel: "gpt-5.3-codex-spark", documentationUrl: "http://127.0.0.1:1",
    dataDir: path.join(root, ".cloudx"), webDistDir: path.join(root, "missing-web-dist"), appServerEnabled: false, automationStartDisabled: true,
    terminalReplayBytes: 1024, voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES, documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
    documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES
  };
  const services = buildServices(config);
  const runtimes = new Map<string, { session: PluginSession; failTermination: boolean; reportCompletedTurn(): void }>();
  const plugin = services.plugins.get("codex-terminal");
  const launch = async (input: CreatePluginSessionInput): Promise<PluginSession> => {
    const initialInput = { ...input.initialInput, codexExecutionId: randomUUID() };
    await input.controls.setRestoreInput?.(initialInput);
    let exited = false;
    let statusChanged: Parameters<NonNullable<PluginSession["onStatusChange"]>>[0] = () => {};
    const runtime = { failTermination: false, reportCompletedTurn: () => statusChanged("completed", "The conversational turn ended; the native client remains live."),
      session: undefined as unknown as PluginSession };
    runtime.session = {
      tab: input.tab, restoreInput: () => initialInput, hasExited: () => exited, detach: () => {},
      async terminate() { if (runtime.failTermination) throw new Error("Native termination is unconfirmed."); exited = true; },
      onStatusChange(listener) { statusChanged = listener; return () => { statusChanged = () => {}; }; },
      snapshot: () => ({ tabId: input.tab.id, pluginId: plugin.id, title: input.tab.title, cwd: root, status: "running", state: { turn: "idle" } }),
      voiceContext: () => ({ kind: "agent", cwd: root, summary: "No native process or hardware is opened." }), handleAction: () => ({})
    };
    runtimes.set(input.tab.id, runtime);
    return runtime.session;
  };
  vi.spyOn(plugin, "createSession").mockImplementation(launch);
  vi.spyOn(plugin, "recoverSession").mockImplementation(launch);
  vi.spyOn(plugin, "restoreSession").mockImplementation(async input => {
    const runtime = runtimes.get(input.tab.id);
    if (!runtime) throw new PluginSessionMissingError("This broker has no matching native runtime.");
    return runtime.session;
  });
  const app = await buildServer(config, services); apps.push(app);
  const management = async (action: string, input: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action, input } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().result;
  };
  const mutate = (action: string, input: Record<string, unknown>) => management(action, { requestId: randomUUID(), ...input }) as Promise<HardwareMutationResult>;
  const state = async () => (await app.inject({ method: "GET", url: "/api/hardware/state" })).json<HardwareStateView>();
  const createAgent = async (initialInput: Record<string, unknown> = {}) => {
    const window = services.workspace!.getActiveWindow();
    const response = await app.inject({ method: "POST", url: "/api/tabs", payload: { pluginId: plugin.id, cwd: root, initialInput, windowId: window.id, paneId: window.layout.activePaneId } });
    expect(response.statusCode, response.body).toBe(201);
    const tab = response.json().tab as WorkspaceTab;
    return { tab, locator: (await services.hardwareContexts!.prepare(tab.id))! };
  };
  const agent = (locator: HardwareAgentLocator, action: string, input: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/hardware/agent",
    headers: { authorization: `Bearer ${locator.capability}` }, payload: { tabId: locator.owner.tabId, executionId: locator.owner.executionId, action, input } });
  const reserve = async (locator: HardwareAgentLocator, item: HardwareItem) => {
    const response = await agent(locator, "hardware.reserve", { requestId: randomUUID(), hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Native-tab lifecycle" });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().result as HardwareMutationResult;
  };
  const createTarget = async () => {
    const identity = path.join(root, "identity"); await fs.writeFile(identity, "No SSH connection is opened.\n", { mode: 0o600 });
    const created = await mutate("hardware.items.create", { newGroupName: "Lifecycle target", item: { name: "Lifecycle target", description: "", enabled: true,
      typeId: "hardware.ssh", configVersion: 1, config: { host: "fixture.invalid", port: 22, username: "fixture", auth: { kind: "identity_file", path: identity }, connectTimeoutMs: 1000 },
      tagIds: [], notes: "No hardware access is opened by this test.", statuses: [], hooks: { onRelease: { source: "printf release >> releases", cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] } } } });
    return created.receipt.result!.item as unknown as HardwareItem;
  };
  return { root, app, services, runtimes, state, createAgent, agent, reserve, createTarget };
}

it("closes a native tab, releases its lease, and refuses old ownership after a saved conversation is reopened", async () => {
  const f = await fixture();
  const item = await f.createTarget(), original = await f.createAgent({ resume: { mode: "session", sessionId: "saved-conversation" } });
  const acquired = await f.reserve(original.locator, item), ref = { reservationId: acquired.reservation!.reservationId, generation: acquired.reservation!.generation };
  const revoke = vi.spyOn(f.services.hardwareContexts!, "revoke");
  const closed = await f.app.inject({ method: "DELETE", url: `/api/tabs/${original.tab.id}` });
  expect(closed.statusCode, closed.body).toBe(200);
  await vi.waitFor(async () => expect((await f.state()).reservations).toEqual([]));
  expect(revoke).toHaveBeenCalledWith(original.tab.id);
  expect((await f.state()).history.some(event => event.kind === "owner_ended")).toBe(false);
  expect(await fs.readFile(path.join(f.root, "releases"), "utf8")).toBe("release");
  const next = await f.createAgent(), replacement = (await f.reserve(next.locator, item)).reservation!;
  const reopened = await f.createAgent({ resume: { mode: "session", sessionId: "saved-conversation" }, codexExecutionId: original.locator.owner.executionId });
  expect(reopened.locator.owner.executionId).not.toBe(original.locator.owner.executionId);
  expect((await f.agent(original.locator, "hardware.release", { requestId: randomUUID(), ...ref })).statusCode).toBe(403);
  const stale = await f.agent(reopened.locator, "hardware.access.open", { requestId: randomUUID(), ...ref });
  expect(stale.json().code).toBe("STALE_RESERVATION");
  const foreign = await f.agent(reopened.locator, "hardware.access.open", { requestId: randomUUID(), reservationId: replacement.reservationId, generation: replacement.generation });
  expect(foreign.json().code).toBe("OWNER_CHANGED");
  expect((await f.state()).reservations).toEqual([replacement]);
});

it("releases an explicitly closed persisted tab whose native runtime is missing without claiming producer quiescence", async () => {
  const first = await fixture();
  const item = await first.createTarget(), original = await first.createAgent();
  await first.reserve(original.locator, item);
  await first.app.close();
  const restored = await fixture(first.root);
  expect(restored.services.sessions.getTab(original.tab.id).recovery?.state).toBe("missing");
  expect((await restored.state()).reservations).toMatchObject([{ state: "recovery_required", lastOwnerObservation: "unknown" }]);
  const closed = await restored.app.inject({ method: "DELETE", url: `/api/tabs/${original.tab.id}` });
  expect(closed.statusCode, closed.body).toBe(200);
  await vi.waitFor(async () => expect((await restored.state()).reservations).toEqual([]));
  expect((await restored.state()).history.some(event => event.kind === "owner_ended")).toBe(false);
  expect(await fs.readFile(path.join(restored.root, "releases"), "utf8")).toBe("release");
  expect((await restored.agent(original.locator, "hardware.items.list", {})).statusCode).toBe(403);
});

it("keeps the lease for turn completion and an unsuccessful native-tab close", async () => {
  const f = await fixture();
  const item = await f.createTarget(), original = await f.createAgent();
  const acquired = await f.reserve(original.locator, item);
  f.runtimes.get(original.tab.id)!.reportCompletedTurn();
  expect((await f.state()).reservations[0].reservationId).toBe(acquired.reservation!.reservationId);
  f.runtimes.get(original.tab.id)!.failTermination = true;
  const closed = await f.app.inject({ method: "DELETE", url: `/api/tabs/${original.tab.id}` });
  expect(closed.statusCode).toBe(500);
  expect(f.services.sessions.getTab(original.tab.id)).toBeDefined();
  expect((await f.state()).reservations[0].generation).toBe(acquired.reservation!.generation);
  await expect(fs.stat(path.join(f.root, "releases"))).rejects.toMatchObject({ code: "ENOENT" });
});

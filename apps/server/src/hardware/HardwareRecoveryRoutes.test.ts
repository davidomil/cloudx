import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { AgentOwner, HardwareMutationResult, HardwareStateView, OperationReceipt } from "@cloudx/shared";
import { AgentHardwareContext } from "./AgentHardwareContext.js";
import { HardwareService } from "./HardwareService.js";
import { HardwareTypeRegistry } from "./HardwareTypeRegistry.js";
import { registerHardwareRoutes } from "./HardwareRoutes.js";
import { HardwareStore } from "./HardwareStore.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(initialState?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-recovery-http-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  if (initialState !== undefined) {
    await fs.mkdir(path.join(root, "hardware"));
    await fs.writeFile(path.join(root, "hardware/state.json"), initialState);
  }
  const owner: AgentOwner = { kind: "agent", tabId: "agent-1", providerId: "codex", executionId: "execution-1" };
  const contexts = new AgentHardwareContext({ dataDir: root, endpoint: () => "http://127.0.0.1/api/hardware/agent", binding: tabId => tabId === owner.tabId ? owner : undefined });
  const effects = { connect: 0, invoke: 0, close: 0 };
  const provider: HardwareTypeProvider<unknown> = {
    descriptor: { id: "fixture.device", ownerPluginId: "fixture", apiVersion: 1, configVersion: 1, displayName: "Fixture", description: "Emulated device",
      configSchema: { type: "object", additionalProperties: false }, operations: [{ id: "device.measure", description: "Read measurement", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", additionalProperties: false } }] },
    parseConfig: value => value,
    inspectEndpoint: async () => ({ resourceKeys: ["fixture:endpoint"], ready: true, blockers: [] }),
    describeAccess: () => ({ summary: "Emulator", details: {} }),
    connect: async (_config, context) => {
      effects.connect++;
      const close = async () => { effects.close++; return { state: "completed" as const, value: null }; };
      context.registerCleanup(close);
      return { state: "completed", value: { close, invoke: async () => { effects.invoke++; return { state: "completed", value: {} }; } } };
    }
  };
  const registry = new HardwareTypeRegistry([{ id: "fixture", hardwareTypes: [provider] }]);
  const hardware = new HardwareService({ dataDir: root, registry, ownerState: () => "active" });
  cleanups.push(() => hardware.dispose());
  if (initialState === undefined) await hardware.init();
  else await expect(hardware.init()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  const app = Fastify();
  await registerHardwareRoutes(app, hardware, contexts);
  await app.ready();
  cleanups.push(() => app.close());
  let sequence = 0;
  const inputFor = (action: string, input: Record<string, unknown>) => action === "hardware.diagnostics" ? input : { requestId: `request-${++sequence}`, ...input };
  const management = (action: string, input: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action, input: inputFor(action, input) } });
  const agent = async (action: string, input: Record<string, unknown> = {}) => {
    const locator = (await contexts.prepare(owner.tabId))!;
    return app.inject({ method: "POST", url: "/api/hardware/agent", headers: { authorization: `Bearer ${locator.capability}` }, payload: { tabId: owner.tabId, executionId: owner.executionId, action, input: inputFor(action, input) } });
  };
  const state = async () => {
    const response = await app.inject({ url: "/api/hardware/state" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.json<HardwareStateView>();
  };
  const settle = async (receipt: OperationReceipt, agentOwned: boolean) => {
    let observed: OperationReceipt | undefined;
    await vi.waitFor(async () => {
      const response = await (agentOwned ? agent : management)("hardware.receipt.get", { requestId: receipt.requestId });
      expect(response.statusCode, response.body).toBe(200);
      observed = response.json<{ result: { receipt: OperationReceipt } }>().result.receipt;
      expect(observed.state).not.toBe("running");
    });
    return observed!;
  };
  return { root, hardware, app, registry, effects, management, agent, state, settle };
}

async function openReservation(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await f.management("hardware.groups.create", { name: "Lab" })).statusCode).toBe(200);
  const group = (await f.state()).groups[0];
  expect((await f.management("hardware.items.create", { item: { name: "Target", description: "Emulated", enabled: true, physicalResourceId: group.id, typeId: "fixture.device", configVersion: 1, config: {}, tagIds: [], notes: "Do not reboot.", statuses: [], hooks: {} } })).statusCode).toBe(200);
  const item = (await f.state()).items[0].item;
  const reserved = await f.agent("hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Recover an idle open reservation" });
  expect(reserved.statusCode, reserved.body).toBe(200);
  expect((await f.settle(reserved.json<{ result: HardwareMutationResult }>().result.receipt, true)).state).toBe("succeeded");
  const claim = (await f.state()).reservations[0];
  const ref = { reservationId: claim.reservationId, generation: claim.generation };
  const opened = await f.agent("hardware.access.open", ref);
  expect(opened.statusCode, opened.body).toBe(200);
  expect((await f.settle(opened.json<{ result: HardwareMutationResult }>().result.receipt, true)).state).toBe("succeeded");
  expect((await f.state()).reservations[0]).toMatchObject({ ...ref, accessState: "open", activeOperationIds: [] });
  return ref;
}

function exhaustStorage(boundary: "write" | "directory_sync") {
  const original = fs.open;
  return vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await original(...args);
    if (typeof args[0] === "string") {
      const full = args[0];
      const error = Object.assign(new Error("private filesystem failure detail"), { code: "ENOSPC" });
      if (boundary === "write" && /\/\.state-.*\.tmp$/.test(full)) vi.spyOn(file, "writeFile").mockRejectedValue(error);
      if (boundary === "directory_sync" && full.endsWith("/hardware")) vi.spyOn(file, "sync").mockRejectedValue(error);
    }
    return file;
  });
}

it.each([
  { boundary: "write" as const, phase: "temporary_write", authorityReplaced: false, durability: "unchanged" },
  { boundary: "directory_sync" as const, phase: "directory_sync", authorityReplaced: true, durability: "unconfirmed" }
])("keeps recovery HTTP routes usable after ENOSPC at $boundary and resumes effects only after explicit durable reconciliation", async ({ boundary, phase, authorityReplaced, durability }) => {
  const f = await fixture();
  const ref = await openReservation(f);
  const before = await f.state();
  const fault = exhaustStorage(boundary);
  const failed = await f.management("hardware.groups.create", { name: "Storage failure" });
  expect(failed.statusCode, failed.body).toBe(503);
  expect(failed.json()).toMatchObject({ code: "STORE_UNAVAILABLE", details: { errno: "ENOSPC", authorityReplaced } });
  expect(failed.body).not.toContain("private filesystem failure detail");
  const unavailable = await f.state();
  expect(unavailable.readiness).toMatchObject({ state: "unavailable", recovery: { phase, errno: "ENOSPC", authorityReplaced, durability, nextAction: expect.any(String) } });
  expect(unavailable.reservations[0]).toMatchObject(ref);
  const override = { target: { kind: "reservation", ...ref }, expectedHoldRevision: unavailable.reservations[0].revision, reason: "Recover the idle reservation", acceptUnresolvedExternalActivity: false };
  expect((await f.management("hardware.forceRelease", override)).statusCode).toBe(503);
  expect((await f.agent("hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} })).statusCode).toBe(503);
  expect(f.effects).toMatchObject({ connect: 1, invoke: 0 });
  for (const action of ["hardware.reconcile", "hardware.diagnostics"])
    expect((await f.agent(action)).statusCode).toBe(403);
  const diagnostics = await f.management("hardware.diagnostics");
  expect(diagnostics.statusCode, diagnostics.body).toBe(200);
  expect(diagnostics.headers["cache-control"]).toBe("no-store");
  expect(diagnostics.json()).toMatchObject({ result: { lastConfirmedState: true, readiness: unavailable.readiness, state: { reservations: [expect.objectContaining(ref)] } } });
  expect((await f.management("hardware.reconcile")).statusCode).toBe(503);
  expect((await f.management("hardware.diagnostics")).statusCode).toBe(200);
  fault.mockRestore();
  expect((await f.state()).readiness.state).toBe("unavailable");
  expect((await f.agent("hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} })).statusCode).toBe(503);
  const reconciled = await f.management("hardware.reconcile");
  expect(reconciled.statusCode, reconciled.body).toBe(200);
  expect(reconciled.json()).toMatchObject({ result: { readiness: { state: "ready" }, reservations: [expect.objectContaining(ref)] } });
  const ready = await f.state();
  expect(ready.receipts).toEqual(expect.arrayContaining(before.receipts));
  expect(ready.history).toEqual(expect.arrayContaining(before.history));
  const released = await f.management("hardware.forceRelease", { ...override, expectedHoldRevision: ready.reservations[0].revision });
  expect(released.statusCode, released.body).toBe(200);
  expect(await f.settle(released.json<{ result: HardwareMutationResult }>().result.receipt, false)).toMatchObject({ state: "succeeded", result: { released: true, unresolvedActivityAccepted: false } });
  expect((await f.state()).reservations).toEqual([]);
  expect((await f.state()).items[0].availability).toBe("available");
  expect(f.effects.close).toBeGreaterThan(0);
  expect((await f.agent("hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} })).statusCode).toBe(409);
  expect(f.effects.invoke).toBe(0);
});

it("serves diagnostics and preserves corrupt startup evidence when operator reconciliation cannot read the store", async () => {
  const corrupt = '{"schemaVersion":1}';
  const f = await fixture(corrupt);
  const unavailable = await f.state();
  expect(unavailable.readiness).toMatchObject({ state: "unavailable", recovery: { phase: expect.any(String), nextAction: expect.any(String) } });
  const diagnostics = await f.management("hardware.diagnostics");
  expect(diagnostics.statusCode, diagnostics.body).toBe(200);
  expect(diagnostics.json()).toMatchObject({ result: { lastConfirmedState: false, readiness: unavailable.readiness } });
  expect((await f.management("hardware.reconcile")).statusCode).toBe(503);
  expect((await f.management("hardware.diagnostics")).statusCode).toBe(200);
  expect(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8")).toBe(corrupt);
  expect(f.effects).toEqual({ connect: 0, invoke: 0, close: 0 });
});

it("reports competing writer authority as HTTP 503 and retains the operator diagnostic path", async () => {
  const f = await fixture();
  await (f.hardware as unknown as { store: HardwareStore }).store.dispose();
  const writer = new HardwareStore(f.root);
  await writer.init();
  cleanups.push(() => writer.dispose());
  const recovered = await f.management("hardware.reconcile");
  expect(recovered.statusCode, recovered.body).toBe(503);
  expect(recovered.json()).toMatchObject({ code: "WRITER_LOST" });
  expect((await f.state()).readiness.state).toBe("unavailable");
  expect((await f.management("hardware.diagnostics")).statusCode).toBe(200);
  await writer.dispose();
  expect((await f.state()).readiness.state).toBe("unavailable");
  const reconciled = await f.management("hardware.reconcile");
  expect(reconciled.statusCode, reconciled.body).toBe(200);
  expect(reconciled.json()).toMatchObject({ result: { readiness: { state: "ready" } } });
});

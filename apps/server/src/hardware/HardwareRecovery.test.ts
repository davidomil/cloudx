import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareItem, HardwareMutationResult, HardwareOwner, OperationReceipt } from "@cloudx/shared";
import { HardwareService } from "./HardwareService.js";
import { HardwareStore } from "./HardwareStore.js";
import { HardwareScriptRunner } from "./HardwareScriptRunner.js";
import { HardwareError } from "./HardwareError.js";

const user: HardwareOwner = { kind: "user", userId: "local" };
const owner: HardwareOwner = { kind: "agent", tabId: "agent", providerId: "codex", executionId: "execution-1" };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(hooks: HardwareItem["hooks"] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-reconciliation-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const invoke = vi.fn(async () => ({ state: "completed" as const, value: {} }));
  const close = vi.fn(async () => ({ state: "completed" as const, value: null }));
  const provider: HardwareTypeProvider<unknown> = {
    descriptor: { id: "fixture.device", ownerPluginId: "fixture", apiVersion: 1, configVersion: 1, displayName: "Fixture", description: "Controlled device", configSchema: { type: "object" }, operations: [{ id: "device.measure", description: "Measure", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] },
    parseConfig: value => value,
    inspectEndpoint: async () => ({ resourceKeys: ["endpoint:fixture"], ready: true, blockers: [] }),
    describeAccess: () => ({ summary: "Controlled device", details: {} }),
    connect: async (_config, context) => { context.registerCleanup(close); return { state: "completed", value: { close, invoke } }; }
  };
  const service = new HardwareService({ dataDir: root, registry: { values: () => [provider], get: () => provider }, ownerState: () => "active" });
  cleanups.push(() => service.dispose());
  await service.init();
  let sequence = 0;
  const mutate = (action: string, input: Record<string, unknown>, candidate = user) => service.execute(action, { requestId: `request-${++sequence}`, ...input }, candidate) as Promise<HardwareMutationResult>;
  const settle = async (receipt: OperationReceipt, candidate = owner) => {
    let result!: OperationReceipt;
    await vi.waitFor(async () => {
      result = (await service.execute("hardware.receipt.get", { requestId: receipt.requestId }, candidate) as { receipt: OperationReceipt }).receipt;
      expect(result.state).not.toBe("running");
    });
    return result;
  };
  const created = await mutate("hardware.items.create", { newGroupName: "Lab", item: { name: "Target", description: "", enabled: true, typeId: "fixture.device", configVersion: 1, config: {}, tagIds: [], notes: "Do not reboot.", statuses: [], hooks } });
  const item = created.receipt.result!.item as unknown as HardwareItem;
  const reserve = async () => {
    const result = await mutate("hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Storage recovery" }, owner);
    await settle(result.receipt);
    const claim = (await service.snapshot(user)).reservations[0];
    return { reservationId: claim.reservationId, generation: claim.generation };
  };
  const open = async () => {
    const ref = await reserve();
    await settle((await mutate("hardware.access.open", ref, owner)).receipt);
    return ref;
  };
  const reconcile = (requestId = `reconcile-${++sequence}`) => service.execute("hardware.reconcile", { requestId }, user);
  const override = async (accept: boolean) => {
    const claim = (await service.snapshot(user)).reservations[0];
    const result = await mutate("hardware.forceRelease", { target: { kind: "reservation", reservationId: claim.reservationId, generation: claim.generation }, expectedHoldRevision: claim.revision, reason: "Inspect and clear the recovery hold", acceptUnresolvedExternalActivity: accept });
    return settle(result.receipt, user);
  };
  return { root, service, item, invoke, close, mutate, settle, reserve, open, reconcile, override };
}

function failDirectorySync() {
  const original = fs.open;
  return vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await original(...args);
    if (typeof args[0] === "string" && args[0].endsWith("/hardware")) vi.spyOn(file, "sync").mockRejectedValue(Object.assign(new Error("private host detail"), { code: "ENOSPC" }));
    return file;
  });
}

it("preserves a renamed generation revocation after a failed directory sync, while retaining its local handle for operator cleanup", async () => {
  const f = await fixture();
  const ref = await f.open();
  const fault = failDirectorySync();
  await expect(f.override(false)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  const saved = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
  expect(saved.reservations[0].generation).toBeGreaterThan(ref.generation);
  expect(f.close).not.toHaveBeenCalled();
  fault.mockRestore();
  await f.reconcile();
  const reconciled = await f.service.snapshot(user);
  expect(reconciled.reservations[0]).toMatchObject({ reservationId: ref.reservationId, generation: saved.reservations[0].generation, state: "recovery_required", accessState: "unknown" });
  await expect(f.mutate("hardware.access.open", ref, owner)).rejects.toMatchObject({ code: "STALE_RESERVATION" });
  expect((await f.override(false)).state).toBe("unknown");
  expect((await f.service.snapshot(user)).reservations).toHaveLength(1);
  expect(await f.override(true)).toMatchObject({ state: "succeeded", result: { released: true, unresolvedActivityAccepted: true } });
  expect(f.close).toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
  expect((await f.service.snapshot(user)).reservations).toEqual([]);
});

it("durably confirms a renamed operation result without replaying its effect", async () => {
  const f = await fixture();
  const ref = await f.open();
  let finish!: () => void;
  f.invoke.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { state: "completed", value: {} }; });
  const operation = await f.mutate("hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} }, owner);
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledOnce());
  const fault = failDirectorySync();
  finish();
  await vi.waitFor(async () => expect((await f.service.snapshot(user)).readiness.state).toBe("unavailable"));
  await vi.waitFor(() => expect((f.service as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(0));
  fault.mockRestore();
  await f.reconcile();
  // A renamed completion is read from disk. It is safe to retain its confirmed
  // outcome after the explicit reconciliation durably saves that authority.
  expect(await f.settle(operation.receipt)).toMatchObject({ state: "succeeded" });
  expect(f.invoke).toHaveBeenCalledOnce();
  expect((await f.service.snapshot(user)).reservations[0].state).toBe("active");
});

it("holds an interrupted operation whose completion was not renamed and never replays it during reconciliation", async () => {
  const f = await fixture();
  const ref = await f.open();
  let finish!: () => void;
  f.invoke.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { state: "completed", value: {} }; });
  const operation = await f.mutate("hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} }, owner);
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledOnce());
  const fault = vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  finish();
  await vi.waitFor(() => expect((f.service as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(0));
  fault.mockRestore();
  await f.reconcile();
  expect(await f.settle(operation.receipt)).toMatchObject({ state: "unknown", error: { code: "OUTCOME_UNKNOWN" } });
  expect((await f.service.snapshot(user)).reservations[0].state).toBe("recovery_required");
  expect((await f.override(false)).state).toBe("unknown");
  expect((await f.service.snapshot(user)).reservations).toHaveLength(1);
  expect((await f.override(true)).state).toBe("succeeded");
  expect(f.invoke).toHaveBeenCalledOnce();
});

it("does not replay a release hook admitted by a rename whose directory sync failed", async () => {
  const script = vi.spyOn(HardwareScriptRunner.prototype, "run");
  const f = await fixture({ onRelease: { source: "printf release", cwd: os.tmpdir(), timeoutMs: 1000, maxOutputBytes: 1000, credentialRefIds: [] } });
  const ref = await f.open();
  const fault = failDirectorySync();
  await expect(f.mutate("hardware.release", ref, owner)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  fault.mockRestore();
  await f.reconcile();
  expect((await f.service.snapshot(user)).reservations[0].state).toBe("recovery_required");
  expect((await f.override(false)).state).toBe("unknown");
  expect((await f.override(true)).state).toBe("succeeded");
  expect(script).not.toHaveBeenCalled();
});

it("requires local work to settle and keeps diagnostics available when reconciliation itself cannot proceed", async () => {
  const f = await fixture();
  const ref = await f.open();
  let finish!: () => void;
  f.invoke.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { state: "completed", value: {} }; });
  await f.mutate("hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} }, owner);
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledOnce());
  await expect(f.reconcile()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", details: { phase: "local_cleanup" } });
  expect(await f.service.execute("hardware.diagnostics", {}, user)).toMatchObject({ readiness: { state: "unavailable", recovery: { phase: "local_cleanup" } } });
  finish();
  await vi.waitFor(() => expect((f.service as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(0));
  await f.reconcile();
  expect((await f.service.snapshot(user)).reservations[0].state).toBe("recovery_required");
});

it("preserves reconciliation request receipts without closing admission on an available replay", async () => {
  const f = await fixture();
  await f.reconcile("same-recovery");
  const first = await f.service.snapshot(user);
  await f.reconcile("same-recovery");
  const second = await f.service.snapshot(user);
  expect(second).toEqual(first);
  expect(second.readiness.state).toBe("ready");
  expect(second.receipts.filter(receipt => receipt.requestId === "same-recovery")).toHaveLength(1);
});

it("reloads and durably confirms authority when an old reconciliation request races a failed replacement", async () => {
  const f = await fixture();
  await f.reconcile("known-recovery");
  const write = HardwareStore.prototype.write;
  let entered!: () => void, finish!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(HardwareStore.prototype, "write").mockImplementationOnce(async function (this: HardwareStore, state) {
    await write.call(this, state);
    entered(); await hold;
    throw new HardwareError("STORE_UNAVAILABLE", "Injected directory sync failure", { phase: "directory_sync", authorityReplaced: true, durability: "unconfirmed", errno: "ENOSPC" });
  });
  const changing = f.mutate("hardware.groups.create", { name: "New durable authority" });
  const failed = expect(changing).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  await writing;
  const recovering = f.reconcile("known-recovery");
  finish();
  await failed; await recovering;
  const confirmed = await f.service.snapshot(user);
  expect(confirmed.readiness.state).toBe("ready");
  expect(confirmed.groups.some(group => group.name === "New durable authority")).toBe(true);
  const saved = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
  expect(saved.revision).toBe(confirmed.revision);
  expect(saved.groups).toEqual(confirmed.groups);
  expect(confirmed.receipts.filter(receipt => receipt.requestId === "known-recovery")).toHaveLength(1);
});

it("rejects an older state after startup read valid authority but could not save reconciliation", async () => {
  const f = await fixture();
  await f.reserve();
  await f.service.dispose();
  const authority = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
  const restarting = new HardwareService({ dataDir: f.root, registry: { values: () => [], get: () => { throw new Error("Unavailable provider"); } } });
  cleanups.push(() => restarting.dispose());
  vi.spyOn(HardwareStore.prototype, "write").mockRejectedValueOnce(new HardwareError("STORE_UNAVAILABLE", "Injected startup storage failure"));
  await expect(restarting.init()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  const older = { ...authority, revision: authority.revision - 1 };
  await fs.writeFile(path.join(f.root, "hardware/state.json"), JSON.stringify(older));
  await expect(restarting.execute("hardware.reconcile", { requestId: "reject-rollback" }, user)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", details: { phase: "state_validate" } });
  expect((await restarting.snapshot(user)).readiness.state).toBe("unavailable");
  expect(JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"))).toEqual(older);
});

it("keeps unavailable shutdown cleanup from overwriting a renamed durable authority", async () => {
  const f = await fixture();
  await f.open();
  const fault = failDirectorySync();
  await expect(f.mutate("hardware.groups.create", { name: "Renamed before failure" })).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  const before = await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8");
  fault.mockRestore();
  await f.service.dispose();
  expect(f.close).toHaveBeenCalled();
  expect(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8")).toBe(before);
});

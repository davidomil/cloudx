import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareItemDraft, HardwareMutationResult, HardwareOwner, OperationReceipt, StatusDefinition, StatusValue } from "@cloudx/shared";
import { HardwareService, type HardwareServiceOptions } from "./HardwareService.js";
import { HardwareStore } from "./HardwareStore.js";
import { HardwareScriptRunner, type HardwareScriptResult } from "./HardwareScriptRunner.js";
import { PathPolicy } from "../pathPolicy.js";

const user: HardwareOwner = { kind: "user", userId: "local" };
const alice: HardwareOwner = { kind: "agent", tabId: "alice", providerId: "codex", executionId: "alice-1" };
const bob: HardwareOwner = { kind: "agent", tabId: "bob", providerId: "claude", executionId: "bob-1" };
const services: HardwareService[] = [];
const roots: string[] = [];
let sequence = 0;
const requestId = () => `request-${++sequence}`;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(retention?: HardwareServiceOptions["retention"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-service-"));
  roots.push(root);
  const provider: HardwareTypeProvider<{ endpoint: string; ready?: boolean }> = {
    descriptor: { id: "fixture.device", ownerPluginId: "fixture", apiVersion: 1, configVersion: 1, displayName: "Fixture", description: "Controlled device", configSchema: { type: "object" }, operations: [{ id: "device.measure", description: "Observe", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false } }] },
    parseConfig(value) { if (!value || typeof value !== "object" || !("endpoint" in value) || typeof value.endpoint !== "string") throw new Error("endpoint is required"); return value as { endpoint: string; ready?: boolean }; },
    async inspectEndpoint(config) { return { resourceKeys: [`endpoint:${config.endpoint}`], ready: config.ready !== false, blockers: config.ready === false ? ["Device absent"] : [] }; },
    describeAccess: () => ({ summary: "Controlled device", details: {} }),
    async connect(_config, context) {
      const close = async () => ({ state: "completed" as const, value: null });
      context.registerCleanup(close);
      return { state: "completed", value: { close, invoke: async () => ({ state: "completed", value: { value: 42 } }) } };
    },
  };
  const registry = { values: () => [provider], get: (id: string) => { if (id !== provider.descriptor.id) throw new Error("Provider missing"); return provider; } };
  const liveness = { observation: "active" as "active" | "confirmed_ended" | "unknown" };
  const service = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]), ownerState: () => liveness.observation, retention });
  services.push(service);
  await service.init();
  return { root, provider, registry, service, liveness };
}

async function mutate(service: HardwareService, action: string, input: Record<string, unknown>, owner = user) {
  return service.execute(action, { requestId: requestId(), ...input }, owner) as Promise<HardwareMutationResult>;
}
async function addItem(service: HardwareService, overrides: Partial<HardwareItemDraft> = {}) {
  const state = await service.snapshot(user);
  let group = state.groups[0];
  if (!group) { await mutate(service, "hardware.groups.create", { name: "Lab" }); group = (await service.snapshot(user)).groups[0]; }
  await mutate(service, "hardware.items.create", { item: { name: "Target", description: "", enabled: true, physicalResourceId: group.id, typeId: "fixture.device", configVersion: 1, config: { endpoint: "device-1" }, tagIds: [], notes: "Do not reboot.", statuses: [], hooks: {}, ...overrides } });
  return (await service.snapshot(user)).items.at(-1)!.item;
}
async function settled(service: HardwareService, receipt: OperationReceipt, owner = user) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await service.execute("hardware.receipt.get", { requestId: receipt.requestId }, owner) as { receipt: OperationReceipt };
    if (result.receipt.state !== "running") return result.receipt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Hardware operation did not settle.");
}

describe("hardware ownership and catalogs", () => {
  it("exposes an immutable claim-only owner query without acquisition configuration or hooks", async () => {
    const { service, provider } = await fixture(); const item = await addItem(service);
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Owner monitor" }, alice);
    const inspect = vi.spyOn(provider, "inspectEndpoint");
    const claims = service.ownerClaims(); expect(inspect).not.toHaveBeenCalled(); expect(claims[0]).not.toHaveProperty("acquiredItem");
    claims[0].resourceKeys.length = 0; claims[0].owner = bob;
    expect(service.ownerClaims()[0]).toMatchObject({ owner: alice }); expect(service.ownerClaims()[0].resourceKeys.length).toBeGreaterThan(0);
  });
  it("admits exactly one simultaneous owner, retains advisory notes, and releases for reuse", async () => {
    const { service } = await fixture();
    const item = await addItem(service);
    const results = await Promise.allSettled([alice, bob].map(owner => mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Validation" }, owner)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const state = await service.snapshot(user);
    expect(state.reservations).toHaveLength(1);
    expect(state.items[0].item.notes).toBe("Do not reboot.");
    const claim = state.reservations[0];
    const released = await mutate(service, "hardware.release", { reservationId: claim.reservationId, generation: claim.generation }, claim.owner);
    expect((await settled(service, released.receipt, claim.owner)).state).toBe("succeeded");
    expect((await service.snapshot(bob)).items[0].availability).toBe("available");
  });

  it("persists a preparing hold before dispatch, blocks aliases, and deduplicates request IDs", async () => {
    const { service, root } = await fixture();
    const script = { source: 'printf started > started; while [ ! -f finish ]; do sleep 0.02; done', cwd: root, timeoutMs: 5000, maxOutputBytes: 4096, credentialRefIds: [] };
    const item = await addItem(service, { hooks: { beforeReserve: script } });
    const alias = await addItem(service, { name: "Console", config: { endpoint: "device-console" } });
    const input = { requestId: requestId(), hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Deploy" };
    const first = await service.execute("hardware.reserve", input, alice) as HardwareMutationResult;
    expect((await service.snapshot(user)).reservations[0].state).toBe("preparing");
    await expect(mutate(service, "hardware.reserve", { hardwareId: alias.id, expectedItemRevision: alias.revision, purpose: "Conflicting" }, bob)).rejects.toMatchObject({ code: "RESERVATION_CONFLICT" });
    expect((await service.execute("hardware.reserve", input, alice) as HardwareMutationResult).receipt.runId).toBe(first.receipt.runId);
    await expect(service.execute("hardware.reserve", { ...input, purpose: "Changed" }, alice)).rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
    await fs.writeFile(path.join(root, "finish"), "ready");
    expect((await settled(service, first.receipt, alice)).state).toBe("succeeded");
  });

  it("keeps failed preparation held and rejects stale generations after operator override", async () => {
    const { service, root } = await fixture();
    const item = await addItem(service, { hooks: { beforeReserve: { source: "exit 9", cwd: root, timeoutMs: 1000, maxOutputBytes: 4096, credentialRefIds: [] } } });
    const result = await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Validation" }, alice);
    expect((await settled(service, result.receipt, alice)).state).toBe("failed");
    const held = (await service.snapshot(user)).reservations[0];
    expect(held.state).toBe("recovery_required");
    const overridden = await mutate(service, "hardware.forceRelease", { target: { kind: "reservation", reservationId: held.reservationId, generation: held.generation }, expectedHoldRevision: held.revision, reason: "Operator inspected target", acceptUnresolvedExternalActivity: true });
    expect((await settled(service, overridden.receipt)).state).toBe("succeeded");
    await expect(mutate(service, "hardware.access.open", { reservationId: held.reservationId, generation: held.generation }, alice)).rejects.toMatchObject({ code: "STALE_RESERVATION" });
  });

  it("preserves tag identity on rename, rejects used deletion, and enforces exact revisions", async () => {
    const { service } = await fixture();
    await mutate(service, "hardware.tags.create", { label: "ARM64", description: "Architecture" });
    const tag = (await service.snapshot(user)).tags[0];
    await addItem(service, { tagIds: [tag.id] });
    await mutate(service, "hardware.tags.update", { id: tag.id, expectedRevision: tag.revision, label: "arm64-v8" });
    expect((await service.snapshot(user)).items[0].item.tagIds).toEqual([tag.id]);
    await expect(mutate(service, "hardware.tags.update", { id: tag.id, expectedRevision: tag.revision, label: "Stale" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(mutate(service, "hardware.tags.delete", { id: tag.id, expectedRevision: tag.revision + 1 })).rejects.toMatchObject({ code: "IN_USE" });
    await expect(mutate(service, "hardware.groups.create", { name: "Unauthorized" }, alice)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects duplicate endpoints across groups and missing selected endpoints", async () => {
    const { service } = await fixture();
    await addItem(service);
    await mutate(service, "hardware.groups.create", { name: "Other lab" });
    const group = (await service.snapshot(user)).groups.at(-1)!;
    await expect(addItem(service, { physicalResourceId: group.id })).rejects.toMatchObject({ code: "ENDPOINT_CONFLICT" });
    const absent = await addItem(service, { name: "Absent", config: { endpoint: "absent", ready: false } });
    await expect(mutate(service, "hardware.reserve", { hardwareId: absent.id, expectedItemRevision: absent.revision, purpose: "Validation" }, alice)).rejects.toMatchObject({ code: "STATUS_NOT_READY" });
  });

  it("updates notes while held without policy enforcement and freezes connection configuration", async () => {
    const { service } = await fixture();
    const item = await addItem(service);
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Validation" }, alice);
    await mutate(service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { notes: "Do not reboot. Use test B." } });
    const current = (await service.snapshot(alice)).items[0].item;
    expect(current.notesRevision).toBe(item.notesRevision + 1);
    await expect(mutate(service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: current.revision, patch: { config: { endpoint: "other" } } })).rejects.toMatchObject({ code: "RESERVATION_CONFLICT" });
  });
});

describe("hardware status checks and recovery", () => {
  it("accepts a required false manual value and never lets it clear an internal claim", async () => {
    const { service } = await fixture();
    await mutate(service, "hardware.statuses.create", { label: "Busy", valueType: "boolean" });
    const definition = (await service.snapshot(user)).statusDefinitions[0];
    const item = await addItem(service, { statuses: [{ revision: 1, definitionId: definition.id, source: "manual", value: false, requiredForReserve: { equals: false } }] });
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Validation" }, alice);
    await mutate(service, "hardware.statuses.set", { hardwareId: item.id, expectedItemRevision: item.revision, definitionId: definition.id, value: true });
    expect((await service.snapshot(user)).items[0].availability).toBe("held");
    const claim = service.ownerClaims()[0];
    await service.ownerUnknown(alice, "Execution unconfirmed");
    await expect(mutate(service, "hardware.statuses.refresh", { hardwareId: item.id, reservationId: claim.reservationId, generation: claim.generation }, alice)).rejects.toMatchObject({ code: "INVALID_PHASE" });
    await expect(mutate(service, "hardware.statuses.refresh", { hardwareId: item.id, reservationId: claim.reservationId, generation: claim.generation + 1 }, alice)).rejects.toMatchObject({ code: "STALE_RESERVATION" });
  });

  it("holds a free group during a status script and stores an exact exit-status observation", async () => {
    const { service, root } = await fixture();
    await mutate(service, "hardware.statuses.create", { label: "Up", valueType: "boolean" });
    const definition = (await service.snapshot(user)).statusDefinitions[0];
    const item = await addItem(service, { statuses: [{ revision: 1, definitionId: definition.id, source: "command", script: { source: 'while [ ! -f measured ]; do sleep 0.02; done; exit 1', cwd: root, timeoutMs: 5000, maxOutputBytes: 4096, credentialRefIds: [] }, maxAgeMs: 1000, intervalMs: null, requiredForReserve: { equals: false } }] });
    const check = await mutate(service, "hardware.statuses.refresh", { hardwareId: item.id }, alice);
    expect((await service.snapshot(user)).checkHolds).toHaveLength(1);
    await expect(mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Validation" }, bob)).rejects.toMatchObject({ code: "CHECK_IN_PROGRESS" });
    await fs.writeFile(path.join(root, "measured"), "done");
    expect((await settled(service, check.receipt, alice)).state).toBe("succeeded");
    const state = await service.snapshot(user);
    expect(state.checkHolds).toEqual([]);
    expect(state.items[0].observations[0]).toMatchObject({ state: "known", value: false });
    expect(state.items[0].availability).toBe("available");
  });

  it("retains unknown effects through close and permits operator recovery", async () => {
    const { service, provider } = await fixture();
    provider.connect = async (_config, context) => {
      const close = async () => ({ state: "completed" as const, value: null });
      context.registerCleanup(close);
      return { state: "completed", value: { close, invoke: async () => ({ state: "unknown", error: { code: "LOST", message: "Remote result missing" } }) } };
    };
    const item = await addItem(service);
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Validation" }, alice);
    const claim = (await service.snapshot(user)).reservations[0];
    const opened = await mutate(service, "hardware.access.open", { reservationId: claim.reservationId, generation: claim.generation }, alice);
    await settled(service, opened.receipt, alice);
    const invoked = await mutate(service, "hardware.access.invoke", { reservationId: claim.reservationId, generation: claim.generation, operationId: "device.measure", input: {} }, alice);
    expect((await settled(service, invoked.receipt, alice)).state).toBe("unknown");
    const closed = await mutate(service, "hardware.access.close", { reservationId: claim.reservationId, generation: claim.generation }, alice);
    expect((await settled(service, closed.receipt, alice)).state).toBe("succeeded");
    expect((await service.snapshot(user)).reservations[0].state).toBe("recovery_required");
    await expect(mutate(service, "hardware.release", { reservationId: claim.reservationId, generation: claim.generation }, alice)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  });

  it("restores exact surviving claims and never transfers one to a replacement execution", async () => {
    const { service, root, registry } = await fixture();
    const item = await addItem(service);
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Validation" }, alice);
    await service.dispose();
    const restored = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]), ownerState: () => "active" });
    services.push(restored);
    await restored.init();
    expect((await restored.snapshot(user)).reservations[0].state).toBe("active");
    const claim = (await restored.snapshot(user)).reservations[0];
    await expect(mutate(restored, "hardware.access.open", { reservationId: claim.reservationId, generation: claim.generation }, { ...alice, executionId: "replacement" })).rejects.toMatchObject({ code: "OWNER_CHANGED" });
  });
});

describe("hardware command status values", () => {
  async function statusFixture(source: string, options: { valueType?: StatusDefinition["valueType"]; required?: StatusValue; maxOutputBytes?: number; timeoutMs?: number } = {}) {
    const { service, root } = await fixture();
    const valueType = options.valueType ?? "boolean";
    await mutate(service, "hardware.statuses.create", { label: "Observed", valueType, ...(valueType === "enum" ? { enumValues: ["ready", "busy"] } : {}) });
    const definition = (await service.snapshot(user)).statusDefinitions[0];
    const item = await addItem(service, { statuses: [{ revision: 1, definitionId: definition.id, source: "command", script: { source, cwd: root, timeoutMs: options.timeoutMs ?? 1000, maxOutputBytes: options.maxOutputBytes ?? 4096, credentialRefIds: [] }, maxAgeMs: 60_000, intervalMs: null, ...(options.required === undefined ? {} : { requiredForReserve: { equals: options.required } }) }] });
    const refresh = async () => settled(service, (await mutate(service, "hardware.statuses.refresh", { hardwareId: item.id })).receipt);
    return { service, root, item, refresh };
  }

  it.each([
    { source: "exit 0", exitCode: 0, value: true },
    { source: "printf 'PING fixture: host is reachable'; exit 0", exitCode: 0, value: true },
    { source: "printf false; exit 0", exitCode: 0, value: true },
    { source: "printf true; exit 1", exitCode: 1, value: false },
    ...[2, 7, 126, 127, 143, 255].map(exitCode => ({ source: `exit ${exitCode}`, exitCode, value: false })),
  ])("measures $value from normal exit $exitCode for $source", async ({ source, exitCode, value }) => {
    const { service, refresh } = await statusFixture(source);
    expect(await refresh()).toMatchObject({ state: "succeeded", result: { diagnostics: [{ exitCode, cleanupConfirmed: true }] } });
    const state = await service.snapshot(user);
    expect(state.items[0].observations).toMatchObject([{ state: "known", value }]);
    expect(state.checkHolds).toEqual([]);
  });

  it.each([
    { exitCode: 0, required: true, availability: "available" },
    { exitCode: 1, required: false, availability: "available" },
    { exitCode: 0, required: false, availability: "ineligible" },
    { exitCode: 1, required: true, availability: "ineligible" },
  ] as const)("gates required $required against exit $exitCode as $availability", async ({ exitCode, required, availability }) => {
    const { service, item, refresh } = await statusFixture(`exit ${exitCode}`, { required });
    expect((await refresh()).state).toBe("succeeded");
    expect((await service.snapshot(user)).items[0].availability).toBe(availability);
    const reserve = mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Verify exact status gate" });
    if (availability === "available") expect((await reserve).reservation?.state).toBe("active");
    else await expect(reserve).rejects.toMatchObject({ code: "STATUS_NOT_READY" });
  });

  it("replaces a successful true measurement with the latest false exit without changing the binding", async () => {
    const { service, root, refresh } = await statusFixture("test -f online", { required: true });
    await fs.writeFile(path.join(root, "online"), "reachable");
    const first = await refresh(); expect(first.state).toBe("succeeded");
    expect((await service.snapshot(user)).items[0].availability).toBe("available");
    await fs.rm(path.join(root, "online"));
    const latest = await refresh(); expect(latest.state).toBe("succeeded");
    const state = await service.snapshot(user);
    expect(state.items[0].observations).toMatchObject([{ state: "known", value: false, bindingRevision: 1, runId: latest.runId }]);
    expect(state.items[0].availability).toBe("ineligible"); expect(state.checkHolds).toEqual([]);
  });

  it.each([
    { source: "kill -TERM $$", maxOutputBytes: 4096, errorCode: "EXIT_CODE" },
    { source: "printf overflow", maxOutputBytes: 1, errorCode: "OUTPUT_LIMIT" },
    { source: "sleep 10 & exit 1", maxOutputBytes: 4096, errorCode: "DESCENDANTS_RUNNING" },
  ])("keeps $errorCode as a check error rather than a false measurement", async ({ source, maxOutputBytes, errorCode }) => {
    const { service, refresh } = await statusFixture(source, { maxOutputBytes, required: false });
    expect(await refresh()).toMatchObject({ state: "failed", result: { diagnostics: [{ errorCode }] } });
    const state = await service.snapshot(user);
    expect(state.items[0].observations).toMatchObject([{ state: "error", errorCode }]);
    expect(state.items[0].observations[0]).not.toHaveProperty("value");
    expect(state.items[0].availability).toBe("ineligible"); expect(state.checkHolds).toEqual([]);
  });

  it.each([
    { state: "failed", exitCode: null, errorCode: "SPAWN_FAILED", cleanupConfirmed: true },
    { state: "failed", exitCode: 1, errorCode: "STDIN_FAILED", cleanupConfirmed: true },
    { state: "unknown", exitCode: 1, errorCode: "CLEANUP_UNKNOWN", cleanupConfirmed: false },
  ] satisfies Array<Pick<HardwareScriptResult, "state" | "exitCode" | "errorCode" | "cleanupConfirmed">>)("preserves $errorCode runner failures independently of numeric exits", async result => {
    const { service, refresh } = await statusFixture("exit 0", { required: false });
    vi.spyOn(HardwareScriptRunner.prototype, "run").mockResolvedValueOnce({ ...result, stdout: "false", stderr: "", timedOut: false, cancelled: false });
    expect((await refresh()).state).toBe(result.state === "unknown" ? "unknown" : "failed");
    const state = await service.snapshot(user);
    expect(state.items[0].observations).toMatchObject([{ state: "error", errorCode: result.errorCode }]);
    expect(state.items[0].observations[0]).not.toHaveProperty("value");
    if (result.state === "unknown") expect(state.checkHolds).toMatchObject([{ state: "recovery_required" }]);
    else expect(state.checkHolds).toEqual([]);
  });

  it("retains cancelled status execution as an unknown receipt and recovery hold", async () => {
    const { service, root, item } = await statusFixture("printf started > started; sleep 10", { timeoutMs: 5000, required: false });
    const check = await mutate(service, "hardware.statuses.refresh", { hardwareId: item.id });
    for (let attempt = 0; attempt < 100; attempt++) { if (await fs.stat(path.join(root, "started")).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(await fs.readFile(path.join(root, "started"), "utf8")).toBe("started");
    await service.dispose();
    const state = JSON.parse(await fs.readFile(path.join(root, "hardware/state.json"), "utf8"));
    expect(state.receipts.find((record: { receipt: OperationReceipt }) => record.receipt.runId === check.receipt.runId).receipt).toMatchObject({ state: "unknown", result: { diagnostics: [{ cancelled: true, errorCode: "CANCELLED" }] } });
    expect(state.checkHolds).toMatchObject([{ state: "recovery_required" }]);
    expect(state.observations[item.id][0]).not.toHaveProperty("value");
  });

  it.each(["text", "enum"] as const)("keeps %s commands on successful typed JSON output", async valueType => {
    const { service, refresh } = await statusFixture(`printf '"ready"'`, { valueType, required: "ready" });
    expect((await refresh()).state).toBe("succeeded");
    expect((await service.snapshot(user)).items[0]).toMatchObject({ availability: "available", observations: [{ state: "known", value: "ready" }] });
  });

  it.each([
    { valueType: "text", source: "printf malformed", errorCode: "INVALID_STATUS_VALUE" },
    { valueType: "text", source: `printf '"ready" "another"'`, errorCode: "INVALID_STATUS_VALUE" },
    { valueType: "enum", source: "printf malformed", errorCode: "INVALID_STATUS_VALUE" },
    { valueType: "enum", source: `printf '"ready" "another"'`, errorCode: "INVALID_STATUS_VALUE" },
    { valueType: "enum", source: `printf '"unknown"'`, errorCode: "INVALID_STATUS_VALUE" },
    { valueType: "enum", source: "printf false", errorCode: "INVALID_STATUS_VALUE" },
    { valueType: "text", source: `printf '"ready"'; exit 1`, errorCode: "EXIT_CODE" },
    { valueType: "enum", source: `printf '"ready"'; exit 1`, errorCode: "EXIT_CODE" },
  ] as const)("rejects invalid $valueType execution: $source", async ({ valueType, source, errorCode }) => {
    const { service, refresh } = await statusFixture(source, { valueType });
    expect((await refresh()).state).toBe("failed");
    expect((await service.snapshot(user)).items[0].observations).toMatchObject([{ state: "error", errorCode }]);
  });

  it("keeps a nonzero release hook as a failure rather than a boolean measurement", async () => {
    const { service, root } = await fixture();
    const item = await addItem(service, { hooks: { onRelease: { source: "exit 7", cwd: root, timeoutMs: 1000, maxOutputBytes: 4096, credentialRefIds: [] } } });
    const reserved = await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Verify hook semantics" });
    const claim = reserved.reservation!;
    expect(await settled(service, (await mutate(service, "hardware.release", { reservationId: claim.reservationId, generation: claim.generation })).receipt)).toMatchObject({ state: "failed", error: { code: "HOOK_FAILED" }, result: { diagnostics: { exitCode: 7 } } });
    expect((await service.snapshot(user)).reservations).toMatchObject([{ state: "recovery_required" }]);
  });
});

describe("hardware admission and operation races", () => {
  it("reports closed access before the first open and after repeated close without losing the claim", async () => {
    const { service } = await fixture(); const item = await addItem(service);
    const claim = (await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Close safely" }, alice)).reservation!;
    const ref = { reservationId: claim.reservationId, generation: claim.generation };
    expect((await mutate(service, "hardware.access.close", ref, alice)).receipt).toMatchObject({ state: "succeeded", result: { closed: true } });
    await settled(service, (await mutate(service, "hardware.access.open", ref, alice)).receipt, alice);
    expect((await settled(service, (await mutate(service, "hardware.access.close", ref, alice)).receipt, alice)).state).toBe("succeeded");
    expect((await mutate(service, "hardware.access.close", ref, alice)).receipt.state).toBe("succeeded");
    expect((await service.snapshot(user)).reservations[0]).toMatchObject({ state: "active", accessState: "closed" });
  });
  it("rechecks exact execution liveness after endpoint inspection and before preparation", async () => {
    const { service, provider, root, liveness } = await fixture();
    const item = await addItem(service, { hooks: { beforeReserve: { source: "touch forbidden", cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] } } });
    let inspected!: () => void, proceed!: () => void;
    const reached = new Promise<void>(resolve => { inspected = resolve; }), gate = new Promise<void>(resolve => { proceed = resolve; });
    const inspect = provider.inspectEndpoint;
    provider.inspectEndpoint = async config => { inspected(); await gate; return inspect(config); };
    const pending = mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Stale launch" }, alice);
    await reached; liveness.observation = "unknown"; proceed();
    await expect(pending).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    expect((await service.snapshot(user)).reservations).toEqual([]);
    await expect(fs.stat(path.join(root, "forbidden"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prevents a queued operation from dispatching after the exact execution changes", async () => {
    const { service, provider, liveness } = await fixture();
    let calls = 0, entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
    provider.connect = async (_config, context) => { const close = async () => ({ state: "completed" as const, value: null }); context.registerCleanup(close); return { state: "completed", value: { close, invoke: async () => { calls++; entered(); await gate; return { state: "completed", value: { value: 42 } }; } } }; };
    const item = await addItem(service);
    const reservation = (await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Measure" }, alice)).reservation!;
    const ref = { reservationId: reservation.reservationId, generation: reservation.generation };
    await settled(service, (await mutate(service, "hardware.access.open", ref, alice)).receipt, alice);
    const first = await mutate(service, "hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} }, alice);
    await started;
    const queued = await mutate(service, "hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} }, alice);
    liveness.observation = "unknown"; finish();
    expect((await settled(service, first.receipt, alice)).state).toBe("succeeded");
    expect((await settled(service, queued.receipt, alice)).error?.code).toBe("OWNER_CHANGED");
    expect(calls).toBe(1);
  });

  it("keeps a cancelled in-flight effect held until the operator accepts its uncertainty", async () => {
    const { service, provider } = await fixture();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    provider.connect = async (_config, context) => { const close = async () => ({ state: "completed" as const, value: null }); context.registerCleanup(close); return { state: "completed", value: { close, invoke: async (_id, _input, signal) => { entered(); return new Promise(resolve => signal.addEventListener("abort", () => resolve({ state: "unknown", error: { code: "INTERRUPTED", message: "Remote completion unknown" } }), { once: true })); } } }; };
    const item = await addItem(service);
    const claim = (await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Measure" }, alice)).reservation!;
    const ref = { reservationId: claim.reservationId, generation: claim.generation };
    await settled(service, (await mutate(service, "hardware.access.open", ref, alice)).receipt, alice);
    const operation = await mutate(service, "hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} }, alice); await started;
    const held = (await service.snapshot(user)).reservations[0];
    const override = await mutate(service, "hardware.forceRelease", { target: { kind: "reservation", ...ref }, expectedHoldRevision: held.revision, reason: "Inspect remote activity", acceptUnresolvedExternalActivity: false });
    expect((await settled(service, operation.receipt, alice)).state).toBe("unknown");
    expect((await settled(service, override.receipt)).state).toBe("unknown");
    const recovery = (await service.snapshot(user)).reservations[0];
    expect(recovery).toMatchObject({ state: "recovery_required", generation: ref.generation + 1 });
    const accepted = await mutate(service, "hardware.forceRelease", { target: { kind: "reservation", reservationId: recovery.reservationId, generation: recovery.generation }, expectedHoldRevision: recovery.revision, reason: "Remote activity inspected", acceptUnresolvedExternalActivity: true });
    expect((await settled(service, accepted.receipt)).state).toBe("succeeded");
    expect((await service.snapshot(user)).reservations).toEqual([]);
  });

  it("closes leaked connection setup through cleanup registered before dispatch", async () => {
    const { service, provider } = await fixture();
    let closed = 0, entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    provider.connect = async (_config, context) => { context.registerCleanup(async () => { closed++; return { state: "completed", value: null }; }); entered(); return new Promise(resolve => context.signal.addEventListener("abort", () => resolve({ state: "unknown", error: { code: "INTERRUPTED", message: "Setup interrupted" } }), { once: true })); };
    const item = await addItem(service);
    const claim = (await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Open" }, alice)).reservation!;
    const ref = { reservationId: claim.reservationId, generation: claim.generation };
    const opened = await mutate(service, "hardware.access.open", ref, alice); await started;
    const release = await mutate(service, "hardware.release", ref, alice);
    expect((await settled(service, opened.receipt, alice)).state).toBe("unknown");
    expect((await settled(service, release.receipt, alice)).state).toBe("unknown");
    expect(closed).toBe(1);
    expect((await service.snapshot(user)).reservations[0].state).toBe("recovery_required");
  });

  it("does not use provider removal as owner end and still closes an existing handle", async () => {
    const { service, registry } = await fixture();
    const item = await addItem(service);
    const claim = (await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Open" }, alice)).reservation!;
    const ref = { reservationId: claim.reservationId, generation: claim.generation };
    await settled(service, (await mutate(service, "hardware.access.open", ref, alice)).receipt, alice);
    registry.get = () => { throw new Error("Plugin removed"); };
    expect((await service.snapshot(user)).reservations[0].state).toBe("active");
    expect((await settled(service, (await mutate(service, "hardware.access.close", ref, alice)).receipt, alice)).state).toBe("succeeded");
    expect((await settled(service, (await mutate(service, "hardware.release", ref, alice)).receipt, alice)).state).toBe("succeeded");
  });

  it("runs a release hook once for concurrent release requests and preserves human claims on shutdown", async () => {
    const { service, root, registry } = await fixture();
    const item = await addItem(service, { hooks: { onRelease: { source: 'printf release >> released; while [ ! -f finish ]; do sleep 0.02; done', cwd: root, timeoutMs: 5000, maxOutputBytes: 100, credentialRefIds: [] } } });
    const claim = (await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "User work" })).reservation!;
    const ref = { reservationId: claim.reservationId, generation: claim.generation };
    const [first, second] = await Promise.all([mutate(service, "hardware.release", ref), mutate(service, "hardware.release", ref)]);
    expect(first.receipt.runId).toBe(second.receipt.runId);
    await fs.writeFile(path.join(root, "finish"), "done");
    expect((await settled(service, first.receipt)).state).toBe("succeeded"); expect((await settled(service, second.receipt)).state).toBe("succeeded");
    expect(await fs.readFile(path.join(root, "released"), "utf8")).toBe("release");
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Survive shutdown" });
    await service.dispose();
    const restored = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]) }); services.push(restored); await restored.init();
    expect((await restored.snapshot(user)).reservations[0]).toMatchObject({ owner: user, state: "active" });
  });

  it("ends only the exact owner and accepts internal cleanup after closing admission", async () => {
    const { service } = await fixture(); const item = await addItem(service);
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Owned" }, alice);
    await service.ownerEnded({ ...alice, executionId: "old-execution" });
    expect((await service.snapshot(user)).reservations).toHaveLength(1);
    await service.ownerUnknown(alice, "Provider temporarily disconnected");
    expect((await service.snapshot(user)).reservations[0]).toMatchObject({ state: "recovery_required", lastOwnerObservation: "unknown" });
    service.beginShutdown();
    await expect(mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Rejected" }, bob)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
    await service.ownerEnded(alice);
    for (let attempt = 0; attempt < 100 && (await service.snapshot(user)).reservations.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await service.snapshot(user)).reservations).toEqual([]);
  });

  it("drains a known completed preparation after confirmed owner end without reactivating it", async () => {
    const { service, root, liveness } = await fixture();
    let entered!: () => void, complete!: (result: HardwareScriptResult) => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<HardwareScriptResult>(resolve => { complete = resolve; });
    const run = HardwareScriptRunner.prototype.run;
    vi.spyOn(HardwareScriptRunner.prototype, "run").mockImplementation(function (this: HardwareScriptRunner, script, context, signal) { if (context.purpose === "before_reserve") { entered(); return gate; } return run.call(this, script, context, signal); });
    const item = await addItem(service, { hooks: { beforeReserve: { source: "printf preparation", cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] }, onRelease: { source: "printf released > released", cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] } } });
    const reserved = await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "End while preparing" }, alice); await started;
    liveness.observation = "confirmed_ended"; await service.ownerEnded(alice);
    expect((await service.snapshot(user)).reservations[0].state).toBe("releasing");
    complete({ state: "completed", exitCode: 0, stdout: "preparation", stderr: "", timedOut: false, cancelled: false, cleanupConfirmed: true });
    expect((await settled(service, reserved.receipt, alice)).state).toBe("succeeded");
    for (let attempt = 0; attempt < 100 && service.ownerClaims().length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.ownerClaims()).toEqual([]); expect(await fs.readFile(path.join(root, "released"), "utf8")).toBe("released");
  });

  it("preserves confirmed owner end when later tab disappearance arrives during cleanup", async () => {
    const { service, root } = await fixture();
    const item = await addItem(service, { hooks: { onRelease: { source: 'printf started > cleanup; while [ ! -f finish ]; do sleep 0.02; done', cwd: root, timeoutMs: 5000, maxOutputBytes: 100, credentialRefIds: [] } } });
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Confirmed completion" }, alice);
    await service.ownerEnded(alice);
    for (let attempt = 0; attempt < 100; attempt++) { if (await fs.stat(path.join(root, "cleanup")).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    await service.ownerUnknown(alice, "The completed execution tab disappeared");
    expect(service.ownerClaims()[0]).toMatchObject({ state: "releasing", lastOwnerObservation: "confirmed_ended" });
    await fs.writeFile(path.join(root, "finish"), "done");
    for (let attempt = 0; attempt < 100 && service.ownerClaims().length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.ownerClaims()).toEqual([]); expect((await service.snapshot(user)).items[0].availability).toBe("available");
  });
});

describe("hardware discovery, observations, and retained evidence", () => {
  it("manages enum/text definitions and unused catalog records with exact revisions", async () => {
    const { service } = await fixture();
    const created = await mutate(service, "hardware.statuses.create", { label: "Mode", valueType: "enum", enumValues: ["ready", "busy"] });
    const definition = created.receipt.result!.statusDefinition as { id: string; revision: number };
    const item = await addItem(service, { statuses: [{ revision: 1, definitionId: definition.id, source: "manual", value: "ready", requiredForReserve: { equals: "ready" } }] });
    await expect(mutate(service, "hardware.statuses.set", { hardwareId: item.id, expectedItemRevision: item.revision, definitionId: definition.id, value: "READY" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mutate(service, "hardware.statuses.update", { id: definition.id, expectedRevision: definition.revision, enumValues: ["changed"] })).rejects.toMatchObject({ code: "IN_USE" });
    await mutate(service, "hardware.statuses.update", { id: definition.id, expectedRevision: definition.revision, label: "Execution mode" });
    await expect(mutate(service, "hardware.groups.delete", { id: item.physicalResourceId, expectedRevision: 1 })).rejects.toMatchObject({ code: "IN_USE" });
    await mutate(service, "hardware.items.delete", { hardwareId: item.id, expectedItemRevision: item.revision });
    await mutate(service, "hardware.statuses.delete", { id: definition.id, expectedRevision: 2 });
    await mutate(service, "hardware.groups.update", { id: item.physicalResourceId, expectedRevision: 1, name: "Empty lab" });
    await mutate(service, "hardware.groups.delete", { id: item.physicalResourceId, expectedRevision: 2 });
    expect((await service.snapshot(user)).items).toEqual([]); expect((await service.snapshot(user)).groups).toEqual([]); expect((await service.snapshot(user)).statusDefinitions).toEqual([]);
  });

  it("validates contributed configuration and operation output before exposing a usable result", async () => {
    const { service, provider } = await fixture();
    provider.descriptor.configSchema = { type: "object", properties: { endpoint: { type: "string" } }, required: ["endpoint"], additionalProperties: false };
    await expect(addItem(service, { config: { endpoint: "target", extra: true } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const item = await addItem(service);
    provider.connect = async (_config, context) => { const close = async () => ({ state: "completed" as const, value: null }); context.registerCleanup(close); return { state: "completed", value: { close, invoke: async () => ({ state: "completed", value: { invalid: true } }) } }; };
    const claim = (await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Validate output" }, alice)).reservation!;
    const ref = { reservationId: claim.reservationId, generation: claim.generation };
    await settled(service, (await mutate(service, "hardware.access.open", ref, alice)).receipt, alice);
    const result = await mutate(service, "hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} }, alice);
    expect((await settled(service, result.receipt, alice)).error?.code).toBe("INVALID_PROVIDER_OUTPUT");
    expect((await service.snapshot(user)).reservations[0].state).toBe("recovery_required");
  });

  it("retains an ambiguous system check across operator fencing until acknowledgement", async () => {
    const { service, root } = await fixture();
    await mutate(service, "hardware.statuses.create", { label: "Observed", valueType: "boolean" }); const definition = (await service.snapshot(user)).statusDefinitions[0];
    const item = await addItem(service, { statuses: [{ revision: 1, definitionId: definition.id, source: "command", script: { source: "printf running > checking; sleep 10; printf true", cwd: root, timeoutMs: 5000, maxOutputBytes: 100, credentialRefIds: [] }, maxAgeMs: 1000, intervalMs: null }] });
    const check = await mutate(service, "hardware.statuses.refresh", { hardwareId: item.id }, alice);
    for (let attempt = 0; attempt < 100; attempt++) { if (await fs.stat(path.join(root, "checking")).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    const held = (await service.snapshot(user)).checkHolds[0];
    await expect(mutate(service, "hardware.forceRelease", { target: { kind: "system_check", runId: held.runId, generation: held.generation }, expectedHoldRevision: held.revision + 1, reason: "Stale panel", acceptUnresolvedExternalActivity: false })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const override = await mutate(service, "hardware.forceRelease", { target: { kind: "system_check", runId: held.runId, generation: held.generation }, expectedHoldRevision: held.revision, reason: "Cancel check", acceptUnresolvedExternalActivity: false });
    expect((await settled(service, check.receipt, alice)).state).toBe("unknown"); expect((await settled(service, override.receipt)).state).toBe("unknown");
    const recovery = (await service.snapshot(user)).checkHolds[0];
    const accepted = await mutate(service, "hardware.forceRelease", { target: { kind: "system_check", runId: recovery.runId, generation: recovery.generation }, expectedHoldRevision: recovery.revision, reason: "Local checking process inspected", acceptUnresolvedExternalActivity: true });
    expect((await settled(service, accepted.receipt)).state).toBe("succeeded"); expect((await service.snapshot(user)).checkHolds).toEqual([]);
    expect((await service.snapshot(user)).items[0].observations).toEqual([]);
  });
  it("binds stable pagination to an exact filter and store revision", async () => {
    const { service } = await fixture();
    await mutate(service, "hardware.tags.create", { label: "ARM64" }); await mutate(service, "hardware.tags.create", { label: "Deployment" });
    const tags = (await service.snapshot(user)).tags;
    const zulu = await addItem(service, { name: "Zulu", config: { endpoint: "zulu" }, tagIds: tags.map(tag => tag.id) });
    const alpha = await addItem(service, { name: "alpha", config: { endpoint: "alpha" }, tagIds: [tags[0].id] });
    await addItem(service, { name: "Beta", config: { endpoint: "beta" }, tagIds: [] });
    const first = await service.execute("hardware.items.list", { limit: 1, tags: { all: [tags[0].id], none: [] } }, alice) as { items: Array<{ item: { id: string } }>; nextCursor: string };
    expect(first.items.map(summary => summary.item.id)).toEqual([alpha.id]);
    const second = await service.execute("hardware.items.list", { limit: 1, tags: { all: [tags[0].id], none: [] }, cursor: first.nextCursor }, alice) as { items: Array<{ item: { id: string } }>; nextCursor: null };
    expect(second.items.map(summary => summary.item.id)).toEqual([zulu.id]); expect(second.nextCursor).toBeNull();
    await expect(service.execute("hardware.items.list", { limit: 1, tags: { all: [tags[0].id], none: [] }, cursor: first.nextCursor }, bob)).rejects.toMatchObject({ code: "INVALID_FILTER" });
    const tagsPage = await service.execute("hardware.tags.list", { limit: 1 }, alice) as { nextCursor: string };
    await expect(service.execute("hardware.items.list", { limit: 1, cursor: tagsPage.nextCursor }, alice)).rejects.toMatchObject({ code: "INVALID_FILTER" });
    await expect(service.execute("hardware.items.list", { tags: { all: ["missing"] } }, alice)).rejects.toMatchObject({ code: "INVALID_FILTER" });
    await expect(service.execute("hardware.items.list", { typeIds: ["pcie"] }, alice)).rejects.toMatchObject({ code: "INVALID_FILTER" });
    await mutate(service, "hardware.items.update", { hardwareId: alpha.id, expectedItemRevision: alpha.revision, patch: { notes: "Changed" } });
    await expect(service.execute("hardware.items.list", { limit: 1, tags: { all: [tags[0].id], none: [] }, cursor: first.nextCursor }, alice)).rejects.toMatchObject({ code: "CURSOR_STALE" });
  });

  it("keeps unknown, stale, and mismatched status values ineligible without coercion", async () => {
    const { service, root } = await fixture();
    await mutate(service, "hardware.statuses.create", { label: "Ready", valueType: "boolean" }); const definition = (await service.snapshot(user)).statusDefinitions[0];
    const item = await addItem(service, { statuses: [{ revision: 1, definitionId: definition.id, source: "command", script: { source: "exit 1", cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] }, intervalMs: null, maxAgeMs: 1000, requiredForReserve: { equals: false } }] });
    expect((await service.snapshot(user)).items[0].availability).toBe("ineligible");
    const check = await mutate(service, "hardware.statuses.refresh", { hardwareId: item.id }, alice); await settled(service, check.receipt, alice);
    expect((await service.snapshot(user)).items[0].availability).toBe("available");
    const current = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(current + 2000);
    expect((await service.snapshot(user)).items[0].blockers.some(blocker => blocker.includes("stale"))).toBe(true); clock.mockRestore();
    await expect(service.execute("hardware.items.list", { statuses: [{ definitionId: definition.id, equals: "false", requireFresh: true }] }, alice)).rejects.toMatchObject({ code: "INVALID_FILTER" });
    const binding = { ...item.statuses[0], script: { ...(item.statuses[0].source === "command" ? item.statuses[0].script : {}), source: "exit 0" } };
    await expect(mutate(service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { statuses: [binding] } })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await mutate(service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { statuses: [{ ...binding, revision: 2 }] } });
    expect((await service.snapshot(user)).items[0].observations).toEqual([]);
    const mismatched = await mutate(service, "hardware.statuses.refresh", { hardwareId: item.id }, alice);
    expect((await settled(service, mismatched.receipt, alice)).state).toBe("succeeded");
    expect((await service.snapshot(user)).items[0]).toMatchObject({ availability: "ineligible", observations: [{ state: "known", value: true }] });
    expect((await service.snapshot(user)).checkHolds).toEqual([]);
  });

  it("prunes completed output by count while preserving old request identity across restart", async () => {
    const retention = { completedMaxEntries: 1, snapshotMaxCompletedReceipts: 1 };
    const { service, root, registry } = await fixture(retention);
    const item = await addItem(service, { hooks: { beforeReserve: { source: 'printf run >> executions', cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] } } });
    const input = { requestId: requestId(), hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Once" };
    const original = await service.execute("hardware.reserve", input, alice) as HardwareMutationResult; await settled(service, original.receipt, alice);
    await mutate(service, "hardware.tags.create", { label: "Later" });
    const saved = await service.execute("hardware.receipt.get", { requestId: input.requestId }, alice) as { receipt: OperationReceipt };
    expect(saved.receipt).toMatchObject({ state: "succeeded", outputPruned: { reason: "count" } }); expect(saved.receipt.result).toBeUndefined();
    expect((await service.snapshot(user)).receipts).toHaveLength(1);
    await service.dispose();
    const restored = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]), ownerState: () => "active", retention }); services.push(restored); await restored.init();
    const repeated = await restored.execute("hardware.reserve", input, alice) as HardwareMutationResult;
    expect(repeated.receipt.runId).toBe(original.receipt.runId); expect(repeated.receipt.outputPruned?.reason).toBe("count");
    expect(await fs.readFile(path.join(root, "executions"), "utf8")).toBe("run");
    await expect(restored.execute("hardware.reserve", { ...input, purpose: "Reuse" }, alice)).rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
  });

  it("bounds aggregate completed output, applies age retention, and preserves unknown diagnostics", async () => {
    const { service, root } = await fixture({ outputMaxBytes: 512, completedMaxAgeMs: 1000, completedMaxEntries: 2 });
    const large = await mutate(service, "hardware.tags.create", { label: "Large", description: "x".repeat(1000) });
    expect(large.receipt).toMatchObject({ state: "succeeded", outputPruned: { reason: "budget" } });
    const small = await mutate(service, "hardware.groups.create", { name: "Lab" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    await mutate(service, "hardware.tags.create", { label: "Later" }); clock.mockRestore();
    const old = await service.execute("hardware.receipt.get", { requestId: small.receipt.requestId }, user) as { receipt: OperationReceipt };
    expect(old.receipt.outputPruned?.reason).toBe("age");
    const item = await addItem(service, { hooks: { beforeReserve: { source: "printf diagnostic; sleep 10", cwd: root, timeoutMs: 50, maxOutputBytes: 100, credentialRefIds: [] } } });
    const result = await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Unknown effect" }, alice);
    expect((await settled(service, result.receipt, alice)).state).toBe("unknown");
    await mutate(service, "hardware.tags.create", { label: "Newest" });
    const uncertain = await service.execute("hardware.receipt.get", { requestId: result.receipt.requestId }, alice) as { receipt: OperationReceipt };
    expect(uncertain.receipt.outputPruned).toBeUndefined(); expect(uncertain.receipt.result?.diagnostics).toMatchObject({ stdout: "diagnostic", timedOut: true });
    expect((await service.snapshot(user)).receipts.some(receipt => receipt.runId === result.receipt.runId)).toBe(true);
  });

  it("sweeps aged completed output while the server is otherwise idle", async () => {
    const { service } = await fixture({ completedMaxAgeMs: 1000 });
    const result = await mutate(service, "hardware.tags.create", { label: "Old detail" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    for (let attempt = 0; attempt < 150; attempt++) {
      const receipt = (await service.execute("hardware.receipt.get", { requestId: result.receipt.requestId }, user) as { receipt: OperationReceipt }).receipt;
      if (receipt.outputPruned) { expect(receipt.outputPruned.reason).toBe("age"); return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("The idle retention sweep did not persist pruning.");
  });

  it("reconciles an interrupted durable snapshot without replaying preparation", async () => {
    const { service, root, registry } = await fixture();
    const item = await addItem(service, { hooks: { beforeReserve: { source: 'printf run >> executions; while [ ! -f finish ]; do sleep 0.02; done', cwd: root, timeoutMs: 5000, maxOutputBytes: 100, credentialRefIds: [] } } });
    const result = await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Crash point" }, alice);
    for (let attempt = 0; attempt < 100; attempt++) { if (await fs.stat(path.join(root, "executions")).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    const crashSnapshot = await fs.readFile(path.join(root, "hardware/state.json"), "utf8");
    await service.dispose();
    await fs.writeFile(path.join(root, "hardware/state.json"), crashSnapshot);
    const restored = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]), ownerState: () => "active" }); services.push(restored); await restored.init();
    expect((await restored.snapshot(user)).reservations[0]).toMatchObject({ state: "recovery_required", activeOperationIds: [] });
    const receipt = await restored.execute("hardware.receipt.get", { requestId: result.receipt.requestId }, alice) as { receipt: OperationReceipt };
    expect(receipt.receipt.state).toBe("unknown"); expect(await fs.readFile(path.join(root, "executions"), "utf8")).toBe("run");
  });

  it("never dispatches a preparation hook when durable admission fails", async () => {
    const { service, root } = await fixture();
    const item = await addItem(service, { hooks: { beforeReserve: { source: "touch forbidden", cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] } } });
    vi.spyOn(HardwareStore.prototype, "write").mockRejectedValueOnce(new Error("Injected durable admission failure"));
    await expect(mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Must persist first" }, alice)).rejects.toThrow("Injected durable admission failure");
    expect((await service.snapshot(user)).readiness.state).toBe("unavailable");
    await expect(fs.stat(path.join(root, "forbidden"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(path.join(root, "hardware/state.json"), "utf8")).reservations).toEqual([]);
  });

  it("starts one recorded cleanup on restored confirmed owner end and keeps unknown owners held", async () => {
    const { service, root, registry } = await fixture();
    const item = await addItem(service, { hooks: { onRelease: { source: "printf release >> released", cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] } } });
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Saved attempt" }, alice);
    await service.dispose();
    const unknown = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]), ownerState: () => "unknown" }); services.push(unknown); await unknown.init();
    expect((await unknown.snapshot(user)).reservations[0]).toMatchObject({ state: "recovery_required", lastOwnerObservation: "unknown" });
    await expect(fs.stat(path.join(root, "released"))).rejects.toMatchObject({ code: "ENOENT" });
    await unknown.dispose();
    const ended = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]), ownerState: () => "confirmed_ended" }); services.push(ended); await ended.init();
    for (let attempt = 0; attempt < 100 && (await ended.snapshot(user)).reservations.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await ended.snapshot(user)).reservations).toEqual([]);
    expect(await fs.readFile(path.join(root, "released"), "utf8")).toBe("release");
    expect((await ended.snapshot(user)).receipts.filter(receipt => receipt.requestId.startsWith("owner-ended-") && receipt.state === "succeeded")).toHaveLength(1);
  });
});

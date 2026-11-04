import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareItem, HardwareMutationResult, HardwareOwner, HardwareReservationRecord, OperationReceipt } from "@cloudx/shared";
import { PathPolicy } from "../pathPolicy.js";
import { HardwareService } from "./HardwareService.js";
import { emptyHardwareState } from "./HardwareStore.js";
import { HardwareCapacity, HARDWARE_CLEANUP_RESERVE, HARDWARE_STATE_BYTES } from "./HardwareCapacity.js";
import { HardwareError } from "./HardwareError.js";

const user: HardwareOwner = { kind: "user", userId: "local" };
const roots: string[] = [], services: HardwareService[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.allSettled(services.splice(0).map(service => service.dispose())); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fullReceiptIndex(options: { receiptCount?: number; escapedUnresolvedBytes?: number; stateBytes?: number; interruptedFinal?: boolean; missingReleaseCredential?: boolean; unknownConnection?: boolean; maximumTarget?: boolean; cleanupBarrier?: boolean; restartSiblings?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-capacity-")); roots.push(root);
  const at = new Date().toISOString();
  const state = emptyHardwareState();
  for (const name of ["active", "recovery", "checking", "scheduled", "new"]) {
    const item: HardwareItem = { id: name, revision: 1, name, description: "", enabled: true, physicalResourceId: `group-${name}`, typeId: "fixture", configVersion: 1, config: { endpoint: name }, tagIds: [], notes: "", notesRevision: 1, statuses: [], hooks: {} };
    if (name === "recovery" && options.missingReleaseCredential) item.hooks.onRelease = { source: "touch forbidden", cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: ["unavailable"] };
    if (name === "active" && options.maximumTarget) item.hooks.onRelease = { source: "printf ran >> executions; head -c 65536 /dev/zero", cwd: root, timeoutMs: 1000, maxOutputBytes: 65536, credentialRefIds: [] };
    if (name === "active" && options.cleanupBarrier) item.hooks.onRelease = { source: "printf ran >> executions", cwd: root, timeoutMs: 1000, maxOutputBytes: 65536, credentialRefIds: ["cleanup-barrier"] };
    state.groups.push({ id: item.physicalResourceId, revision: 1, name }); state.items.push(item);
    if (name === "scheduled" || name === "checking") item.statuses.push({ revision: 1, definitionId: "ready", source: "command", script: { source: "printf checked >> executions; printf true", cwd: root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] }, maxAgeMs: 1000, intervalMs: name === "scheduled" ? 1000 : null });
    if (name === "active" || name === "recovery") {
      const claim: HardwareReservationRecord = { reservationId: `reservation-${name}`, generation: state.nextGeneration++, revision: 1, hardwareId: item.id, owner: user, state: name === "active" ? "active" : "recovery_required", resourceKeys: [`physical:${item.physicalResourceId}`, `endpoint:${name}`].sort(), purpose: "Existing work", acquiredItemRevision: 1, acquiredNotesRevision: 1, acquiredAt: at, updatedAt: at, lastOwnerObservation: "active", activeOperationIds: [], accessState: "closed", acquiredItem: structuredClone(item), ...(name === "recovery" ? { recoveryReason: "Prior effects require operator acknowledgement.", recoveryCause: "effects" as const } : {}) };
      state.reservations.push(claim);
    }
  }
  state.statusDefinitions.push({ id: "ready", revision: 1, label: "Ready", valueType: "boolean" });
  state.checkHolds.push({ kind: "system_check", runId: "old-check", generation: state.nextGeneration++, revision: 1, hardwareId: "checking", resourceKeys: ["physical:group-checking", "endpoint:checking"], state: "recovery_required", bindingRevisions: [{ definitionId: "ready", revision: 1 }], startedAt: at, recoveryReason: "Prior checking lifetime is unknown." });
  const originalInput = { requestId: "reserve-before-capacity", hardwareId: "active", expectedItemRevision: 1, purpose: "Existing work" };
  state.receipts.push({ owner: user, action: "hardware.reserve", digest: createHash("sha256").update(canonical({ action: "hardware.reserve", input: originalInput })).digest("hex"), receipt: { requestId: originalInput.requestId, runId: "run-before-capacity", state: "succeeded", startedAt: at, finishedAt: at, reservation: { reservationId: "reservation-active", generation: 1 }, result: { state: "active" } } });
  for (let index = 1; index < (options.receiptCount ?? 100_000); index++) state.receipts.push({ owner: user, action: "hardware.statuses.refresh", digest: "0".repeat(64), receipt: { requestId: `request-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, runId: `run-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, state: options.escapedUnresolvedBytes ? "unknown" : "succeeded", startedAt: at, finishedAt: at, ...(options.escapedUnresolvedBytes ? { result: { stdout: "\0".repeat(options.escapedUnresolvedBytes) }, error: { code: "OUTCOME_UNKNOWN", message: "Unresolved evidence must be retained." } } : {}) } });
  if (options.stateBytes) {
    state.reservations = state.reservations.filter(claim => claim.hardwareId === "active" || options.restartSiblings); if (!options.restartSiblings) state.checkHolds = [];
    for (const item of state.items) for (const binding of item.statuses) if (binding.source === "command") binding.intervalMs = null;
    const claim = state.reservations[0];
    claim.owner = { kind: "agent", providerId: "codex", tabId: "ended-tab", executionId: "ended-execution" }; claim.lastOwnerObservation = "confirmed_ended";
    if (options.cleanupBarrier) {
      const item = state.items.find(item => item.id === claim.hardwareId)!;
      item.id = randomUUID(); claim.hardwareId = item.id; claim.acquiredItem.id = item.id; claim.reservationId = `reservation-${randomUUID()}`;
      claim.owner = { kind: "agent", providerId: "codex", tabId: randomUUID(), executionId: randomUUID() };
      originalInput.hardwareId = item.id; state.receipts[0].receipt.reservation = { reservationId: claim.reservationId, generation: claim.generation };
      state.receipts[0].digest = createHash("sha256").update(canonical({ action: "hardware.reserve", input: originalInput })).digest("hex");
    }
    if (options.restartSiblings) {
      claim.lastOwnerObservation = "active";
      const sibling = state.reservations[1]; sibling.owner = structuredClone(claim.owner); sibling.lastOwnerObservation = "active"; sibling.state = "active";
      delete sibling.recoveryCause; delete sibling.recoveryReason;
    }
    if (options.maximumTarget) {
      const item = state.items.find(item => item.id === claim.hardwareId)!;
      item.id = "h".repeat(128); claim.hardwareId = item.id; claim.acquiredItem.id = item.id; claim.reservationId = "r".repeat(128);
      originalInput.hardwareId = item.id; state.receipts[0].receipt.reservation = { reservationId: claim.reservationId, generation: claim.generation };
      state.receipts[0].digest = createHash("sha256").update(canonical({ action: "hardware.reserve", input: originalInput })).digest("hex");
    }
    fillToBytes(state, options.stateBytes);
    if (options.interruptedFinal) {
      claim.generation = state.nextGeneration++; claim.revision++; claim.state = "releasing"; claim.activeOperationIds = ["interrupted-final-run"];
      state.receipts.push({ owner: user, action: "hardware.forceRelease", digest: "0".repeat(64), finalCleanupTarget: { kind: "reservation", reservationId: claim.reservationId, generation: claim.generation }, receipt: { requestId: "interrupted-final", runId: "interrupted-final-run", state: "running", startedAt: at, reservation: { reservationId: claim.reservationId, generation: claim.generation } } });
    }
  }
  const text = `${JSON.stringify(state)}\n`;
  expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024 * 1024);
  console.info(`Full receipt fixture: ${state.receipts.length} identities, ${Buffer.byteLength(text)} bytes.`);
  await fs.mkdir(path.join(root, "hardware")); await fs.writeFile(path.join(root, "hardware/state.json"), text);
  let cleanupRegistrations = 0;
  const provider: HardwareTypeProvider<{ endpoint: string }> = {
    descriptor: { id: "fixture", ownerPluginId: "fixture", apiVersion: 1, configVersion: 1, displayName: "Fixture", description: "Capacity fixture", configSchema: { type: "object" }, operations: [] },
    parseConfig: value => value as { endpoint: string }, inspectEndpoint: async config => ({ resourceKeys: [`endpoint:${config.endpoint}`], ready: true, blockers: [] }), describeAccess: () => ({ summary: "Fixture", details: {} }),
    connect: async (_config, context) => { const close = async () => ({ state: "completed" as const, value: null }); context.registerCleanup(close); cleanupRegistrations++; return options.unknownConnection ? { state: "unknown", error: { code: "OPEN_UNKNOWN", message: "Connection setup has an unknown outcome." } } : { state: "completed", value: { close, invoke: async () => ({ state: "completed", value: {} }) } }; },
  };
  const registry = { values: () => [provider], get: () => provider };
  const service = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]), ...(options.restartSiblings ? { ownerState: () => "active" as const } : {}) }); services.push(service); await service.init();
  return { service, root, registry, originalInput, cleanupRegistrations: () => cleanupRegistrations };
}

async function settle(service: HardwareService, receipt: OperationReceipt, owner = user) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = await service.execute("hardware.receipt.get", { requestId: receipt.requestId }, owner) as { receipt: OperationReceipt };
    if (current.receipt.state !== "running") return current.receipt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Capacity cleanup did not finish.");
}
const execute = (service: HardwareService, action: string, input: Record<string, unknown>) => service.execute(action, input, user) as Promise<HardwareMutationResult>;

describe("Hardware retained-request capacity", () => {
  it("rejects fresh work and skips scheduled checks without poisoning a valid full index", async () => {
    const { service, root, originalInput } = await fullReceiptIndex();
    const before = await fs.readFile(path.join(root, "hardware/state.json"), "utf8");
    await expect(execute(service, "hardware.reserve", { requestId: "new-work", hardwareId: "new", expectedItemRevision: 1, purpose: "Must not start" })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    await (service as unknown as { checkScheduledStatuses(): Promise<void> }).checkScheduledStatuses();
    expect((await service.snapshot(user)).readiness.state).toBe("ready");
    expect(await fs.readFile(path.join(root, "hardware/state.json"), "utf8")).toBe(before);
    await expect(fs.stat(path.join(root, "executions"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await execute(service, "hardware.reserve", originalInput)).receipt.runId).toBe("run-before-capacity");
  }, 30_000);

  it("releases and overrides existing holds at capacity, preserving identities after restart", async () => {
    const { service, root, registry, originalInput } = await fullReceiptIndex();
    const released = await execute(service, "hardware.release", { requestId: "release-at-capacity", reservationId: "reservation-active", generation: 1 });
    expect((await settle(service, released.receipt)).state).toBe("succeeded");
    const held = service.ownerClaims().find(claim => claim.hardwareId === "recovery")!;
    const overrideInput = { requestId: "override-at-capacity", target: { kind: "reservation", reservationId: held.reservationId, generation: held.generation }, expectedHoldRevision: held.revision, reason: "Operator reconciled external effects", acceptUnresolvedExternalActivity: true };
    const overridden = await execute(service, "hardware.forceRelease", overrideInput);
    expect((await settle(service, overridden.receipt)).state).toBe("succeeded");
    const check = (await service.snapshot(user)).checkHolds[0];
    const cleared = await execute(service, "hardware.forceRelease", { requestId: "clear-check-at-capacity", target: { kind: "system_check", runId: check.runId, generation: check.generation }, expectedHoldRevision: check.revision, reason: "Operator reconciled checking lifetime", acceptUnresolvedExternalActivity: true });
    expect((await settle(service, cleared.receipt)).state).toBe("succeeded");
    expect(service.ownerClaims()).toEqual([]); expect((await service.snapshot(user)).checkHolds).toEqual([]);
    await service.dispose();
    const restored = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]) }); services.push(restored); await restored.init();
    expect((await restored.snapshot(user)).readiness.state).toBe("ready");
    expect((await execute(restored, "hardware.reserve", originalInput)).receipt.runId).toBe("run-before-capacity");
    expect((await execute(restored, "hardware.forceRelease", overrideInput)).receipt.runId).toBe(overridden.receipt.runId);
    const savedOverride = JSON.parse(await fs.readFile(path.join(root, "hardware/state.json"), "utf8")).receipts.find((record: { receipt: OperationReceipt }) => record.receipt.requestId === overrideInput.requestId);
    expect(savedOverride.finalCleanupTarget).toMatchObject({ kind: "reservation", reservationId: held.reservationId });
    expect(overridden.receipt).not.toHaveProperty("finalCleanupTarget");
    expect(JSON.parse(await fs.readFile(path.join(root, "hardware/state.json"), "utf8")).receipts).toHaveLength(100_003);
    await expect(execute(restored, "hardware.reserve", { ...originalInput, purpose: "Changed payload" })).rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
  }, 30_000);

  it("rejects byte-heavy new work before writing and keeps cleanup available under the physical bound", async () => {
    const { service, root } = await fullReceiptIndex({ receiptCount: 80, escapedUnresolvedBytes: 128 * 1024 });
    const before = await fs.readFile(path.join(root, "hardware/state.json"), "utf8");
    expect(Buffer.byteLength(before)).toBeGreaterThan(48 * 1024 * 1024);
    await expect(execute(service, "hardware.reserve", { requestId: "byte-quota-work", hardwareId: "new", expectedItemRevision: 1, purpose: "Must not start" })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect((await service.snapshot(user)).readiness.state).toBe("ready"); expect(await fs.readFile(path.join(root, "hardware/state.json"), "utf8")).toBe(before);
    const released = await execute(service, "hardware.release", { requestId: "byte-quota-release", reservationId: "reservation-active", generation: 1 });
    expect((await settle(service, released.receipt)).state).toBe("succeeded");
    expect((await fs.stat(path.join(root, "hardware/state.json"))).size).toBeLessThanOrEqual(64 * 1024 * 1024);
    const persisted = JSON.parse(await fs.readFile(path.join(root, "hardware/state.json"), "utf8"));
    expect(persisted.receipts.filter((record: { receipt: OperationReceipt }) => record.receipt.state === "unknown").every((record: { receipt: OperationReceipt }) => record.receipt.result?.stdout === "\0".repeat(128 * 1024))).toBe(true);
  }, 30_000);

  it("restores an interrupted final override at the byte boundary and funds a new explicit final escape", async () => {
    const { service, root, registry } = await fullReceiptIndex({ receiptCount: 1, stateBytes: HARDWARE_STATE_BYTES - HARDWARE_CLEANUP_RESERVE, interruptedFinal: true });
    const claim = service.ownerClaims()[0];
    expect(claim).toMatchObject({ state: "recovery_required", lastOwnerObservation: "confirmed_ended" });
    const old = await service.execute("hardware.receipt.get", { requestId: "interrupted-final" }, user) as { receipt: OperationReceipt };
    expect(old.receipt.state).toBe("unknown");
    const input = { requestId: "new-explicit-final", target: { kind: "reservation", reservationId: claim.reservationId, generation: claim.generation }, expectedHoldRevision: claim.revision, reason: "Operator reconciled the interrupted override", acceptUnresolvedExternalActivity: true };
    const final = await execute(service, "hardware.forceRelease", input);
    expect((await settle(service, final.receipt)).state).toBe("succeeded"); expect(service.ownerClaims()).toEqual([]);
    expect((await fs.stat(path.join(root, "hardware/state.json"))).size).toBeLessThanOrEqual(HARDWARE_STATE_BYTES);
    expect((await service.snapshot(user)).history.some(event => event.kind === "owner_ended")).toBe(true);
    await service.dispose();
    const restored = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]) }); services.push(restored); await restored.init();
    expect((await execute(restored, "hardware.forceRelease", input)).receipt.runId).toBe(final.receipt.runId);
    expect((await restored.execute("hardware.receipt.get", { requestId: "interrupted-final" }, user) as { receipt: OperationReceipt }).receipt.state).toBe("unknown");
  }, 30_000);

  it("honors an acknowledged final override when release-hook credential resolution fails", async () => {
    const { service, root } = await fullReceiptIndex({ receiptCount: 1, missingReleaseCredential: true });
    const held = service.ownerClaims().find(claim => claim.hardwareId === "recovery")!;
    const result = await execute(service, "hardware.forceRelease", { requestId: "accept-unavailable-hook", target: { kind: "reservation", reservationId: held.reservationId, generation: held.generation }, expectedHoldRevision: held.revision, reason: "Operator accepts the unavailable cleanup hook", acceptUnresolvedExternalActivity: true });
    expect(await settle(service, result.receipt)).toMatchObject({ state: "succeeded", result: { released: true, unresolvedActivityAccepted: true } });
    expect(service.ownerClaims().some(claim => claim.reservationId === held.reservationId)).toBe(false);
    await expect(fs.stat(path.join(root, "forbidden"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([HARDWARE_CLEANUP_RESERVE, 544 * 1024])("defers automatic owner cleanup when only a %i-byte final allowance remains", async allowance => {
    const { service } = await fullReceiptIndex({ receiptCount: 1, stateBytes: HARDWARE_STATE_BYTES - allowance });
    expect((await service.snapshot(user)).readiness.state).toBe("ready");
    const claim = service.ownerClaims()[0];
    expect(claim).toMatchObject({ state: "recovery_required", lastOwnerObservation: "confirmed_ended" });
    expect(claim.recoveryReason).toContain("capacity");
    const result = await execute(service, "hardware.forceRelease", { requestId: "final-after-owner-end", target: { kind: "reservation", reservationId: claim.reservationId, generation: claim.generation }, expectedHoldRevision: claim.revision, reason: "Operator accepts cleanup at the final allowance", acceptUnresolvedExternalActivity: true });
    expect((await settle(service, result.receipt)).state).toBe("succeeded"); expect(service.ownerClaims()).toEqual([]);
  }, 30_000);

  it("keeps confirmed-owner cleanup held when capacity denies closing an existing managed handle", async () => {
    const { service, cleanupRegistrations } = await fullReceiptIndex({ receiptCount: 1, unknownConnection: true });
    const opened = await execute(service, "hardware.access.open", { requestId: "uncertain-open", reservationId: "reservation-active", generation: 1 });
    expect((await settle(service, opened.receipt)).state).toBe("unknown");
    expect(cleanupRegistrations()).toBe(1);
    const check = HardwareCapacity.prototype.assertMutation;
    vi.spyOn(HardwareCapacity.prototype, "assertMutation").mockImplementation(function (this: HardwareCapacity, previous, next) {
      if (next.receipts.length > previous.receipts.length && next.receipts.at(-1)!.action === "hardware.access.close") throw new HardwareError("CAPACITY_EXCEEDED", "Closing would consume the final override allowance.");
      return check.call(this, previous, next);
    });
    await service.ownerEnded(user);
    expect((await service.snapshot(user)).readiness.state).toBe("ready");
    const claim = service.ownerClaims().find(claim => claim.hardwareId === "active")!;
    expect(claim).toMatchObject({ state: "recovery_required", lastOwnerObservation: "confirmed_ended" }); expect(claim.recoveryReason).toContain("capacity");
    const result = await execute(service, "hardware.forceRelease", { requestId: "final-after-close-denial", target: { kind: "reservation", reservationId: claim.reservationId, generation: claim.generation }, expectedHoldRevision: claim.revision, reason: "Operator accepts the incomplete managed cleanup", acceptUnresolvedExternalActivity: true });
    expect((await settle(service, result.receipt)).state).toBe("succeeded");
    expect(service.ownerClaims().some(held => held.reservationId === claim.reservationId)).toBe(false);
  });

  it("funds maximum valid override identities, escaped reason, and hook diagnostics at the byte boundary", async () => {
    const { service, root } = await fullReceiptIndex({ receiptCount: 1, stateBytes: HARDWARE_STATE_BYTES - 544 * 1024, maximumTarget: true });
    const claim = service.ownerClaims()[0], operator: HardwareOwner = { kind: "user", userId: "u".repeat(128) };
    expect(claim.reservationId).toHaveLength(128); expect(claim.hardwareId).toHaveLength(128);
    const input = { requestId: "q".repeat(128), target: { kind: "reservation", reservationId: claim.reservationId, generation: claim.generation }, expectedHoldRevision: claim.revision, reason: "\u0001".repeat(2000), acceptUnresolvedExternalActivity: true };
    const result = await service.execute("hardware.forceRelease", input, operator) as HardwareMutationResult;
    expect(await settle(service, result.receipt, operator)).toMatchObject({ state: "succeeded", result: { released: true, reason: input.reason, diagnostics: { stdout: "\0".repeat(65536), cleanupConfirmed: true } } });
    expect(service.ownerClaims()).toEqual([]); expect((await fs.stat(path.join(root, "hardware/state.json"))).size).toBeLessThanOrEqual(HARDWARE_STATE_BYTES);
    expect((await service.execute("hardware.forceRelease", input, operator) as HardwareMutationResult).receipt.runId).toBe(result.receipt.runId);
    expect(await fs.readFile(path.join(root, "executions"), "utf8")).toBe("ran");
  }, 30_000);

  it("rejects an underfunded final admission without changing persisted state or writer readiness", async () => {
    const { service, root } = await fullReceiptIndex({ receiptCount: 1, stateBytes: HARDWARE_STATE_BYTES - 528 * 1024, cleanupBarrier: true });
    const before = await fs.readFile(path.join(root, "hardware/state.json"), "utf8"), claim = service.ownerClaims()[0];
    const input = { requestId: randomUUID(), target: { kind: "reservation", reservationId: claim.reservationId, generation: claim.generation }, expectedHoldRevision: claim.revision, reason: "r".repeat(2000), acceptUnresolvedExternalActivity: true };
    await expect(execute(service, "hardware.forceRelease", input)).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(await fs.readFile(path.join(root, "hardware/state.json"), "utf8")).toBe(before);
    expect((await service.snapshot(user)).readiness.state).toBe("ready");
    expect(service.ownerClaims()[0]).toEqual(claim); await expect(fs.stat(path.join(root, "executions"))).rejects.toMatchObject({ code: "ENOENT" });
    const final = await execute(service, "hardware.forceRelease", { ...input, requestId: randomUUID(), reason: "Accepted" });
    expect((await settle(service, final.receipt)).state).toBe("succeeded"); expect(service.ownerClaims()).toEqual([]);
  }, 30_000);

  it.each([false, true])("keeps an actually admitted final override recoverable after its owning process is killed (siblings: %s)", async siblings => {
    const { service, root, registry } = await fullReceiptIndex({ receiptCount: 1, stateBytes: HARDWARE_STATE_BYTES - (siblings ? 3 : 1) * 544 * 1024, cleanupBarrier: true, restartSiblings: siblings });
    await service.dispose();
    const file = path.join(root, "hardware/state.json"), inputId = randomUUID();
    const source = `
      import { HardwareService } from ${JSON.stringify(new URL("./HardwareService.ts", import.meta.url).href)};
      const provider = { descriptor: { id: "fixture", ownerPluginId: "fixture", apiVersion: 1, configVersion: 1, displayName: "Fixture", description: "Capacity fixture", configSchema: { type: "object" }, operations: [] }, parseConfig: value => value, inspectEndpoint: async config => ({ resourceKeys: ["endpoint:" + config.endpoint], ready: true, blockers: [] }), describeAccess: () => ({ summary: "Fixture", details: {} }) };
      const service = new HardwareService({ dataDir: ${JSON.stringify(root)}, registry: { values: () => [provider], get: () => provider }, ownerState: () => "active", resolveCredential: () => new Promise(() => {}) });
      await service.init();
      const claim = service.ownerClaims()[0];
      const input = { requestId: ${JSON.stringify(inputId)}, target: { kind: "reservation", reservationId: claim.reservationId, generation: claim.generation }, expectedHoldRevision: claim.revision, reason: "r".repeat(2000), acceptUnresolvedExternalActivity: true };
      const result = await service.execute("hardware.forceRelease", input, ${JSON.stringify(user)});
      process.stdout.write(JSON.stringify({ input, receipt: result.receipt, writerPid: service.store.writer.child.pid }) + "\\n");
      process.stdin.resume();
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
    let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
    let writerPid: number | undefined;
    try {
      const admitted = await new Promise<{ input: Record<string, unknown>; receipt: OperationReceipt; writerPid: number }>((resolve, reject) => {
        let output = "";
        const cleanup = () => { clearTimeout(deadline); child.stdout.off("data", receive); child.off("error", failed); child.off("exit", exited); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const exited = (code: number | null) => failed(new Error(`Override process exited ${code}: ${errors}`));
        const receive = (chunk: Buffer) => {
          output += chunk;
          if (!output.includes("\n")) return;
          try { const value = JSON.parse(output.slice(0, output.indexOf("\n"))); cleanup(); resolve(value); }
          catch (error) { failed(error as Error); }
        };
        const deadline = setTimeout(() => failed(new Error(`Override admission did not finish: ${errors}`)), 10_000);
        child.stdout.on("data", receive); child.once("error", failed); child.once("exit", exited);
      });
      writerPid = admitted.writerPid;
      expect(admitted.receipt.state).toBe("running");
      const running = JSON.parse(await fs.readFile(file, "utf8"));
      expect(running.receipts.at(-1)).toMatchObject({ finalCleanupTarget: { kind: "reservation", ...admitted.receipt.reservation }, receipt: { runId: admitted.receipt.runId, state: "running" } });
      const ended = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await ended;
      await waitForWriterExit(writerPid);
      const resolveCredential = vi.fn();
      const restored = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]), ownerState: () => "confirmed_ended", resolveCredential }); services.push(restored);
      await restored.init();
      expect((await restored.snapshot(user)).readiness.state).toBe("ready");
      const claim = restored.ownerClaims().find(held => held.reservationId === admitted.receipt.reservation!.reservationId)!; expect(claim).toMatchObject({ state: "recovery_required", lastOwnerObservation: "confirmed_ended" });
      if (siblings) {
        const sibling = restored.ownerClaims().find(held => held.reservationId !== claim.reservationId)!;
        expect(sibling).toMatchObject({ state: "recovery_required", lastOwnerObservation: "confirmed_ended" }); expect(sibling.recoveryReason).toContain("capacity");
        expect((await restored.snapshot(user)).history.some(event => event.kind === "cleanup_capacity" && event.reservationId === sibling.reservationId)).toBe(true);
      }
      expect((await execute(restored, "hardware.forceRelease", admitted.input)).receipt).toMatchObject({ state: "unknown", runId: admitted.receipt.runId });
      expect(resolveCredential).not.toHaveBeenCalled(); await expect(fs.stat(path.join(root, "executions"))).rejects.toMatchObject({ code: "ENOENT" });
      const final = await execute(restored, "hardware.forceRelease", { ...admitted.input, requestId: randomUUID(), target: { kind: "reservation", reservationId: claim.reservationId, generation: claim.generation }, expectedHoldRevision: claim.revision });
      expect((await settle(restored, final.receipt)).state).toBe("succeeded"); expect(restored.ownerClaims()).toHaveLength(siblings ? 1 : 0);
      if (siblings) {
        const sibling = restored.ownerClaims()[0], check = (await restored.snapshot(user)).checkHolds[0];
        for (const target of [{ kind: "reservation", reservationId: sibling.reservationId, generation: sibling.generation }, { kind: "system_check", runId: check.runId, generation: check.generation }]) {
          const result = await execute(restored, "hardware.forceRelease", { requestId: randomUUID(), target, expectedHoldRevision: target.kind === "reservation" ? sibling.revision : check.revision, reason: "Accepted", acceptUnresolvedExternalActivity: true });
          expect((await settle(restored, result.receipt)).state).toBe("succeeded");
        }
        expect(restored.ownerClaims()).toEqual([]); expect((await restored.snapshot(user)).checkHolds).toEqual([]);
      }
      expect((await fs.stat(file)).size).toBeLessThanOrEqual(HARDWARE_STATE_BYTES);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const ended = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await ended; }
      if (writerPid) await waitForWriterExit(writerPid);
    }
  }, 30_000);
});

async function waitForWriterExit(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    if (!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("The killed service's writer helper did not exit.");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
}
function fillToBytes(state: ReturnType<typeof emptyHardwareState>, target: number) {
  let remaining = target - Buffer.byteLength(JSON.stringify(state)) - 1;
  while (remaining > 0) {
    const index = state.receipts.length;
    const saved = { owner: user, action: "hardware.access.invoke", digest: "0".repeat(64), receipt: { requestId: `evidence-${index}`, runId: `evidence-run-${index}`, state: "unknown" as const, startedAt: "2026-11-03T00:00:00.000Z", finishedAt: "2026-11-03T00:00:00.000Z", result: { data: "" } } };
    const overhead = Buffer.byteLength(JSON.stringify(saved)) + (state.receipts.length ? 1 : 0);
    if (remaining < overhead) { const previous = state.receipts.at(-1)!; previous.receipt.result!.data = String(previous.receipt.result!.data) + "x".repeat(remaining); break; }
    const bytes = Math.min(1024 * 1024 - 4096, remaining - overhead);
    saved.receipt.result.data = "x".repeat(bytes); state.receipts.push(saved); remaining -= overhead + bytes;
  }
  expect(Buffer.byteLength(JSON.stringify(state)) + 1).toBe(target);
}

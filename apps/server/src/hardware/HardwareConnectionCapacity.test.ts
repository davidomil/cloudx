import { describe, expect, it } from "vitest";
import type { HardwareItem, JsonObject } from "@cloudx/shared";
import { HardwareCapacity, HARDWARE_STATE_BYTES } from "./HardwareCapacity.js";
import { emptyHardwareState, validateHardwareState, type HardwareStoredState, type StoredHardwareReceipt } from "./HardwareStore.js";

const at = "2026-11-15T00:00:00.000Z", owner = { kind: "user" as const, userId: "local" };
const policy = new HardwareCapacity(), bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function pendingChecks(count = 1): HardwareStoredState {
  const state = emptyHardwareState();
  for (let index = 0; index < count; index++) {
    const item = addItem(state, `ssh-${index}`);
    state.checkHolds.push({ kind: "system_check", runId: `check-${index}`, generation: state.nextGeneration++, revision: 1, hardwareId: item.id, resourceKeys: [`physical:${item.physicalResourceId}`], state: "checking", bindingRevisions: [], connectionCheck: { itemRevision: item.revision }, startedAt: at });
  }
  return state;
}

function addItem(state: HardwareStoredState, id: string): HardwareItem {
  const item: HardwareItem = { id, revision: 1, name: id, description: "", enabled: true, physicalResourceId: `${id}-lab`, typeId: "hardware.ssh", configVersion: 1, config: { host: `${id}.example`, port: 22, username: "fixture", auth: { kind: "agent" }, connectTimeoutMs: 1000 }, tagIds: [], notes: "", notesRevision: 1, statuses: [], hooks: {} };
  state.items.push(item); state.groups.push({ id: item.physicalResourceId, revision: 1, name: id });
  return item;
}

function record(id: string, action = "hardware.access.invoke"): StoredHardwareReceipt {
  return { owner, action, digest: "0".repeat(64), receipt: { requestId: id, runId: `run-${id}`, state: "running", startedAt: at } };
}

function addSibling(state: HardwareStoredState): void {
  const item = addItem(state, "sibling");
  state.reservations.push({ reservationId: "sibling-reservation", generation: state.nextGeneration++, revision: 1, hardwareId: item.id, owner, state: "recovery_required", resourceKeys: [`physical:${item.physicalResourceId}`], purpose: "Recover", acquiredItemRevision: 1, acquiredNotesRevision: 1, acquiredAt: at, updatedAt: at, lastOwnerObservation: "active", activeOperationIds: [], accessState: "closed", acquiredItem: item, recoveryReason: "An earlier effect is unknown.", recoveryCause: "effects" });
}

function acknowledgeCleanup(state: HardwareStoredState, sibling = false): void {
  const saved = record("acknowledged-cleanup", "hardware.forceRelease");
  if (sibling) {
    const claim = state.reservations[0]; claim.generation = state.nextGeneration++; claim.revision++; claim.state = "releasing"; claim.activeOperationIds.push(saved.receipt.runId);
    saved.receipt.reservation = { reservationId: claim.reservationId, generation: claim.generation };
    saved.finalCleanupTarget = { kind: "reservation", ...saved.receipt.reservation };
  } else {
    const hold = state.checkHolds[0]; hold.generation = state.nextGeneration++; hold.revision++; hold.state = "recovery_required"; hold.recoveryReason = "The previous checking generation was revoked for operator cleanup.";
    saved.finalCleanupTarget = { kind: "system_check", runId: hold.runId, generation: hold.generation };
  }
  state.receipts.push(saved);
}

function maximumDiagnostics(): JsonObject {
  const diagnostics = { stdout: "", stderr: "\0".repeat(10 * 1024) };
  diagnostics.stdout = "x".repeat(64 * 1024 - bytes(diagnostics));
  expect(bytes(diagnostics)).toBe(64 * 1024);
  return diagnostics;
}

function unknownChecks(state: HardwareStoredState): void {
  for (const hold of state.checkHolds) {
    hold.state = "recovery_required"; hold.revision++; hold.recoveryReason = "\u0001".repeat(4096);
    hold.connectionCheck!.diagnostics = maximumDiagnostics();
  }
}

function fillToAccountingLimit(state: HardwareStoredState): void {
  let remaining = HARDWARE_STATE_BYTES - 4096 - policy.accountedBytes(state, "bookkeeping");
  while (remaining > 0) {
    const saved = record(`evidence-${state.receipts.length}`); saved.receipt.state = "unknown"; saved.receipt.finishedAt = at; saved.receipt.result = { data: "" };
    const overhead = bytes(saved) + (state.receipts.length ? 1 : 0);
    if (remaining < overhead) { const last = state.receipts.at(-1)!.receipt.result!; last.data = String(last.data) + "x".repeat(remaining); break; }
    const length = Math.min(1024 * 1024 - 4096, remaining - overhead);
    saved.receipt.result.data = "x".repeat(length); state.receipts.push(saved); remaining -= overhead + length;
  }
  expect(policy.accountedBytes(state, "bookkeeping")).toBe(HARDWARE_STATE_BYTES - 4096);
}

describe("SSH connection-check recovery capacity", () => {
  it("preserves pending check evidence when a sibling acknowledged cleanup reaches capacity", () => {
    const before = pendingChecks(); addSibling(before); fillToAccountingLimit(before);
    expect(() => validateHardwareState(before)).not.toThrow();
    expect(() => policy.assertMutation(before, before)).not.toThrow();
    const cleaning = structuredClone(before); acknowledgeCleanup(cleaning, true);
    expect(() => validateHardwareState(cleaning)).not.toThrow();
    expect(() => policy.assertMutation(before, cleaning)).not.toThrow();
    const unknown = structuredClone(cleaning); unknownChecks(unknown);
    expect(() => validateHardwareState(unknown)).not.toThrow();
    expect(() => policy.assertMutation(cleaning, unknown)).not.toThrow();
    expect(policy.accountedBytes(unknown, "bookkeeping")).toBeLessThanOrEqual(HARDWARE_STATE_BYTES);
  });

  it.each(["ordinary", "cleanup", "bookkeeping"] as const)("funds bounded unknown evidence for every pending check during %s accounting", use => {
    const pending = pendingChecks(2), unknown = structuredClone(pending); unknownChecks(unknown);
    expect(() => validateHardwareState(unknown)).not.toThrow();
    expect(policy.accountedBytes(unknown, use) - policy.accountedBytes(pending, use)).toBeLessThan(128);
    expect(unknown.receipts).toEqual(pending.receipts);
    expect(unknown.checkHolds).toHaveLength(2);
  });

  it("keeps late diagnostics funded after an operator revokes the checking generation", () => {
    const pending = pendingChecks(); pending.checkHolds[0].state = "recovery_required"; pending.checkHolds[0].recoveryReason = "Cleanup still needs confirmation.";
    acknowledgeCleanup(pending);
    const settled = structuredClone(pending); settled.checkHolds[0].connectionCheck!.diagnostics = maximumDiagnostics();
    expect(() => validateHardwareState(pending)).not.toThrow(); expect(() => validateHardwareState(settled)).not.toThrow();
    expect(policy.accountedBytes(settled, "bookkeeping")).toBe(policy.accountedBytes(pending, "bookkeeping"));
    expect(() => policy.assertMutation(pending, settled)).not.toThrow();
    expect(settled.checkHolds[0].generation).toBe(pending.checkHolds[0].generation);
    expect(settled.checkHolds[0].state).toBe("recovery_required");
  });

  it("retains the recovery budget and diagnostics across startup without replaying a check", () => {
    const unknown = pendingChecks(); unknownChecks(unknown);
    const restored = structuredClone(unknown), hold = restored.checkHolds[0];
    hold.revision++; hold.state = "recovery_required"; hold.recoveryReason = "CloudX restarted before this checking process was confirmed ended.";
    expect(() => validateHardwareState(restored)).not.toThrow();
    expect(Math.abs(policy.accountedBytes(restored, "bookkeeping") - policy.accountedBytes(unknown, "bookkeeping"))).toBeLessThan(1024);
    expect(restored.checkHolds[0].connectionCheck).toEqual(unknown.checkHolds[0].connectionCheck);
    expect(restored.checkHolds[0].generation).toBe(unknown.checkHolds[0].generation);
    expect(restored.receipts).toEqual(unknown.receipts);
    const cleaning = structuredClone(restored); acknowledgeCleanup(cleaning);
    expect(() => policy.assertMutation(restored, cleaning)).not.toThrow(); expect(() => validateHardwareState(cleaning)).not.toThrow();
  });

  it("returns a completed check's allowance only when its hold is removed", () => {
    const pending = pendingChecks(2), completed = structuredClone(pending);
    completed.checkHolds.shift();
    expect(() => validateHardwareState(completed)).not.toThrow();
    expect(() => policy.assertMutation(pending, completed)).not.toThrow();
    expect(policy.accountedBytes(pending, "bookkeeping") - policy.accountedBytes(completed, "bookkeeping")).toBeGreaterThan(600 * 1024);
    expect(completed.checkHolds[0]).toEqual(pending.checkHolds[1]);
    expect(completed.receipts).toEqual(pending.receipts);
  });
});

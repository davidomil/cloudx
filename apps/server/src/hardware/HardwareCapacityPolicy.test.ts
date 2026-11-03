import { describe, expect, it } from "vitest";
import type { HardwareItem, HardwareReservationRecord } from "@cloudx/shared";
import { HardwareCapacity, HARDWARE_CLEANUP_COMPLETION, HARDWARE_CLEANUP_RESERVE, HARDWARE_ORDINARY_BYTES, HARDWARE_STATE_BYTES } from "./HardwareCapacity.js";
import { emptyHardwareState, validateHardwareState, type HardwareStoredState, type StoredHardwareReceipt } from "./HardwareStore.js";

const at = "2026-11-03T00:00:00.000Z", owner = { kind: "user" as const, userId: "local" };
const policy = new HardwareCapacity();
function heldState() {
  const state = emptyHardwareState(); state.nextGeneration = 2;
  const item: HardwareItem = { id: "target", revision: 1, name: "Target", description: "", enabled: true, physicalResourceId: "lab", typeId: "fixture", configVersion: 1, config: {}, tagIds: [], notes: "", notesRevision: 1, statuses: [], hooks: {} };
  const claim: HardwareReservationRecord = { reservationId: "reservation", generation: 1, revision: 1, hardwareId: item.id, owner, state: "recovery_required", resourceKeys: ["physical:lab"], purpose: "Recover", acquiredItemRevision: 1, acquiredNotesRevision: 1, acquiredAt: at, updatedAt: at, lastOwnerObservation: "active", activeOperationIds: [], accessState: "closed", acquiredItem: item, recoveryReason: "An earlier effect is unknown.", recoveryCause: "effects" };
  state.groups.push({ id: "lab", revision: 1, name: "Lab" }); state.items.push(item); state.reservations.push(claim);
  return state;
}
function record(id: string, action = "hardware.access.invoke"): StoredHardwareReceipt {
  return { owner, action, digest: "0".repeat(64), receipt: { requestId: id, runId: `run-${id}`, state: "running", startedAt: at } };
}
function fillToBytes(state: HardwareStoredState, target: number) {
  let remaining = target - Buffer.byteLength(JSON.stringify(state)) - 1;
  while (remaining > 0) {
    const saved = record(`evidence-${state.receipts.length}`); saved.receipt.state = "unknown"; saved.receipt.finishedAt = at; saved.receipt.result = { data: "" };
    const overhead = Buffer.byteLength(JSON.stringify(saved)) + (state.receipts.length ? 1 : 0);
    if (remaining < overhead) { const previous = state.receipts.at(-1)!; previous.receipt.result!.data = String(previous.receipt.result!.data) + "x".repeat(remaining); break; }
    const bytes = Math.min(1024 * 1024 - 4096, remaining - overhead);
    saved.receipt.result.data = "x".repeat(bytes); state.receipts.push(saved); remaining -= overhead + bytes;
  }
  expect(Buffer.byteLength(JSON.stringify(state)) + 1).toBe(target);
}
function acknowledgedOverride(state: HardwareStoredState, id: string) {
  const claim = state.reservations[0]; claim.generation = state.nextGeneration++; claim.revision++;
  const saved = record(id, "hardware.forceRelease");
  saved.receipt.reservation = { reservationId: claim.reservationId, generation: claim.generation };
  saved.finalCleanupTarget = { kind: "reservation", ...saved.receipt.reservation };
  state.receipts.push(saved); return saved;
}

describe("Hardware completion and cleanup byte allowances", () => {
  it("leaves completion space for a running result and separately saved status observations", () => {
    const before = heldState(); fillToBytes(before, HARDWARE_ORDINARY_BYTES - 1024 * 1024);
    const next = structuredClone(before); next.receipts.push(record("new-command"));
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(HARDWARE_ORDINARY_BYTES);
    expect(() => policy.assertMutation(before, next)).toThrow(expect.objectContaining({ code: "CAPACITY_EXCEEDED" }));
    expect(policy.canSchedule(before)).toBe(false);
  });

  it("protects the last acknowledged override allowance from fresh close requests", () => {
    const before = heldState(); fillToBytes(before, HARDWARE_STATE_BYTES - HARDWARE_CLEANUP_RESERVE);
    expect(policy.accountedBytes(before)).toBe(HARDWARE_STATE_BYTES);
    const closing = structuredClone(before); closing.receipts.push(record("another-close", "hardware.access.close"));
    expect(() => policy.assertMutation(before, closing)).toThrow(expect.objectContaining({ code: "CAPACITY_EXCEEDED" }));
    const final = structuredClone(before); acknowledgedOverride(final, "final-cleanup");
    expect(() => policy.assertMutation(before, final)).not.toThrow();
    expect(() => validateHardwareState(final)).not.toThrow();
    expect(() => policy.assertCleanupAvailable(final, final.receipts.at(-1)!.finalCleanupTarget!)).toThrow(expect.objectContaining({ code: "OPERATION_IN_PROGRESS" }));
  });

  it("saves worst-case escaped hook diagnostics within the acknowledged completion allowance", () => {
    const before = heldState(); fillToBytes(before, HARDWARE_STATE_BYTES - HARDWARE_CLEANUP_RESERVE);
    const pending = structuredClone(before); const saved = acknowledgedOverride(pending, "escaped-cleanup");
    policy.assertMutation(before, pending);
    const complete = structuredClone(pending), receipt = complete.receipts.at(-1)!.receipt;
    receipt.state = "succeeded"; receipt.finishedAt = at; receipt.result = { released: true, reason: "\u0001".repeat(2000), diagnostics: { stdout: "\0".repeat(64 * 1024), stderr: "", state: "completed", cleanupConfirmed: true, exitCode: 0, timedOut: false, cancelled: false } };
    complete.reservations = [];
    expect(Buffer.byteLength(JSON.stringify(receipt.result))).toBeLessThan(HARDWARE_CLEANUP_COMPLETION);
    expect(() => policy.assertMutation(pending, complete)).not.toThrow(); expect(() => validateHardwareState(complete)).not.toThrow();
    expect(saved.finalCleanupTarget).toMatchObject({ reservationId: "reservation", generation: 2 });
  });

  it("keeps a new explicit final override admissible after interrupted cleanup is restored", () => {
    const before = heldState(); fillToBytes(before, HARDWARE_STATE_BYTES - HARDWARE_CLEANUP_RESERVE);
    const interrupted = structuredClone(before); acknowledgedOverride(interrupted, "interrupted-cleanup");
    interrupted.receipts.at(-1)!.receipt.state = "unknown"; interrupted.receipts.at(-1)!.receipt.finishedAt = at; interrupted.receipts.at(-1)!.receipt.error = { code: "OUTCOME_UNKNOWN", message: "Restart prevented proof of cleanup. Effects are not replayed." };
    const next = structuredClone(interrupted); acknowledgedOverride(next, "explicit-cleanup");
    expect(() => policy.assertMutation(interrupted, next)).not.toThrow(); expect(() => validateHardwareState(next)).not.toThrow();
    expect(next.receipts.find(saved => saved.receipt.requestId === "interrupted-cleanup")!.receipt.state).toBe("unknown");
  });

  it("validates private final-cleanup metadata against its action and exact recorded target", () => {
    const state = heldState(); acknowledgedOverride(state, "final");
    expect(() => validateHardwareState(state)).not.toThrow();
    for (const change of [
      (saved: StoredHardwareReceipt) => { saved.action = "hardware.access.invoke"; },
      (saved: StoredHardwareReceipt) => { saved.receipt.reservation = undefined; },
      (saved: StoredHardwareReceipt) => { saved.finalCleanupTarget!.generation = 0; },
      (saved: StoredHardwareReceipt) => { saved.receipt.reservation!.generation++; },
      (saved: StoredHardwareReceipt) => { Object.assign(saved.finalCleanupTarget!, { extra: true }); },
    ]) { const malformed = structuredClone(state); change(malformed.receipts[0]); expect(() => validateHardwareState(malformed)).toThrow(); }
  });
});

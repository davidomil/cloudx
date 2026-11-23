import { describe, expect, it } from "vitest";
import type { HardwareItem, HardwareReservationRecord } from "@cloudx/shared";
import { HardwareCapacity, HARDWARE_CLEANUP_COMPLETION, HARDWARE_CLEANUP_RESERVE, HARDWARE_ORDINARY_BYTES, HARDWARE_REQUEST_QUOTA, HARDWARE_STATE_BYTES } from "./HardwareCapacity.js";
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
function reconciliationReceipt(id: string): StoredHardwareReceipt {
  const saved = record(id, "hardware.reconcile");
  saved.receipt.state = "succeeded"; saved.receipt.finishedAt = at; saved.receipt.result = { reconciled: true };
  return saved;
}

describe("Hardware completion and cleanup byte allowances", () => {
  it("admits durable reconciliation above ordinary request and byte limits while ordinary work stays blocked", () => {
    const before = heldState();
    before.receipts = Array.from({ length: HARDWARE_REQUEST_QUOTA }, (_, index) => {
      const saved = record(`retained-${index}`); saved.receipt.state = "succeeded"; saved.receipt.finishedAt = at;
      return saved;
    });
    fillToBytes(before, HARDWARE_ORDINARY_BYTES + 1024);
    const reconciled = { ...before, receipts: [...before.receipts, reconciliationReceipt("reconcile-at-capacity")] };
    expect(() => validateHardwareState(reconciled)).not.toThrow();
    expect(() => policy.assertNewRequest(before, "hardware.reconcile")).not.toThrow();
    expect(() => policy.assertMutation(before, reconciled)).not.toThrow();
    expect(() => policy.assertNewRequest(reconciled, "hardware.access.invoke")).toThrow(expect.objectContaining({ code: "CAPACITY_EXCEEDED" }));
    expect(() => policy.assertMutation(reconciled, { ...reconciled, receipts: [...reconciled.receipts, record("ordinary-at-capacity")] })).toThrow(expect.objectContaining({ code: "CAPACITY_EXCEEDED" }));
    expect(policy.canSchedule(reconciled)).toBe(false);
  });

  it("charges reconciliation as bookkeeping and preserves final cleanup space at the durable state limit", () => {
    const before = heldState(), saved = reconciliationReceipt("near-state-limit");
    const pending = { ...before, receipts: [saved] };
    const bookkeepingReserve = policy.accountedBytes(pending, "bookkeeping") - Buffer.byteLength(JSON.stringify(pending)) - 1;
    const receiptBytes = Buffer.byteLength(JSON.stringify(saved)) + 1;
    fillToBytes(before, HARDWARE_STATE_BYTES - bookkeepingReserve - receiptBytes - 16 * 1024);
    const reconciled = { ...before, receipts: [...before.receipts, saved] };
    expect(policy.accountedBytes(reconciled, "bookkeeping")).toBe(HARDWARE_STATE_BYTES - 16 * 1024);
    expect(policy.accountedBytes(reconciled, "cleanup")).toBeGreaterThan(HARDWARE_STATE_BYTES);
    expect(() => policy.assertMutation(before, reconciled)).not.toThrow();
    const closing = { ...reconciled, receipts: [...reconciled.receipts, record("another-close", "hardware.access.close")] };
    expect(() => policy.assertMutation(reconciled, closing)).toThrow(expect.objectContaining({ code: "CAPACITY_EXCEEDED" }));
    const final = { ...reconciled, reservations: structuredClone(reconciled.reservations), receipts: [...reconciled.receipts] };
    acknowledgedOverride(final, "final-after-reconciliation");
    expect(() => policy.assertMutation(reconciled, final)).not.toThrow();
    expect(() => validateHardwareState(final)).not.toThrow();
    const enlarged = (bytes: number) => ({ ...reconciled, receipts: [...before.receipts, { ...saved, receipt: { ...saved.receipt, result: { reconciled: true, evidence: "x".repeat(bytes) } } }] });
    const spendsCleanupReserve = enlarged(32 * 1024);
    expect(Buffer.byteLength(JSON.stringify(spendsCleanupReserve)) + 1).toBeLessThan(HARDWARE_STATE_BYTES);
    expect(() => policy.assertMutation(before, spendsCleanupReserve)).toThrow(expect.objectContaining({ code: "CAPACITY_EXCEEDED" }));
    const exceedsStateLimit = enlarged(1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(exceedsStateLimit)) + 1).toBeGreaterThan(HARDWARE_STATE_BYTES);
    expect(() => policy.assertMutation(before, exceedsStateLimit)).toThrow(expect.objectContaining({ code: "CAPACITY_EXCEEDED" }));
  });

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

  it.each([
    { kinds: ["reservation"], sibling: undefined },
    { kinds: ["system_check"], sibling: undefined },
    { kinds: ["reservation", "system_check"], sibling: undefined },
    { kinds: ["reservation"], sibling: "effects" },
    { kinds: ["reservation"], sibling: "active" },
    { kinds: ["reservation"], sibling: "owner" },
  ])("funds restart bookkeeping for pending $kinds and $sibling siblings", ({ kinds, sibling }) => {
    const pending = heldState(), claim = pending.reservations[0];
    claim.owner = { kind: "agent", providerId: "codex", tabId: "t".repeat(128), executionId: "e".repeat(128), ownerPluginId: "p".repeat(128), logicalRunId: "l".repeat(128), workerId: "w".repeat(128), attemptId: "a".repeat(128) };
    claim.hardwareId = "h".repeat(128); claim.acquiredItem.id = claim.hardwareId; pending.items[0].id = claim.hardwareId; claim.reservationId = "r".repeat(128);
    if (kinds.includes("reservation")) {
      const saved = acknowledgedOverride(pending, "reservation-final"); claim.state = "releasing"; claim.activeOperationIds = [saved.receipt.runId];
    } else pending.reservations = [];
    if (kinds.includes("system_check") || sibling) {
      const item = { ...structuredClone(claim.acquiredItem), id: "c".repeat(128), physicalResourceId: "check-lab" };
      pending.items.push(item); pending.groups.push({ id: "check-lab", revision: 1, name: "Check lab" });
      const hold = { kind: "system_check" as const, runId: "s".repeat(128), hardwareId: item.id, generation: pending.nextGeneration++, revision: 1, resourceKeys: ["physical:check-lab"], state: "recovery_required" as const, bindingRevisions: [{ definitionId: "ready", revision: 1 }], startedAt: at, recoveryReason: "The previous checking generation was revoked for operator cleanup." };
      pending.checkHolds.push(hold);
      if (kinds.includes("system_check")) { const saved = record("check-final", "hardware.forceRelease"); saved.finalCleanupTarget = { kind: "system_check", runId: hold.runId, generation: hold.generation }; pending.receipts.push(saved); }
    }
    if (sibling) {
      const item = { ...structuredClone(claim.acquiredItem), id: "b".repeat(128), physicalResourceId: "sibling-lab" };
      pending.items.push(item); pending.groups.push({ id: "sibling-lab", revision: 1, name: "Sibling lab" });
      pending.reservations.push({ ...structuredClone(claim), reservationId: "n".repeat(128), generation: pending.nextGeneration++, hardwareId: item.id, acquiredItem: item, resourceKeys: ["physical:sibling-lab"], activeOperationIds: [], state: sibling === "active" ? "active" : "recovery_required", recoveryReason: sibling === "active" ? undefined : "The previous execution requires recovery.", recoveryCause: sibling === "active" ? undefined : sibling === "owner" ? "owner" : "effects" });
    }
    const restored = structuredClone(pending), observedAt = "+010000-01-01T00:00:00.000Z";
    for (const saved of restored.receipts) {
      saved.receipt.state = "unknown"; saved.receipt.finishedAt = observedAt;
      saved.receipt.error = { code: "OUTCOME_UNKNOWN", message: "CloudX restarted before the operation outcome was saved. The effect will not be replayed." };
    }
    for (const held of restored.reservations) {
      const cleanup = held.state === "active" || held.recoveryCause === "owner", accessState = held.accessState;
      const reason = "Automatic cleanup reached Hardware capacity. The resource remains held. Inspect its activity and use an acknowledged operator override.";
      Object.assign(held, { state: "recovery_required", revision: held.revision + (cleanup ? 3 : 2), lastOwnerObservation: "confirmed_ended", lastOwnerObservedAt: observedAt, recoveryReason: cleanup ? reason : "Startup could not prove the exact owner and all prior effects are settled.", recoveryCause: cleanup ? "cleanup" : "restart", accessState: cleanup ? accessState : "unknown", activeOperationIds: [], ...(cleanup ? { updatedAt: observedAt } : {}) });
      const event = { id: `event-${String(restored.history.length).padStart(36, "0")}`, at: observedAt, kind: "owner_ended", detail: "The exact execution owner has ended and its producer has quiesced.", owner: held.owner, reservationId: held.reservationId, hardwareId: held.hardwareId };
      restored.history.push(event);
      if (cleanup) restored.history.push({ ...event, id: `event-${String(restored.history.length).padStart(36, "0")}`, kind: "cleanup_capacity", detail: reason });
    }
    for (const held of restored.checkHolds) { held.revision++; held.recoveryReason = "CloudX restarted before this checking process was confirmed ended."; }
    expect(() => validateHardwareState(pending)).not.toThrow(); expect(() => validateHardwareState(restored)).not.toThrow();
    expect(policy.accountedBytes(pending, "bookkeeping")).toBeGreaterThanOrEqual(policy.accountedBytes(restored, "bookkeeping"));
    expect(restored.receipts.map(saved => saved.receipt.requestId)).toEqual(pending.receipts.map(saved => saved.receipt.requestId));
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

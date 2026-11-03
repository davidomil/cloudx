import type { HardwareHoldRef } from "@cloudx/shared";
import { HardwareError } from "./HardwareError.js";
import type { HardwareStoredState, StoredHardwareReceipt } from "./HardwareStore.js";

export const HARDWARE_STATE_BYTES = 64 * 1024 * 1024;
export const HARDWARE_ORDINARY_BYTES = 48 * 1024 * 1024;
export const HARDWARE_REQUEST_QUOTA = 100_000;
export const HARDWARE_CLEANUP_RESERVE = 640 * 1024;
export const HARDWARE_CLEANUP_COMPLETION = 512 * 1024;
const FINAL_ADMISSION_MARGIN = 32 * 1024;
export const HARDWARE_OPERATION_RESERVE = 4 * 1024 * 1024 + 128 * 1024;

const cleanupActions = new Set(["hardware.release", "hardware.forceRelease", "hardware.access.close"]);
type HardwareHold = HardwareStoredState["reservations"][number] | HardwareStoredState["checkHolds"][number];
type CapacityUse = "ordinary" | "cleanup" | "bookkeeping";

/** Ordinary work must leave room to save outcomes and clean up every existing hold. */
export class HardwareCapacity {
  assertNewRequest(state: HardwareStoredState, action: string): void {
    if (!cleanupActions.has(action) && state.receipts.length >= HARDWARE_REQUEST_QUOTA) this.exceeded(state, "The retained request index reached its ordinary-work quota. Existing receipts and cleanup remain available.");
  }

  canSchedule(state: HardwareStoredState): boolean {
    return state.receipts.length < HARDWARE_REQUEST_QUOTA && this.accountedBytes(state) + HARDWARE_OPERATION_RESERVE + 4096 <= HARDWARE_ORDINARY_BYTES;
  }

  assertMutation(previous: HardwareStoredState, next: HardwareStoredState): void {
    const added = next.receipts.slice(previous.receipts.length);
    const ordinary = added.some(record => !cleanupActions.has(record.action));
    if (ordinary && next.receipts.length > HARDWARE_REQUEST_QUOTA) this.exceeded(next, "The retained request index reached its ordinary-work quota.");
    const limit = ordinary ? HARDWARE_ORDINARY_BYTES : HARDWARE_STATE_BYTES;
    const final = added.length > 0 && added.every(record => record.finalCleanupTarget);
    const accounted = this.accountedBytes(next, ordinary ? "ordinary" : added.length && !final ? "cleanup" : "bookkeeping");
    if (accounted > limit) this.exceeded(next, ordinary ? "Hardware has no capacity for new work while preserving operation outcomes and cleanup." : "Hardware cleanup capacity is reserved for acknowledged overrides. Inspect existing receipts or explicitly acknowledge unresolved activity when releasing a hold.");
  }

  assertCleanupAvailable(state: HardwareStoredState, target: HardwareHoldRef): void {
    const existing = state.receipts.find(record => record.receipt.state === "running" && record.finalCleanupTarget && sameTarget(record.finalCleanupTarget, target));
    if (existing) throw new HardwareError("OPERATION_IN_PROGRESS", "An acknowledged override is already draining this held resource. Inspect its original receipt.", { requestId: existing.receipt.requestId });
  }

  accountedBytes(state: HardwareStoredState, use: CapacityUse = "ordinary"): number {
    const running = state.receipts.filter(record => record.receipt.state === "running"), final = running.filter(record => record.finalCleanupTarget);
    const completion = running.reduce((sum, record) => sum + this.completionReserve(record), 0);
    const allowance = (hold: HardwareHold) => use === "ordinary" ? HARDWARE_CLEANUP_RESERVE : HARDWARE_CLEANUP_COMPLETION + (use === "cleanup" ? FINAL_ADMISSION_MARGIN : this.finalAdmissionBytes(state, hold));
    const holds = [...state.reservations, ...state.checkHolds];
    let reserved = completion;
    for (const hold of holds) {
      const target: HardwareHoldRef = "reservationId" in hold ? { kind: "reservation", reservationId: hold.reservationId, generation: hold.generation } : { kind: "system_check", runId: hold.runId, generation: hold.generation };
      if (!final.some(record => sameTarget(record.finalCleanupTarget!, target))) reserved += allowance(hold);
    }
    if (final.length) {
      const restarted = holds.reduce((sum, hold) => sum + HARDWARE_CLEANUP_COMPLETION + this.finalAdmissionBytes(state, hold) + this.restartHoldBytes(hold), 0) + final.reduce((sum, record) => sum + this.restartReceiptBytes(record), 0);
      // Other outcomes can complete before cleanup crashes. Keep their credits
      // separate from the larger completion-or-restart branch for final cleanup.
      const otherCompletions = completion - final.reduce((sum, record) => sum + this.completionReserve(record), 0);
      reserved = Math.max(reserved, otherCompletions + restarted);
    }
    return Buffer.byteLength(JSON.stringify(state)) + 1 + reserved;
  }

  private restartReceiptBytes(record: StoredHardwareReceipt): number {
    const at = "+999999-12-31T23:59:59.999Z", bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const receipt = record.receipt;
    return Math.max(0, bytes({ state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "CloudX restarted before the operation outcome was saved. The effect will not be replayed." }, finishedAt: at }) - bytes({ state: receipt.state, error: receipt.error, finishedAt: receipt.finishedAt }));
  }

  private restartHoldBytes(hold: HardwareHold): number {
    const at = "+999999-12-31T23:59:59.999Z", bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const growth = (before: unknown, after: unknown) => Math.max(0, bytes(after) - bytes(before));
    if (!("reservationId" in hold)) return growth({ state: hold.state, recoveryReason: hold.recoveryReason, revision: hold.revision }, { state: "recovery_required", recoveryReason: "CloudX restarted before this checking process was confirmed ended.", revision: hold.revision + 1 }) + 64;
    const before = { state: hold.state, revision: hold.revision, lastOwnerObservation: hold.lastOwnerObservation, lastOwnerObservedAt: hold.lastOwnerObservedAt, recoveryReason: hold.recoveryReason, recoveryCause: hold.recoveryCause, accessState: hold.accessState, activeOperationIds: hold.activeOperationIds };
    const restored = { ...before, state: "recovery_required", revision: hold.revision + 2, lastOwnerObservation: "confirmed_ended", lastOwnerObservedAt: at, recoveryReason: "Startup could not prove the exact owner and all prior effects are settled.", recoveryCause: "restart", accessState: "unknown", activeOperationIds: [] };
    const ownerEnded = { id: `event-${"x".repeat(36)}`, at, kind: "owner_ended", detail: "The exact execution owner has ended and its producer has quiesced.", owner: hold.owner, reservationId: hold.reservationId, hardwareId: hold.hardwareId };
    let metadata = growth(before, restored) + bytes(ownerEnded);
    if (hold.state === "active" || hold.recoveryCause === "owner") {
      const reason = "Automatic cleanup reached Hardware capacity. The resource remains held. Inspect its activity and use an acknowledged operator override.";
      const deferred = { ...restored, revision: hold.revision + 3, recoveryReason: reason, recoveryCause: "cleanup", accessState: hold.accessState };
      metadata = Math.max(metadata, growth({ ...before, updatedAt: hold.updatedAt }, { ...deferred, updatedAt: at }) + bytes(ownerEnded) + bytes({ ...ownerEnded, kind: "cleanup_capacity", detail: reason }));
    }
    // Include array separators and the store/hold revision counters.
    return metadata + 64;
  }

  private finalAdmissionBytes(state: HardwareStoredState, hold: HardwareHold): number {
    const owner = { kind: "user", userId: "x".repeat(128) }, runId = `run-${"x".repeat(36)}`, at = "+999999-12-31T23:59:59.999Z";
    const reservation = "reservationId" in hold;
    const target: HardwareHoldRef = reservation ? { kind: "reservation", reservationId: hold.reservationId, generation: state.nextGeneration } : { kind: "system_check", runId: hold.runId, generation: state.nextGeneration };
    const receipt = { owner, action: "hardware.forceRelease", digest: "x".repeat(64), finalCleanupTarget: target, receipt: { requestId: "x".repeat(128), runId, state: "running", startedAt: at, ...(reservation ? { reservation: { reservationId: hold.reservationId, generation: state.nextGeneration } } : {}) } };
    const history = { id: `event-${"x".repeat(36)}`, at, kind: "override_requested", detail: "\u0001".repeat(2000), owner, hardwareId: hold.hardwareId, ...(reservation ? { reservationId: hold.reservationId } : {}) };
    const before = reservation ? { generation: hold.generation, revision: hold.revision, state: hold.state, updatedAt: hold.updatedAt, activeOperationIds: hold.activeOperationIds, releaseRunId: hold.releaseRunId } : { generation: hold.generation, revision: hold.revision, state: hold.state, recoveryReason: hold.recoveryReason };
    const after = reservation ? { ...before, generation: state.nextGeneration, revision: hold.revision + 1, state: "releasing", updatedAt: at, activeOperationIds: [...hold.activeOperationIds, runId], releaseRunId: hold.releaseRunId ?? (hold.acquiredItem.hooks.onRelease ? runId : undefined) } : { ...before, generation: state.nextGeneration, revision: hold.revision + 1, state: "recovery_required", recoveryReason: "The previous checking generation was revoked for operator cleanup." };
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    // Include both array separators and counter growth without serializing acquisition data.
    return bytes(receipt) + bytes(history) + Math.max(0, bytes(after) - bytes(before)) + 64;
  }

  private completionReserve(record: StoredHardwareReceipt): number {
    // A valid receipt result is at most 2 MiB. Status observations can also be saved
    // on the item. Cleanup saves at most 64 KiB of text (384 KiB after JSON escaping),
    // plus bounded reason/error strings, owner/target metadata, and history.
    return cleanupActions.has(record.action) ? HARDWARE_CLEANUP_COMPLETION : HARDWARE_OPERATION_RESERVE;
  }

  private exceeded(state: HardwareStoredState, message: string): never {
    throw new HardwareError("CAPACITY_EXCEEDED", message, { retainedRequests: state.receipts.length, ordinaryRequestQuota: HARDWARE_REQUEST_QUOTA, stateBytes: Buffer.byteLength(JSON.stringify(state)) + 1, ordinaryBytes: HARDWARE_ORDINARY_BYTES, maximumBytes: HARDWARE_STATE_BYTES });
  }
}

function sameTarget(a: HardwareHoldRef, b: HardwareHoldRef): boolean {
  return a.kind === b.kind && a.generation === b.generation && (a.kind === "reservation" && b.kind === "reservation" ? a.reservationId === b.reservationId : a.kind === "system_check" && b.kind === "system_check" && a.runId === b.runId);
}

import { describe, expect, it } from "vitest";
import { parseCloudxUpdateBackups, parseCloudxUpdateBackupPreview, parseCloudxUpdateBackupCleanup,
  parseCloudxUpdateBackupCleanupRequest, type CloudxUpdateBackup, type CloudxUpdateBackupCleanup } from "./cloudxUpdateBackups.js";

const id = "11111111-1111-4111-8111-111111111111";
const backup: CloudxUpdateBackup = {
  id: `${id}:snapshot`, runId: id, kind: "snapshot", sourceCommit: "a".repeat(40), targetCommit: "b".repeat(40),
  createdAt: "2026-10-04T03:02:05Z", outcome: "succeeded", path: `/state/settings-update/${id}/snapshot`,
  logicalBytes: 8199804310, allocatedBytes: 8199866368, reclaimableBytes: 4099933184,
};
const cleanup: CloudxUpdateBackupCleanup = {
  id, state: "completed", startedAt: backup.createdAt, finishedAt: "2026-10-04T03:04:05Z",
  results: [{ id: backup.id, runId: id, path: backup.path, status: "deleted", deletedLogicalBytes: backup.logicalBytes! }],
  freeSpace: [{ path: "/state", availableBytesBefore: 1024, availableBytesAfter: 4099934208 }],
};

describe("update backup contracts", () => {
  it("preserves measured storage, unknown allocation, protected versions and the bulk estimate", () => {
    const protectedBackup = { ...backup, id: `${id}:release`, kind: "release" as const,
      logicalBytes: null, allocatedBytes: null, reclaimableBytes: null, protectionReason: "A surviving terminal broker uses this release." };
    const value = { backups: [backup, protectedBackup], blockedReason: "An update is mutating the installation." };
    expect(parseCloudxUpdateBackups(value)).toEqual(value);
    const preview = { ...value, id, createdAt: backup.createdAt, reclaimableBytes: backup.reclaimableBytes!,
      estimateNote: "Shared extents may retain storage. Measured free space is reported after cleanup." };
    expect(parseCloudxUpdateBackupPreview(preview)).toEqual(preview);
  });

  it("requires an exact reviewed identity and permanent-deletion consent", () => {
    const request = { previewId: id, confirmPermanentDeletion: true as const };
    expect(parseCloudxUpdateBackupCleanupRequest(request)).toEqual(request);
  });

  it.each([null, {}, { previewId: id }, { previewId: id, confirmPermanentDeletion: false },
    { previewId: "../snapshot", confirmPermanentDeletion: true },
    { previewId: "11111111-1111-1111-1111-111111111111", confirmPermanentDeletion: true },
    { previewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(), confirmPermanentDeletion: true }, { previewId: id, confirmPermanentDeletion: "yes" },
    { previewId: id, confirmPermanentDeletion: true, path: "/unrelated" }])("rejects unreviewed or browser-selected deletions: %j", value => {
    expect(() => parseCloudxUpdateBackupCleanupRequest(value)).toThrow("explicitly confirm permanent deletion");
  });

  it.each([{ path: "relative" }, { path: "/state/../unrelated" }, { runId: "../run" }, { targetCommit: "main" },
    { sourceCommit: "unknown" }, { createdAt: "yesterday" }, { logicalBytes: -1 }, { reclaimableBytes: Number.MAX_SAFE_INTEGER + 1 },
    { allocatedBytes: "8192" }, { outcome: "" }, { kind: "anything" }])("rejects unverifiable backup evidence: %j", fields => {
    expect(() => parseCloudxUpdateBackups({ backups: [{ ...backup, ...fields }] })).toThrow("Invalid retained");
  });

  it("rejects duplicate backup identities rather than combining their bytes", () => {
    expect(() => parseCloudxUpdateBackups({ backups: [backup, backup] })).toThrow("identities must be unique");
  });

  it.each([{ id: "old-preview" }, { createdAt: "invalid" }, { reclaimableBytes: -1 }, { estimateNote: "" }])("rejects invalid bulk previews: %j", fields => {
    expect(() => parseCloudxUpdateBackupPreview({ id, createdAt: backup.createdAt, reclaimableBytes: 0,
      estimateNote: "Shared allocation is uncertain.", backups: [backup], ...fields })).toThrow("Invalid CloudX update backup preview");
  });

  it("reports partial failures and measured capacity without inventing reclaimed bytes", () => {
    const value = { ...cleanup, results: [{ ...cleanup.results[0]!, status: "failed", reason: "Permission denied; remaining files retained.", deletedLogicalBytes: 1024 }],
      freeSpace: [{ path: "/state", availableBytesBefore: 1024, availableBytesAfter: 1024 }] };
    expect(parseCloudxUpdateBackupCleanup(value)).toEqual(value);
    expect(parseCloudxUpdateBackupCleanup(null)).toBeNull();
    expect(parseCloudxUpdateBackupCleanup({ ...cleanup, freeSpace: [{ ...cleanup.freeSpace[0]!, availableBytesAfter: null }] })?.freeSpace[0]?.availableBytesAfter).toBeNull();
  });

  it("requires durable interruption details and allows unfinished items for explicit recovery", () => {
    const interrupted = { ...cleanup, state: "interrupted", results: [{ ...cleanup.results[0]!, status: "deleting", deletedLogicalBytes: 0 }],
      recoveryAction: "Review a new preview and confirm cleanup to remove the remaining files." };
    expect(parseCloudxUpdateBackupCleanup(interrupted)).toEqual(interrupted);
    expect(() => parseCloudxUpdateBackupCleanup({ ...interrupted, recoveryAction: undefined })).toThrow("Invalid CloudX update backup cleanup");
    expect(() => parseCloudxUpdateBackupCleanup({ ...interrupted, finishedAt: undefined })).toThrow("Invalid CloudX update backup cleanup");
  });

  it.each(["protected", "skipped", "failed"])("requires a reason for a %s item", status => {
    expect(() => parseCloudxUpdateBackupCleanup({ ...cleanup, results: [{ ...cleanup.results[0]!, status }] })).toThrow("Invalid CloudX backup cleanup result");
  });

  it.each(["pending", "deleting"])("does not accept a completed operation with an item still %s", status => {
    expect(() => parseCloudxUpdateBackupCleanup({ ...cleanup, results: [{ ...cleanup.results[0]!, status }] })).toThrow("outcome for every item");
  });

  it.each([{ availableBytesBefore: -1 }, { availableBytesAfter: -1 }, { path: "relative" }])("rejects invalid measured capacity: %j", fields => {
    expect(() => parseCloudxUpdateBackupCleanup({ ...cleanup, freeSpace: [{ ...cleanup.freeSpace[0]!, ...fields }] })).toThrow("Invalid CloudX backup cleanup free space");
  });
});

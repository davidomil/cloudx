import { describe, expect, it } from "vitest";
import { parseCloudxUpdateStatus, parseCloudxUpdatePreview, parseCloudxUpdateRequest } from "./cloudxUpdate.js";

const run = {
  id: "update-1", state: "running", message: "Updating CloudX.", startedAt: "2026-09-15T00:00:00.000Z"
};

describe("CloudX update status", () => {
  it("projects availability and a durable run without leaking private runner fields", () => {
    expect(parseCloudxUpdateStatus({ available: true, logPath: "/private/log", run: { ...run, pid: 123 } }))
      .toEqual({ available: true, run });
    expect(parseCloudxUpdateStatus({ available: false, unavailableReason: "Use the installed service." }))
      .toEqual({ available: false, unavailableReason: "Use the installed service." });
  });

  it.each(["succeeded", "failed"])("accepts a finished %s run", state => {
    const status = { available: true, run: { ...run, state, finishedAt: "2026-09-15T00:03:00.000Z" } };
    expect(parseCloudxUpdateStatus(status)).toEqual(status);
  });

  it("projects target-bound confirmation and recovery diagnostics without private paths", () => {
    const status = {
      available: true,
      confirmation: { targetCommit: "b".repeat(40), message: "Terminal replacement interrupts active work.", restoreSnapshotRunId: "22222222-2222-4222-8222-222222222222", requiresInterruption: true },
      run: { ...run, id: "11111111-1111-4111-8111-111111111111", state: "failed", targetCommit: "b".repeat(40), phase: "prepare",
        component: "dependencies", cause: "Dependency download failed.", recoveryAction: "Restore network access, then resume.", resumable: true },
    };
    expect(parseCloudxUpdateStatus({ ...status, confirmation: { ...status.confirmation, logPath: "/private" }, run: { ...status.run, snapshot: "/private" } })).toEqual(status);
  });

  it.each([
    { confirmation: {} }, { confirmation: { targetCommit: "main", message: "Interrupt." } },
    { confirmation: { targetCommit: "b".repeat(40), message: "" } },
    { confirmation: { targetCommit: "b".repeat(40), message: "Restore data.", restoreSnapshotRunId: "../snapshot" } },
    { confirmation: { targetCommit: "b".repeat(40), message: "Restore data.", requiresInterruption: "true" } },
    ...[{ resumable: "yes" }, { resumable: true }, { phase: 5 }, { component: [] }, { cause: "" }, { recoveryAction: {} }, { targetCommit: "main" }]
      .map(change => ({ run: { ...run, ...change } })),
  ])("rejects unsafe recovery or confirmation data: %j", fields => {
    expect(() => parseCloudxUpdateStatus({ available: true, ...fields })).toThrow();
  });

  it.each([null, [], {}, { available: "true" }, { available: false, unavailableReason: 5 },
    { available: true, run: [] },
    ...[{ id: "" }, { id: "x".repeat(129) }, { state: "unknown" }, { state: ["running"] }, { message: 5 }, { message: "x".repeat(4097) },
      { startedAt: "invalid" }, { finishedAt: 12 }].map(change => ({ available: true, run: { ...run, ...change } }))
  ])("rejects malformed process or HTTP output: %j", status => {
    expect(() => parseCloudxUpdateStatus(status)).toThrow(/Invalid CloudX update/);
  });
});

describe("CloudX update selection and preview", () => {
  const preview = {
    channel: "releases", currentCommit: "a".repeat(40), checkedAt: "2026-09-15T00:00:00Z", state: "available",
    target: { commit: "b".repeat(40), name: "v1.0", url: "https://github.com/davidomil/cloudx/releases/tag/v1.0" },
    changelog: [{ number: 82, title: "Select an update release cycle", url: "https://github.com/davidomil/cloudx/pull/82" }],
    changelogComplete: true, compareUrl: "https://github.com/davidomil/cloudx/compare/a...b", message: "New release available.",
  };

  it("projects the release comparison without exposing provider data", () => {
    expect(parseCloudxUpdatePreview({ ...preview, private: "omitted", target: { ...preview.target, private: "omitted" } })).toEqual(preview);
  });

  it.each(["available", "current", "ahead", "diverged", "unavailable"])("accepts the %s comparison state", state => {
    expect(parseCloudxUpdatePreview({ ...preview, state }).state).toBe(state);
  });

  it("represents no published release without inventing a target", () => {
    expect(parseCloudxUpdatePreview({ ...preview, state: "unavailable", target: undefined }).target).toBeUndefined();
  });

  it.each([
    null, [], {}, { ...preview, channel: "nightly" }, { ...preview, currentCommit: "main" },
    { ...preview, checkedAt: "yesterday" }, { ...preview, state: "ready" }, { ...preview, target: undefined },
    { ...preview, target: { ...preview.target, commit: "--exec" } }, { ...preview, target: { ...preview.target, name: "" } },
    { ...preview, target: { ...preview.target, url: "javascript:alert(1)" } },
    { ...preview, compareUrl: "https://github.com.evil/davidomil/cloudx/compare/a...b" },
    { ...preview, compareUrl: "https://user:pass@github.com/davidomil/cloudx/compare/a...b" },
    { ...preview, message: "x".repeat(4097) }, { ...preview, changelogComplete: "yes" },
    { ...preview, changelog: [{}] }, { ...preview, changelog: new Array(501).fill(preview.changelog[0]) },
    ...[{ number: 0 }, { number: 1.1 }, { title: "" }, { title: "x".repeat(1025) }, { url: "https://evil.example" }]
      .map(change => ({ ...preview, changelog: [{ ...preview.changelog[0], ...change }] })),
  ])("rejects malformed preview data and unsafe links: %j", value => {
    expect(() => parseCloudxUpdatePreview(value)).toThrow();
  });

  it.each(["main", "releases"])("accepts a pinned %s start request", channel => {
    const request = { channel, targetCommit: "b".repeat(40) };
    expect(parseCloudxUpdateRequest(request)).toEqual(request);
  });

  it("accepts explicit interruption consent and the pinned durable run to resume", () => {
    const request = { channel: "main", targetCommit: "b".repeat(40), confirmInterruption: true, resumeRunId: "11111111-1111-4111-8111-111111111111", restoreSnapshotRunId: "22222222-2222-4222-8222-222222222222" };
    expect(parseCloudxUpdateRequest(request)).toEqual(request);
  });

  it.each([{ confirmInterruption: "true" }, { confirmInterruption: 1 }, { resumeRunId: "../run" }, { resumeRunId: 5 }, { resumeRunId: "" }, { restoreSnapshotRunId: "../data" }, { restoreSnapshotRunId: 5 }])("rejects unsafe confirmation and resume options: %j", fields => {
    expect(() => parseCloudxUpdateRequest({ channel: "main", targetCommit: "b".repeat(40), ...fields })).toThrow();
  });

  it.each([null, [], {}, { channel: "main" }, { channel: "nightly", targetCommit: "b".repeat(40) },
    { channel: "main", targetCommit: "origin/main" }, { channel: "main", targetCommit: "b".repeat(40), command: "x" }])("rejects unchecked or arbitrary start options: %j", request => {
    expect(() => parseCloudxUpdateRequest(request)).toThrow();
  });
});

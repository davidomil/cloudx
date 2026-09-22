import { describe, expect, it } from "vitest";
import { parseCodexUpdateStatus, type CodexUpdateStatus } from "./codexUpdate.js";

const completed: CodexUpdateStatus = {
  jobId: "job", phase: "succeeded", installedVersion: "1.2.3", outcome: "updated",
  message: "Codex updated.", startedAt: "2026-09-22T00:00:00Z", finishedAt: "2026-09-22T00:01:00Z",
};

describe("Codex update status", () => {
  it("accepts a verified result and projects only public fields", () => {
    expect(parseCodexUpdateStatus({ ...completed, privateLog: "secret" })).toEqual(completed);
  });

  it("accepts a failure with the last verified usable version", () => {
    const failed = { ...completed, phase: "failed", outcome: null };
    expect(parseCodexUpdateStatus(failed)).toEqual(failed);
  });

  it("accepts a prerelease with npm build metadata", () => {
    expect(parseCodexUpdateStatus({ ...completed, installedVersion: "1.2.3-rc.1+build.0" }).installedVersion).toBe("1.2.3-rc.1+build.0");
  });

  it.each([
    null, [], {}, { ...completed, installedVersion: null }, { ...completed, outcome: null },
    { ...completed, finishedAt: null }, { ...completed, phase: ["succeeded"] },
    { ...completed, phase: "failed" }, { ...completed, phase: "unknown" },
    { ...completed, installedVersion: "private command output" }, { ...completed, message: "x".repeat(2049) },
  ])("rejects malformed or unverified success %#", value => {
    expect(() => parseCodexUpdateStatus(value)).toThrow("Invalid Codex update status");
  });
});

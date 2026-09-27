import { describe, expect, it } from "vitest";
import { compareCodexVersions, isExactCodexVersion, parseCodexReleases, parseCodexUpdateRequest, parseCodexUpdateStatus, type CodexUpdateStatus } from "./codexUpdate.js";

const completed: CodexUpdateStatus = {
  jobId: "job", phase: "succeeded", requestedVersion: "1.2.3", installedVersion: "1.2.3", activeVersion: "1.2.3", previousVerifiedVersion: "1.2.2", outcome: "updated",
  message: "Codex selected.", startedAt: "2026-09-22T00:00:00Z", finishedAt: "2026-09-22T00:01:00Z",
};

describe("Codex version selection contracts", () => {
  it("accepts a verified result and projects only public fields", () => {
    expect(parseCodexUpdateStatus({ ...completed, privateLog: "secret" })).toEqual(completed);
  });

  it("retains distinct candidate and active versions after failed verification", () => {
    const failed = { ...completed, phase: "failed", activeVersion: "1.2.2", outcome: null };
    expect(parseCodexUpdateStatus(failed)).toEqual(failed);
  });

  it("accepts an unresolved latest request while checking", () => {
    const checking = { ...completed, phase: "checking", requestedVersion: "latest", installedVersion: null, outcome: null, finishedAt: null };
    expect(parseCodexUpdateStatus(checking)).toEqual(checking);
  });

  it.each([
    null, [], {}, { ...completed, installedVersion: null }, { ...completed, activeVersion: undefined },
    { ...completed, requestedVersion: undefined }, { ...completed, previousVerifiedVersion: undefined },
    { ...completed, requestedVersion: "latest" }, { ...completed, outcome: null },
    { ...completed, finishedAt: null }, { ...completed, phase: ["succeeded"] },
    { ...completed, phase: "failed" }, { ...completed, phase: "unknown" },
    { ...completed, installedVersion: "private command output" }, { ...completed, message: "x".repeat(2049) },
  ])("rejects malformed or unverified success %#", value => {
    expect(() => parseCodexUpdateStatus(value)).toThrow("Invalid Codex update status");
  });

  it.each(["0.155.1", "1.2.3-rc.1+build.0", "latest", "previous"])("accepts explicit target %s", targetVersion => {
    expect(parseCodexUpdateRequest({ targetVersion, acknowledgeDowngrade: true })).toEqual({ targetVersion, acknowledgeDowngrade: true });
    expect(parseCodexUpdateRequest({ targetVersion })).toEqual({ targetVersion });
  });

  it.each([true, false])("retains explicit recovery mode %s without implying downgrade acknowledgement", recoveryMode => {
    const request = { targetVersion: "0.155.1", recoveryMode };
    expect(parseCodexUpdateRequest(request)).toEqual(request);
  });

  it.each([undefined, {}, [], null, { targetVersion: "^1.2.3" }, { targetVersion: "1.2" }, { targetVersion: "1.2.3", package: "evil" },
    { targetVersion: "@openai/codex@1.2.3" }, { targetVersion: "https://example.com/pkg" }, { targetVersion: "/tmp/pkg" },
    { targetVersion: "1.2.3;touch /tmp/pkg" }, { targetVersion: " 1.2.3" }, { targetVersion: "1.2.3", acknowledgeDowngrade: "true" },
    { targetVersion: "1.2.3", recoveryMode: "true" }, { targetVersion: "1.2.3", recoveryMode: null },
  ])("rejects implicit, ranged, and caller-selected package requests %#", value => {
    expect(() => parseCodexUpdateRequest(value)).toThrow(/Invalid Codex update request/);
  });

  it("accepts only a complete published release list with a stable latest entry", () => {
    const releases = { latestStable: "1.2.3", versions: ["1.2.3", "1.2.4-rc.1"] };
    expect(parseCodexReleases(releases)).toEqual(releases);
    for (const value of [null, [], {}, { ...releases, latestStable: "1.2.4-rc.1" }, { ...releases, versions: [] },
      { ...releases, versions: ["1.2.3", "garbage"] }, { ...releases, versions: ["1.2.4"] }, { ...releases, versions: ["1.2.3", "1.2.3"] }]) {
      expect(() => parseCodexReleases(value)).toThrow("Invalid Codex releases");
    }
  });

  it.each(["01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-a..b", "1.2.3+", "1.2.3-alpha+build..one", "1.2.3\n", "v1.2.3"])("rejects invalid exact version %j", version => {
    expect(isExactCodexVersion(version)).toBe(false);
  });

  it.each([
    ["0.155.1", "0.156.1"], ["1.9.0", "1.10.0"], ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"], ["1.0.0-beta.2", "1.0.0-beta.11"], ["1.0.0-rc.1", "1.0.0"],
    ["1.0.0-99999999999999999999", "1.0.0-100000000000000000000"],
  ])("compares %s before %s using SemVer precedence", (older, newer) => {
    expect(compareCodexVersions(older, newer)).toBe(-1);
    expect(compareCodexVersions(newer, older)).toBe(1);
    expect(compareCodexVersions(older, older)).toBe(0);
  });

  it("ignores build metadata for downgrade precedence and rejects ranges", () => {
    expect(compareCodexVersions("1.2.3+old", "1.2.3+new")).toBe(0);
    expect(() => compareCodexVersions("^1.2.3", "1.2.3")).toThrow("Invalid exact Codex version");
  });
});

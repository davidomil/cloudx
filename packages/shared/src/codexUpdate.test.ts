import { describe, expect, it } from "vitest";
import { isExactCodexVersion, parseCodexReleaseCatalog, parseCodexUpdateStatus, type CodexUpdateStatus } from "./codexUpdate.js";

const completed: CodexUpdateStatus = {
  jobId: "job", phase: "succeeded", installedVersion: "1.2.3", outcome: "updated",
  activeVersion: "1.2.3", requestedVersion: "1.2.3", previousVersion: "1.1.0",
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
    const version = "1.2.3-rc.1+build.0";
    expect(parseCodexUpdateStatus({ ...completed, installedVersion: version, activeVersion: version, requestedVersion: version }).installedVersion).toBe(version);
  });

  it.each([
    null, [], {}, { ...completed, installedVersion: null }, { ...completed, outcome: null },
    { ...completed, finishedAt: null }, { ...completed, phase: ["succeeded"] },
    { ...completed, phase: "failed" }, { ...completed, phase: "unknown" },
    { ...completed, installedVersion: "private command output" }, { ...completed, message: "x".repeat(2049) },
    { ...completed, requestedVersion: null }, { ...completed, activeVersion: "1.1.0" },
    { ...completed, previousVersion: "latest" }, { ...completed, requestedVersion: undefined },
  ])("rejects malformed or unverified success %#", value => {
    expect(() => parseCodexUpdateStatus(value)).toThrow("Invalid Codex update status");
  });
});

describe("exact Codex versions", () => {
  it.each(["0.155.1", "1.0.0-rc.1", "1.0.0+build.1", "0.0.0-nightly-20260927"])("accepts %s", version => {
    expect(isExactCodexVersion(version)).toBe(true);
  });
  it.each(["latest", "^0.155.1", "~0.155.1", "0.155", "01.2.3", "1.0.0-01", "1.0.0-rc..1", "@other/package@1.0.0", "https://example.com/1.0.0", "../1.0.0", "1.0.0; echo secret", "1.0.0\n", null, 1])("rejects %s", version => {
    expect(isExactCodexVersion(version)).toBe(false);
  });
});

describe("Codex release catalog", () => {
  const catalog = { latestStable: "1.2.3", versions: [{ version: "1.3.0-rc.1", prerelease: true }, { version: "1.2.3", prerelease: false }] };
  it("keeps exact versions and prerelease labels while projecting public fields", () => {
    expect(parseCodexReleaseCatalog({ ...catalog, privateData: "secret" })).toEqual(catalog);
  });
  it.each([
    null, [], {}, { ...catalog, latestStable: "latest" }, { ...catalog, latestStable: "1.3.0-rc.1" },
    { ...catalog, versions: [] }, { ...catalog, versions: [null] },
    { ...catalog, versions: [{ version: "1.2.3", prerelease: "false" }] },
    { ...catalog, versions: [...catalog.versions, catalog.versions[0]] },
    { ...catalog, versions: [{ version: "1.2.3", prerelease: true }] },
    { ...catalog, versions: [{ version: "1.2.3-rc.1", prerelease: false }] },
  ])("rejects malformed catalog %#", value => {
    expect(() => parseCodexReleaseCatalog(value)).toThrow("Invalid Codex release catalog");
  });
});

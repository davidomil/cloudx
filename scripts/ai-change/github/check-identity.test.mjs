import { describe, expect, it, vi } from "vitest";

import {
  buildCheckExternalId,
  checkRunTargetForPullRequest,
  ciIdentityArtifact,
  listAllCheckRuns,
  managedIntentSha256,
  mergeIdentityForPullRequest,
  parseCheckExternalId,
  validateCiIdentityArtifact,
} from "./check-identity.mjs";

const identity = Object.freeze({
  pullRequest: 42,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  testMergeSha: "c".repeat(40),
  testMergeTreeSha: "d".repeat(40),
  policySha256: "1".repeat(64),
});

describe("canonical v2 merge identity", () => {
  it.each([
    ["ci", {}, {}],
    [
      "review",
      {
        subjectSha256: "2".repeat(64),
        manualReviewRequired: false,
      },
      {
        subjectSha256: "2".repeat(64),
        manualReviewRequired: false,
      },
    ],
    ["merge-intent", { actor: "Maintainer-1" }, { actor: "Maintainer-1" }],
    [
      "protected-intent",
      { actor: "Release-Owner" },
      { actor: "Release-Owner" },
    ],
    [
      "managed-intent",
      { managedSha256: "3".repeat(64) },
      { managedSha256: "3".repeat(64) },
    ],
  ])("round-trips one exact %s external ID", (kind, qualifier, expected) => {
    const externalId = buildCheckExternalId(kind, identity, qualifier);

    expect(parseCheckExternalId(externalId)).toEqual({
      kind,
      identity,
      ...expected,
    });
  });

  it("rejects appended, duplicated, non-canonical, and kind-specific fields", () => {
    const canonical = buildCheckExternalId("ci", identity);

    expect(() => parseCheckExternalId(`${canonical}:actor:abc`)).toThrow(
      /canonical v2/i,
    );
    expect(() =>
      parseCheckExternalId(canonical.replace(":base:", ":base:deadbeef:base:")),
    ).toThrow(/canonical v2/i);
    expect(() =>
      parseCheckExternalId(
        canonical.replace(identity.baseSha, identity.baseSha.toUpperCase()),
      ),
    ).toThrow(/canonical v2/i);
    expect(() =>
      parseCheckExternalId(canonical.replace(":pr:42:", ":pr:042:")),
    ).toThrow(/canonical v2/i);
    expect(() => buildCheckExternalId("review", identity)).toThrow(/subject/i);
    expect(() =>
      buildCheckExternalId("ci", identity, { subjectSha256: "2".repeat(64) }),
    ).toThrow(/does not accept/i);
  });

  it("binds the manual-review disposition into the exact review check identity", () => {
    const automatic = buildCheckExternalId("review", identity, {
      subjectSha256: "2".repeat(64),
      manualReviewRequired: false,
    });
    const manual = buildCheckExternalId("review", identity, {
      subjectSha256: "2".repeat(64),
      manualReviewRequired: true,
    });

    expect(manual).not.toBe(automatic);
    expect(parseCheckExternalId(manual)).toMatchObject({
      manualReviewRequired: true,
    });
    expect(() =>
      parseCheckExternalId(automatic.replace(":manual:not-required", "")),
    ).toThrow(/manual-review disposition|canonical v2/i);
  });

  it("resolves a live test merge only when its parents are the bound base and head", async () => {
    const api = {
      repository: "owner/repo",
      get: vi.fn().mockResolvedValue({
        sha: identity.testMergeSha,
        tree: { sha: identity.testMergeTreeSha },
        parents: [{ sha: identity.baseSha }, { sha: identity.headSha }],
      }),
    };
    const pullRequest = {
      number: identity.pullRequest,
      base: { ref: "main", sha: identity.baseSha },
      head: { sha: identity.headSha },
      merge_commit_sha: identity.testMergeSha,
      mergeable: true,
    };

    await expect(
      mergeIdentityForPullRequest(api, pullRequest, identity.policySha256),
    ).resolves.toEqual(identity);
    expect(api.get).toHaveBeenCalledWith(
      `/repos/owner/repo/git/commits/${identity.testMergeSha}`,
    );

    api.get.mockResolvedValueOnce({
      sha: identity.testMergeSha,
      tree: { sha: identity.testMergeTreeSha },
      parents: [{ sha: identity.headSha }, { sha: identity.baseSha }],
    });
    await expect(
      mergeIdentityForPullRequest(api, pullRequest, identity.policySha256),
    ).rejects.toThrow(/parents.*base.*head/i);
  });

  it("targets fork checks at the exact base-repository test merge", () => {
    const pullRequest = {
      number: identity.pullRequest,
      head: { sha: identity.headSha, repo: { full_name: "owner/repo" } },
    };

    expect(
      checkRunTargetForPullRequest(pullRequest, identity, "owner/repo"),
    ).toBe(identity.headSha);
    expect(
      checkRunTargetForPullRequest(
        {
          ...pullRequest,
          head: {
            ...pullRequest.head,
            repo: { full_name: "contributor/fork" },
          },
        },
        identity,
        "owner/repo",
      ),
    ).toBe(identity.testMergeSha);
    expect(() =>
      checkRunTargetForPullRequest(
        { ...pullRequest, head: { sha: identity.headSha, repo: null } },
        identity,
        "owner/repo",
      ),
    ).toThrow(/head repository/i);
  });

  it("validates an exact trusted CI artifact without accepting extra keys", () => {
    const artifact = ciIdentityArtifact({
      repository: "owner/repo",
      workflowRunId: 91,
      workflowRunAttempt: 1,
      ...identity,
    });

    expect(
      validateCiIdentityArtifact(artifact, {
        repository: "owner/repo",
        workflowRunId: 91,
        workflowRunAttempt: 1,
      }),
    ).toEqual({ artifact, identity });
    expect(() =>
      validateCiIdentityArtifact(
        { ...artifact, unexpected: true },
        {
          repository: "owner/repo",
          workflowRunId: 91,
          workflowRunAttempt: 1,
        },
      ),
    ).toThrow(/exact keys/i);
    expect(() =>
      validateCiIdentityArtifact(artifact, {
        repository: "owner/repo",
        workflowRunId: 92,
        workflowRunAttempt: 1,
      }),
    ).toThrow(/workflow run/i);
  });

  it("changes the managed intent digest when any durable authorization field changes", () => {
    const managed = {
      ...identity,
      issue: 7,
      runId: "run-7-1",
      workflowRunId: 99,
      snapshotSha256: "4".repeat(64),
      bundleSha256: "5".repeat(64),
      evidenceSha256: "6".repeat(64),
    };
    const digest = managedIntentSha256(managed);

    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    for (const [field, value] of [
      ["pullRequest", 43],
      ["issue", 8],
      ["runId", "run-7-2"],
      ["workflowRunId", 100],
      ["testMergeTreeSha", "e".repeat(40)],
      ["evidenceSha256", "7".repeat(64)],
    ]) {
      expect(managedIntentSha256({ ...managed, [field]: value })).not.toBe(
        digest,
      );
    }
  });

  it("fails when GitHub cannot prove the complete check-run set", async () => {
    const api = {
      repository: "owner/repo",
      paginate: vi
        .fn()
        .mockResolvedValue(Array.from({ length: 1_000 }, (_, id) => ({ id }))),
    };

    await expect(listAllCheckRuns(api, identity.headSha)).rejects.toThrow(
      /1000-suite completeness limit/i,
    );
    expect(api.paginate).toHaveBeenCalledWith(
      `/repos/owner/repo/commits/${identity.headSha}/check-runs?filter=all`,
      { arrayKey: "check_runs" },
    );
  });
});

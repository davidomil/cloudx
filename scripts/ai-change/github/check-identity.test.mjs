import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCheckExternalId,
  checkRunTargetForPullRequest,
  ciIdentityArtifact,
  createCiIdentityArtifact,
  recordCiIdentity,
  listAllCheckRuns,
  managedIntentSha256,
  mergeIdentityForPullRequest,
  mergeIdentityDifferences,
  parseCheckExternalId,
  validateCiIdentityArtifact,
  SupersededMergeIdentityError,
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
      state: "open",
      merged: false,
      base: {
        ref: "main",
        sha: identity.baseSha,
        repo: { full_name: "owner/repo" },
      },
      head: { sha: identity.headSha },
      merge_commit_sha: identity.testMergeSha,
      mergeable: true,
    };
    api.get
      .mockResolvedValueOnce({
        sha: identity.testMergeSha,
        tree: { sha: identity.testMergeTreeSha },
        parents: [{ sha: identity.baseSha }, { sha: identity.headSha }],
      })
      .mockResolvedValueOnce({
        ref: "refs/heads/main",
        object: { type: "commit", sha: identity.baseSha },
      });

    await expect(
      mergeIdentityForPullRequest(api, pullRequest, identity.policySha256),
    ).resolves.toEqual(identity);
    expect(api.get).toHaveBeenCalledWith(
      `/repos/owner/repo/git/commits/${identity.testMergeSha}`,
    );

    api.get
      .mockResolvedValueOnce({
        sha: identity.testMergeSha,
        tree: { sha: identity.testMergeTreeSha },
        parents: [{ sha: identity.headSha }, { sha: identity.baseSha }],
      })
      .mockResolvedValueOnce({
        ref: "refs/heads/main",
        object: { type: "commit", sha: identity.baseSha },
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

const repositories = [];
afterEach(() => {
  for (const directory of repositories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function gitFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ci-merge-identity-"),
  );
  repositories.push(directory);
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "CI identity test");
  git("config", "user.email", "ci-identity@example.invalid");
  const commit = (name) => {
    fs.writeFileSync(path.join(directory, name), name);
    git("add", name);
    git("commit", "-m", name);
    return git("rev-parse", "HEAD");
  };
  const eventBase = commit("initial");
  git("checkout", "-b", "feature");
  const head = commit("feature");
  git("checkout", "main");
  const base = commit("target");
  git("checkout", "--detach", base);
  git("merge", "--no-ff", "feature", "-m", "test merge");
  const merge = git("rev-parse", "HEAD");
  const pullRequest = {
    number: 42,
    state: "open",
    merged: false,
    mergeable: true,
    base: { ref: "main", sha: base, repo: { full_name: "owner/repo" } },
    head: { sha: head, repo: { full_name: "contributor/fork" } },
    merge_commit_sha: merge,
  };
  const api = {
    repository: "owner/repo",
    get: vi.fn(async (route) => {
      if (route === "/repos/owner/repo/pulls/42")
        return structuredClone(pullRequest);
      if (route === "/repos/owner/repo/git/ref/heads/main")
        return {
          ref: "refs/heads/main",
          object: { type: "commit", sha: git("rev-parse", "main") },
        };
      if (route.startsWith("/repos/owner/repo/git/commits/")) {
        const [sha, tree, ...parents] = git(
          "show",
          "--no-patch",
          "--format=%H %T %P",
          route.split("/").at(-1),
        ).split(" ");
        return {
          sha,
          tree: { sha: tree },
          parents: parents.map((sha) => ({ sha })),
        };
      }
      throw new Error(`Unexpected API route ${route}`);
    }),
  };
  const input = {
    api,
    source: directory,
    policySha256: identity.policySha256,
    workflowRunId: 91,
    workflowRunAttempt: 1,
    event: {
      eventName: "pull_request",
      baseRepository: api.repository,
      baseRef: "main",
      baseSha: base,
      headSha: head,
      testMergeSha: merge,
      pullRequest: 42,
    },
  };
  return { git, commit, pullRequest, api, input, base, head, merge, eventBase };
}

describe("exact test-merge reconciliation with real Git commits", () => {
  it.each([false, true])(
    "binds artifact and downstream authorization to the tested parents (stale event: %s)",
    async (staleEvent) => {
      const f = gitFixture();
      if (staleEvent) {
        f.input.event.baseSha = f.eventBase;
        f.pullRequest.base.sha = f.eventBase;
      }
      const result = await createCiIdentityArtifact(f.input);
      const { identity: tested } = validateCiIdentityArtifact(result.artifact, {
        repository: f.api.repository,
        workflowRunId: 91,
        workflowRunAttempt: 1,
      });
      const live = await mergeIdentityForPullRequest(
        f.api,
        f.pullRequest,
        identity.policySha256,
      );
      expect(mergeIdentityDifferences(tested, live)).toEqual([]);
      expect(tested).toMatchObject({
        baseSha: f.base,
        headSha: f.head,
        testMergeSha: f.merge,
        testMergeTreeSha: f.git("rev-parse", "HEAD^{tree}"),
      });
      expect(result.reconciliation).toEqual({
        state: "current",
        eventBaseSha: f.input.event.baseSha,
        testedBaseSha: f.base,
        eventBaseReconciled: staleEvent,
      });
      const changedPolicy = await mergeIdentityForPullRequest(
        f.api,
        f.pullRequest,
        "2".repeat(64),
      );
      expect(mergeIdentityDifferences(tested, changedPolicy)).toEqual([
        "policySha256",
      ]);
    },
  );

  it("refuses authorization after target movement and never schedules repeated stale processing", async () => {
    const f = gitFixture();
    const { artifact } = await createCiIdentityArtifact(f.input);
    f.git("checkout", "main");
    const nextBase = f.commit("later-target");
    f.git("checkout", "--detach", f.merge);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(createCiIdentityArtifact(f.input)).rejects.toMatchObject({
        code: "SUPERSEDED_MERGE_IDENTITY",
        reason: "target_moved",
        observed: {
          testedBaseSha: artifact.base_sha,
          currentBaseSha: nextBase,
        },
      });
      await expect(
        mergeIdentityForPullRequest(
          f.api,
          f.pullRequest,
          identity.policySha256,
        ),
      ).rejects.toBeInstanceOf(SupersededMergeIdentityError);
    }
    expect(Object.keys(f.api)).toEqual(["repository", "get"]);
  });

  it("classifies a later PR head and regenerated test merge as superseded", async () => {
    const f = gitFixture();
    f.git("checkout", "feature");
    f.pullRequest.head.sha = f.commit("later-feature");
    f.git("checkout", "--detach", f.base);
    f.git("merge", "--no-ff", "feature", "-m", "new test merge");
    f.pullRequest.merge_commit_sha = f.git("rev-parse", "HEAD");
    f.git("checkout", "--detach", f.merge);
    await expect(createCiIdentityArtifact(f.input)).rejects.toMatchObject({
      code: "SUPERSEDED_MERGE_IDENTITY",
      reason: "head_moved",
      observed: {
        currentHeadSha: f.pullRequest.head.sha,
        tested: { headSha: f.head },
      },
    });
  });

  it("classifies head movement before GitHub finishes regenerating its merge", async () => {
    const f = gitFixture();
    f.git("checkout", "feature");
    f.pullRequest.head.sha = f.commit("pending-feature");
    f.pullRequest.merge_commit_sha = null;
    f.pullRequest.mergeable = null;
    f.git("checkout", "--detach", f.merge);
    await expect(createCiIdentityArtifact(f.input)).rejects.toMatchObject({
      code: "SUPERSEDED_MERGE_IDENTITY",
      reason: "head_moved",
    });
  });

  it("rejects an old artifact after the same parents receive a new merge commit", async () => {
    const f = gitFixture();
    const { artifact } = await createCiIdentityArtifact(f.input);
    f.pullRequest.merge_commit_sha = f.git(
      "commit-tree",
      f.git("rev-parse", "HEAD^{tree}"),
      "-p",
      f.base,
      "-p",
      f.head,
      "-m",
      "regenerated merge",
    );
    const current = await mergeIdentityForPullRequest(
      f.api,
      f.pullRequest,
      identity.policySha256,
    );
    expect(
      mergeIdentityDifferences(
        validateCiIdentityArtifact(artifact, {
          repository: f.api.repository,
          workflowRunId: 91,
          workflowRunAttempt: 1,
        }).identity,
        current,
      ),
    ).toEqual(["testMergeSha"]);
    await expect(createCiIdentityArtifact(f.input)).rejects.toMatchObject({
      code: "SUPERSEDED_MERGE_IDENTITY",
      reason: "identity_moved",
      observed: { differences: ["testMergeSha"] },
    });
  });

  it.each(["current", "superseded", "rejected"])(
    "records %s diagnostics and only emits a current identity artifact",
    async (state) => {
      const f = gitFixture();
      const artifactFile = path.join(f.input.source, "identity.json");
      const reconciliationFile = path.join(
        f.input.source,
        "reconciliation.json",
      );
      const githubOutput = path.join(f.input.source, "github-output");
      if (state === "superseded") {
        f.git("checkout", "main");
        f.commit("next-target");
        f.git("checkout", "--detach", f.merge);
      }
      if (state === "rejected") f.input.event.headSha = f.base;
      const operation = recordCiIdentity({
        ...f.input,
        artifactFile,
        reconciliationFile,
        githubOutput,
      });
      if (state === "rejected")
        await expect(operation).rejects.toThrow("exact GitHub test merge");
      else await operation;
      expect(
        JSON.parse(fs.readFileSync(reconciliationFile, "utf8")).state,
      ).toBe(state);
      expect(fs.existsSync(artifactFile)).toBe(state === "current");
      if (state === "current") {
        expect(JSON.parse(fs.readFileSync(artifactFile, "utf8"))).toMatchObject(
          { base_sha: f.base, head_sha: f.head, test_merge_sha: f.merge },
        );
      }
      if (state === "rejected") expect(fs.existsSync(githubOutput)).toBe(false);
      else
        expect(fs.readFileSync(githubOutput, "utf8")).toBe(
          `identity-state=${state}\n`,
        );
    },
  );

  it.each([
    "wrong repository",
    "wrong target",
    "wrong event repository",
    "wrong event target",
    "wrong target reference",
    "noncommit target",
    "wrong API commit",
    "substituted head",
    "substituted merge",
    "reversed parents",
    "extra parent",
    "wrong tree",
  ])("rejects %s", async (scenario) => {
    const f = gitFixture();
    if (scenario === "wrong repository")
      f.pullRequest.base.repo.full_name = "other/repo";
    if (scenario === "wrong target") f.pullRequest.base.ref = "release";
    if (scenario === "wrong event repository")
      f.input.event.baseRepository = "other/repo";
    if (scenario === "wrong event target") f.input.event.baseRef = "release";
    if (
      [
        "wrong target reference",
        "noncommit target",
        "wrong API commit",
      ].includes(scenario)
    ) {
      const get = f.api.get;
      f.api.get = async (route) => {
        const result = await get(route);
        if (route.endsWith("/git/ref/heads/main")) {
          if (scenario === "wrong target reference")
            return { ...result, ref: "refs/heads/release" };
          if (scenario === "noncommit target")
            return { ...result, object: { ...result.object, type: "tag" } };
        }
        if (scenario === "wrong API commit" && route.includes("/git/commits/"))
          return { ...result, sha: f.base };
        return result;
      };
    }
    if (scenario === "substituted head") f.input.event.headSha = f.base;
    if (scenario === "substituted merge") f.input.event.testMergeSha = f.base;
    if (scenario === "reversed parents" || scenario === "extra parent") {
      const parents =
        scenario === "reversed parents"
          ? [f.head, f.base]
          : [f.base, f.head, f.eventBase];
      const invalidMerge = f.git(
        "commit-tree",
        f.git("rev-parse", "HEAD^{tree}"),
        ...parents.flatMap((sha) => ["-p", sha]),
        "-m",
        scenario,
      );
      f.input.event.testMergeSha = invalidMerge;
      f.pullRequest.merge_commit_sha = invalidMerge;
      f.git("checkout", "--detach", invalidMerge);
    }
    if (scenario === "wrong tree") {
      const get = f.api.get;
      f.api.get = async (route) => {
        const result = await get(route);
        return route.includes("/git/commits/")
          ? { ...result, tree: { sha: f.git("rev-parse", "main^{tree}") } }
          : result;
      };
    }
    await expect(createCiIdentityArtifact(f.input)).rejects.toThrow();
  });
});

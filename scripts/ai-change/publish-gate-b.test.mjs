import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readGateBArtifactSnapshot,
  publishGateBCandidate,
} from "./publish-gate-b.mjs";
import {
  GATE_B_CANDIDATE_REF,
  GATE_B_COMMIT_SUBJECTS,
  GATE_B_EXPECTED_OLD_CANDIDATE_SHA,
  GATE_B_EXPECTED_TARGET_BASE_SHA,
  GATE_B_LOCAL_CHANGE_BASE_SHA,
  GATE_B_POLICY_SHA256,
  GATE_B_PULL_REQUEST,
  GATE_B_REPOSITORY,
  GATE_B_REVIEW_ROLES,
  GATE_B_TARGET_BASE_REF,
} from "./validate-process.mjs";

const gitSha = (character) => character.repeat(40);
const sha = (character) => character.repeat(64);

describe("Gate B candidate publisher", () => {
  it("validates one immutable exact-head bundle before one non-force push and authoritative readback", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture);

    const result = await publishGateBCandidate({
      artifactDir: fixture.directory,
      authorizedManifestSha256: fixture.manifestSha256,
      expectedOldHead: fixture.oldHead,
      runCommand: runner.run,
    });

    expect(result).toEqual({
      status: "published",
      headSha: fixture.head,
      manifestSha256: fixture.manifestSha256,
      repository: GATE_B_REPOSITORY,
      targetBaseRef: GATE_B_TARGET_BASE_REF,
      targetBaseSha: GATE_B_EXPECTED_TARGET_BASE_SHA,
      candidateRef: GATE_B_CANDIDATE_REF,
      remoteHeadSha: fixture.head,
      pullRequest: GATE_B_PULL_REQUEST,
      reviewPrHandoffAuthorized: true,
    });
    expect(runner.pushes).toEqual([
      [
        "git",
        [
          "push",
          "--porcelain",
          "origin",
          "HEAD:refs/heads/architecture-and-new-codex",
        ],
      ],
    ]);
  });

  it.each([
    [
      "malformed",
      (fixture) => fixture.mutate("plan.json", (plan) => delete plan.task),
    ],
    [
      "missing",
      (fixture) => fs.rmSync(path.join(fixture.directory, "review-web.json")),
    ],
    ["extra", (fixture) => writeJson(fixture.directory, "extra.json", {})],
    [
      "renamed",
      (fixture) =>
        fs.renameSync(
          path.join(fixture.directory, "review-web.json"),
          path.join(fixture.directory, "renamed.json"),
        ),
    ],
    [
      "duplicate role",
      (fixture) =>
        fixture.mutate("review-security.json", (review) => {
          review.reviewer_role = "review-web";
        }),
    ],
    [
      "wrong subject",
      (fixture) =>
        fixture.mutate("review-web.json", (review) => {
          review.subject = "plan";
        }),
    ],
    [
      "wrong digest",
      (fixture) =>
        fixture.mutate("review-web.json", (review) => {
          review.subject_sha256 = sha("9");
        }),
    ],
    [
      "wrong base",
      (fixture) =>
        fixture.mutate("implementation.json", (implementation) => {
          implementation.base_sha = gitSha("c");
        }),
    ],
    [
      "wrong head",
      (fixture) =>
        fixture.mutate("verification.json", (verification) => {
          verification.head_sha = gitSha("c");
        }),
    ],
    [
      "wrong policy",
      (fixture) =>
        fixture.mutate("review-change.json", (review) => {
          review.policy_sha256 = sha("9");
        }),
    ],
    [
      "blocked review",
      (fixture) =>
        fixture.mutate("review-web.json", (review) => {
          review.verdict = "blocked";
          review.findings = [finding()];
        }),
    ],
    [
      "missing manual review",
      (fixture) =>
        fixture.mutate("review-change.json", (review) => {
          review.tags = [];
        }),
    ],
    [
      "missing claim",
      (fixture) =>
        fixture.mutate("implementation.json", (implementation) => {
          implementation.claim_evidence.pop();
        }),
    ],
    [
      "duplicate claim",
      (fixture) =>
        fixture.mutate("implementation.json", (implementation) => {
          implementation.claim_evidence.push(
            structuredClone(implementation.claim_evidence[0]),
          );
        }),
    ],
    [
      "missing path",
      (fixture) =>
        fixture.mutate("implementation.json", (implementation) => {
          implementation.changed_files.pop();
        }),
    ],
    [
      "duplicate path",
      (fixture) =>
        fixture.mutate("implementation.json", (implementation) => {
          implementation.changed_files.push(implementation.changed_files[0]);
        }),
    ],
    [
      "changed verification command",
      (fixture) =>
        fixture.mutate("verification.json", (verification) => {
          verification.commands[0].command = "npm run lint";
        }),
    ],
    [
      "changed tree",
      (fixture) =>
        fixture.mutate("verification.json", (verification) => {
          verification.tree_sha256_after = sha("8");
        }),
    ],
  ])(
    "rejects a %s artifact mismatch before invoking the command runner",
    async (_name, mutate) => {
      const fixture = gateBFixture();
      mutate(fixture);
      const runner = commandRunner(fixture);

      await expect(
        publishGateBCandidate({
          artifactDir: fixture.directory,
          authorizedManifestSha256: readGateBArtifactSnapshot(fixture.directory)
            .manifestSha256,
          expectedOldHead: fixture.oldHead,
          runCommand: runner.run,
        }),
      ).rejects.toThrow();
      expect(runner.calls).toEqual([]);
    },
  );

  it("rejects an unauthorized manifest before invoking the command runner", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture);

    await expect(
      publishGateBCandidate({
        artifactDir: fixture.directory,
        authorizedManifestSha256: sha("9"),
        expectedOldHead: fixture.oldHead,
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/authorized manifest/i);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    [
      "wrong subjects",
      { subjects: [...GATE_B_COMMIT_SUBJECTS.slice(0, -1), "POLICY: bypass"] },
    ],
    ["dirty index", { indexClean: false }],
    ["dirty worktree", { worktreeClean: false }],
    ["wrong target base", { remoteTargetBase: gitSha("c") }],
    ["wrong old head", { remoteCandidate: gitSha("d") }],
    ["non-fast-forward", { fastForward: false }],
    [
      "wrong pull request",
      {
        beforePushPr: { baseRefName: "release" },
      },
    ],
    ["protected branch", { protectionStatus: 200 }],
    ["branch rules", { rules: [{ id: 1 }] }],
  ])("rejects %s before the push command", async (_name, overrides) => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, overrides);

    await expect(
      publishGateBCandidate({
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        runCommand: runner.run,
      }),
    ).rejects.toThrow();
    expect(runner.pushes).toEqual([]);
  });

  it("rejects an artifact replacement after preflight and before push", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, {
      afterRules() {
        fixture.mutate("review-web.json", (review) => {
          review.run_id = "replaced-after-validation";
        });
      },
    });

    await expect(
      publishGateBCandidate({
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/changed after validation/i);
    expect(runner.pushes).toEqual([]);
  });

  it.each([
    ["missing GitHub CLI", { throwOn: "gh --version" }],
    ["malformed GitHub CLI version", { ghVersion: "unknown\n" }],
    ["failed GitHub authentication", { authExitCode: 1 }],
    ["malformed GitHub authentication", { authOutput: "github.com\n" }],
    [
      "wrong origin push URL",
      { originPushUrls: ["git@github.com:davidomil/cloudx.git"] },
    ],
    [
      "multiple origin push URLs",
      {
        originPushUrls: [
          "https://github.com/davidomil/cloudx",
          "https://example.invalid/cloudx",
        ],
      },
    ],
    ["missing origin push URL", { originPushUrls: [] }],
    [
      "origin query failure",
      { failOn: "git remote get-url --push --all origin" },
    ],
    [
      "repository query failure",
      {
        failOn:
          "gh repo view davidomil/cloudx --json nameWithOwner,viewerPermission",
      },
    ],
    ["malformed repository JSON", { repositoryJson: "{" }],
    [
      "repository mismatch",
      {
        repositoryJson: JSON.stringify({
          nameWithOwner: "other/cloudx",
          viewerPermission: "ADMIN",
        }),
      },
    ],
    [
      "non-admin repository permission",
      {
        repositoryJson: JSON.stringify({
          nameWithOwner: GATE_B_REPOSITORY,
          viewerPermission: "WRITE",
        }),
      },
    ],
    ["missing target ref", { targetBaseOutput: "" }],
    ["malformed target ref", { targetBaseOutput: "not-a-ref\n" }],
    [
      "duplicate target ref",
      {
        targetBaseOutput: `${GATE_B_EXPECTED_TARGET_BASE_SHA}\t${GATE_B_TARGET_BASE_REF}\n${GATE_B_EXPECTED_TARGET_BASE_SHA}\t${GATE_B_TARGET_BASE_REF}\n`,
      },
    ],
    ["drifted target ref name", { targetBaseRef: "refs/heads/release" }],
    ["wrong target ref OID", { remoteTargetBase: gitSha("c") }],
    [
      "target ref query failure",
      { failOn: `git ls-remote origin ${GATE_B_TARGET_BASE_REF}` },
    ],
    ["missing candidate ref", { candidateOutput: "" }],
    ["malformed candidate ref", { candidateOutput: "bad\n" }],
    [
      "duplicate candidate ref",
      {
        candidateOutput: `${GATE_B_EXPECTED_OLD_CANDIDATE_SHA}\t${GATE_B_CANDIDATE_REF}\n${GATE_B_EXPECTED_OLD_CANDIDATE_SHA}\t${GATE_B_CANDIDATE_REF}\n`,
      },
    ],
    ["drifted candidate ref name", { candidateRef: "refs/heads/other" }],
    ["wrong candidate ref OID", { remoteCandidate: gitSha("d") }],
    [
      "candidate ref query failure",
      { failOn: `git ls-remote origin ${GATE_B_CANDIDATE_REF}` },
    ],
    ["non-ancestor candidate history", { fastForward: false }],
    [
      "malformed ancestry command result",
      {
        malformedOn: `git merge-base --is-ancestor ${GATE_B_EXPECTED_OLD_CANDIDATE_SHA} ${gitSha("b")}`,
      },
    ],
    [
      "pull-request query failure",
      {
        failOn: `gh pr view ${GATE_B_PULL_REQUEST} --repo ${GATE_B_REPOSITORY} --json number,state,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository,url`,
      },
    ],
    ["malformed pull-request JSON", { beforePushPrOutput: "{" }],
    ["closed pull request", { beforePushPr: { state: "CLOSED" } }],
    [
      "cross-repository pull request",
      { beforePushPr: { isCrossRepository: true } },
    ],
    ["wrong PR number", { beforePushPr: { number: 2 } }],
    ["wrong PR base name", { beforePushPr: { baseRefName: "release" } }],
    ["wrong PR base OID", { beforePushPr: { baseRefOid: gitSha("c") } }],
    ["wrong PR head name", { beforePushPr: { headRefName: "other" } }],
    ["wrong PR head OID", { beforePushPr: { headRefOid: gitSha("d") } }],
    [
      "wrong PR head repository",
      { beforePushPr: { url: "https://github.com/other/cloudx/pull/1" } },
    ],
    ["protected candidate branch", { protectionStatus: 200 }],
    [
      "unconfirmed protection status",
      { protectionOutput: "HTTP/2 403 Forbidden\n" },
    ],
    ["malformed protection response", { protectionOutput: "404\n" }],
    [
      "duplicate protection status",
      { protectionOutput: "HTTP/2 404 Not Found\nHTTP/2 404 Not Found\n" },
    ],
    [
      "rules query failure",
      {
        failOn: `gh api repos/${GATE_B_REPOSITORY}/rules/branches/architecture-and-new-codex`,
      },
    ],
    ["malformed rules response", { rulesOutput: "{" }],
    ["applicable candidate rules", { rules: [{ id: 1 }] }],
  ])("blocks %s with zero push attempts", async (_name, overrides) => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, overrides);

    await expect(
      publishGateBCandidate({
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        runCommand: runner.run,
      }),
    ).rejects.toThrow();
    expect(runner.pushes).toEqual([]);
  });

  it("rejects a caller old-head mismatch before any command", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture);

    await expect(
      publishGateBCandidate({
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: gitSha("d"),
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/expected old candidate/i);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ["push runner throw", { pushThrows: true }],
    ["push nonzero exit", { pushResult: result("", 1, "transport failed") }],
    ["forced porcelain row", { pushOutput: "+" }],
    ["new-ref porcelain row", { pushOutput: "*" }],
    ["rejected porcelain row", { pushOutput: "!" }],
    ["up-to-date porcelain row", { pushOutput: "=" }],
    ["deleted porcelain row", { pushOutput: "-" }],
    ["malformed porcelain", { pushResult: result("ok\n") }],
    ["extra porcelain row", { extraPushRow: true }],
    [
      "wrong porcelain summary",
      { pushSummary: `${gitSha("c")}..${gitSha("d")}` },
    ],
    [
      "post-push target query failure",
      { failAfterPushOn: `git ls-remote origin ${GATE_B_TARGET_BASE_REF}` },
    ],
    ["post-push target OID mismatch", { postPushTargetBase: gitSha("c") }],
    [
      "post-push candidate query failure",
      { failAfterPushOn: `git ls-remote origin ${GATE_B_CANDIDATE_REF}` },
    ],
    ["post-push candidate OID mismatch", { postPushHead: gitSha("e") }],
    [
      "post-push PR query failure",
      {
        failAfterPushOn: `gh pr view ${GATE_B_PULL_REQUEST} --repo ${GATE_B_REPOSITORY} --json number,state,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository,url`,
      },
    ],
    ["post-push malformed PR JSON", { afterPushPrOutput: "{" }],
    ["post-push closed PR", { afterPushPr: { state: "CLOSED" } }],
    ["post-push wrong PR number", { afterPushPr: { number: 2 } }],
    [
      "post-push wrong PR base name",
      { afterPushPr: { baseRefName: "release" } },
    ],
    [
      "post-push wrong PR base OID",
      { afterPushPr: { baseRefOid: gitSha("c") } },
    ],
    ["post-push wrong PR head name", { afterPushPr: { headRefName: "other" } }],
    [
      "post-push wrong PR head OID",
      { afterPushPr: { headRefOid: gitSha("e") } },
    ],
    [
      "post-push cross-repository PR",
      { afterPushPr: { isCrossRepository: true } },
    ],
    [
      "post-push wrong PR repository",
      { afterPushPr: { url: "https://github.com/other/cloudx/pull/1" } },
    ],
  ])("stops at manual reconciliation for %s", async (_name, overrides) => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, overrides);

    const outcome = await publishGateBCandidate({
      artifactDir: fixture.directory,
      authorizedManifestSha256: fixture.manifestSha256,
      expectedOldHead: fixture.oldHead,
      runCommand: runner.run,
    });

    expect(outcome).toMatchObject({
      status: "manual-reconciliation-required",
      pushAttempts: 1,
      reviewPrHandoffAuthorized: false,
    });
    expect(outcome).not.toHaveProperty("remoteHeadSha");
    expect(runner.pushes).toHaveLength(1);
  });

  it("returns terminal manual reconciliation after a post-push mismatch without retry or review handoff", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, { postPushHead: gitSha("e") });

    const outcome = await publishGateBCandidate({
      artifactDir: fixture.directory,
      authorizedManifestSha256: fixture.manifestSha256,
      expectedOldHead: fixture.oldHead,
      runCommand: runner.run,
    });

    expect(outcome).toMatchObject({
      status: "manual-reconciliation-required",
      pushAttempts: 1,
      reviewPrHandoffAuthorized: false,
    });
    expect(runner.pushes).toHaveLength(1);
  });
});

function gateBFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx-gate-b-v11-"),
  );
  const head = gitSha("b");
  const oldHead = GATE_B_EXPECTED_OLD_CANDIDATE_SHA;
  const plan = {
    schema_version: 1,
    kind: "change-plan",
    run_id: "gate-b-v11",
    base_sha: GATE_B_LOCAL_CHANGE_BASE_SHA,
    head_sha: head,
    policy_sha256: GATE_B_POLICY_SHA256,
    skill_versions: { "plan-change": sha("2") },
    task: "Bind one exact candidate bundle.",
    classification: {
      type: "refactor",
      areas: [
        "agent-policy",
        "asr",
        "automation",
        "documentation",
        "installer",
        "repository",
        "security",
        "server",
        "shared",
        "web",
      ],
      risk: "human-required",
      skills: [...GATE_B_REVIEW_ROLES],
      human_review_required: true,
      automerge_eligible: false,
    },
    anchors: [
      { path: "apps/server/src/server.ts", line: 1, reason: "Server owner." },
      {
        path: "scripts/ai-change/publish-gate-b.mjs",
        line: 1,
        reason: "Publisher owner.",
      },
    ],
    claims: Array.from({ length: 71 }, (_, index) => ({
      id: `CLAIM-${index + 1}`,
      behavior: `Behavior ${index + 1}.`,
      production_seam: `Production seam ${index + 1}.`,
      test: `Revert-failing test ${index + 1}.`,
      negative_cases: [`Negative ${index + 1}.`],
    })),
    allowed_paths: Array.from(
      { length: 112 },
      (_, index) => `apps/server/src/gate-b-${index + 1}.ts`,
    ),
    forbidden_paths: [".github/**"],
    verification: ["npm run typecheck", "npm test"],
  };
  writeJson(directory, "plan.json", plan);
  const planDigest = fileDigest(directory, "plan.json");
  const implementation = {
    schema_version: 1,
    kind: "change-implementation",
    run_id: "gate-b-v11",
    base_sha: plan.base_sha,
    head_sha: plan.head_sha,
    policy_sha256: plan.policy_sha256,
    plan_sha256: planDigest,
    changed_files: [...plan.allowed_paths],
    claim_evidence: plan.claims.map(({ id }) => ({
      claim_id: id,
      production_path: "production",
      test_path: "test",
      revert_failing_assertion: "Reverting production fails this test.",
      negative_cases: ["Negative case."],
    })),
    deviations: [],
  };
  writeJson(directory, "implementation.json", implementation);
  const implementationDigest = fileDigest(directory, "implementation.json");
  writeJson(
    directory,
    "plan-review.json",
    review(plan, "review-plan", "plan", planDigest),
  );
  for (const role of GATE_B_REVIEW_ROLES) {
    writeJson(
      directory,
      `${role}.json`,
      review(plan, role, "implementation", implementationDigest),
    );
  }
  writeJson(
    directory,
    "review-change.json",
    review(plan, "review-change", "implementation", implementationDigest),
  );
  writeJson(directory, "verification.json", verification(plan));

  const fixture = {
    directory,
    head,
    oldHead,
    mutate(name, mutation) {
      const filePath = path.join(directory, name);
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      mutation(value);
      writeJson(directory, name, value);
    },
  };
  fixture.manifestSha256 = readGateBArtifactSnapshot(directory).manifestSha256;
  return fixture;
}

function review(plan, reviewerRole, subject, subjectSha256) {
  return {
    schema_version: 1,
    kind: "change-review",
    run_id: `gate-b-${reviewerRole}`,
    subject,
    subject_sha256: subjectSha256,
    base_sha: plan.base_sha,
    head_sha: plan.head_sha,
    policy_sha256: plan.policy_sha256,
    reviewer_role: reviewerRole,
    verdict: "clean",
    tags: ["manual-review"],
    findings: [],
  };
}

function verification(plan) {
  return {
    schema_version: 1,
    kind: "change-verification",
    run_id: "gate-b-verification",
    base_sha: plan.base_sha,
    head_sha: plan.head_sha,
    policy_sha256: plan.policy_sha256,
    tree_sha256_before: sha("7"),
    tree_sha256_after: sha("7"),
    verdict: "passed",
    commands: plan.verification.map((command) => ({
      command,
      exit_code: 0,
      stdout_sha256: sha("3"),
      stderr_sha256: sha("4"),
      tree_sha256_before: sha("7"),
      tree_sha256_after: sha("7"),
    })),
  };
}

function finding() {
  return {
    id: "POLICY-001",
    severity: "high",
    category: "process",
    path: "AGENTS.md",
    line: 1,
    evidence: "Contradictory publication authority.",
    required_fix: "Remove the contradiction.",
  };
}

function commandRunner(fixture, overrides = {}) {
  const calls = [];
  const pushes = [];
  let pushed = false;
  let remoteReads = 0;
  const subjects = overrides.subjects ?? GATE_B_COMMIT_SUBJECTS;
  const expectedPr = {
    number: GATE_B_PULL_REQUEST,
    state: "OPEN",
    baseRefName: "main",
    baseRefOid: GATE_B_EXPECTED_TARGET_BASE_SHA,
    headRefName: "architecture-and-new-codex",
    headRefOid: fixture.oldHead,
    isCrossRepository: false,
    url: `https://github.com/${GATE_B_REPOSITORY}/pull/${GATE_B_PULL_REQUEST}`,
  };
  const run = async (command, args, options = {}) => {
    calls.push([command, args]);
    const signature = `${command} ${args.join(" ")}`;
    if (overrides.throwOn === signature) throw new Error("runner failed");
    if (overrides.failOn === signature) return result("", 1, "failed");
    if (overrides.malformedOn === signature) return {};
    if (pushed && overrides.throwAfterPushOn === signature)
      throw new Error("post-push runner failed");
    if (pushed && overrides.failAfterPushOn === signature)
      return result("", 1, "post-push failed");
    if (signature === "git rev-parse HEAD") return result(fixture.head);
    if (signature === "git symbolic-ref --short HEAD") {
      return result("architecture-and-new-codex\n");
    }
    if (signature.startsWith("git log --reverse --format=%s "))
      return result(`${subjects.join("\n")}\n`);
    if (signature === "git diff --cached --quiet")
      return result("", overrides.indexClean === false ? 1 : 0);
    if (signature === "git diff --quiet")
      return result("", overrides.worktreeClean === false ? 1 : 0);
    if (signature === "git remote get-url --push --all origin")
      return result(
        `${(overrides.originPushUrls ?? ["https://github.com/davidomil/cloudx"]).join("\n")}\n`,
      );
    if (signature === "gh --version")
      return result(overrides.ghVersion ?? "gh version 2.80.0\n");
    if (signature === "gh auth status --active --hostname github.com")
      return result(
        overrides.authOutput ?? "Logged in to github.com account operator\n",
        overrides.authExitCode ?? 0,
      );
    if (signature.startsWith("gh repo view davidomil/cloudx"))
      return result(
        `${overrides.repositoryJson ?? JSON.stringify({ nameWithOwner: GATE_B_REPOSITORY, viewerPermission: "ADMIN" })}\n`,
      );
    if (signature === `git ls-remote origin ${GATE_B_TARGET_BASE_REF}`) {
      const head = pushed
        ? (overrides.postPushTargetBase ?? GATE_B_EXPECTED_TARGET_BASE_SHA)
        : (overrides.remoteTargetBase ?? GATE_B_EXPECTED_TARGET_BASE_SHA);
      const ref = overrides.targetBaseRef ?? GATE_B_TARGET_BASE_REF;
      return result(overrides.targetBaseOutput ?? `${head}\t${ref}\n`);
    }
    if (signature === `git ls-remote origin ${GATE_B_CANDIDATE_REF}`) {
      remoteReads += 1;
      const head = pushed
        ? (overrides.postPushHead ?? fixture.head)
        : (overrides.remoteCandidate ?? fixture.oldHead);
      const ref = overrides.candidateRef ?? GATE_B_CANDIDATE_REF;
      return result(overrides.candidateOutput ?? `${head}\t${ref}\n`);
    }
    if (signature.startsWith("git merge-base --is-ancestor "))
      return result("", overrides.fastForward === false ? 1 : 0);
    if (signature.startsWith("gh pr view 1 --repo davidomil/cloudx")) {
      const phaseOverrides = pushed
        ? overrides.afterPushPr
        : overrides.beforePushPr;
      const value = {
        ...expectedPr,
        ...(pushed ? { headRefOid: fixture.head } : {}),
        ...phaseOverrides,
      };
      return result(
        pushed
          ? (overrides.afterPushPrOutput ?? `${JSON.stringify(value)}\n`)
          : (overrides.beforePushPrOutput ?? `${JSON.stringify(value)}\n`),
      );
    }
    if (
      signature.startsWith(
        "gh api --include repos/davidomil/cloudx/branches/architecture-and-new-codex/protection",
      )
    ) {
      return overrides.protectionStatus === 200
        ? result("HTTP/2 200 OK\n\n{}\n")
        : result(
            overrides.protectionOutput ?? "HTTP/2 404 Not Found\n",
            overrides.protectionExitCode ?? 1,
          );
    }
    if (
      signature.startsWith(
        "gh api repos/davidomil/cloudx/rules/branches/architecture-and-new-codex",
      )
    ) {
      overrides.afterRules?.();
      return result(
        overrides.rulesOutput ?? `${JSON.stringify(overrides.rules ?? [])}\n`,
      );
    }
    if (
      signature ===
      "git push --porcelain origin HEAD:refs/heads/architecture-and-new-codex"
    ) {
      pushes.push([command, args]);
      pushed = true;
      if (overrides.pushThrows) throw new Error("push transport failed");
      const pushFlag = overrides.pushOutput ?? " ";
      const pushSummary =
        overrides.pushSummary ?? `${fixture.oldHead}..${fixture.head}`;
      const pushStdout = `To https://github.com/davidomil/cloudx\n${pushFlag}\tHEAD:${GATE_B_CANDIDATE_REF}\t${pushSummary}\n${
        overrides.extraPushRow
          ? ` \tHEAD:refs/heads/extra\t${pushSummary}\n`
          : ""
      }Done\n`;
      return overrides.pushResult ?? result(pushStdout);
    }
    throw new Error(
      `Unexpected command: ${signature}; options=${JSON.stringify(options)}; remoteReads=${remoteReads}`,
    );
  };
  return { calls, pushes, run };
}

function result(stdout = "", exitCode = 0, stderr = "") {
  return { stdout, stderr, exitCode };
}

function writeJson(directory, name, value) {
  fs.writeFileSync(
    path.join(directory, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function fileDigest(directory, name) {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(directory, name)))
    .digest("hex");
}

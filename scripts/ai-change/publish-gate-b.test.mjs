import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalPublicationAuthorization,
  readGateBArtifactSnapshot,
  publishGateBCandidate,
} from "./publish-gate-b.mjs";
import {
  GATE_B_CANDIDATE_REF,
  GATE_B_COMMIT_SUBJECTS,
  GATE_B_EXPECTED_OLD_CANDIDATE_SHA,
  GATE_B_EXPECTED_TARGET_BASE_SHA,
  GATE_B_LOCAL_CHANGE_BASE_SHA,
  GATE_B_PLANNING_HEAD_SHA,
  GATE_B_POLICY_SHA256,
  GATE_B_PULL_REQUEST,
  GATE_B_REPOSITORY,
  GATE_B_REVIEW_ROLES,
  GATE_B_TARGET_BASE_REF,
} from "./validate-process.mjs";

const gitSha = (character) => character.repeat(40);
const sha = (character) => character.repeat(64);

describe("Gate B candidate publisher", () => {
  it("requires publication authorization before reading a token or dispatching a command", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture);
    let tokenReads = 0;

    await expect(
      publishGateBCandidate({
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        readToken() {
          tokenReads += 1;
          return "sentinel-token";
        },
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/publication authorization/i);
    expect(tokenReads).toBe(0);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ["compact JSON", (canonical) => JSON.stringify(JSON.parse(canonical))],
    ["CRLF", (canonical) => canonical.replaceAll("\n", "\r\n")],
    ["BOM", (canonical) => `\ufeff${canonical}`],
    ["extra newline", (canonical) => `${canonical}\n`],
    ["trailing space", (canonical) => canonical.replace("\n", " \n")],
    [
      "unsorted keys",
      (_canonical, fixture) =>
        `${JSON.stringify(fixture.authorization, null, 2)}\n`,
    ],
  ])(
    "rejects %s authorization bytes before reading a token or dispatching a command",
    async (_name, transform) => {
      const fixture = gateBFixture();
      writeAuthorizationBytes(
        fixture,
        transform(
          canonicalPublicationAuthorization(fixture.authorization),
          fixture,
        ),
      );

      await expectAuthorizationRejectedBeforeToken(fixture);
    },
  );

  it.each([
    [
      "artifact manifest",
      (authorization) => (authorization.artifact_manifest_sha256 = sha("9")),
    ],
    ["policy", (authorization) => (authorization.policy_sha256 = sha("9"))],
    [
      "local change base",
      (authorization) => (authorization.local_change_base_sha = gitSha("9")),
    ],
    [
      "planning head",
      (authorization) => (authorization.planning_head_sha = gitSha("9")),
    ],
    [
      "candidate head",
      (authorization) => (authorization.candidate_head_sha = gitSha("9")),
    ],
    [
      "expected old candidate",
      (authorization) =>
        (authorization.expected_old_candidate_sha = gitSha("9")),
    ],
    [
      "target base",
      (authorization) => (authorization.expected_target_base_sha = gitSha("9")),
    ],
    [
      "PR base",
      (authorization) => (authorization.pr_base_ref_oid = gitSha("9")),
    ],
    [
      "PR head",
      (authorization) => (authorization.pr_head_ref_oid = gitSha("9")),
    ],
    ["grant", (authorization) => (authorization.grant_scope = "other")],
    ["nonce", (authorization) => (authorization.authorization_nonce = "short")],
    ["secret field", (authorization) => (authorization.token = "forbidden")],
    [
      "principal kind",
      (authorization) => (authorization.principal.kind = "github-user"),
    ],
  ])(
    "rejects a substituted %s authorization before reading a token or dispatching a command",
    async (_name, mutate) => {
      const fixture = gateBFixture();
      mutate(fixture.authorization);
      writeCanonicalAuthorization(fixture);

      await expectAuthorizationRejectedBeforeToken(fixture);
    },
  );

  it.each([
    ["future issue", 60_000, 10 * 60_000],
    ["expired", -10 * 60_000, 0],
    ["zero lifetime", -60_000, -60_000],
    ["negative lifetime", -60_000, -120_000],
    ["over 15 minutes", -60_000, 15 * 60_000],
  ])(
    "rejects a %s grant before reading a token or dispatching a command",
    async (_name, issuedOffset, expiryOffset) => {
      const fixture = gateBFixture();
      fixture.authorization.issued_at = new Date(
        fixture.nowMs + issuedOffset,
      ).toISOString();
      fixture.authorization.expires_at = new Date(
        fixture.nowMs + expiryOffset,
      ).toISOString();
      writeCanonicalAuthorization(fixture);

      await expectAuthorizationRejectedBeforeToken(fixture);
    },
  );

  it("publishes through the attended-user identity without querying installation repositories", async () => {
    const fixture = gateBFixture();
    useAttendedUserAuthorization(fixture);
    const runner = commandRunner(fixture);

    const result = await publishGateBCandidate({
      ...authorizationArguments(fixture),
      artifactDir: fixture.directory,
      authorizedManifestSha256: fixture.manifestSha256,
      expectedOldHead: fixture.oldHead,
      runCommand: runner.run,
    });

    expect(result.status).toBe("published");
    expect(commandSignatures(runner.calls)).toContain(
      "gh api --method GET /user",
    );
    expect(commandSignatures(runner.calls)).not.toContain(
      "gh api --method GET /installation/repositories",
    );
  });

  it.each([
    ["user ID", { id: 4004, login: "cloudx-operator" }],
    ["user login", { id: 3003, login: "other-operator" }],
  ])("rejects an attended %s mismatch before push", async (_name, user) => {
    const fixture = gateBFixture();
    useAttendedUserAuthorization(fixture);
    const runner = commandRunner(fixture, { user });

    await expect(
      publishGateBCandidate({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/attended user/i);
    expect(runner.pushes).toEqual([]);
  });

  it("accepts an exact 15-minute authorization lifetime", async () => {
    const fixture = gateBFixture();
    fixture.authorization.issued_at = new Date(
      fixture.nowMs - 60_000,
    ).toISOString();
    fixture.authorization.expires_at = new Date(
      fixture.nowMs + 14 * 60_000,
    ).toISOString();
    writeCanonicalAuthorization(fixture);
    const runner = commandRunner(fixture);

    const result = await publishGateBCandidate({
      ...authorizationArguments(fixture),
      artifactDir: fixture.directory,
      authorizedManifestSha256: fixture.manifestSha256,
      expectedOldHead: fixture.oldHead,
      runCommand: runner.run,
    });

    expect(result.status).toBe("published");
  });

  it.each(["automated-app", "attended-user"])(
    "publishes through the real spawned CLI in %s mode",
    (credentialMode) => {
      const fixture = gateBFixture();
      if (credentialMode === "attended-user") {
        useAttendedUserAuthorization(fixture);
      }
      const spawned = spawnedPublisherFixture(fixture);

      const result = spawnPublisher(fixture, spawned);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "published",
        headSha: fixture.head,
        publicationAuthorizationSha256: fixture.authorizedPublicationSha256,
      });
      const calls = readShimCalls(spawned);
      const signatures = commandSignatures(
        calls.map(({ command, args }) => [command, args]),
      );
      expect(signatures).toContain(
        credentialMode === "automated-app"
          ? "gh api --method GET /installation/repositories"
          : "gh api --method GET /user",
      );
      expect(signatures).not.toContain(
        credentialMode === "automated-app"
          ? "gh api --method GET /user"
          : "gh api --method GET /installation/repositories",
      );
      const networkCalls = calls.filter(
        ({ command, operation }) =>
          command === "gh" ||
          (command === "git" && ["ls-remote", "push"].includes(operation)),
      );
      expect(
        new Set(networkCalls.map(({ tokenSha256 }) => tokenSha256)),
      ).toEqual(new Set([digest(fixture.token)]));
      expect(
        networkCalls.every(({ cloudxTokenPresent }) => !cloudxTokenPresent),
      ).toBe(true);
      expect(
        networkCalls.every(({ githubTokenPresent }) => !githubTokenPresent),
      ).toBe(true);
      expect(
        networkCalls
          .filter(({ command }) => command === "git")
          .every(
            ({ askpass, configGlobal, terminalPrompt }) =>
              askpass === "/bin/false" &&
              configGlobal === "/dev/null" &&
              terminalPrompt === "0",
          ),
      ).toBe(true);
      const pushes = calls.filter(({ operation }) => operation === "push");
      expect(pushes).toHaveLength(1);
      expect(pushes[0].args.slice(-5)).toEqual([
        "push",
        "--porcelain",
        `--force-with-lease=${GATE_B_CANDIDATE_REF}:${fixture.oldHead}`,
        "origin",
        `HEAD:${GATE_B_CANDIDATE_REF}`,
      ]);
      expect(
        `${result.stdout}\n${result.stderr}\n${fs.readFileSync(spawned.logFile, "utf8")}`,
      ).not.toContain(fixture.token);
    },
  );

  it.each([
    ["missing authorization file argument", { omit: "authorization-file" }],
    ["duplicate credential mode argument", { duplicate: "credential-mode" }],
    ["unsupported argument", { extra: ["--retry", "true"] }],
    ["noncanonical authorization", { noncanonical: true }],
  ])("rejects %s in the real CLI before any shim command", (_name, options) => {
    const fixture = gateBFixture();
    if (options.noncanonical) {
      writeAuthorizationBytes(fixture, JSON.stringify(fixture.authorization));
    }
    const spawned = spawnedPublisherFixture(fixture);

    const result = spawnPublisher(fixture, spawned, options);

    expect(result.status).not.toBe(0);
    expect(readShimCalls(spawned)).toEqual([]);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.token);
  });

  it("rejects a CLI credential-mode mismatch before reading a token", async () => {
    const fixture = gateBFixture();
    fixture.credentialMode = "attended-user";

    await expectAuthorizationRejectedBeforeToken(fixture);
  });

  it.each([
    [
      "missing file",
      (fixture) => {
        fixture.authorizationFile = path.join(
          path.dirname(fixture.authorizationFile),
          "missing.json",
        );
      },
    ],
    [
      "directory",
      (fixture) => {
        const directory = path.join(
          path.dirname(fixture.authorizationFile),
          "authorization-directory",
        );
        fs.mkdirSync(directory);
        fixture.authorizationFile = directory;
      },
    ],
    [
      "symlink",
      (fixture) => {
        const target = `${fixture.authorizationFile}.target`;
        fs.renameSync(fixture.authorizationFile, target);
        fs.symlinkSync(target, fixture.authorizationFile);
      },
    ],
    [
      "oversized file",
      (fixture) => writeAuthorizationBytes(fixture, "x".repeat(32 * 1024 + 1)),
    ],
    [
      "artifact-directory descendant",
      (fixture) => {
        const inside = path.join(fixture.directory, "authorization.json");
        fs.copyFileSync(fixture.authorizationFile, inside);
        fixture.authorizationFile = inside;
        fixture.authorizedPublicationSha256 = fileDigest(
          fixture.directory,
          "authorization.json",
        );
      },
    ],
  ])(
    "rejects a %s authorization source before reading a token or dispatching a command",
    async (_name, mutate) => {
      const fixture = gateBFixture();
      mutate(fixture);
      await expectAuthorizationRejectedBeforeToken(fixture);
    },
  );

  it("rereads authorization and rejects replacement or expiry before push", async () => {
    for (const change of [
      (fixture) => {
        fixture.authorization.authorization_nonce = sha("b");
        writeCanonicalAuthorization(fixture);
      },
      (fixture) => {
        fixture.nowMs = Date.parse(fixture.authorization.expires_at);
      },
    ]) {
      const fixture = gateBFixture();
      const runner = commandRunner(fixture, {
        afterRules: () => change(fixture),
      });

      await expect(
        publishGateBCandidate({
          ...authorizationArguments(fixture),
          artifactDir: fixture.directory,
          authorizedManifestSha256: fixture.manifestSha256,
          expectedOldHead: fixture.oldHead,
          runCommand: runner.run,
        }),
      ).rejects.toThrow(/authorization|grant/i);
      expect(runner.pushes).toEqual([]);
    }
  });

  it("finishes authoritative readback when the grant expires after the sole push starts", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, {
      afterPush() {
        fixture.nowMs = Date.parse(fixture.authorization.expires_at);
      },
    });

    const result = await publishGateBCandidate({
      ...authorizationArguments(fixture),
      artifactDir: fixture.directory,
      authorizedManifestSha256: fixture.manifestSha256,
      expectedOldHead: fixture.oldHead,
      runCommand: runner.run,
    });

    expect(result.status).toBe("published");
    expect(runner.pushes).toHaveLength(1);
  });

  it("validates one immutable exact-head bundle before one non-force push and authoritative readback", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture);

    const result = await publishGateBCandidate({
      ...authorizationArguments(fixture),
      artifactDir: fixture.directory,
      authorizedManifestSha256: fixture.manifestSha256,
      expectedOldHead: fixture.oldHead,
      runCommand: runner.run,
    });

    expect(result).toEqual({
      status: "published",
      headSha: fixture.head,
      manifestSha256: fixture.manifestSha256,
      publicationAuthorizationSha256: fixture.authorizedPublicationSha256,
      repository: GATE_B_REPOSITORY,
      targetBaseRef: GATE_B_TARGET_BASE_REF,
      targetBaseSha: GATE_B_EXPECTED_TARGET_BASE_SHA,
      candidateRef: GATE_B_CANDIDATE_REF,
      remoteHeadSha: fixture.head,
      pullRequest: GATE_B_PULL_REQUEST,
      reviewPrHandoffAuthorized: true,
    });
    expect(runner.pushes).toHaveLength(1);
    expect(runner.pushes[0][1].slice(-5)).toEqual([
      "push",
      "--porcelain",
      `--force-with-lease=${GATE_B_CANDIDATE_REF}:${fixture.oldHead}`,
      "origin",
      "HEAD:refs/heads/architecture-and-new-codex",
    ]);
    expect(runner.pushes[0][1]).toEqual(
      expect.arrayContaining([
        "credential.helper=",
        "credential.useHttpPath=true",
        "core.askPass=/bin/false",
      ]),
    );
    expect(runner.pushes[0][1].join(" ")).not.toContain(fixture.token);
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
          ...authorizationArguments(fixture),
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
        ...authorizationArguments(fixture),
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
    ["protected branch", { branch: { protected: true } }],
    ["branch rules", { rules: [{ id: 1 }] }],
  ])("rejects %s before the push command", async (_name, overrides) => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, overrides);

    await expect(
      publishGateBCandidate({
        ...authorizationArguments(fixture),
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
        ...authorizationArguments(fixture),
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
    [
      "failed automated-app identity query",
      { failOn: "gh api --method GET /installation/repositories" },
    ],
    [
      "malformed automated-app identity",
      { installationRepositories: { total_count: 1, repositories: [] } },
    ],
    [
      "wrong automated-app repository",
      {
        installationRepositories: {
          total_count: 1,
          repositories: [{ full_name: "other/cloudx" }],
        },
      },
    ],
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
      "wrong origin fetch URL",
      { originFetchUrls: ["https://example.invalid/cloudx"] },
    ],
    [
      "origin query failure",
      { failOn: "git remote get-url --push --all origin" },
    ],
    [
      "repository query failure",
      {
        failOn: "gh repo view davidomil/cloudx --json nameWithOwner",
      },
    ],
    ["malformed repository JSON", { repositoryJson: "{" }],
    [
      "repository mismatch",
      {
        repositoryJson: JSON.stringify({
          nameWithOwner: "other/cloudx",
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
    [
      "candidate branch query failure",
      {
        failOn:
          "gh api --method GET repos/davidomil/cloudx/branches/architecture-and-new-codex",
      },
    ],
    ["malformed candidate branch", { branchOutput: "{" }],
    ["wrong candidate branch name", { branch: { name: "other" } }],
    [
      "wrong candidate branch OID",
      { branch: { commit: { sha: gitSha("c") } } },
    ],
    ["protected candidate branch", { branch: { protected: true } }],
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
        ...authorizationArguments(fixture),
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
        ...authorizationArguments(fixture),
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
      ...authorizationArguments(fixture),
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
      ...authorizationArguments(fixture),
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-gate-b-v11-"));
  const directory = path.join(root, "artifacts");
  fs.mkdirSync(directory);
  const head = gitSha("b");
  const oldHead = GATE_B_EXPECTED_OLD_CANDIDATE_SHA;
  const nowMs = Date.now();
  const plan = {
    schema_version: 1,
    kind: "change-plan",
    run_id: "gate-b-v11",
    base_sha: GATE_B_LOCAL_CHANGE_BASE_SHA,
    head_sha: GATE_B_PLANNING_HEAD_SHA,
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
    claims: Array.from({ length: 73 }, (_, index) => ({
      id: `CLAIM-${index + 1}`,
      behavior: `Behavior ${index + 1}.`,
      production_seam: `Production seam ${index + 1}.`,
      test: `Revert-failing test ${index + 1}.`,
      negative_cases: [`Negative ${index + 1}.`],
    })),
    allowed_paths: Array.from(
      { length: 113 },
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
    head_sha: head,
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
    review(plan, "review-plan", "plan", planDigest, GATE_B_PLANNING_HEAD_SHA),
  );
  for (const role of GATE_B_REVIEW_ROLES) {
    writeJson(
      directory,
      `${role}.json`,
      review(plan, role, "implementation", implementationDigest, head),
    );
  }
  writeJson(
    directory,
    "review-change.json",
    review(plan, "review-change", "implementation", implementationDigest, head),
  );
  writeJson(directory, "verification.json", verification(plan, head));

  const fixture = {
    directory,
    head,
    nowMs,
    oldHead,
    mutate(name, mutation) {
      const filePath = path.join(directory, name);
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      mutation(value);
      writeJson(directory, name, value);
    },
  };
  fixture.manifestSha256 = readGateBArtifactSnapshot(directory).manifestSha256;
  fixture.credentialMode = "automated-app";
  fixture.token = "sentinel-gate-b-token";
  fixture.authorizationFile = path.join(root, "publication-authorization.json");
  fixture.authorization = publicationAuthorization(fixture);
  writeCanonicalAuthorization(fixture);
  return fixture;
}

function review(plan, reviewerRole, subject, subjectSha256, headSha) {
  return {
    schema_version: 1,
    kind: "change-review",
    run_id: `gate-b-${reviewerRole}`,
    subject,
    subject_sha256: subjectSha256,
    base_sha: plan.base_sha,
    head_sha: headSha,
    policy_sha256: plan.policy_sha256,
    reviewer_role: reviewerRole,
    verdict: "clean",
    tags: ["manual-review"],
    findings: [],
  };
}

function verification(plan, candidateHead) {
  return {
    schema_version: 1,
    kind: "change-verification",
    run_id: "gate-b-verification",
    base_sha: plan.base_sha,
    head_sha: candidateHead,
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

function publicationAuthorization(fixture, overrides = {}) {
  const automatedPrincipal = {
    kind: "github-app-installation",
    app_id: 1001,
    installation_id: 2002,
    app_slug: "cloudx-publisher",
    repository_selection: "selected",
    repositories: [GATE_B_REPOSITORY],
    permissions: {
      contents: "write",
      pull_requests: "read",
      metadata: "read",
    },
    private_controller_grant_id: "controller-grant-1",
  };
  return {
    schema_version: 1,
    kind: "publication-authorization",
    grant_scope: "initial-candidate-publication",
    authorization_nonce: sha("a"),
    issued_at: new Date(fixture.nowMs - 60_000).toISOString(),
    expires_at: new Date(fixture.nowMs + 10 * 60_000).toISOString(),
    repository: GATE_B_REPOSITORY,
    pull_request: GATE_B_PULL_REQUEST,
    artifact_manifest_sha256: fixture.manifestSha256,
    policy_sha256: GATE_B_POLICY_SHA256,
    credential_mode: "automated-app",
    local_change_base_sha: GATE_B_LOCAL_CHANGE_BASE_SHA,
    planning_head_sha: GATE_B_PLANNING_HEAD_SHA,
    candidate_head_sha: fixture.head,
    expected_old_candidate_sha: fixture.oldHead,
    candidate_ref: GATE_B_CANDIDATE_REF,
    target_base_ref: GATE_B_TARGET_BASE_REF,
    expected_target_base_sha: GATE_B_EXPECTED_TARGET_BASE_SHA,
    pr_state: "OPEN",
    pr_base_ref_name: "main",
    pr_base_ref_oid: GATE_B_EXPECTED_TARGET_BASE_SHA,
    pr_head_ref_name: "architecture-and-new-codex",
    pr_head_ref_oid: fixture.oldHead,
    same_repository: true,
    principal: automatedPrincipal,
    ...overrides,
  };
}

function writeCanonicalAuthorization(fixture) {
  writeAuthorizationBytes(
    fixture,
    canonicalPublicationAuthorization(fixture.authorization),
  );
}

function writeAuthorizationBytes(fixture, bytes) {
  fs.writeFileSync(fixture.authorizationFile, bytes, { mode: 0o600 });
  fixture.authorizedPublicationSha256 = fileDigest(
    path.dirname(fixture.authorizationFile),
    path.basename(fixture.authorizationFile),
  );
}

function useAttendedUserAuthorization(fixture) {
  fixture.credentialMode = "attended-user";
  fixture.authorization.credential_mode = "attended-user";
  fixture.authorization.principal = {
    kind: "github-user",
    user_id: 3003,
    login: "cloudx-operator",
    attended_authorization_id: "attended-grant-1",
  };
  writeCanonicalAuthorization(fixture);
}

async function expectAuthorizationRejectedBeforeToken(fixture) {
  const runner = commandRunner(fixture);
  let tokenReads = 0;
  await expect(
    publishGateBCandidate({
      ...authorizationArguments(fixture),
      artifactDir: fixture.directory,
      authorizedManifestSha256: fixture.manifestSha256,
      expectedOldHead: fixture.oldHead,
      readToken() {
        tokenReads += 1;
        return fixture.token;
      },
      runCommand: runner.run,
    }),
  ).rejects.toThrow();
  expect(tokenReads).toBe(0);
  expect(runner.calls).toEqual([]);
}

function commandSignatures(calls) {
  return calls.map(([command, args]) => {
    const routedArgs =
      command === "git" && args[0] === "-c" ? args.slice(8) : args;
    return `${command} ${routedArgs.join(" ")}`;
  });
}

function spawnedPublisherFixture(fixture) {
  const root = path.dirname(fixture.authorizationFile);
  const bin = path.join(root, "bin");
  const logFile = path.join(root, "shim-calls.jsonl");
  const stateFile = path.join(root, "shim-state.json");
  fs.mkdirSync(bin);
  fs.writeFileSync(logFile, "");
  fs.writeFileSync(stateFile, JSON.stringify({ pushed: false }));
  const source = `#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const routed = [...args];
while (command === "git" && routed[0] === "-c") routed.splice(0, 2);
const operation = routed[0] ?? "";
const token = process.env.GH_TOKEN ?? "";
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
  command,
  args,
  operation,
  tokenSha256: token ? crypto.createHash("sha256").update(token).digest("hex") : null,
  cloudxTokenPresent: Boolean(process.env.CLOUDX_GATE_B_TOKEN),
  githubTokenPresent: Boolean(process.env.GITHUB_TOKEN),
  askpass: process.env.GIT_ASKPASS ?? null,
  configGlobal: process.env.GIT_CONFIG_GLOBAL ?? null,
  terminalPrompt: process.env.GIT_TERMINAL_PROMPT ?? null,
}) + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const output = (value) => process.stdout.write(value);
const fail = (message) => { process.stderr.write(message + "\\n"); process.exitCode = 1; };
const oldHead = ${JSON.stringify(fixture.oldHead)};
const head = ${JSON.stringify(fixture.head)};
const target = ${JSON.stringify(GATE_B_EXPECTED_TARGET_BASE_SHA)};
const candidateRef = ${JSON.stringify(GATE_B_CANDIDATE_REF)};
const targetRef = ${JSON.stringify(GATE_B_TARGET_BASE_REF)};
if (command === "git") {
  if (operation === "rev-parse") output(head + "\\n");
  else if (operation === "symbolic-ref") output("architecture-and-new-codex\\n");
  else if (operation === "log") output(${JSON.stringify(`${GATE_B_COMMIT_SUBJECTS.join("\n")}\n`)});
  else if (operation === "diff") {}
  else if (operation === "remote") output("https://github.com/davidomil/cloudx\\n");
  else if (operation === "merge-base") {}
  else if (operation === "ls-remote") {
    const ref = routed[2];
    const oid = ref === targetRef ? target : state.pushed ? head : oldHead;
    output(oid + "\\t" + ref + "\\n");
  } else if (operation === "push") {
    state.pushed = true;
    fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
    output("To https://github.com/davidomil/cloudx\\n \\tHEAD:" + candidateRef + "\\t" + oldHead + ".." + head + "\\nDone\\n");
  } else fail("unexpected git operation: " + routed.join(" "));
} else if (command === "gh") {
  const signature = routed.join(" ");
  if (signature === "--version") output("gh version 2.80.0\\n");
  else if (signature === "api --method GET /installation/repositories") output(JSON.stringify({ total_count: 1, repositories: [{ full_name: ${JSON.stringify(GATE_B_REPOSITORY)} }] }) + "\\n");
  else if (signature === "api --method GET /user") output(JSON.stringify({ id: 3003, login: "cloudx-operator" }) + "\\n");
  else if (signature === "repo view davidomil/cloudx --json nameWithOwner") output(JSON.stringify({ nameWithOwner: ${JSON.stringify(GATE_B_REPOSITORY)} }) + "\\n");
  else if (signature.startsWith("pr view 1 --repo davidomil/cloudx")) output(JSON.stringify({ number: 1, state: "OPEN", baseRefName: "main", baseRefOid: target, headRefName: "architecture-and-new-codex", headRefOid: state.pushed ? head : oldHead, isCrossRepository: false, url: "https://github.com/davidomil/cloudx/pull/1" }) + "\\n");
  else if (signature === "api --method GET repos/davidomil/cloudx/branches/architecture-and-new-codex") output(JSON.stringify({ name: "architecture-and-new-codex", commit: { sha: oldHead }, protected: false }) + "\\n");
  else if (signature === "api repos/davidomil/cloudx/rules/branches/architecture-and-new-codex") output("[]\\n");
  else fail("unexpected gh operation: " + signature);
} else fail("unexpected command: " + command);
`;
  for (const command of ["git", "gh"]) {
    const executable = path.join(bin, command);
    fs.writeFileSync(executable, source, { mode: 0o755 });
  }
  return { bin, logFile };
}

function spawnPublisher(fixture, spawned, options = {}) {
  const pairs = [
    ["artifact-dir", fixture.directory],
    ["authorized-manifest-sha256", fixture.manifestSha256],
    ["authorization-file", fixture.authorizationFile],
    ["authorized-publication-sha256", fixture.authorizedPublicationSha256],
    ["credential-mode", fixture.credentialMode],
    ["expected-old-head", fixture.oldHead],
  ].filter(([name]) => name !== options.omit);
  const args = pairs.flatMap(([name, value]) => [`--${name}`, value]);
  if (options.duplicate) {
    const value = pairs.find(([name]) => name === options.duplicate)?.[1];
    args.push(`--${options.duplicate}`, value ?? "duplicate");
  }
  args.push(...(options.extra ?? []));
  return spawnSync(
    process.execPath,
    [path.resolve("scripts/ai-change/publish-gate-b.mjs"), ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        CLOUDX_GATE_B_TOKEN: fixture.token,
        GH_CONFIG_DIR: "/ambient/gh",
        GH_TOKEN: "ambient-gh-token",
        GIT_ASKPASS: "/ambient/askpass",
        GIT_CONFIG_GLOBAL: "/ambient/gitconfig",
        GITHUB_TOKEN: "ambient-github-token",
        LANG: "C",
        LC_ALL: "C",
        PATH: `${spawned.bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    },
  );
}

function readShimCalls(spawned) {
  const source = fs.readFileSync(spawned.logFile, "utf8").trim();
  return source ? source.split("\n").map((line) => JSON.parse(line)) : [];
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function authorizationArguments(fixture) {
  return {
    authorizationFile: fixture.authorizationFile,
    authorizedPublicationSha256: fixture.authorizedPublicationSha256,
    credentialMode: fixture.credentialMode,
    now: () => fixture.nowMs,
    readToken: () => fixture.token,
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
    const routedArgs =
      command === "git" && args[0] === "-c" ? args.slice(8) : args;
    const signature = `${command} ${routedArgs.join(" ")}`;
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
    if (signature === "git remote get-url --all origin")
      return result(
        `${(overrides.originFetchUrls ?? ["https://github.com/davidomil/cloudx"]).join("\n")}\n`,
      );
    if (signature === "gh --version")
      return result(overrides.ghVersion ?? "gh version 2.80.0\n");
    if (signature === "gh api --method GET /installation/repositories") {
      return result(
        `${JSON.stringify(
          overrides.installationRepositories ?? {
            total_count: 1,
            repositories: [{ full_name: GATE_B_REPOSITORY }],
          },
        )}\n`,
      );
    }
    if (signature === "gh api --method GET /user") {
      return result(
        `${JSON.stringify(
          overrides.user ?? { id: 3003, login: "cloudx-operator" },
        )}\n`,
      );
    }
    if (signature === "gh auth status --active --hostname github.com")
      return result(
        overrides.authOutput ?? "Logged in to github.com account operator\n",
        overrides.authExitCode ?? 0,
      );
    if (signature.startsWith("gh repo view davidomil/cloudx"))
      return result(
        `${overrides.repositoryJson ?? JSON.stringify({ nameWithOwner: GATE_B_REPOSITORY })}\n`,
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
      signature ===
      "gh api --method GET repos/davidomil/cloudx/branches/architecture-and-new-codex"
    ) {
      const branch = {
        name: "architecture-and-new-codex",
        commit: { sha: fixture.oldHead },
        protected: false,
        ...overrides.branch,
      };
      return result(overrides.branchOutput ?? `${JSON.stringify(branch)}\n`);
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
      `git push --porcelain --force-with-lease=${GATE_B_CANDIDATE_REF}:${fixture.oldHead} origin HEAD:refs/heads/architecture-and-new-codex`
    ) {
      pushes.push([command, args]);
      pushed = true;
      overrides.afterPush?.();
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

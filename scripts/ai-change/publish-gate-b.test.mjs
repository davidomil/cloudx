import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalPublicationAuthorization,
  publishGateBCandidate,
  publishGateBCandidateForLoopbackTest,
  readGateBArtifactSnapshot,
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
  it("v18 requires the ephemeral token commitment in publication authorization", () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.resolve(".agents/schemas/publication-authorization.schema.json"),
        "utf8",
      ),
    );

    expect(schema.required).toContain("credential_token_sha256");
    expect(schema.properties.credential_token_sha256).toEqual({
      $ref: "#/$defs/sha256",
    });
  });

  it("v18 returns only the closed published terminal result", async () => {
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
      outcome: "published",
      pushAttempts: 1,
      retry: false,
      reviewPrHandoff: true,
    });
  });

  it("rejects a token fingerprint mismatch before every command", async () => {
    const fixture = gateBFixture();
    fixture.authorization.credential_token_sha256 = sha("9");
    writeCanonicalAuthorization(fixture);
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
    ).rejects.toThrow(/credential is not authorized/i);

    expect(tokenReads).toBe(1);
    expect(runner.calls).toEqual([]);
  });

  it("keeps the token commitment only in private authorization bytes", () => {
    const fixture = gateBFixture();
    const authorizationBytes = fs.readFileSync(
      fixture.authorizationFile,
      "utf8",
    );
    const artifactBytes = Object.values(
      readGateBArtifactSnapshot(fixture.directory).files,
    ).map((bytes) => bytes.toString("utf8"));

    expect(authorizationBytes).toContain(
      `"credential_token_sha256": "${digest(fixture.token)}"`,
    );
    expect(authorizationBytes).not.toContain(fixture.token);
    expect(artifactBytes.join("\n")).not.toContain(fixture.token);
    expect(artifactBytes.join("\n")).not.toContain(digest(fixture.token));
  });

  it("rejects a public production transport selector before token or process use", () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture);
    let tokenReads = 0;

    expect(() =>
      publishGateBCandidate({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        transport: Object.freeze({}),
        readToken() {
          tokenReads += 1;
          return fixture.token;
        },
        runCommand: runner.run,
      }),
    ).toThrow(/closed contract/i);
    expect(tokenReads).toBe(0);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ["mutable descriptor", loopbackTransport(41000, { freeze: false })],
    ["extra descriptor key", loopbackTransport(41001, { extra: true })],
    ["localhost host", loopbackTransport(41002, { hostname: "localhost" })],
    ["missing port", loopbackTransport(undefined)],
    ["wrong path", loopbackTransport(41003, { path: "other.git" })],
    ["query", loopbackTransport(41004, { query: "?transport=other" })],
    ["fragment", loopbackTransport(41005, { fragment: "#other" })],
    ["userinfo", loopbackTransport(41006, { userinfo: "operator@" })],
    [
      "scope host drift",
      loopbackTransport(41007, { scopeHost: "127.0.0.1:9" }),
    ],
    ["scope path drift", loopbackTransport(41008, { scopePath: "other.git" })],
  ])("rejects a %s loopback test transport", (_name, transport) => {
    expect(() => publishGateBCandidateForLoopbackTest({}, transport)).toThrow(
      /loopback|frozen closed/i,
    );
  });

  it("turns post-push cleanup uncertainty into only manual reconciliation", async () => {
    for (const pushResult of [undefined, result("", 1, "failed")]) {
      const fixture = gateBFixture();
      const runner = commandRunner(fixture, { pushResult });
      let cleanupCalls = 0;
      let contextRoot;

      const terminal = await publishGateBCandidate({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        removeDirectory(directory) {
          cleanupCalls += 1;
          contextRoot = directory;
          throw new Error(`untrusted cleanup ${fixture.token}`);
        },
        runCommand: runner.run,
      });

      expect(terminal).toEqual({
        outcome: "manual-reconciliation-required",
        pushAttempts: 1,
        retry: false,
        reviewPrHandoff: false,
      });
      expect(cleanupCalls).toBe(1);
      expect(runner.pushes).toHaveLength(1);
      fs.rmSync(contextRoot, { force: true, recursive: true });
    }
  });

  it("rejects pre-push cleanup failure without fabricating an attempt", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, { failOn: "gh --version" });
    let cleanupCalls = 0;
    let contextRoot;

    await expect(
      publishGateBCandidate({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        removeDirectory(directory) {
          cleanupCalls += 1;
          contextRoot = directory;
          throw new Error(`untrusted cleanup ${fixture.token}`);
        },
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/^Gate B pre-push cleanup failed\.$/u);

    expect(cleanupCalls).toBe(1);
    expect(runner.pushes).toEqual([]);
    fs.rmSync(contextRoot, { force: true, recursive: true });
  });

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
      "transport field",
      (authorization) =>
        (authorization.transport_url = "https://example.invalid/cloudx"),
    ],
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

    expect(result.outcome).toBe("published");
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

    expect(result.outcome).toBe("published");
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
      expect(JSON.parse(result.stdout)).toEqual({
        outcome: "published",
        pushAttempts: 1,
        retry: false,
        reviewPrHandoff: true,
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
      expect(networkCalls.every(({ tokenPresent }) => tokenPresent)).toBe(true);
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
      expect(pushes[0].args.slice(-6)).toEqual([
        "push",
        "--no-verify",
        "--porcelain",
        `--force-with-lease=${GATE_B_CANDIDATE_REF}:${fixture.oldHead}`,
        "https://github.com/davidomil/cloudx",
        `HEAD:${GATE_B_CANDIDATE_REF}`,
      ]);
      expect(
        `${result.stdout}\n${result.stderr}\n${fs.readFileSync(spawned.logFile, "utf8")}`,
      ).not.toContain(fixture.token);
      expect(
        `${result.stdout}\n${result.stderr}\n${fs.readFileSync(spawned.logFile, "utf8")}`,
      ).not.toContain(digest(fixture.token));
    },
  );

  it.each([
    ["missing authorization file argument", { omit: "authorization-file" }],
    ["duplicate credential mode argument", { duplicate: "credential-mode" }],
    ["unsupported argument", { extra: ["--retry", "true"] }],
    [
      "transport URL argument",
      { extra: ["--transport-url", "http://127.0.0.1:9/cloudx.git"] },
    ],
    ["URL alias", { extra: ["--url", "https://example.invalid/cloudx"] }],
    ["credential scope alias", { extra: ["--credential-scope", "other"] }],
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
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Gate B publication rejected before push.\n");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(1024);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.token);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      digest(fixture.token),
    );
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

    expect(result.outcome).toBe("published");
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
      outcome: "published",
      pushAttempts: 1,
      retry: false,
      reviewPrHandoff: true,
    });
    expect(runner.pushes).toHaveLength(1);
    expect(runner.pushes[0][1].slice(-6)).toEqual([
      "push",
      "--no-verify",
      "--porcelain",
      `--force-with-lease=${GATE_B_CANDIDATE_REF}:${fixture.oldHead}`,
      "https://github.com/davidomil/cloudx",
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
    ).rejects.toThrow(/changed before publication/i);
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
      {
        failOn: `git ls-remote https://github.com/davidomil/cloudx ${GATE_B_TARGET_BASE_REF}`,
      },
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
      {
        failOn: `git ls-remote https://github.com/davidomil/cloudx ${GATE_B_CANDIDATE_REF}`,
      },
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
      {
        failAfterPushOn: `git ls-remote https://github.com/davidomil/cloudx ${GATE_B_TARGET_BASE_REF}`,
      },
    ],
    ["post-push target OID mismatch", { postPushTargetBase: gitSha("c") }],
    [
      "post-push candidate query failure",
      {
        failAfterPushOn: `git ls-remote https://github.com/davidomil/cloudx ${GATE_B_CANDIDATE_REF}`,
      },
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

    expect(outcome).toEqual({
      outcome: "manual-reconciliation-required",
      pushAttempts: 1,
      retry: false,
      reviewPrHandoff: false,
    });
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

    expect(outcome).toEqual({
      outcome: "manual-reconciliation-required",
      pushAttempts: 1,
      retry: false,
      reviewPrHandoff: false,
    });
    expect(runner.pushes).toHaveLength(1);
  });

  it("publishes through an authenticated real smart-HTTP receive-pack", async () => {
    const integration = await smartHttpIntegrationFixture();
    const originalDirectory = process.cwd();
    const originalTemplate = process.env.GIT_TEMPLATE_DIR;
    const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    try {
      process.chdir(integration.sourceDirectory);
      process.env.GIT_TEMPLATE_DIR = integration.hostileTemplateDirectory;
      process.env.GIT_CONFIG_GLOBAL = integration.hostileGlobalConfig;

      const terminal = await publishGateBCandidateForLoopbackTest(
        {
          ...authorizationArguments(integration.fixture),
          artifactDir: integration.fixture.directory,
          authorizedManifestSha256: integration.fixture.manifestSha256,
          expectedOldHead: integration.fixture.oldHead,
          runCommand: integration.runCommand,
        },
        integration.transport,
      );

      expect(terminal).toEqual({
        outcome: "published",
        pushAttempts: 1,
        retry: false,
        reviewPrHandoff: true,
      });
      expect(integration.observations).toMatchObject({
        authenticatedRequests: expect.any(Number),
        backendProcesses: expect.any(Number),
        backendBeforeAuthentication: false,
        challengeWasExact: true,
        firstRequestHadAuthorization: false,
        receivePackPosts: 1,
        tokenMatched: true,
      });
      expect(integration.observations.authenticatedRequests).toBeGreaterThan(0);
      expect(integration.observations.backendProcesses).toBeGreaterThan(0);
      expect(
        execFileSync(
          "git",
          [
            `--git-dir=${integration.targetGitDirectory}`,
            "rev-parse",
            GATE_B_CANDIDATE_REF,
          ],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(integration.fixture.head);
      expect(
        execFileSync(
          "git",
          [
            `--git-dir=${integration.targetGitDirectory}`,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
          ],
          { encoding: "utf8" },
        )
          .trim()
          .split("\n"),
      ).toEqual([
        `${GATE_B_CANDIDATE_REF} ${integration.fixture.head}`,
        `${GATE_B_TARGET_BASE_REF} ${GATE_B_EXPECTED_TARGET_BASE_SHA}`,
      ]);
      expect(fs.existsSync(integration.hostileMarker)).toBe(false);
      expect(integration.observations.contextRoots).toHaveLength(1);
      expect(fs.existsSync(integration.observations.contextRoots[0])).toBe(
        false,
      );

      const durableCapture = JSON.stringify({
        calls: integration.observations.calls,
        terminal,
      });
      expect(durableCapture).not.toContain(integration.fixture.token);
      expect(durableCapture).not.toContain(digest(integration.fixture.token));
      expect(
        fs.readFileSync(integration.fixture.authorizationFile, "utf8"),
      ).not.toContain(integration.fixture.token);
    } finally {
      process.chdir(originalDirectory);
      restoreEnvironment("GIT_TEMPLATE_DIR", originalTemplate);
      restoreEnvironment("GIT_CONFIG_GLOBAL", originalGlobalConfig);
      await integration.dispose();
    }
  }, 30_000);
});

async function smartHttpIntegrationFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx-gate-b-http-integration-"),
  );
  const sourceDirectory = path.join(root, "source");
  execFileSync(
    "git",
    ["clone", "--quiet", "--no-hardlinks", process.cwd(), sourceDirectory],
    { stdio: "pipe" },
  );
  execFileSync("git", ["-C", sourceDirectory, "config", "user.name", "Gate B"]);
  execFileSync("git", [
    "-C",
    sourceDirectory,
    "config",
    "user.email",
    "gate-b@example.invalid",
  ]);
  execFileSync("git", [
    "-C",
    sourceDirectory,
    "checkout",
    "--quiet",
    "--detach",
    GATE_B_PLANNING_HEAD_SHA,
  ]);
  execFileSync("git", [
    "-C",
    sourceDirectory,
    "checkout",
    "--quiet",
    "-B",
    "architecture-and-new-codex",
  ]);
  execFileSync("git", [
    "-C",
    sourceDirectory,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "POLICY: isolate publication credentials and outcomes",
  ]);
  const candidateHead = execFileSync(
    "git",
    ["-C", sourceDirectory, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const fixture = gateBFixture({ head: candidateHead });

  const hostileMarker = path.join(root, "hostile-hook-ran");
  const hostileHooksDirectory = path.join(root, "hostile-hooks");
  const hostileTemplateDirectory = path.join(root, "hostile-template");
  fs.mkdirSync(hostileHooksDirectory);
  fs.mkdirSync(path.join(hostileTemplateDirectory, "hooks"), {
    recursive: true,
  });
  const hostileHook = `#!/bin/sh\nprintf hostile > ${JSON.stringify(hostileMarker)}\n`;
  fs.writeFileSync(path.join(hostileHooksDirectory, "pre-push"), hostileHook, {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(hostileTemplateDirectory, "hooks", "pre-push"),
    hostileHook,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(sourceDirectory, ".git", "hooks", "pre-push"),
    hostileHook,
    { mode: 0o755 },
  );
  execFileSync("git", [
    "-C",
    sourceDirectory,
    "remote",
    "set-url",
    "origin",
    "https://example.invalid/hostile.git",
  ]);
  const hostileGlobalConfig = path.join(root, "hostile-global-config");
  fs.writeFileSync(
    hostileGlobalConfig,
    `[credential]\n\thelper = store\n[http]\n\textraHeader = X-Hostile: true\n[core]\n\thooksPath = ${hostileHooksDirectory}\n[init]\n\ttemplateDir = ${hostileTemplateDirectory}\n`,
  );

  const serverRoot = path.join(root, "server");
  const emptyTargetTemplate = path.join(root, "empty-target-template");
  const targetGitDirectory = path.join(serverRoot, "cloudx.git");
  fs.mkdirSync(serverRoot);
  fs.mkdirSync(emptyTargetTemplate);
  execFileSync("git", [
    "init",
    "--quiet",
    "--bare",
    `--template=${emptyTargetTemplate}`,
    targetGitDirectory,
  ]);
  execFileSync("git", [
    `--git-dir=${targetGitDirectory}`,
    "fetch",
    "--quiet",
    "--no-tags",
    sourceDirectory,
    `${GATE_B_EXPECTED_TARGET_BASE_SHA}:${GATE_B_TARGET_BASE_REF}`,
    `${fixture.oldHead}:${GATE_B_CANDIDATE_REF}`,
  ]);

  const observations = {
    authenticatedRequests: 0,
    backendProcesses: 0,
    backendBeforeAuthentication: false,
    challengeWasExact: false,
    contextRoots: [],
    calls: [],
    firstRequestHadAuthorization: undefined,
    receivePackPosts: 0,
    tokenMatched: true,
  };
  const server = await startGitHttpBackendServer({
    observations,
    serverRoot,
    token: fixture.token,
  });
  const address = server.address();
  const transport = loopbackTransport(address.port);
  const runCommand = smartHttpCommandRunner({ fixture, observations });

  return {
    dispose: async () => {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(root, { force: true, recursive: true });
      fs.rmSync(path.dirname(fixture.directory), {
        force: true,
        recursive: true,
      });
    },
    fixture,
    hostileGlobalConfig,
    hostileMarker,
    hostileTemplateDirectory,
    observations,
    runCommand,
    sourceDirectory,
    targetGitDirectory,
    transport,
  };
}

function smartHttpCommandRunner({ fixture, observations }) {
  let pushed = false;
  return async (command, args, options = {}) => {
    const routed = command === "git" ? routedGitArguments(args) : args;
    const operation = routed[0] ?? "";
    const authenticated =
      command === "gh" ||
      (command === "git" && ["ls-remote", "push"].includes(operation));
    observations.calls.push({
      authenticated,
      command,
      operation,
      tokenMatched: authenticated
        ? options.env?.GH_TOKEN === fixture.token
        : options.env?.GH_TOKEN === undefined,
    });
    if (authenticated) {
      observations.tokenMatched &&= options.env?.GH_TOKEN === fixture.token;
    }
    if (command === "git" && operation === "init") {
      observations.contextRoots.push(path.dirname(routed.at(-1)));
    }
    if (command === "gh") {
      const signature = routed.join(" ");
      if (signature === "--version") return result("gh version 2.80.0\n");
      if (signature === "api --method GET /installation/repositories") {
        return result(
          `${JSON.stringify({
            total_count: 1,
            repositories: [{ full_name: GATE_B_REPOSITORY }],
          })}\n`,
        );
      }
      if (signature === "repo view davidomil/cloudx --json nameWithOwner") {
        return result(
          `${JSON.stringify({ nameWithOwner: GATE_B_REPOSITORY })}\n`,
        );
      }
      if (signature.startsWith("pr view 1 --repo davidomil/cloudx")) {
        return result(
          `${JSON.stringify({
            number: 1,
            state: "OPEN",
            baseRefName: "main",
            baseRefOid: GATE_B_EXPECTED_TARGET_BASE_SHA,
            headRefName: "architecture-and-new-codex",
            headRefOid: pushed ? fixture.head : fixture.oldHead,
            isCrossRepository: false,
            url: "https://github.com/davidomil/cloudx/pull/1",
          })}\n`,
        );
      }
      if (
        signature ===
        "api --method GET repos/davidomil/cloudx/branches/architecture-and-new-codex"
      ) {
        return result(
          `${JSON.stringify({
            name: "architecture-and-new-codex",
            commit: { sha: fixture.oldHead },
            protected: false,
          })}\n`,
        );
      }
      if (
        signature ===
        "api repos/davidomil/cloudx/rules/branches/architecture-and-new-codex"
      ) {
        return result("[]\n");
      }
      return result("", 1, "unexpected gh command");
    }

    const commandResult = await runTextProcess(command, args, options);
    if (
      command === "git" &&
      operation === "push" &&
      commandResult.exitCode === 0
    ) {
      pushed = true;
    }
    return commandResult;
  };
}

async function startGitHttpBackendServer({ observations, serverRoot, token }) {
  const expectedAuthorization = `Basic ${Buffer.from(
    `x-access-token:${token}`,
  ).toString("base64")}`;
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    try {
      requestCount += 1;
      const authorization = request.headers.authorization;
      if (requestCount === 1) {
        observations.firstRequestHadAuthorization = authorization !== undefined;
      }
      if (authorization !== expectedAuthorization) {
        request.resume();
        observations.tokenMatched &&= authorization === undefined;
        observations.challengeWasExact = true;
        response.writeHead(401, {
          "WWW-Authenticate": 'Basic realm="cloudx-gate-b-test"',
        });
        response.end();
        return;
      }

      observations.authenticatedRequests += 1;
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      if (
        request.method === "POST" &&
        requestUrl.pathname.endsWith("/git-receive-pack")
      ) {
        observations.receivePackPosts += 1;
      }
      const body = await readRequestBody(request);
      observations.backendBeforeAuthentication ||=
        observations.authenticatedRequests === 0;
      observations.backendProcesses += 1;
      const backend = await runBinaryProcess("git", ["http-backend"], {
        env: {
          CONTENT_LENGTH: String(body.length),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_PROJECT_ROOT: serverRoot,
          HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
          LANG: "C",
          LC_ALL: "C",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PATH_INFO: requestUrl.pathname,
          QUERY_STRING: requestUrl.search.slice(1),
          REMOTE_ADDR: "127.0.0.1",
          REMOTE_USER: "x-access-token",
          REQUEST_METHOD: request.method,
        },
        input: body,
      });
      if (backend.exitCode !== 0) {
        response.writeHead(500);
        response.end();
        return;
      }
      writeCgiResponse(response, backend.stdout);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function writeCgiResponse(response, bytes) {
  const crlfBoundary = bytes.indexOf("\r\n\r\n");
  const lfBoundary = bytes.indexOf("\n\n");
  const boundary = crlfBoundary >= 0 ? crlfBoundary : lfBoundary;
  const separatorLength = crlfBoundary >= 0 ? 4 : 2;
  if (boundary < 0) throw new Error("git http-backend response is malformed");
  const headers = bytes.subarray(0, boundary).toString("utf8").split(/\r?\n/u);
  for (const header of headers) {
    const separator = header.indexOf(":");
    const name = header.slice(0, separator);
    const value = header.slice(separator + 1).trim();
    if (name.toLowerCase() === "status") {
      response.statusCode = Number.parseInt(value, 10);
    } else {
      response.setHeader(name, value);
    }
  }
  response.end(bytes.subarray(boundary + separatorLength));
}

function runTextProcess(command, args, options = {}) {
  return runBinaryProcess(command, args, options).then((commandResult) => ({
    exitCode: commandResult.exitCode,
    stderr: commandResult.stderr.toString("utf8"),
    stdout: commandResult.stdout.toString("utf8"),
  }));
}

function runBinaryProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
    });
    child.on("close", (exitCode) =>
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      }),
    );
    child.stdin.end(options.input);
  });
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function gateBFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-gate-b-v18-"));
  const directory = path.join(root, "artifacts");
  fs.mkdirSync(directory);
  const head = overrides.head ?? gitSha("b");
  const oldHead = GATE_B_EXPECTED_OLD_CANDIDATE_SHA;
  const nowMs = Date.now();
  const plan = {
    schema_version: 1,
    kind: "change-plan",
    run_id: "gate-b-v18",
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
    claims: Array.from({ length: 75 }, (_, index) => ({
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
  fixture.token = "sentinel-gate-b-token-with-40-characters-001";
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
    credential_token_sha256: digest(fixture.token),
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
    const routedArgs = command === "git" ? routedGitArguments(args) : args;
    return `${command} ${routedArgs.join(" ")}`;
  });
}

function routedGitArguments(args) {
  const routed = [...args];
  if (routed[0]?.startsWith("--git-dir=")) routed.shift();
  while (routed[0] === "-c") routed.splice(0, 2);
  return routed;
}

function loopbackTransport(port, overrides = {}) {
  const hostname = overrides.hostname ?? "127.0.0.1";
  const portSuffix = port === undefined ? "" : `:${port}`;
  const descriptor = {
    credentialScope: {
      host: overrides.scopeHost ?? `${hostname}${portSuffix}`,
      path: overrides.scopePath ?? "cloudx.git",
    },
    protocol: "http",
    url: `http://${overrides.userinfo ?? ""}${hostname}${portSuffix}/${
      overrides.path ?? "cloudx.git"
    }${overrides.query ?? ""}${overrides.fragment ?? ""}`,
    ...(overrides.extra ? { fallback: "forbidden" } : {}),
  };
  if (overrides.freeze === false) return descriptor;
  Object.freeze(descriptor.credentialScope);
  return Object.freeze(descriptor);
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
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const routed = [...args];
if (command === "git" && routed[0]?.startsWith("--git-dir=")) routed.shift();
while (command === "git" && routed[0] === "-c") routed.splice(0, 2);
const operation = routed[0] ?? "";
const token = process.env.GH_TOKEN ?? "";
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
  command,
  args,
  operation,
  tokenPresent: token.length >= 32,
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
  if (operation === "init") {
    const directory = routed.at(-1);
    fs.mkdirSync(path.join(directory, "objects"), { recursive: true });
    fs.mkdirSync(path.join(directory, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(directory, "config"), "[core]\\n\\trepositoryformatversion = 0\\n\\tfilemode = true\\n\\tbare = true\\n");
  }
  else if (operation === "config") output("core.repositoryformatversion\\n0\\0core.filemode\\ntrue\\0core.bare\\ntrue\\0");
  else if (operation === "fetch") {}
  else if (operation === "rev-parse" && routed[1] === "--absolute-git-dir") output(${JSON.stringify(path.join(fixture.directory, ".git"))} + "\\n");
  else if (operation === "rev-parse") output(head + "\\n");
  else if (operation === "symbolic-ref" && routed[1] === "--short") output("architecture-and-new-codex\\n");
  else if (operation === "symbolic-ref") {}
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
        CLOUDX_GATE_B_TRANSPORT: "loopback",
        CLOUDX_GATE_B_URL: "http://127.0.0.1:9/cloudx.git",
        CLOUDX_GATE_B_TOKEN: fixture.token,
        GH_CONFIG_DIR: "/ambient/gh",
        GH_TOKEN: "ambient-gh-token",
        GIT_ASKPASS: "/ambient/askpass",
        GIT_CONFIG_GLOBAL: "/ambient/gitconfig",
        GIT_REMOTE_URL: "https://example.invalid/cloudx",
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
    const routedArgs = command === "git" ? routedGitArguments(args) : args;
    const signature = `${command} ${routedArgs.join(" ")}`;
    if (overrides.throwOn === signature) throw new Error("runner failed");
    if (overrides.failOn === signature) return result("", 1, "failed");
    if (overrides.malformedOn === signature) return {};
    if (pushed && overrides.throwAfterPushOn === signature)
      throw new Error("post-push runner failed");
    if (pushed && overrides.failAfterPushOn === signature)
      return result("", 1, "post-push failed");
    if (signature.startsWith("git init --bare --template=")) {
      const directory = routedArgs.at(-1);
      fs.mkdirSync(path.join(directory, "objects"), { recursive: true });
      fs.mkdirSync(path.join(directory, "refs", "heads"), { recursive: true });
      fs.writeFileSync(
        path.join(directory, "config"),
        "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n",
      );
      return result();
    }
    if (signature === "git config --local --null --list") {
      return result(
        "core.repositoryformatversion\n0\0core.filemode\ntrue\0core.bare\ntrue\0",
      );
    }
    if (signature.startsWith("git fetch --no-tags ")) return result();
    if (signature === `git symbolic-ref HEAD ${GATE_B_CANDIDATE_REF}`)
      return result();
    if (signature === `git rev-parse ${GATE_B_CANDIDATE_REF}`)
      return result(fixture.head);
    if (signature === "git rev-parse --absolute-git-dir")
      return result(path.join(fixture.directory, ".git"));
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
    if (
      signature ===
      `git ls-remote https://github.com/davidomil/cloudx ${GATE_B_TARGET_BASE_REF}`
    ) {
      const head = pushed
        ? (overrides.postPushTargetBase ?? GATE_B_EXPECTED_TARGET_BASE_SHA)
        : (overrides.remoteTargetBase ?? GATE_B_EXPECTED_TARGET_BASE_SHA);
      const ref = overrides.targetBaseRef ?? GATE_B_TARGET_BASE_REF;
      return result(overrides.targetBaseOutput ?? `${head}\t${ref}\n`);
    }
    if (
      signature ===
      `git ls-remote https://github.com/davidomil/cloudx ${GATE_B_CANDIDATE_REF}`
    ) {
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
      `git push --no-verify --porcelain --force-with-lease=${GATE_B_CANDIDATE_REF}:${fixture.oldHead} https://github.com/davidomil/cloudx HEAD:refs/heads/architecture-and-new-codex`
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

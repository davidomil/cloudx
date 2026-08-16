import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalPublicationAuthorization,
  publishGateBCandidate,
  publishGateBCandidateForDirectTest as publishCandidateForDirectTest,
  readGateBArtifactSnapshot,
  validateTrustedExecutablesForDirectTest,
} from "./publish-gate-b.mjs";
import * as gateBPublisher from "./publish-gate-b.mjs";
import {
  GATE_B_ALLOWED_PATH_COUNT,
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
import { displayCommand, verificationPlan } from "./verify.mjs";

const gitSha = (character) => character.repeat(40);
const sha = (character) => character.repeat(64);
const directTestTransport = loopbackTransport(41_099);
const expectedCredentialFreeGitEnvironment = {
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "/bin/false",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
  NO_COLOR: "1",
  PATH: "/usr/bin:/bin",
  SSH_ASKPASS: "/bin/false",
};
const publishGateBCandidateForDirectTest = (
  options,
  transport = directTestTransport,
) => publishCandidateForDirectTest(options, transport);

describe("Gate B candidate publisher", () => {
  it("awaits private runner process-group exhaustion without exposing a token", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cloudx-gate-b-runner-"),
    );
    const pidFile = path.join(directory, "descendant.pid");
    const secret = "gate-b-test-token-that-must-never-appear-0123456789";
    const childSource = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;
    const leaderSource = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;
    let processGroup;
    try {
      const run = gateBPublisher.runGateBCommandForDirectTest(
        process.execPath,
        ["-e", leaderSource],
        { env: { ...process.env, GH_TOKEN: secret }, timeoutMs: 2_000 },
      );
      processGroup = await recordedProcessGroup(pidFile);
      const result = await run;

      expect(result.exitCode).toBe(1);
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.stderr).toBe("string");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(await processGroupHasRunningMember(processGroup)).toBe(false);
    } finally {
      if (processGroup) await terminateProcessGroup(processGroup);
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails closed after a leader exits with a live descendant or spawn fails", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cloudx-gate-b-leader-exit-"),
    );
    const pidFile = path.join(directory, "descendant.pid");
    const secret = "gate-b-leader-exit-token-that-must-not-appear-0123456789";
    const descendantSource = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;
    const leaderSource = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
setTimeout(() => process.exit(0), 100);
`;
    let processGroup;
    try {
      const run = gateBPublisher.runGateBCommandForDirectTest(
        process.execPath,
        ["-e", leaderSource],
        { env: { ...process.env, GH_TOKEN: secret } },
      );
      processGroup = await recordedProcessGroup(pidFile);
      await expect(run).resolves.toEqual({
        stdout: "",
        stderr: "",
        exitCode: 1,
      });
      expect(await processGroupHasRunningMember(processGroup)).toBe(false);

      const spawnFailure = await gateBPublisher.runGateBCommandForDirectTest(
        path.join(directory, "missing-executable"),
        [secret],
        { env: { ...process.env, GH_TOKEN: secret } },
      );
      expect(spawnFailure).toEqual({ stdout: "", stderr: "", exitCode: 1 });
      expect(JSON.stringify(spawnFailure)).not.toContain(secret);
    } finally {
      if (processGroup) await terminateProcessGroup(processGroup);
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps the private runner's output type and independent two-MiB stream bounds", async () => {
    const limit = 2 * 1024 * 1024;
    const exact = await gateBPublisher.runGateBCommandForDirectTest(
      process.execPath,
      [
        "-e",
        `process.stdout.write(Buffer.alloc(${limit}, 0x61)); process.stderr.write(Buffer.alloc(${limit}, 0x62));`,
      ],
    );
    expect(exact).toEqual({
      stdout: "a".repeat(limit),
      stderr: "b".repeat(limit),
      exitCode: 0,
    });

    const binary = await gateBPublisher.runGateBCommandForDirectTest(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0xff, 0x00, 0x61]));"],
      { encoding: "buffer" },
    );
    expect(binary).toEqual({
      stdout: Buffer.from([0xff, 0x00, 0x61]),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    });

    const multibyte = await gateBPublisher.runGateBCommandForDirectTest(
      process.execPath,
      [
        "-e",
        `process.stdout.write(Buffer.alloc(${limit - 3}, 0x61), () => { process.stdout.write(Buffer.from([0xe2])); setImmediate(() => process.stdout.write(Buffer.from([0x82, 0xac]))); });`,
      ],
    );
    expect(multibyte.exitCode).toBe(0);
    expect(Buffer.byteLength(multibyte.stdout)).toBe(limit);
    expect(multibyte.stdout.endsWith("€")).toBe(true);

    for (const stream of ["stdout", "stderr"]) {
      const overflow = await gateBPublisher.runGateBCommandForDirectTest(
        process.execPath,
        [
          "-e",
          `process.${stream}.write(Buffer.alloc(${limit + 1}, 0x63)); setInterval(() => {}, 1000);`,
        ],
      );
      expect(overflow).toEqual({ stdout: "", stderr: "", exitCode: 1 });
    }
  }, 15_000);

  it("requires the complete ordered eleven-subject candidate history", () => {
    expect(GATE_B_COMMIT_SUBJECTS).toEqual([
      "WORKSPACE: make server workspace commands atomic",
      "AUTOMATION: persist trigger delivery and cancellation state",
      "DOCUMENTATION: publish bounded atomic archive ingestion",
      "ASR: bound inference workers and service readiness",
      "SERVER: make readiness and shutdown lifecycle explicit",
      "INSTALLER: unify reproducible local service setup",
      "DOCS: align operator and scoped-agent contracts",
      "POLICY: separate candidate publication from live-head review",
      "POLICY: bind publication authorization and candidate lease",
      "POLICY: isolate publication credentials and outcomes",
      "POLICY: harden Gate B publication boundary",
    ]);
  });

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
    expect(schema.properties.credential_mode).toEqual({
      const: "attended-user",
    });
    expect(schema.properties.principal).toEqual({
      $ref: "#/$defs/attendedUserPrincipal",
    });
    expect(schema.$defs.automatedAppPrincipal).toBeUndefined();
  });

  it("v18 returns only the closed published terminal result", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture);

    const result = await publishGateBCandidateForDirectTest({
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
    expect(runner.committedHeadReads).toBe(2);
    expect(runner.committedDiffReads).toBe(2);

    const committedDiffCalls = runner.calls.filter(
      ([, args]) => args[0] === "diff" && args[1] === "--name-only",
    );
    const committedHeadCalls = runner.calls.filter(
      ([, args, options]) =>
        args.join(" ") === "rev-parse HEAD" &&
        options.env &&
        !Object.hasOwn(options.env, "HOME"),
    );
    expect(committedHeadCalls).toHaveLength(2);
    for (const [command, args, options] of committedHeadCalls) {
      expect(command).toBe("git");
      expect(args).toEqual(["rev-parse", "HEAD"]);
      expect(options).toEqual({
        cwd: process.cwd(),
        env: expectedCredentialFreeGitEnvironment,
      });
    }
    expect(committedDiffCalls).toHaveLength(2);
    for (const [command, args, options] of committedDiffCalls) {
      expect(command).toBe("git");
      expect(args).toEqual([
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        `${GATE_B_LOCAL_CHANGE_BASE_SHA}..${fixture.head}`,
        "--",
      ]);
      expect(options).toEqual({
        cwd: process.cwd(),
        encoding: "buffer",
        env: expectedCredentialFreeGitEnvironment,
      });
    }
    for (const [, args, options] of runner.calls) {
      if (args[0] !== "diff" || args[1] !== "--name-only") {
        expect(options.encoding).toBeUndefined();
      }
    }
  });

  it("rejects the obsolete 113-path bundle before token or process use", async () => {
    const fixture = gateBFixture();
    fixture.mutate("plan.json", (plan) => {
      plan.allowed_paths = plan.allowed_paths.slice(0, 113);
    });
    const runner = commandRunner(fixture);
    const readToken = vi.fn(() => fixture.token);

    await expect(
      publishGateBCandidateForDirectTest({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: readableManifestOrOriginal(fixture),
        expectedOldHead: fixture.oldHead,
        readToken,
        runCommand: runner.run,
      }),
    ).rejects.toThrow(
      `Gate B plan allowed path count must equal ${GATE_B_ALLOWED_PATH_COUNT}.`,
    );

    expect(readToken).not.toHaveBeenCalled();
    expect(runner.calls).toEqual([]);
    expect(runner.pushes).toEqual([]);
  });

  it.each([
    [
      "missing",
      (fixture) => committedDiffOutput(fixture, fixture.allowedPaths.slice(1)),
    ],
    [
      "extra",
      (fixture) =>
        committedDiffOutput(fixture, [
          ...fixture.allowedPaths,
          "apps/server/src/unreviewed.ts",
        ]),
    ],
    [
      "duplicate",
      (fixture) =>
        committedDiffOutput(fixture, [
          ...fixture.allowedPaths,
          fixture.allowedPaths[0],
        ]),
    ],
    [
      "renamed as one endpoint",
      (fixture) =>
        committedDiffOutput(fixture, fixture.allowedPaths.slice(0, -1)),
    ],
    [
      "newline-containing",
      (fixture) =>
        committedDiffOutput(fixture, [
          `${fixture.allowedPaths[0]}\nother`,
          ...fixture.allowedPaths.slice(1),
        ]),
    ],
    [
      "absolute",
      (fixture) =>
        committedDiffOutput(fixture, [
          "/apps/server/src/gate-b-1.ts",
          ...fixture.allowedPaths.slice(1),
        ]),
    ],
    [
      "traversal",
      (fixture) =>
        committedDiffOutput(fixture, [
          "apps/server/../gate-b-1.ts",
          ...fixture.allowedPaths.slice(1),
        ]),
    ],
    [
      "unterminated NUL",
      (fixture) => Buffer.from(fixture.allowedPaths.join("\0")),
    ],
    [
      "empty NUL field",
      (fixture) =>
        Buffer.from(
          `${fixture.allowedPaths[0]}\0\0${fixture.allowedPaths.slice(1).join("\0")}\0`,
        ),
    ],
    ["invalid UTF-8", () => Buffer.from([0xff, 0x00])],
    ["oversized", () => Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)],
  ])(
    "rejects a %s initial committed diff before token or authenticated work",
    async (_name, committedDiff) => {
      const fixture = gateBFixture();
      const runner = commandRunner(fixture, {
        initialCommittedDiff: committedDiff(fixture),
      });
      const readToken = vi.fn(() => fixture.token);

      await expect(
        publishGateBCandidateForDirectTest({
          ...authorizationArguments(fixture),
          artifactDir: fixture.directory,
          authorizedManifestSha256: fixture.manifestSha256,
          expectedOldHead: fixture.oldHead,
          readToken,
          runCommand: runner.run,
        }),
      ).rejects.toThrow();

      expect(readToken).not.toHaveBeenCalled();
      expect(runner.committedDiffReads).toBe(1);
      expect(commandSignatures(runner.calls)).not.toContainEqual(
        expect.stringMatching(/^(?:gh|git init) /u),
      );
      expect(runner.pushes).toEqual([]);
    },
  );

  it("preserves a leading UTF-8 BOM as committed pathname identity", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, {
      initialCommittedDiff: committedDiffOutput(fixture, [
        `\uFEFF${fixture.allowedPaths[0]}`,
        ...fixture.allowedPaths.slice(1),
      ]),
    });
    const readToken = vi.fn(() => fixture.token);

    await expect(
      publishGateBCandidateForDirectTest({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        readToken,
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/committed diff paths/i);

    expect(readToken).not.toHaveBeenCalled();
    expect(runner.committedDiffReads).toBe(1);
    expect(runner.pushes).toEqual([]);
  });

  it("admits an exactly declared leading-BOM committed pathname", async () => {
    const allowedPaths = Array.from(
      { length: GATE_B_ALLOWED_PATH_COUNT },
      (_, index) =>
        index === 0
          ? "\uFEFFapps/server/src/gate-b-1.ts"
          : `apps/server/src/gate-b-${index + 1}.ts`,
    );
    const fixture = gateBFixture({ allowedPaths });
    const runner = commandRunner(fixture);

    await expect(
      publishGateBCandidateForDirectTest({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        runCommand: runner.run,
      }),
    ).resolves.toEqual({
      outcome: "published",
      pushAttempts: 1,
      retry: false,
      reviewPrHandoff: true,
    });

    expect(runner.committedDiffReads).toBe(2);
    expect(runner.pushes).toHaveLength(1);
  });

  it("rejects a wrong committed HEAD before token or authenticated work", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, {
      initialCommittedHead: gitSha("c"),
    });
    const readToken = vi.fn(() => fixture.token);

    await expect(
      publishGateBCandidateForDirectTest({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        readToken,
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/committed-diff local head/i);

    expect(readToken).not.toHaveBeenCalled();
    expect(runner.committedDiffReads).toBe(0);
    expect(runner.pushes).toEqual([]);
  });

  it("rejects a committed-diff command failure before token", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, { committedDiffExitCode: 1 });
    const readToken = vi.fn(() => fixture.token);

    await expect(
      publishGateBCandidateForDirectTest({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        readToken,
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/committed-diff command failed/i);

    expect(readToken).not.toHaveBeenCalled();
    expect(runner.pushes).toEqual([]);
  });

  it("uses the actual default runner Buffer path and fatal UTF-8 decoder", async () => {
    const fixture = gateBFixture();
    const executable = committedDiffExecutable(fixture, Buffer.from([0xff, 0]));
    const readToken = vi.fn(() => fixture.token);

    await expect(
      publishGateBCandidateForDirectTest({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        executables: { git: executable, gh: executable },
        expectedOldHead: fixture.oldHead,
        readToken,
      }),
    ).rejects.toThrow(/valid UTF-8/i);

    expect(readToken).not.toHaveBeenCalled();
  });

  it("keeps actual default-runner normal commands string-only", async () => {
    const fixture = gateBFixture();
    const executable = committedDiffExecutable(
      fixture,
      committedDiffOutput(fixture),
    );
    const readToken = vi.fn(() => "short");

    await expect(
      publishGateBCandidateForDirectTest({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        executables: { git: executable, gh: executable },
        expectedOldHead: fixture.oldHead,
        readToken,
      }),
    ).rejects.toThrow(/high-entropy CLOUDX_GATE_B_TOKEN/i);

    expect(readToken).toHaveBeenCalledOnce();
  });

  it("rechecks the committed diff immediately before push", async () => {
    const fixture = gateBFixture();
    const runner = commandRunner(fixture, {
      freshCommittedDiff: committedDiffOutput(
        fixture,
        fixture.allowedPaths.slice(1),
      ),
    });
    const readToken = vi.fn(() => fixture.token);

    await expect(
      publishGateBCandidateForDirectTest({
        ...authorizationArguments(fixture),
        artifactDir: fixture.directory,
        authorizedManifestSha256: fixture.manifestSha256,
        expectedOldHead: fixture.oldHead,
        readToken,
        runCommand: runner.run,
      }),
    ).rejects.toThrow(/committed diff paths/i);

    expect(readToken).toHaveBeenCalledOnce();
    expect(runner.committedDiffReads).toBe(2);
    expect(commandSignatures(runner.calls)).toContain(
      "gh api repos/davidomil/cloudx/rules/branches/architecture-and-new-codex",
    );
    expect(runner.pushes).toEqual([]);
  });

  it("rejects a token fingerprint mismatch after credential-free candidate admission", async () => {
    const fixture = gateBFixture();
    fixture.authorization.credential_token_sha256 = sha("9");
    writeCanonicalAuthorization(fixture);
    const runner = commandRunner(fixture);
    let tokenReads = 0;

    await expect(
      publishGateBCandidateForDirectTest({
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
    expect(runner.committedDiffReads).toBe(1);
    expect(commandSignatures(runner.calls)).toEqual([
      "git rev-parse HEAD",
      committedDiffSignature(fixture),
    ]);
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

  it("requires an explicit loopback transport before accepting direct-test dependencies", () => {
    const readToken = vi.fn();
    const runCommand = vi.fn();

    expect(() =>
      publishCandidateForDirectTest({ readToken, runCommand }),
    ).toThrow(/transport|loopback/i);
    expect(readToken).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["runner", { runCommand: () => undefined }],
    ["Git executable", { gitExecutable: "/tmp/git" }],
    ["GitHub executable", { ghExecutable: "/tmp/gh" }],
    ["clock", { now: () => Date.now() }],
    ["token reader", { readToken: () => "x".repeat(40) }],
    ["cleanup", { removeDirectory: () => undefined }],
  ])(
    "rejects a production %s selector before token or process use",
    (_name, selector) => {
      const fixture = gateBFixture();
      expect(() =>
        publishGateBCandidate({
          artifactDir: fixture.directory,
          authorizedManifestSha256: fixture.manifestSha256,
          authorizationFile: fixture.authorizationFile,
          authorizedPublicationSha256: fixture.authorizedPublicationSha256,
          credentialMode: fixture.credentialMode,
          expectedOldHead: fixture.oldHead,
          ...selector,
        }),
      ).toThrow(/closed contract/i);
    },
  );

  it.each([
    ["missing", { missing: "/usr/bin/git" }],
    ["linked", { mutate: ["/usr/bin/git", { symbolicLink: true }] }],
    ["nonregular", { mutate: ["/usr/bin/git", { kind: "directory" }] }],
    ["non-root-owned", { mutate: ["/usr/bin/git", { uid: 1000n }] }],
    ["group-writable", { mutate: ["/usr/bin/git", { mode: 0o100775n }] }],
    ["nonexecutable", { mutate: ["/usr/bin/git", { mode: 0o100644n }] }],
    ["identity-drifted", { drift: "/usr/bin/git" }],
  ])("rejects a %s fixed executable path", (_name, behavior) => {
    const fileSystem = trustedExecutableFileSystem(behavior);
    expect(() =>
      validateTrustedExecutablesForDirectTest(
        { git: "/usr/bin/git", gh: "/usr/bin/gh" },
        fileSystem,
      ),
    ).toThrow();
    expect(fileSystem.tokenReads).toBe(0);
    expect(fileSystem.processes).toBe(0);
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
    [
      "production GitHub descriptor",
      Object.freeze({
        credentialScope: Object.freeze({
          host: "github.com",
          path: "davidomil/cloudx",
        }),
        protocol: "https",
        url: "https://github.com/davidomil/cloudx",
      }),
    ],
  ])("rejects a %s loopback test transport", (_name, transport) => {
    expect(() => publishGateBCandidateForDirectTest({}, transport)).toThrow(
      /loopback|frozen closed/i,
    );
  });

  it("turns post-push cleanup uncertainty into only manual reconciliation", async () => {
    for (const pushResult of [undefined, result("", 1, "failed")]) {
      const fixture = gateBFixture();
      const runner = commandRunner(fixture, { pushResult });
      let cleanupCalls = 0;
      let contextRoot;

      const terminal = await publishGateBCandidateForDirectTest({
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
      publishGateBCandidateForDirectTest({
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
      publishGateBCandidateForDirectTest({
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
      (authorization) =>
        (authorization.principal = {
          kind: "github-app-installation",
          app_id: 1001,
        }),
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

    const result = await publishGateBCandidateForDirectTest({
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
      publishGateBCandidateForDirectTest({
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

    const result = await publishGateBCandidateForDirectTest({
      ...authorizationArguments(fixture),
      artifactDir: fixture.directory,
      authorizedManifestSha256: fixture.manifestSha256,
      expectedOldHead: fixture.oldHead,
      runCommand: runner.run,
    });

    expect(result.outcome).toBe("published");
  });

  it("rejects automated-app in the spawned CLI without consulting hostile PATH shims", () => {
    const fixture = gateBFixture();
    fixture.credentialMode = "automated-app";
    const spawned = spawnedPublisherFixture(fixture);

    const result = spawnPublisher(fixture, spawned);

    expect(result.status).not.toBe(0);
    expect(readShimCalls(spawned)).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Gate B publication rejected before push.\n");
    expect(fs.readFileSync(spawned.logFile, "utf8")).not.toContain(
      fixture.token,
    );
  });

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
    fixture.credentialMode = "automated-app";

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
        publishGateBCandidateForDirectTest({
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

    const result = await publishGateBCandidateForDirectTest({
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

    const result = await publishGateBCandidateForDirectTest({
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
      directTestTransport.url,
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

  it("enumerates exactly the canonical 15 names before any artifact content read", () => {
    const fixture = gateBFixture();
    fs.writeFileSync(path.join(fixture.directory, "sixteenth.json"), "{}\n");
    const read = vi.spyOn(fs, "readSync");
    try {
      expect(() => readGateBArtifactSnapshot(fixture.directory)).toThrow(
        /filenames|entries|15/i,
      );
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it.each([
    [
      "same-size in-place rewrite",
      (filePath, bytes) =>
        fs.writeFileSync(filePath, Buffer.alloc(bytes.length, 65)),
    ],
    ["growth", (filePath) => fs.appendFileSync(filePath, "growth")],
    [
      "replacement",
      (filePath, bytes) => {
        const replacement = `${filePath}.replacement`;
        fs.writeFileSync(replacement, bytes);
        fs.renameSync(replacement, filePath);
      },
    ],
  ])("rejects a %s during a stable descriptor read", (_name, mutate) => {
    const fixture = gateBFixture();
    const filePath = path.join(fixture.directory, "implementation.json");
    const bytes = fs.readFileSync(filePath);
    const originalRead = fs.readSync;
    let changed = false;
    const read = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const count = originalRead(...args);
      if (!changed && count > 0) {
        changed = true;
        mutate(filePath, bytes);
      }
      return count;
    });
    try {
      expect(() => readGateBArtifactSnapshot(fixture.directory)).toThrow(
        /changed|stable|size|identity/i,
      );
    } finally {
      read.mockRestore();
    }
  });

  it("rejects a short descriptor read and closes every opened file exactly once", () => {
    const fixture = gateBFixture();
    const read = vi.spyOn(fs, "readSync").mockReturnValue(0);
    const close = vi.spyOn(fs, "closeSync");
    try {
      expect(() => readGateBArtifactSnapshot(fixture.directory)).toThrow(
        /short read|EOF/i,
      );
      expect(
        new Set(close.mock.calls.map(([descriptor]) => descriptor)).size,
      ).toBe(close.mock.calls.length);
      expect(close).toHaveBeenCalledTimes(15);
    } finally {
      close.mockRestore();
      read.mockRestore();
    }
  });

  it.each([
    ["per-file", 0, 1024 * 1024 + 1],
    ["aggregate", 9, 1024 * 1024],
  ])(
    "rejects %s artifact byte overflow before allocation or read",
    (_name, count, size) => {
      const fixture = gateBFixture();
      const names = fs.readdirSync(fixture.directory).sort();
      for (const name of names.slice(0, count || 1)) {
        fs.truncateSync(path.join(fixture.directory, name), size);
      }
      const read = vi.spyOn(fs, "readSync");
      const allocate = vi.spyOn(Buffer, "alloc");
      try {
        expect(() => readGateBArtifactSnapshot(fixture.directory)).toThrow(
          /1 MiB|8 MiB|size|aggregate/i,
        );
        expect(read).not.toHaveBeenCalled();
        expect(allocate).not.toHaveBeenCalled();
      } finally {
        allocate.mockRestore();
        read.mockRestore();
      }
    },
  );

  it.each(["symlink", "directory"])("rejects a %s artifact entry", (kind) => {
    const fixture = gateBFixture();
    const filePath = path.join(fixture.directory, "implementation.json");
    fs.rmSync(filePath);
    if (kind === "symlink") fs.symlinkSync("plan.json", filePath);
    else fs.mkdirSync(filePath);
    expect(() => readGateBArtifactSnapshot(fixture.directory)).toThrow(
      /regular file|nonsymlink/i,
    );
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
        publishGateBCandidateForDirectTest({
          ...authorizationArguments(fixture),
          artifactDir: fixture.directory,
          authorizedManifestSha256: readableManifestOrOriginal(fixture),
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
      publishGateBCandidateForDirectTest({
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
      publishGateBCandidateForDirectTest({
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
      publishGateBCandidateForDirectTest({
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
        failOn: `git ls-remote ${directTestTransport.url} ${GATE_B_TARGET_BASE_REF}`,
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
        failOn: `git ls-remote ${directTestTransport.url} ${GATE_B_CANDIDATE_REF}`,
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
      publishGateBCandidateForDirectTest({
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
      publishGateBCandidateForDirectTest({
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
        failAfterPushOn: `git ls-remote ${directTestTransport.url} ${GATE_B_TARGET_BASE_REF}`,
      },
    ],
    ["post-push target OID mismatch", { postPushTargetBase: gitSha("c") }],
    [
      "post-push candidate query failure",
      {
        failAfterPushOn: `git ls-remote ${directTestTransport.url} ${GATE_B_CANDIDATE_REF}`,
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

    const outcome = await publishGateBCandidateForDirectTest({
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

    const outcome = await publishGateBCandidateForDirectTest({
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

  it("publishes the unreplaced object graph through authenticated smart HTTP", async () => {
    const integration = await smartHttpIntegrationFixture();
    const originalDirectory = process.cwd();
    const originalTemplate = process.env.GIT_TEMPLATE_DIR;
    const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    try {
      process.chdir(integration.sourceDirectory);
      process.env.GIT_TEMPLATE_DIR = integration.hostileTemplateDirectory;
      process.env.GIT_CONFIG_GLOBAL = integration.hostileGlobalConfig;

      expect(
        execFileSync(
          "git",
          [
            "-C",
            integration.sourceDirectory,
            "show",
            "-s",
            "--format=%s",
            "HEAD",
          ],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("HOSTILE REPLACEMENT");
      expect(
        execFileSync(
          "git",
          [
            "-C",
            integration.sourceDirectory,
            "show",
            "-s",
            "--format=%s",
            "HEAD",
          ],
          {
            encoding: "utf8",
            env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
          },
        ).trim(),
      ).toBe(GATE_B_COMMIT_SUBJECTS.at(-1));

      const terminal = await publishGateBCandidateForDirectTest(
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
            "show",
            "-s",
            "--format=%s",
            GATE_B_CANDIDATE_REF,
          ],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(GATE_B_COMMIT_SUBJECTS.at(-1));
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
      const sourceReadsAndImport = integration.observations.calls.filter(
        ({ command, operation, sourceRepository }) =>
          command === "git" && (sourceRepository || operation === "fetch"),
      );
      expect(sourceReadsAndImport.length).toBeGreaterThan(0);
      expect(sourceReadsAndImport).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "diff" }),
          expect.objectContaining({ operation: "fetch" }),
          expect.objectContaining({ operation: "log" }),
          expect.objectContaining({ operation: "rev-parse" }),
        ]),
      );
      for (const call of sourceReadsAndImport) {
        expect(call.noReplaceObjects).toBe(true);
      }

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
  const candidateHead = execFileSync(
    "git",
    ["-C", sourceDirectory, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const allowedPaths = execFileSync("git", [
    "-C",
    sourceDirectory,
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    `${GATE_B_LOCAL_CHANGE_BASE_SHA}..${candidateHead}`,
    "--",
  ])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  expect(allowedPaths).toHaveLength(GATE_B_ALLOWED_PATH_COUNT);
  const fixture = gateBFixture({ allowedPaths, head: candidateHead });
  const replacementTree = execFileSync(
    "git",
    [
      "-C",
      sourceDirectory,
      "rev-parse",
      `${GATE_B_LOCAL_CHANGE_BASE_SHA}^{tree}`,
    ],
    { encoding: "utf8" },
  ).trim();
  const replacementCommit = execFileSync(
    "git",
    [
      "-C",
      sourceDirectory,
      "commit-tree",
      replacementTree,
      "-p",
      GATE_B_LOCAL_CHANGE_BASE_SHA,
    ],
    { encoding: "utf8", input: "HOSTILE REPLACEMENT\n" },
  ).trim();
  execFileSync("git", [
    "-C",
    sourceDirectory,
    "replace",
    candidateHead,
    replacementCommit,
  ]);

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
      noReplaceObjects: options.env?.GIT_NO_REPLACE_OBJECTS === "1",
      operation,
      sourceRepository: options.cwd === process.cwd(),
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
      if (signature === "api --method GET /user") {
        return result(
          `${JSON.stringify({ id: 3003, login: "cloudx-operator" })}\n`,
        );
      }
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

    const commandResult =
      options.encoding === "buffer"
        ? await runBinaryProcess(command, args, options)
        : await runTextProcess(command, args, options);
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
  const allowedPaths =
    overrides.allowedPaths ??
    Array.from(
      { length: GATE_B_ALLOWED_PATH_COUNT },
      (_, index) => `apps/server/src/gate-b-${index + 1}.ts`,
    );
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
    allowed_paths: [...allowedPaths],
    forbidden_paths: [".github/**"],
    verification: verificationPlan("full").map(displayCommand),
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
    allowedPaths: Object.freeze([...plan.allowed_paths].sort()),
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
  fixture.credentialMode = "attended-user";
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
    credential_mode: "attended-user",
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
    principal: {
      kind: "github-user",
      user_id: 3003,
      login: "cloudx-operator",
      attended_authorization_id: "attended-grant-1",
    },
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
    publishGateBCandidateForDirectTest({
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
  let committedHeadReads = 0;
  let committedDiffReads = 0;
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
    calls.push([command, args, options]);
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
    if (signature === "git rev-parse HEAD") {
      if (options.env && !Object.hasOwn(options.env, "HOME")) {
        committedHeadReads += 1;
        return result(
          committedHeadReads === 1
            ? (overrides.initialCommittedHead ?? fixture.head)
            : (overrides.freshCommittedHead ?? fixture.head),
        );
      }
      return result(fixture.head);
    }
    if (signature === committedDiffSignature(fixture)) {
      committedDiffReads += 1;
      if (options.encoding !== "buffer") {
        throw new Error("Committed diff must request Buffer output.");
      }
      const value =
        committedDiffReads === 1
          ? (overrides.initialCommittedDiff ?? committedDiffOutput(fixture))
          : (overrides.freshCommittedDiff ?? committedDiffOutput(fixture));
      return binaryResult(
        value,
        overrides.committedDiffExitCode ?? 0,
        overrides.committedDiffStderr,
      );
    }
    if (options.encoding === "buffer") {
      throw new Error(
        "Only committed-diff commands may request Buffer output.",
      );
    }
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
      `git ls-remote ${directTestTransport.url} ${GATE_B_TARGET_BASE_REF}`
    ) {
      const head = pushed
        ? (overrides.postPushTargetBase ?? GATE_B_EXPECTED_TARGET_BASE_SHA)
        : (overrides.remoteTargetBase ?? GATE_B_EXPECTED_TARGET_BASE_SHA);
      const ref = overrides.targetBaseRef ?? GATE_B_TARGET_BASE_REF;
      return result(overrides.targetBaseOutput ?? `${head}\t${ref}\n`);
    }
    if (
      signature ===
      `git ls-remote ${directTestTransport.url} ${GATE_B_CANDIDATE_REF}`
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
      `git push --no-verify --porcelain --force-with-lease=${GATE_B_CANDIDATE_REF}:${fixture.oldHead} ${directTestTransport.url} HEAD:refs/heads/architecture-and-new-codex`
    ) {
      pushes.push([command, args]);
      pushed = true;
      overrides.afterPush?.();
      if (overrides.pushThrows) throw new Error("push transport failed");
      const pushFlag = overrides.pushOutput ?? " ";
      const pushSummary =
        overrides.pushSummary ?? `${fixture.oldHead}..${fixture.head}`;
      const pushStdout = `To ${directTestTransport.url}\n${pushFlag}\tHEAD:${GATE_B_CANDIDATE_REF}\t${pushSummary}\n${
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
  return {
    calls,
    get committedHeadReads() {
      return committedHeadReads;
    },
    get committedDiffReads() {
      return committedDiffReads;
    },
    pushes,
    run,
  };
}

function result(stdout = "", exitCode = 0, stderr = "") {
  return { stdout, stderr, exitCode };
}

function binaryResult(stdout = Buffer.alloc(0), exitCode = 0, stderr) {
  return {
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
    exitCode,
  };
}

function committedDiffSignature(fixture) {
  return `git diff --name-only -z --no-renames ${GATE_B_LOCAL_CHANGE_BASE_SHA}..${fixture.head} --`;
}

function committedDiffOutput(fixture, paths = fixture.allowedPaths) {
  return Buffer.from(`${paths.join("\0")}\0`);
}

function committedDiffExecutable(fixture, diffOutput) {
  const executable = path.join(
    path.dirname(fixture.authorizationFile),
    `committed-diff-${cryptoSafeName(diffOutput)}.mjs`,
  );
  fs.writeFileSync(
    executable,
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.join(" ") === "rev-parse HEAD") process.stdout.write(${JSON.stringify(fixture.head)} + "\\n");\nelse if (args[0] === "diff") process.stdout.write(Buffer.from(${JSON.stringify([...diffOutput])}));\nelse process.exitCode = 1;\n`,
    { mode: 0o755 },
  );
  return executable;
}

function cryptoSafeName(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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

function readableManifestOrOriginal(fixture) {
  try {
    return readGateBArtifactSnapshot(fixture.directory).manifestSha256;
  } catch {
    return fixture.manifestSha256;
  }
}

async function recordedProcessGroup(file) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const pid = Number(
      fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "",
    );
    if (Number.isSafeInteger(pid) && pid > 1) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const processGroup = Number(fields[2]);
      if (Number.isSafeInteger(processGroup) && processGroup > 1)
        return processGroup;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for descendant PID file ${file}.`);
}

async function processGroupHasRunningMember(processGroup) {
  for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${entry.name}/stat`, "utf8");
    } catch {
      continue;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (
      Number(fields[2]) === processGroup &&
      fields[0] !== "Z" &&
      fields[0] !== "X"
    )
      return true;
  }
  return false;
}

async function terminateProcessGroup(processGroup) {
  try {
    process.kill(-processGroup, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 2_000;
  while (await processGroupHasRunningMember(processGroup)) {
    if (Date.now() >= deadline)
      throw new Error(
        `Process group ${processGroup} survived emergency cleanup.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function trustedExecutableFileSystem(behavior = {}) {
  const paths = new Map([
    ["/", trustedStat("directory", 1n)],
    ["/usr", trustedStat("directory", 2n)],
    ["/usr/bin", trustedStat("directory", 3n)],
    ["/usr/bin/git", trustedStat("file", 4n)],
    ["/usr/bin/gh", trustedStat("file", 5n)],
  ]);
  if (behavior.mutate) {
    const [filePath, overrides] = behavior.mutate;
    paths.set(
      filePath,
      trustedStat(overrides.kind ?? "file", paths.get(filePath).ino, overrides),
    );
  }
  const descriptors = new Map();
  const lstatCalls = new Map();
  let nextDescriptor = 10;
  return {
    constants: { O_DIRECTORY: 1, O_NOFOLLOW: 2, O_RDONLY: 4 },
    processes: 0,
    tokenReads: 0,
    closeSync(descriptor) {
      descriptors.delete(descriptor);
    },
    fstatSync(descriptor) {
      return descriptors.get(descriptor);
    },
    lstatSync(filePath) {
      if (behavior.missing === filePath) throw new Error("missing");
      const calls = (lstatCalls.get(filePath) ?? 0) + 1;
      lstatCalls.set(filePath, calls);
      const stat = paths.get(filePath);
      if (behavior.drift === filePath && calls > 1) {
        return { ...stat, ino: stat.ino + 100n };
      }
      return stat;
    },
    openSync(filePath) {
      const descriptor = nextDescriptor;
      nextDescriptor += 1;
      descriptors.set(descriptor, paths.get(filePath));
      return descriptor;
    },
  };
}

function trustedStat(kind, ino, overrides = {}) {
  return {
    ctimeNs: 1n,
    dev: 1n,
    ino,
    mode: kind === "directory" ? 0o040755n : 0o100755n,
    mtimeNs: 1n,
    size: 1n,
    uid: 0n,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => overrides.symbolicLink === true,
    ...overrides,
  };
}

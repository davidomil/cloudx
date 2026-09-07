import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { validateArtifact } from "./artifact-validation.mjs";
import {
  calculateWorktreeDigest,
  displayCommand,
  readHeadSha,
  runCommand,
  verificationPlan,
  verifyChange,
} from "./verify.mjs";

const gitSha = "a".repeat(40);
const policySha = "1".repeat(64);

describe("deterministic change verification", () => {
  it("keeps the full gate fixed outside mutable review policy", () => {
    const plan = verificationPlan("full", {
      asrPython: "asr-python",
      documentationPython: "docs-python",
    });
    expect(
      plan.map(
        ({ timeoutMs, maxStdoutBytes, maxStderrBytes, ...planned }) => planned,
      ),
    ).toEqual([
      { command: "node", args: ["scripts/ai-change/validate-process.mjs"] },
      { command: "npm", args: ["run", "format:check"] },
      { command: "npm", args: ["run", "lint"] },
      { command: "npm", args: ["run", "typecheck", "--", "--pretty", "false"] },
      { command: "npm", args: ["run", "test:coverage"] },
      { command: "npm", args: ["run", "build"] },
      {
        command: "asr-python",
        args: ["-m", "pytest", "services/asr/tests", "-q"],
        env: { PYTHONPATH: "services/asr/src" },
      },
      {
        command: "docs-python",
        args: ["-m", "pytest", "services/documentation-indexer/tests", "-q"],
        env: { PYTHONPATH: "services/documentation-indexer/src" },
      },
      { command: "npm", args: ["run", "test:browser"] },
    ]);
    expect(
      plan.every(
        ({ timeoutMs, maxStdoutBytes, maxStderrBytes }) =>
          Number.isSafeInteger(timeoutMs) &&
          timeoutMs > 0 &&
          Number.isSafeInteger(maxStdoutBytes) &&
          maxStdoutBytes > 0 &&
          Number.isSafeInteger(maxStderrBytes) &&
          maxStderrBytes > 0,
      ),
    ).toBe(true);
  });

  it("records a passing proof only when every command succeeds and the tree is unchanged", async () => {
    const runner = vi.fn(async ({ command, args }) => ({
      exitCode: 0,
      stdout: `${command} ${args.join(" ")} passed`,
      stderr: "",
    }));
    const digest = vi.fn(async () => "2".repeat(64));

    const artifact = await verifyChange({
      ...acceptedVerificationInputs("policy"),
      runId: "run-1",
      scope: "policy",
      runner,
      worktreeDigest: digest,
    });

    expect(artifact.verdict).toBe("passed");
    expect(artifact.commands).toHaveLength(3);
    expect(artifact.commands.every((command) => command.exit_code === 0)).toBe(
      true,
    );
    expect(digest).toHaveBeenCalledTimes(5);
  });

  it("runs every selected command so the artifact contains the complete failure set", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "policy failed",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "format passed",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr: "lint failed",
      });

    const artifact = await verifyChange({
      ...acceptedVerificationInputs("policy"),
      runId: "run-2",
      scope: "policy",
      runner,
      worktreeDigest: async () => "3".repeat(64),
    });

    expect(artifact.verdict).toBe("failed");
    expect(artifact.commands.map((command) => command.exit_code)).toEqual([
      1, 0, 2,
    ]);
  });

  it("fails a green command set when verification changes the worktree", async () => {
    const digests = ["4".repeat(64), "5".repeat(64), "5".repeat(64)];

    const artifact = await verifyChange({
      ...acceptedVerificationInputs("policy"),
      runId: "run-3",
      scope: "policy",
      runner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      worktreeDigest: async () => digests.shift(),
    });

    expect(artifact.verdict).toBe("failed");
    expect(artifact.tree_sha256_before).not.toBe(artifact.tree_sha256_after);
    expect(artifact.commands).toHaveLength(1);
  });

  it("rejects unknown scopes instead of choosing a smaller fallback gate", () => {
    expect(() => verificationPlan("quick", {})).toThrow(/scope/i);
  });

  it("records the Python source path used by a service verification", async () => {
    const artifact = await verifyChange({
      ...acceptedVerificationInputs("python-asr", {
        asrPython: "services/asr/.venv/bin/python",
      }),
      runId: "run-4",
      scope: "python-asr",
      planOptions: { asrPython: "services/asr/.venv/bin/python" },
      runner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      worktreeDigest: async () => "6".repeat(64),
    });

    expect(artifact.commands[0].command).toBe(
      "PYTHONPATH=services/asr/src services/asr/.venv/bin/python -m pytest services/asr/tests -q",
    );
  });

  it("owns a Linux process group and escalates an expired command from TERM to KILL", async () => {
    const child = fakeChild(4101);
    const spawnProcess = vi.fn(() => child);
    const signals = [];
    let alive = true;
    const signalProcess = vi.fn((pid, signal) => {
      if (signal === 0) {
        if (alive) return true;
        throw noSuchProcess();
      }
      signals.push([pid, signal]);
      if (signal === "SIGKILL") {
        alive = false;
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      }
      return true;
    });

    const result = await runCommand(
      boundedCommand({ timeoutMs: 5 }),
      boundedRunner({ child, spawnProcess, signalProcess }),
    );

    expect(spawnProcess).toHaveBeenCalledWith(
      "fake-command",
      [],
      expect.objectContaining({ detached: true }),
    );
    expect(signals).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/timed out after 5ms/i);
    expect(result.stderr).toMatch(/SIGKILL/u);
  });

  it("bounds captured output and terminates the process that exceeded it", async () => {
    const child = fakeChild(4102);
    let alive = true;
    const signalProcess = vi.fn((_pid, signal) => {
      if (signal === 0) {
        if (alive) return true;
        throw noSuchProcess();
      }
      if (signal === "SIGTERM") {
        alive = false;
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      }
      return true;
    });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.stdout.write("x".repeat(64)));
      return child;
    });

    const result = await runCommand(
      boundedCommand({ maxStdoutBytes: 16 }),
      boundedRunner({ child, spawnProcess, signalProcess }),
    );

    expect(Buffer.byteLength(result.stdout)).toBe(16);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024);
    expect(result.stderr).toMatch(/stdout exceeded 16 bytes/i);
    expect(signalProcess).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    expect(signalProcess).not.toHaveBeenCalledWith(-child.pid, "SIGKILL");
  });

  it("allows descendants a bounded natural drain after the command exits", async () => {
    const child = fakeChild(4104);
    let alive = true;
    const signals = [];
    const signalProcess = vi.fn((pid, signal) => {
      if (signal === 0) {
        if (alive) return true;
        throw noSuchProcess();
      }
      signals.push([pid, signal]);
      return true;
    });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      setTimeout(() => {
        alive = false;
      }, 5);
      return child;
    });

    const result = await runCommand(
      boundedCommand(),
      boundedRunner({
        child,
        spawnProcess,
        signalProcess,
        exitDrainMs: 20,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(signals).toEqual([]);
  });

  it("fails and terminates descendants that outlive the natural drain", async () => {
    const child = fakeChild(4105);
    let alive = true;
    const signals = [];
    const signalProcess = vi.fn((pid, signal) => {
      if (signal === 0) {
        if (alive) return true;
        throw noSuchProcess();
      }
      signals.push([pid, signal]);
      if (signal === "SIGTERM") alive = false;
      return true;
    });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    const result = await runCommand(
      boundedCommand(),
      boundedRunner({
        child,
        spawnProcess,
        signalProcess,
        exitDrainMs: 2,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/left descendant processes running/i);
    expect(signals).toEqual([[-child.pid, "SIGTERM"]]);
  });

  it("waits for process cleanup before calculating the command and final tree digests", async () => {
    const child = fakeChild(4103);
    let alive = true;
    let releaseKill;
    const killObserved = new Promise((resolve) => {
      releaseKill = resolve;
    });
    const signalProcess = vi.fn((_pid, signal) => {
      if (signal === 0) {
        if (alive) return true;
        throw noSuchProcess();
      }
      if (signal === "SIGKILL") {
        alive = false;
        releaseKill();
      }
      return true;
    });
    const digestEvents = [];
    const digest = vi.fn(async () => {
      digestEvents.push("digest");
      return "7".repeat(64);
    });
    const verification = verifyChange({
      ...acceptedVerificationInputs("python-asr", {
        asrPython: "services/asr/.venv/bin/python",
      }),
      runId: "run-cleanup-order",
      scope: "python-asr",
      planOptions: { asrPython: "services/asr/.venv/bin/python" },
      runner: (planned) =>
        runCommand(
          { ...planned, timeoutMs: 5 },
          boundedRunner({
            child,
            spawnProcess: () => child,
            signalProcess,
            killGraceMs: 100,
          }),
        ),
      worktreeDigest: digest,
    });

    await killObserved;
    expect(digestEvents).toEqual(["digest"]);
    child.emit("close", null, "SIGKILL");
    const artifact = await verification;

    expect(artifact.verdict).toBe("failed");
    expect(digestEvents).toEqual(["digest", "digest", "digest"]);
  });

  it("bounds the Git commands used to identify the worktree and current head", async () => {
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce(successfulProcess("diff"))
      .mockResolvedValueOnce(successfulProcess(""))
      .mockResolvedValueOnce(successfulProcess(`${gitSha}\n`));

    await calculateWorktreeDigest({ processRunner });
    await expect(readHeadSha({ processRunner })).resolves.toBe(gitSha);

    expect(processRunner).toHaveBeenCalledTimes(3);
    for (const [planned] of processRunner.mock.calls) {
      expect(planned).toEqual(
        expect.objectContaining({
          command: "git",
          timeoutMs: expect.any(Number),
          maxStdoutBytes: expect.any(Number),
          maxStderrBytes: expect.any(Number),
        }),
      );
      expect(planned.timeoutMs).toBeGreaterThan(0);
      expect(planned.maxStdoutBytes).toBeGreaterThan(0);
      expect(planned.maxStderrBytes).toBeGreaterThan(0);
    }
  });

  it("rejects an unbounded command before spawning it", async () => {
    await expect(
      runCommand({ command: "fake-command", args: [] }),
    ).rejects.toThrow(/timeout/i);
  });

  it.each([
    [
      "missing command",
      (plan) => plan.verification.pop(),
      /verification commands/i,
    ],
    [
      "extra command",
      (plan) => plan.verification.push("npm run documentation:test"),
      /verification commands/i,
    ],
    [
      "reordered commands",
      (plan) => plan.verification.reverse(),
      /verification commands/i,
    ],
    [
      "altered executable",
      (plan) =>
        (plan.verification[0] = "python -m pytest services/asr/tests -q"),
      /verification commands/i,
    ],
    [
      "altered arguments",
      (plan) =>
        (plan.verification[0] =
          "node scripts/ai-change/artifact-validation.mjs"),
      /Verification command must be recognized, local, and read-only/u,
    ],
    [
      "altered environment",
      (plan) =>
        (plan.verification[6] =
          "PYTHONPATH=services/asr/other services/asr/.venv/bin/python -m pytest services/asr/tests -q"),
      /Verification command must be recognized, local, and read-only/u,
    ],
  ])(
    "rejects %s before digest or dispatch",
    async (_name, mutate, expectedError) => {
      const acceptedPlan = acceptedPlanFor("full");
      mutate(acceptedPlan);
      const worktreeDigest = vi.fn();
      const runner = vi.fn();

      await expect(
        verifyChange({
          ...acceptedVerificationInputs("full"),
          acceptedPlan,
          runId: "command-parity",
          worktreeDigest,
          runner,
        }),
      ).rejects.toThrow(expectedError);
      expect(worktreeDigest).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it("validates the accepted plan before every source or process dependency", async () => {
    const acceptedPlan = acceptedPlanFor("full");
    acceptedPlan.verification[0] =
      "node scripts/ai-change/validate-process.mjs $(git status)";
    const dependencies = verifierSpies();

    await expect(
      verifyChange({
        acceptedPlan,
        localBaseSha: gitSha,
        headSha: gitSha,
        runId: "invalid-plan",
        ...dependencies,
      }),
    ).rejects.toThrow(/read-only/i);
    expectNoVerifierWork(dependencies);
  });

  it("rejects an explicit local base mismatch before head lookup or construction", async () => {
    const dependencies = verifierSpies();

    await expect(
      verifyChange({
        acceptedPlan: acceptedPlanFor("full"),
        localBaseSha: "b".repeat(40),
        headSha: gitSha,
        runId: "wrong-base",
        ...dependencies,
      }),
    ).rejects.toThrow(/local base/i);
    expectNoVerifierWork(dependencies);
  });

  it("rejects an actual HEAD mismatch before construction, digest, or dispatch", async () => {
    const dependencies = verifierSpies();
    dependencies.readHead.mockResolvedValue("b".repeat(40));

    await expect(
      verifyChange({
        acceptedPlan: acceptedPlanFor("full"),
        localBaseSha: gitSha,
        headSha: gitSha,
        runId: "wrong-head",
        ...dependencies,
      }),
    ).rejects.toThrow(/head/i);
    expect(dependencies.readHead).toHaveBeenCalledOnce();
    expect(dependencies.makeVerificationPlan).not.toHaveBeenCalled();
    expect(dependencies.worktreeDigest).not.toHaveBeenCalled();
    expect(dependencies.runner).not.toHaveBeenCalled();
  });

  it("makes the documented silent npm entry require a valid plan, base, and exact head before child dispatch", () => {
    const fixture = spawnedVerifierFixture();
    try {
      for (const args of [
        [],
        ["--plan", fixture.invalidPlan],
        [
          "--plan",
          fixture.plan,
          "--base-sha",
          "b".repeat(40),
          "--head-sha",
          gitSha,
        ],
        [
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--head-sha",
          "b".repeat(40),
        ],
        [
          "--scope",
          "full",
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
        ],
        [
          "--scope",
          "policy",
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
        ],
        [
          "--output",
          fixture.output,
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
        ],
        [
          "--output-path",
          fixture.output,
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
        ],
        [
          "--path",
          fixture.output,
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
        ],
        [
          "--plan",
          fixture.plan,
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
        ],
        [
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
        ],
        [
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
          "--head-sha",
          gitSha,
        ],
        [
          "--plan",
          fixture.plan,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
          "--run-id",
          "one",
          "--run-id",
          "two",
        ],
        [
          "--plan",
          fixture.subsetPlan,
          "--base-sha",
          gitSha,
          "--head-sha",
          gitSha,
        ],
      ]) {
        fs.writeFileSync(fixture.log, "");
        fs.rmSync(fixture.output, { force: true });
        const trackedBytes = fs.readFileSync("package.json");
        const result = fixture.run(args);
        expect(result.status).not.toBe(0);
        expect(fs.readFileSync(fixture.log, "utf8")).toBe("");
        expect(fs.existsSync(fixture.output)).toBe(false);
        expect(fs.readFileSync("package.json")).toEqual(trackedBytes);
      }

      const trackedBytes = fs.readFileSync("package.json");
      const policySource = new URL(
        "../../.agents/pr-review-policy.toml",
        import.meta.url,
      );
      const policyBytes = fs.readFileSync(policySource);
      const result = fixture.run([
        "--plan",
        fixture.plan,
        "--base-sha",
        gitSha,
        "--head-sha",
        gitSha,
      ]);
      expect(result.status, result.stderr).toBe(0);
      const artifact = JSON.parse(result.stdout);
      expect(artifact.verdict).toBe("passed");
      expect(artifact.policy_sha256).toBe(fixture.policySha256);
      expect(artifact.commands).toHaveLength(9);
      expect(artifact.tree_sha256_after).toBe(artifact.tree_sha256_before);
      expect(fs.readFileSync("package.json")).toEqual(trackedBytes);
      expect(fs.readFileSync(policySource)).toEqual(policyBytes);
      expect(fs.readFileSync(fixture.log, "utf8").trim().split("\n")).toEqual(
        acceptedPlanFor("full", fixture.planOptions).verification,
      );
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  it("rejects a schema-valid mismatched policy digest through the real npm entry before child dispatch", () => {
    const fixture = spawnedVerifierFixture();
    try {
      const accepted = JSON.parse(fs.readFileSync(fixture.plan, "utf8"));
      const mismatched = structuredClone(accepted);
      mismatched.policy_sha256 =
        (accepted.policy_sha256[0] === "0" ? "1" : "0") +
        accepted.policy_sha256.slice(1);
      expect(mismatched.policy_sha256).not.toBe(accepted.policy_sha256);
      expect(() => validateArtifact("plan", mismatched)).not.toThrow();
      const mismatchedPlan = path.join(fixture.root, "mismatched-policy.json");
      const planBytes = `${JSON.stringify(mismatched)}\n`;
      fs.writeFileSync(mismatchedPlan, planBytes);
      const sources = [
        new URL("../../package.json", import.meta.url),
        new URL("../../.agents/pr-review-policy.toml", import.meta.url),
        new URL("./verify.mjs", import.meta.url),
        new URL(import.meta.url),
      ].map((source) => [source, fs.readFileSync(source)]);

      const result = fixture.run([
        "--plan",
        mismatchedPlan,
        "--base-sha",
        gitSha,
        "--head-sha",
        gitSha,
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Verification policy digest/u);
      expect(result.stdout).toBe("");
      expect(fs.readFileSync(fixture.log, "utf8")).toBe("");
      expect(fs.existsSync(fixture.output)).toBe(false);
      expect(fs.readFileSync(mismatchedPlan, "utf8")).toBe(planBytes);
      for (const [source, bytes] of sources) {
        expect(fs.readFileSync(source)).toEqual(bytes);
      }
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

function acceptedPlanFor(scope, planOptions = {}) {
  return {
    schema_version: 1,
    kind: "change-plan",
    run_id: "accepted-plan",
    base_sha: gitSha,
    head_sha: gitSha,
    policy_sha256: policySha,
    skill_versions: { "plan-change": "2".repeat(64) },
    task: "Run one exact deterministic verification plan.",
    classification: {
      type: "bug",
      areas: ["agent-policy"],
      risk: "human-required",
      skills: ["review-agent-policy"],
      human_review_required: true,
      automerge_eligible: false,
    },
    anchors: [
      {
        path: "scripts/ai-change/verify.mjs",
        line: 1,
        reason: "Owns deterministic verification.",
      },
      {
        path: "scripts/ai-change/verify.test.mjs",
        line: 1,
        reason: "Exercises deterministic verification.",
      },
    ],
    claims: [
      {
        id: "CLAIM-VERIFY",
        behavior: "Dispatch the accepted verification commands.",
        production_seam: "verifyChange",
        test: "Verifier production-path tests.",
        negative_cases: ["A command drifts."],
      },
    ],
    allowed_paths: ["scripts/ai-change/verify.mjs"],
    forbidden_paths: [".github/**"],
    verification: verificationPlan(scope, planOptions).map(displayCommand),
  };
}

function acceptedVerificationInputs(scope, planOptions = {}) {
  return {
    acceptedPlan: acceptedPlanFor(scope, planOptions),
    headSha: gitSha,
    localBaseSha: gitSha,
    loadCurrentPolicy: async () => ({ policySha256: policySha }),
    readHead: async () => gitSha,
  };
}

function verifierSpies() {
  return {
    loadCurrentPolicy: vi.fn(),
    makeVerificationPlan: vi.fn(),
    readHead: vi.fn(),
    runner: vi.fn(),
    worktreeDigest: vi.fn(),
  };
}

function expectNoVerifierWork(dependencies) {
  expect(dependencies.readHead).not.toHaveBeenCalled();
  expect(dependencies.worktreeDigest).not.toHaveBeenCalled();
  expect(dependencies.makeVerificationPlan).not.toHaveBeenCalled();
  expect(dependencies.loadCurrentPolicy).not.toHaveBeenCalled();
  expect(dependencies.runner).not.toHaveBeenCalled();
}

function spawnedVerifierFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-verifier-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  const asrPython = path.join(root, "asr", "python");
  const documentationPython = path.join(root, "documentation", "python");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.dirname(asrPython));
  fs.mkdirSync(path.dirname(documentationPython));
  fs.writeFileSync(log, "");
  const logger = `#!${process.execPath}\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst executable = path.basename(process.argv[1]) === "npm" ? "npm" : process.argv[1];\nconst environment = process.env.PYTHONPATH ? ["PYTHONPATH=" + process.env.PYTHONPATH] : [];\nfs.appendFileSync(${JSON.stringify(log)}, [...environment, executable, ...process.argv.slice(2)].join(" ") + "\\n");\n`;
  for (const executable of ["npm", asrPython, documentationPython]) {
    fs.writeFileSync(
      path.isAbsolute(executable) ? executable : path.join(bin, executable),
      logger,
      { mode: 0o755 },
    );
  }
  fs.writeFileSync(
    path.join(bin, "node"),
    `#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nif (args[0] === "scripts/ai-change/verify.mjs") { const result = spawnSync(${JSON.stringify(process.execPath)}, args, { env: process.env, stdio: "inherit" }); process.exit(result.status ?? 1); }\nfs.appendFileSync(${JSON.stringify(log)}, ["node", ...args].join(" ") + "\\n");\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === "rev-parse" && args[1] === "HEAD") process.stdout.write(${JSON.stringify(`${gitSha}\n`)});\n`,
    { mode: 0o755 },
  );
  const planOptions = { asrPython, documentationPython };
  const plan = path.join(root, "plan.json");
  const subsetPlan = path.join(root, "subset-plan.json");
  const invalidPlan = path.join(root, "invalid-plan.json");
  const output = path.join(root, "output.json");
  const accepted = acceptedPlanFor("full", planOptions);
  accepted.policy_sha256 = createHash("sha256")
    .update(
      fs.readFileSync(
        new URL("../../.agents/pr-review-policy.toml", import.meta.url),
      ),
    )
    .digest("hex");
  fs.writeFileSync(plan, `${JSON.stringify(accepted)}\n`);
  const subset = acceptedPlanFor("policy", planOptions);
  subset.policy_sha256 = accepted.policy_sha256;
  fs.writeFileSync(subsetPlan, `${JSON.stringify(subset)}\n`);
  const unsafe = structuredClone(accepted);
  unsafe.verification[0] += " $(git status)";
  fs.writeFileSync(invalidPlan, `${JSON.stringify(unsafe)}\n`);
  return {
    asrPython,
    documentationPython,
    invalidPlan,
    log,
    output,
    plan,
    planOptions,
    policySha256: accepted.policy_sha256,
    root,
    subsetPlan,
    run(args) {
      return spawnSync(
        process.execPath,
        [npmCliPath(), "run", "--silent", "verify", "--", ...args],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            CLOUDX_ASR_PYTHON: asrPython,
            CLOUDX_DOCUMENTATION_PYTHON: documentationPython,
            PATH: `${bin}:/usr/bin:/bin`,
          },
        },
      );
    },
  };
}

function npmCliPath() {
  return process.env.npm_execpath ?? fs.realpathSync("/usr/bin/npm");
}

function boundedCommand(overrides = {}) {
  return {
    command: "fake-command",
    args: [],
    timeoutMs: 1_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    ...overrides,
  };
}

function boundedRunner({
  spawnProcess,
  signalProcess,
  killGraceMs = 20,
  exitDrainMs = 0,
}) {
  return {
    spawnProcess,
    signalProcess,
    platform: "linux",
    termGraceMs: 2,
    killGraceMs,
    exitDrainMs,
    pollIntervalMs: 1,
    writeOutput: () => undefined,
  };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function noSuchProcess() {
  return Object.assign(new Error("process does not exist"), { code: "ESRCH" });
}

function successfulProcess(stdout) {
  return {
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
}

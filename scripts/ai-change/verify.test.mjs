import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  calculateWorktreeDigest,
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
      runId: "run-1",
      scope: "policy",
      headSha: gitSha,
      policySha256: policySha,
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
      runId: "run-2",
      scope: "policy",
      headSha: gitSha,
      policySha256: policySha,
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
      runId: "run-3",
      scope: "policy",
      headSha: gitSha,
      policySha256: policySha,
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
      runId: "run-4",
      scope: "python-asr",
      headSha: gitSha,
      policySha256: policySha,
      planOptions: { asrPython: "asr-python" },
      runner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      worktreeDigest: async () => "6".repeat(64),
    });

    expect(artifact.commands[0].command).toBe(
      "PYTHONPATH=services/asr/src asr-python -m pytest services/asr/tests -q",
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
      runId: "run-cleanup-order",
      scope: "python-asr",
      headSha: gitSha,
      policySha256: policySha,
      planOptions: { asrPython: "fake-command" },
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
});

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

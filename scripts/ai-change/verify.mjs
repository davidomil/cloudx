#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifact } from "./artifact-validation.mjs";
import { loadPolicy } from "./policy.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MiB = 1024 * 1024;
const verificationOutputBytes = 16 * MiB;
const processCleanup = {
  exitDrainMs: 250,
  termGraceMs: 5_000,
  killGraceMs: 5_000,
  pollIntervalMs: 25,
};
const commandTimeoutMs = {
  processValidation: 2 * 60_000,
  formatting: 5 * 60_000,
  lint: 5 * 60_000,
  typecheck: 10 * 60_000,
  coverage: 30 * 60_000,
  build: 10 * 60_000,
  python: 20 * 60_000,
  browser: 20 * 60_000,
};

export function verificationPlan(scope, options = {}) {
  const asrPython =
    options.asrPython ??
    process.env.CLOUDX_ASR_PYTHON ??
    "services/asr/.venv/bin/python";
  const documentationPython =
    options.documentationPython ??
    process.env.CLOUDX_DOCUMENTATION_PYTHON ??
    "services/documentation-indexer/.venv/bin/python";
  const plans = {
    policy: [
      verificationCommand(
        "node",
        ["scripts/ai-change/validate-process.mjs"],
        commandTimeoutMs.processValidation,
      ),
      verificationCommand(
        "npm",
        ["run", "format:check"],
        commandTimeoutMs.formatting,
      ),
      verificationCommand("npm", ["run", "lint"], commandTimeoutMs.lint),
    ],
    typescript: [
      verificationCommand(
        "npm",
        ["run", "typecheck", "--", "--pretty", "false"],
        commandTimeoutMs.typecheck,
      ),
      verificationCommand(
        "npm",
        ["run", "test:coverage"],
        commandTimeoutMs.coverage,
      ),
      verificationCommand("npm", ["run", "build"], commandTimeoutMs.build),
    ],
    "python-asr": [
      verificationCommand(
        asrPython,
        ["-m", "pytest", "services/asr/tests", "-q"],
        commandTimeoutMs.python,
        { PYTHONPATH: "services/asr/src" },
      ),
    ],
    "python-documentation": [
      verificationCommand(
        documentationPython,
        ["-m", "pytest", "services/documentation-indexer/tests", "-q"],
        commandTimeoutMs.python,
        { PYTHONPATH: "services/documentation-indexer/src" },
      ),
    ],
    browser: [
      verificationCommand(
        "npm",
        ["run", "test:browser"],
        commandTimeoutMs.browser,
      ),
    ],
  };
  if (scope === "full") {
    return [
      plans.policy,
      plans.typescript,
      plans["python-asr"],
      plans["python-documentation"],
      plans.browser,
    ].flat();
  }
  if (!plans[scope]) {
    throw new Error(`Unknown verification scope '${scope}'.`);
  }
  return plans[scope];
}

export async function verifyChange({
  runId,
  scope = "full",
  headSha,
  policySha256,
  runner = runCommand,
  worktreeDigest = calculateWorktreeDigest,
  planOptions = {},
}) {
  const plan = verificationPlan(scope, planOptions);
  const before = await worktreeDigest();
  const results = [];

  for (const planned of plan) {
    const commandBefore = results.at(-1)?.tree_sha256_after ?? before;
    const result = await runner(planned);
    const commandAfter = await worktreeDigest();
    results.push({
      command: displayCommand(planned),
      exit_code: result.exitCode,
      stdout_sha256: digest(result.stdout),
      stderr_sha256: digest(result.stderr),
      tree_sha256_before: commandBefore,
      tree_sha256_after: commandAfter,
    });
    if (commandAfter !== commandBefore) break;
  }

  const after = await worktreeDigest();
  const passed =
    results.length === plan.length &&
    results.every(
      (result) =>
        result.exit_code === 0 &&
        result.tree_sha256_before === result.tree_sha256_after,
    ) &&
    before === after;
  return validateArtifact("verification", {
    schema_version: 1,
    kind: "change-verification",
    run_id: runId,
    base_sha: headSha,
    head_sha: headSha,
    policy_sha256: policySha256,
    tree_sha256_before: before,
    tree_sha256_after: after,
    verdict: passed ? "passed" : "failed",
    commands: results,
  });
}

export async function calculateWorktreeDigest({
  processRunner = runBoundedProcess,
} = {}) {
  const hash = createHash("sha256");
  const { stdout: diff } = await runRequiredProcess(
    processRunner,
    boundedProcess(
      "git",
      ["diff", "--binary", "--full-index", "HEAD", "--", "."],
      {
        timeoutMs: 2 * 60_000,
        maxStdoutBytes: 128 * MiB,
        maxStderrBytes: 4 * MiB,
      },
    ),
    "git worktree diff",
  );
  hash.update(diff);

  const { stdout } = await runRequiredProcess(
    processRunner,
    boundedProcess(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        timeoutMs: 60_000,
        maxStdoutBytes: 32 * MiB,
        maxStderrBytes: 4 * MiB,
      },
    ),
    "git untracked-file listing",
  );
  const paths = stdout.toString("utf8").split("\0").filter(Boolean).sort();
  for (const relativePath of paths) {
    const absolutePath = path.join(repoRoot, relativePath);
    const stat = await fs.lstat(absolutePath);
    hash.update(relativePath).update("\0");
    hash.update(
      stat.isSymbolicLink()
        ? await fs.readlink(absolutePath)
        : await fs.readFile(absolutePath),
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function readHeadSha({ processRunner = runBoundedProcess } = {}) {
  const { stdout } = await runRequiredProcess(
    processRunner,
    boundedProcess("git", ["rev-parse", "HEAD"], {
      timeoutMs: 30_000,
      maxStdoutBytes: MiB,
      maxStderrBytes: MiB,
    }),
    "git head lookup",
  );
  return stdout.toString("utf8").trim();
}

export async function runCommand(planned, dependencies = {}) {
  const {
    writeOutput = (chunk) => process.stderr.write(chunk),
    ...processDependencies
  } = dependencies;
  const result = await runBoundedProcess(planned, {
    ...processDependencies,
    writeOutput,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

async function runBoundedProcess(planned, dependencies = {}) {
  assertBoundedProcess(planned);
  const {
    spawnProcess = spawn,
    signalProcess = process.kill,
    platform = process.platform,
    writeOutput = () => undefined,
    exitDrainMs = processCleanup.exitDrainMs,
    termGraceMs = processCleanup.termGraceMs,
    killGraceMs = processCleanup.killGraceMs,
    pollIntervalMs = processCleanup.pollIntervalMs,
  } = dependencies;
  const executable = planned.command;
  const args = planned.args;
  const stop = deferred();
  const closed = deferred();
  let stopReason = null;
  let spawnError = null;
  const requestStop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    stop.resolve({ kind: "stop" });
  };
  const stdout = boundedCapture(
    "stdout",
    planned.maxStdoutBytes,
    requestStop,
    writeOutput,
  );
  const stderr = boundedCapture(
    "stderr",
    planned.maxStderrBytes,
    requestStop,
    writeOutput,
  );

  let child;
  try {
    child = spawnProcess(executable, args, {
      cwd: repoRoot,
      detached: platform !== "win32",
      env: { ...process.env, ...(planned.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return failedSpawn(error, planned.maxStderrBytes);
  }

  child.stdout?.on("data", stdout.write);
  child.stderr?.on("data", stderr.write);
  child.once("error", (error) => {
    spawnError = error;
    if (child.pid) requestStop(`Command process error: ${error.message}.`);
    else stop.resolve({ kind: "spawn-error" });
  });
  child.once("close", (code, signal) => {
    const outcome = { code, signal };
    closed.resolve(outcome);
    stop.resolve({ kind: "close", outcome });
  });

  const timeout = setTimeout(
    () => requestStop(`Command timed out after ${planned.timeoutMs}ms.`),
    planned.timeoutMs,
  );
  const first = await stop.promise;
  clearTimeout(timeout);

  if (first.kind === "spawn-error") {
    return {
      exitCode: 127,
      stdout: stdout.value(),
      stderr: appendDiagnostics(
        stderr.value(),
        [`Command could not start: ${spawnError?.message ?? "unknown error"}.`],
        planned.maxStderrBytes,
      ),
    };
  }

  const tree = ownedProcessTree(child, { platform, signalProcess });
  let outcome = first.kind === "close" ? first.outcome : null;
  let cleanup = null;
  if (first.kind === "close") {
    if (
      tree?.isAlive() &&
      !(await waitForProcessTree(tree, exitDrainMs, pollIntervalMs))
    ) {
      stopReason = "Command left descendant processes running.";
      cleanup = await terminateProcessTree(tree, {
        termGraceMs,
        killGraceMs,
        pollIntervalMs,
      });
    }
  } else if (tree) {
    cleanup = await terminateProcessTree(tree, {
      termGraceMs,
      killGraceMs,
      pollIntervalMs,
    });
  }

  if (!outcome && tree) {
    outcome = await settleWithin(closed.promise, killGraceMs);
  }
  const diagnostics = [];
  if (stopReason) diagnostics.push(stopReason);
  if (cleanup?.signals.includes("SIGKILL")) {
    diagnostics.push(
      `Process tree required SIGKILL after ${termGraceMs}ms of TERM grace.`,
    );
  }
  if (cleanup && !cleanup.stopped) {
    diagnostics.push(
      `Process tree remained alive after ${killGraceMs}ms of KILL grace.`,
    );
  }
  if (!outcome && tree) {
    diagnostics.push("Process cleanup did not reach the child close event.");
  }
  if (outcome?.signal) {
    diagnostics.push(`Process terminated by ${outcome.signal}.`);
  }
  if (spawnError)
    diagnostics.push(`Command process error: ${spawnError.message}.`);

  return {
    exitCode:
      stopReason || (cleanup && !cleanup.stopped) || !outcome
        ? 1
        : (outcome.code ?? 1),
    stdout: stdout.value(),
    stderr: appendDiagnostics(
      stderr.value(),
      diagnostics,
      planned.maxStderrBytes,
    ),
  };
}

async function runRequiredProcess(processRunner, planned, operation) {
  const result = await processRunner(planned);
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed: ${result.stderr.toString("utf8").trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result;
}

function verificationCommand(executable, args, timeoutMs, env) {
  return boundedProcess(executable, args, {
    timeoutMs,
    maxStdoutBytes: verificationOutputBytes,
    maxStderrBytes: verificationOutputBytes,
    ...(env ? { env } : {}),
  });
}

function boundedProcess(command, args, limits) {
  return { command, args, ...limits };
}

function assertBoundedProcess(planned) {
  if (!planned || typeof planned !== "object") {
    throw new Error("bounded command is required");
  }
  if (typeof planned.command !== "string" || !planned.command) {
    throw new Error("bounded command executable is required");
  }
  if (
    !Array.isArray(planned.args) ||
    planned.args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error("bounded command arguments are invalid");
  }
  for (const [name, value] of [
    ["timeout", planned.timeoutMs],
    ["stdout byte limit", planned.maxStdoutBytes],
    ["stderr byte limit", planned.maxStderrBytes],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`bounded command ${name} must be a positive integer`);
    }
  }
  if (planned.timeoutMs > 2_147_483_647) {
    throw new Error("bounded command timeout exceeds the timer limit");
  }
}

function boundedCapture(name, byteLimit, stop, writeOutput) {
  const chunks = [];
  let capturedBytes = 0;
  let exceeded = false;
  return {
    write(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = byteLimit - capturedBytes;
      if (remaining > 0) {
        const captured = Buffer.from(bytes.subarray(0, remaining));
        chunks.push(captured);
        capturedBytes += captured.length;
        try {
          writeOutput(captured);
        } catch {
          // Console mirroring is non-authoritative; captured bytes remain sealed.
        }
      }
      if (!exceeded && bytes.length > remaining) {
        exceeded = true;
        stop(`Command ${name} exceeded ${byteLimit} bytes.`);
      }
    },
    value() {
      return Buffer.concat(chunks, capturedBytes);
    },
  };
}

function ownedProcessTree(child, { platform, signalProcess }) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return null;
  const processId = child.pid;
  const ownsProcessGroup = platform !== "win32";
  const target = ownsProcessGroup ? -processId : processId;
  const signal = (value) => {
    try {
      if (ownsProcessGroup) signalProcess(target, value);
      else if (!child.kill(value)) return false;
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };
  return {
    isAlive() {
      if (!ownsProcessGroup) {
        return child.exitCode === null && child.signalCode === null;
      }
      return signal(0);
    },
    signal,
  };
}

async function terminateProcessTree(
  tree,
  { termGraceMs, killGraceMs, pollIntervalMs },
) {
  const signals = [];
  if (!tree.isAlive()) return { stopped: true, signals };
  if (tree.signal("SIGTERM")) signals.push("SIGTERM");
  if (await waitForProcessTree(tree, termGraceMs, pollIntervalMs)) {
    return { stopped: true, signals };
  }
  if (tree.signal("SIGKILL")) signals.push("SIGKILL");
  return {
    stopped: await waitForProcessTree(tree, killGraceMs, pollIntervalMs),
    signals,
  };
}

async function waitForProcessTree(tree, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (tree.isAlive()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(remaining, pollIntervalMs));
  }
  return true;
}

async function settleWithin(promise, timeoutMs) {
  const expired = Symbol("expired");
  let timer;
  try {
    const outcome = await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(expired), timeoutMs);
      }),
    ]);
    return outcome === expired ? null : outcome;
  } finally {
    clearTimeout(timer);
  }
}

function appendDiagnostics(stderr, diagnostics, byteLimit) {
  if (diagnostics.length === 0) return stderr;
  const suffix = Buffer.from(`${diagnostics.join("\n")}\n`);
  if (suffix.length >= byteLimit) return suffix.subarray(0, byteLimit);
  const separator =
    stderr.length > 0 && stderr.at(-1) !== 10
      ? Buffer.from("\n")
      : Buffer.alloc(0);
  const retainedBytes = Math.max(
    0,
    byteLimit - suffix.length - separator.length,
  );
  return Buffer.concat([stderr.subarray(0, retainedBytes), separator, suffix]);
}

function failedSpawn(error, maxStderrBytes) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: 127,
    stdout: Buffer.alloc(0),
    stderr: appendDiagnostics(
      Buffer.alloc(0),
      [`Command could not start: ${message}.`],
      maxStderrBytes,
    ),
  };
}

function deferred() {
  let settle;
  let settled = false;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      settle(value);
    },
  };
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function displayCommand(planned) {
  const environment = Object.entries(planned.env ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);
  return [...environment, planned.command, ...planned.args]
    .map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = await loadPolicy();
  const artifact = await verifyChange({
    runId: options.runId ?? `local-${Date.now()}`,
    scope: options.scope,
    headSha: await readHeadSha(),
    policySha256: policy.policySha256,
  });
  const rendered = `${JSON.stringify(artifact, null, 2)}\n`;
  if (options.output) {
    await fs.writeFile(path.resolve(repoRoot, options.output), rendered);
  } else {
    process.stdout.write(rendered);
  }
  if (artifact.verdict !== "passed") {
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = { scope: "full" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--scope")
      options.scope = requiredValue(args, ++index, argument);
    else if (argument === "--run-id")
      options.runId = requiredValue(args, ++index, argument);
    else if (argument === "--output")
      options.output = requiredValue(args, ++index, argument);
    else throw new Error(`Unknown verification argument '${argument}'.`);
  }
  return options;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--"))
    throw new Error(`${option} requires a value.`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

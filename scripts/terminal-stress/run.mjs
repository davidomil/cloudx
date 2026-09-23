import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { CommandOutputTail } from "../../containers/ci/diagnostics.mjs";

export const attempts = 3;
export const requiredCases = [
  "delivers a 64 MiB burst with 1024 replay bytes, snapshots, subsequent input, and confirmed termination",
  "drains parsed output without resuming an exited producer during terminate",
  "drains parsed output without resuming an exited producer during stop broker",
  "resumes output parsed while the producer is alive before termination",
  "never retains a partial é character at the oldest boundary",
  "never retains a partial 界 character at the oldest boundary",
  "never retains a partial 😀 character at the oldest boundary",
  "restores a full 32 MiB replay as context with a usable screen and confirmed shell deletion",
];
const maximumReportBytes = 32 * 1024 * 1024;

export async function stressRuntime(cgroup = "/sys/fs/cgroup") {
  const read = async (name) =>
    (await fs.readFile(path.join(cgroup, name), "utf8")).trim();
  return {
    node: process.version,
    platform: process.platform,
    cpu_max: await read("cpu.max"),
    memory_max: await read("memory.max"),
    memory_swap_max: await read("memory.swap.max"),
  };
}

export function requireStressRuntime(runtime) {
  const [quota, period] = runtime.cpu_max.split(" ").map(Number);
  if (
    !/^v22\./u.test(runtime.node) ||
    runtime.platform !== "linux" ||
    quota / period !== 2 ||
    Number(runtime.memory_max) !== 7 * 1024 ** 3 ||
    runtime.memory_swap_max !== "0"
  ) {
    throw new Error(
      "Terminal stress requires Linux, Node 22, two CPUs, 7 GiB RAM and no swap; use containers/ci/terminal-stress.Dockerfile.",
    );
  }
}

export async function runTerminalStress({
  directory,
  runtime,
  command = [process.execPath, "node_modules/vitest/vitest.mjs"],
}) {
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.readdir(directory)).length !== 0)
    throw new Error(
      "Terminal stress output directory must be empty; preserve or remove the previous run first.",
    );
  const results = {
    schema_version: 1,
    kind: "terminal-stress",
    runtime: runtime ?? null,
    planned_attempts: attempts,
    verdict: "incomplete",
    attempts: [],
  };
  const publish = () =>
    writeResults(path.join(directory, "results.json"), results);
  await publish();
  try {
    results.runtime = runtime ?? (await stressRuntime());
    requireStressRuntime(results.runtime);
  } catch (error) {
    results.verdict = "failed";
    results.error = error.message;
    await publish();
    return results;
  }
  for (let number = 1; number <= attempts; number++) {
    const attemptDirectory = path.join(directory, `attempt-${number}`);
    await fs.mkdir(attemptDirectory, { recursive: true });
    const reportPath = path.join(attemptDirectory, "vitest.json");
    const attempt = {
      number,
      outcome: "incomplete",
      started_at: new Date().toISOString(),
    };
    results.attempts.push(attempt);
    await publish();
    Object.assign(
      attempt,
      await runCommand(
        [
          ...command,
          "run",
          "--config",
          "vitest.terminal-stress.config.ts",
          "--reporter=dot",
          "--reporter=json",
          `--outputFile=${reportPath}`,
          `--coverage.reportsDirectory=${path.join(attemptDirectory, "coverage")}`,
        ],
        {
          CLOUDX_TERMINAL_DIAGNOSTICS_DIR: path.join(
            attemptDirectory,
            "diagnostics",
          ),
          CLOUDX_TERMINAL_STRESS_ATTEMPT: String(number),
        },
      ),
    );
    try {
      const report = await readTestReport(reportPath);
      attempt.cases = report.cases;
      attempt.report_errors = report.errors;
    } catch (error) {
      attempt.report_errors = [error.message];
    }
    attempt.outcome =
      attempt.exit_code === 0 && attempt.report_errors.length === 0
        ? "passed"
        : "failed";
    // A later successful attempt can never erase an earlier failure.
    if (attempt.outcome === "failed") results.verdict = "failed";
    await publish();
    process.stdout.write(
      `Terminal stress attempt ${number}/${attempts}: ${attempt.outcome} (${Math.round(attempt.duration_ms)} ms)\n`,
    );
  }
  if (results.verdict !== "failed") results.verdict = "passed";
  await publish();
  return results;
}

async function readTestReport(filename) {
  const size = (await fs.stat(filename)).size;
  if (size > maximumReportBytes) {
    await fs.rm(filename);
    throw new Error("Vitest report exceeded the 32 MiB diagnostic limit.");
  }
  const report = JSON.parse(await fs.readFile(filename, "utf8"));
  const cases = report.testResults
    .flatMap((file) => file.assertionResults)
    .map((test) => ({
      name: test.fullName,
      title: test.title,
      status: test.status,
      duration_ms: test.duration ?? null,
      errors: (test.failureMessages ?? [])
        .slice(0, 4)
        .map((message) => message.slice(-4096)),
    }));
  const errors = [];
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numFailedTestSuites !== 0
  )
    errors.push("Vitest reported a failing test or suite.");
  for (const title of requiredCases) {
    const matches = cases.filter((test) => test.title === title);
    if (matches.length !== 1 || matches[0].status !== "passed")
      errors.push(`Required case did not pass exactly once: ${title}`);
  }
  const selected = cases.filter((test) =>
    /native Forge-owned terminal output|durable terminal broker|terminal replay history|restores a full 32 MiB replay/u.test(
      test.name,
    ),
  );
  if (selected.some((test) => test.status !== "passed"))
    errors.push("A selected terminal case was skipped, incomplete or failed.");
  if (
    selected.some(
      (test) => !Number.isFinite(test.duration_ms) || test.duration_ms < 0,
    )
  )
    errors.push("A selected terminal case has no valid duration.");
  // Retain outcomes and durations, without an unbounded coverage map or stacks.
  await writeResults(filename, { success: report.success, cases, errors });
  return { cases, errors };
}

export async function runCommand(command, env = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    const stdout = new CommandOutputTail();
    const stderr = new CommandOutputTail();
    const child = spawn(command[0], command.slice(1), {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.on("error", (error) => stderr.append(Buffer.from(error.message)));
    child.on("close", (code, signal) =>
      resolve({
        exit_code: code,
        signal,
        duration_ms: performance.now() - started,
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot(),
      }),
    );
  });
}

async function writeResults(filename, results) {
  const temporary = `${filename}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(results, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function main() {
  const directory = path.resolve("test-results/terminal-stress");
  const results = await runTerminalStress({ directory });
  if (results.attempts.length !== attempts) {
    process.exitCode = 1;
    return;
  }
  const measurement = await runCommand([
    process.execPath,
    "--import",
    "tsx",
    "scripts/terminal-stress/measure-replay.mjs",
    path.join(directory, "throughput.json"),
  ]);
  results.measurement = measurement;
  if (measurement.exit_code !== 0) results.verdict = "failed";
  await writeResults(path.join(directory, "results.json"), results);
  if (results.verdict !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();

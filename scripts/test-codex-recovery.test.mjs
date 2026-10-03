import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { CODEX_CLI_VERSION } from "./install-cloudx.mjs";

const runner = fileURLToPath(new URL("test-codex-recovery.mjs", import.meta.url));
const fixtures = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fs.rm(fixture, { recursive: true, force: true }))); });

function run(env = {}) {
  const base = { ...process.env };
  delete base.CLOUDX_NATIVE_CODEX;
  delete base.CLOUDX_NATIVE_CODEX_VERSION;
  return spawnSync(process.execPath, [runner], { env: { ...base, ...env }, encoding: "utf8", timeout: 5_000 });
}

it("fails required native validation when no executable is selected", () => {
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Native recovery validation must not be skipped");
});

it("rejects a selected executable that cannot report its version", () => {
  const result = run({ CLOUDX_NATIVE_CODEX: "/bin/false" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("did not return its installed version");
});

it.each([
  ["0.153.4", undefined, "Expected supported Codex 0.156.1 or 0.157.1; found 0.153.4"],
  ["0.155.1", undefined, "Expected supported Codex 0.156.1 or 0.157.1; found 0.155.1"],
  ["0.156.1", "0.157.1", "Expected supported Codex 0.157.1; found 0.156.1"]
])("rejects unsupported or mismatched native version %s", async (version, expected, diagnostic) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-version-"));
  fixtures.push(fixture);
  const binary = path.join(fixture, "codex");
  await fs.writeFile(binary, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`, { mode: 0o700 });
  const result = run({ CLOUDX_NATIVE_CODEX: binary, ...(expected ? { CLOUDX_NATIVE_CODEX_VERSION: expected } : {}) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(result.stdout).not.toContain("RUN");
});

it.each(["installer", "0.156.1"])("CI installs and validates the exact %s native version", async release => {
  const workflow = parse(await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const job = workflow.jobs["codex-native"];
  expect(job.strategy.matrix.codex).toEqual(["installer", "0.156.1"]);
  const install = job.steps.find(step => step.id === "codex");
  expect(install.env.CODEX_RELEASE).toBe("${{ matrix.codex }}");
  expect(job.steps.find(step => step.env?.CLOUDX_NATIVE_CODEX_VERSION).env.CLOUDX_NATIVE_CODEX_VERSION)
    .toBe("${{ steps.codex.outputs.version }}");

  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-ci-"));
  fixtures.push(fixture);
  const commandLog = path.join(fixture, "npm-command.json");
  const outputs = path.join(fixture, "github-output");
  const runnerTemp = path.join(fixture, "runner temp");
  await fs.writeFile(path.join(fixture, "npm"), `#!${process.execPath}
import fs from "node:fs";
fs.writeFileSync(process.env.NPM_COMMAND_LOG, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });
  const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", install.run], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PATH: `${fixture}${path.delimiter}${process.env.PATH}`, CODEX_RELEASE: release,
      RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: outputs, NPM_COMMAND_LOG: commandLog },
    encoding: "utf8", timeout: 5_000
  });
  expect(result.status, result.stderr).toBe(0);
  const version = release === "installer" ? CODEX_CLI_VERSION : release;
  expect(JSON.parse(await fs.readFile(commandLog, "utf8"))).toEqual([
    "install", "--global", "--prefix", path.join(runnerTemp, "codex"),
    "--ignore-scripts", "--no-audit", "--no-fund", `@openai/codex@${version}`
  ]);
  expect(await fs.readFile(outputs, "utf8")).toBe(`version=${version}\n`);
});

async function runNativeValidation(scenario = {}) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-runner-"));
  fixtures.push(fixture);
  const preload = path.join(fixture, "native-processes.mjs");
  const commandLog = path.join(fixture, "commands.jsonl");
  await fs.writeFile(preload, `
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const scenario = ${JSON.stringify(scenario)};
childProcess.spawnSync = (command, args, options) => {
  fs.appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ command, args, timeout: options.timeout }) + "\\n");
  if (args[0] === "--version") return { status: 0, stdout: "codex-cli 0.157.1\\n" };
  if (args[1] === "run") {
    if ((scenario.durationMs ?? 60_000) > options.timeout)
      return { error: Object.assign(new Error("Native suite deadline exceeded"), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM" };
    const suites = args.slice(2, args.indexOf("--maxWorkers=1"));
    const reportPath = args.find(arg => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);
    const testResults = suites.map(name => ({ name: path.join(options.cwd, name), assertionResults: [{ status: "passed" }] }));
    const report = { numTotalTests: suites.length, numPassedTests: suites.length, numPendingTests: 0, numFailedTests: 0, testResults };
    if (scenario.result === "skipped") { report.numPendingTests = 1; report.numPassedTests--; testResults[0].assertionResults[0].status = "pending"; }
    if (scenario.result === "failed") { report.numFailedTests = 1; report.numPassedTests--; testResults[0].assertionResults[0].status = "failed"; }
    if (scenario.result === "missing") { report.testResults.pop(); report.numTotalTests--; report.numPassedTests--; }
    if (scenario.result === "empty") { report.numTotalTests = 0; report.numPassedTests = 0; report.testResults = []; }
    if (scenario.result === "unreported-skip") testResults[0].assertionResults[0].status = "pending";
    fs.writeFileSync(reportPath, JSON.stringify(report));
    return { status: scenario.suiteExit ?? 0 };
  }
  if (path.basename(args[0]) === "codex-runtime-verification.mjs") return { status: scenario.runtimeExit ?? 0 };
  throw new Error("Unexpected native validation command: " + JSON.stringify(args));
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, runner], {
    env: { ...process.env, CLOUDX_NATIVE_CODEX: path.join(fixture, "codex"), CLOUDX_NATIVE_CODEX_VERSION: "0.157.1" },
    encoding: "utf8", timeout: 5_000
  });
  const commands = (await fs.readFile(commandLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const suiteCommand = commands.find(command => command.args[1] === "run");
  const reportPath = suiteCommand.args.find(arg => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);
  await expect(fs.stat(path.dirname(reportPath))).rejects.toMatchObject({ code: "ENOENT" });
  return { ...result, commands };
}

it("lets the complete serial native suite finish beyond two minutes before checking the built verifier", async () => {
  const result = await runNativeValidation({ durationMs: 180_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.commands[1].args.slice(2, 9)).toEqual([
    "apps/server/src/plugins/CodexConversationRecovery.native.test.ts",
    "apps/server/src/plugins/CodexWorkerBridge.native.test.ts",
    "apps/server/src/plugins/CodexModelDefaults.native.test.ts",
    "apps/server/src/rulesSkills/CodexHomeOverlay.native.test.ts",
    "apps/server/src/plugins/CodexVersionSelection.native.test.ts",
    "apps/server/src/plugins/CodexFirstSelection.native.test.ts",
    "scripts/codex-updater.native.test.mjs"
  ]);
  expect(result.commands[1].args).toContain("--maxWorkers=1");
  expect(result.commands[1].timeout).toBeLessThanOrEqual(300_000);
  expect(result.commands).toHaveLength(3);
  expect(result.commands[2]).toMatchObject({ timeout: 60_000 });
  expect(path.basename(result.commands[2].args[0])).toBe("codex-runtime-verification.mjs");
});

it.each([
  [{ durationMs: 310_000 }, "Native suite deadline exceeded"],
  [{ suiteExit: 1 }, "Native Codex validation exited 1"],
  [{ result: "skipped" }, "skipped tests are not accepted"],
  [{ result: "failed" }, "must run every selected case successfully"],
  [{ result: "empty" }, "must run every selected case successfully"],
  [{ result: "unreported-skip" }, "Required native suite did not pass every case"],
  [{ result: "missing" }, "Required native suite did not pass every case"]
])("rejects incomplete native validation %j without running the built verifier", async (scenario, diagnostic) => {
  const result = await runNativeValidation(scenario);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(result.commands).toHaveLength(2);
});

it("rejects a failed built runtime verifier after the native suites pass", async () => {
  const result = await runNativeValidation({ runtimeExit: 1 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("The built updater runtime verifier did not pass");
  expect(result.commands).toHaveLength(3);
});

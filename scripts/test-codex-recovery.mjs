import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const binary = process.env.CLOUDX_NATIVE_CODEX;
if (!binary || !path.isAbsolute(binary)) {
  console.error("Set CLOUDX_NATIVE_CODEX to the absolute installed Codex executable. Native recovery validation must not be skipped.");
  process.exit(1);
}
const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 65_536 });
if (version.error || version.status !== 0 || !/^codex-cli \S+\s*$/u.test(version.stdout)) {
  console.error("The configured Codex executable did not return its installed version.");
  process.exit(1);
}
const installedVersion = version.stdout.trim().slice("codex-cli ".length);
const supportedVersions = ["0.156.1", "0.157.1"];
if (!supportedVersions.includes(installedVersion) || process.env.CLOUDX_NATIVE_CODEX_VERSION && installedVersion !== process.env.CLOUDX_NATIVE_CODEX_VERSION) {
  console.error(`Expected supported Codex ${process.env.CLOUDX_NATIVE_CODEX_VERSION ?? supportedVersions.join(" or ")}; found ${installedVersion}.`);
  process.exit(1);
}
if (!process.env.CLOUDX_NATIVE_PREVIOUS_CODEX || !path.isAbsolute(process.env.CLOUDX_NATIVE_PREVIOUS_CODEX)) {
  console.error("Set CLOUDX_NATIVE_PREVIOUS_CODEX to another absolute Codex executable for required cross-version conversation and running-session validation.");
  process.exit(1);
}
const resultsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-codex-native-results-"));
const resultsPath = path.join(resultsDirectory, "results.json");
console.log(`Validating native conversation recovery with ${version.stdout.trim()}`);
const root = fileURLToPath(new URL("..", import.meta.url));
const requiredSuites = [
  "apps/server/src/plugins/CodexConversationRecovery.native.test.ts",
  "apps/server/src/plugins/CodexWorkerBridge.native.test.ts",
  "scripts/codex-updater.native.test.mjs"
];
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json"))), "run",
  ...requiredSuites,
  "--reporter=default", "--reporter=json", `--outputFile.json=${resultsPath}`
], { cwd: root, env: process.env, stdio: "inherit", timeout: 120_000 });
try {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native Codex validation exited ${result.status ?? result.signal}.`);
  const report = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  if (!report.numTotalTests || report.numPendingTests || report.numFailedTests || report.numPassedTests !== report.numTotalTests)
    throw new Error("Native Codex validation must run every selected case successfully; skipped tests are not accepted.");
  for (const suite of requiredSuites) {
    const result = report.testResults.find(value => value.name === path.join(root, suite));
    if (!result?.assertionResults?.length || result.assertionResults.some(value => value.status !== "passed"))
      throw new Error(`Required native suite did not pass every case: ${suite}`);
  }
  const runtime = spawnSync(process.execPath, [fileURLToPath(new URL("codex-runtime-verification.mjs", import.meta.url)), binary], {
    cwd: root, env: process.env, stdio: "inherit", timeout: 60_000
  });
  if (runtime.error) throw runtime.error;
  if (runtime.status !== 0) throw new Error("The built updater runtime verifier did not pass.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(resultsDirectory, { recursive: true, force: true });
}

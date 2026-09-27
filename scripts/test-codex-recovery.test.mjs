import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  delete base.CLOUDX_NATIVE_PREVIOUS_CODEX;
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
  ["0.156.1", "0.157.1", "Expected supported Codex 0.157.1; found 0.156.1"],
  ["0.157.1", "0.157.1", "Set CLOUDX_NATIVE_PREVIOUS_CODEX"]
])("rejects incomplete required native version configuration %s", async (version, expected, diagnostic) => {
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

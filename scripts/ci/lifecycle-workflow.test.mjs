import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

it.each([
  ["clean-install", "install"],
  ["installed-upgrade", "upgrade"],
])("%s prepares the browser path for subsequent steps", (jobName, scenario) => {
  const workflow = parseDocument(
    fs.readFileSync(".github/workflows/ci.yml", "utf8"),
  ).toJS();
  const runnerTemp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx lifecycle workflow "),
  );
  const githubEnv = path.join(runnerTemp, "github-env");
  const sourceSha = "a".repeat(40);
  const targetSha = "b".repeat(40);
  fs.writeFileSync(githubEnv, "");

  try {
    execFileSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-euo",
        "pipefail",
        "-c",
        workflow.jobs[jobName].steps[0].run,
      ],
      {
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: runnerTemp,
          GITHUB_ENV: githubEnv,
          SOURCE_SHA: sourceSha,
          TARGET_SHA: targetSha,
        },
        timeout: 5000,
      },
    );

    expect(fs.readFileSync(githubEnv, "utf8")).toBe(
      `PLAYWRIGHT_BROWSERS_PATH=${path.join(runnerTemp, "cloudx-lifecycle-browsers")}\n`,
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(runnerTemp, `lifecycle-${scenario}`, "request.json"),
          "utf8",
        ),
      ),
    ).toEqual({ scenario, sourceSha, targetSha, result: "setup-started" });
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

const diskFixtures = [];
const minimumBytes = 24 * 1024 ** 3;
const failedRunnerAvailableBytes = 91_885_858_816;
const sdkCleanup = [
  "rm",
  "-rf",
  "--",
  "/usr/local/lib/android/sdk",
  "/usr/share/dotnet",
];

afterEach(() => {
  for (const fixture of diskFixtures.splice(0))
    fs.rmSync(fixture, { recursive: true, force: true });
});

function lifecycleSetup(jobName, scenario, available) {
  const { steps } = parseDocument(
    fs.readFileSync(".github/workflows/ci.yml", "utf8"),
  ).toJS().jobs[jobName];
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx lifecycle disk "),
  );
  diskFixtures.push(fixture);
  const workspace = path.join(fixture, "workspace");
  const runnerTemp = path.join(fixture, "runner-temp");
  const bin = path.join(fixture, "bin");
  for (const directory of [workspace, runnerTemp, bin]) fs.mkdirSync(directory);
  const githubEnv = path.join(fixture, "github-env");
  const counter = path.join(fixture, "df-count");
  const sudoLog = path.join(fixture, "sudo.jsonl");
  fs.writeFileSync(githubEnv, "");
  fs.writeFileSync(counter, "0");
  fs.writeFileSync(sudoLog, "");
  fs.writeFileSync(
    path.join(bin, "df"),
    `#!${process.execPath}
const fs = require("node:fs");
const count = Number(fs.readFileSync(process.env.DF_COUNTER, "utf8"));
fs.writeFileSync(process.env.DF_COUNTER, String(count + 1));
const values = JSON.parse(process.env.DF_VALUES);
if (count >= values.length) throw new Error("Unexpected extra disk check");
const available = values[count];
if (process.argv.includes("--output=avail")) console.log("Avail\\n" + available);
else console.log("Filesystem 1B-blocks Used Available Use% Mounted on\\n/fake 154894188544 62991552512 " + available + " 41% /");
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "sudo"),
    `#!${process.execPath}
require("node:fs").appendFileSync(process.env.SUDO_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
    GITHUB_ENV: githubEnv,
    SOURCE_SHA: "a".repeat(40),
    TARGET_SHA: "b".repeat(40),
    DF_COUNTER: counter,
    DF_VALUES: JSON.stringify(available),
    SUDO_LOG: sudoLog,
  };
  let result;
  for (const step of steps) {
    if (step.uses?.startsWith("actions/checkout@")) {
      fs.mkdirSync(path.join(workspace, "scripts"));
      fs.symlinkSync(
        path.resolve("scripts/ci"),
        path.join(workspace, "scripts/ci"),
        "dir",
      );
    } else if (step.run) {
      result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-euo", "pipefail", "-c", step.run],
        { cwd: workspace, env, encoding: "utf8", timeout: 5_000 },
      );
      if (result.status !== 0 || step.id === "lifecycle-space") break;
    }
  }
  const evidence = path.join(runnerTemp, `lifecycle-${scenario}`);
  expect(fs.readFileSync(githubEnv, "utf8")).toBe(
    `PLAYWRIGHT_BROWSERS_PATH=${path.join(runnerTemp, "cloudx-lifecycle-browsers")}\n`,
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(evidence, "request.json"), "utf8")),
  ).toEqual({
    scenario,
    sourceSha: env.SOURCE_SHA,
    targetSha: env.TARGET_SHA,
    result: "setup-started",
  });
  return {
    ...result,
    evidence,
    cleanup: fs
      .readFileSync(sudoLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

describe.each([
  ["clean-install", "install"],
  ["installed-upgrade", "upgrade"],
])("%s lifecycle disk preparation", (jobName, scenario) => {
  it("makes the exact target helper available after early evidence and before disk preparation", () => {
    const { steps } = parseDocument(
      fs.readFileSync(".github/workflows/ci.yml", "utf8"),
    ).toJS().jobs[jobName];
    const checkout = steps.findIndex((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const space = steps.findIndex((step) => step.id === "lifecycle-space");
    expect(steps[0].name).toBe(
      "Initialize lifecycle evidence and browser path before setup",
    );
    expect(checkout).toBe(1);
    expect(checkout).toBeLessThan(space);
    expect(steps[checkout].with).toEqual({
      ref: "${{ needs.lifecycle-revisions.outputs.target-sha }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(steps[space]["timeout-minutes"]).toBe(5);
    expect(
      steps.find(
        (step) =>
          step.name ===
          `Require the real ${scenario} lifecycle on a fresh Ubuntu user`,
      ).run,
    ).toBe(
      `sudo --preserve-env=PLAYWRIGHT_BROWSERS_PATH env CLOUDX_LIFECYCLE_DISPOSABLE=1 PATH="$PATH" bash scripts/ci/lifecycle-host.sh ${scenario} "$SOURCE_SHA" "$TARGET_SHA" "$RUNNER_TEMP/lifecycle-${scenario}"`,
    );
  });

  it("preserves ample-space lifecycle evidence without deleting SDKs", () => {
    const bytes = failedRunnerAvailableBytes;
    const result = lifecycleSetup(jobName, scenario, [bytes, bytes, bytes]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.cleanup).toEqual([]);
    for (const name of ["before", "after"])
      expect(
        fs.readFileSync(
          path.join(result.evidence, `disk-space-${name}.txt`),
          "utf8",
        ),
      ).toContain(String(bytes));
  });

  it("uses the shared guard once and retains both disk snapshots when cleanup is necessary", () => {
    const result = lifecycleSetup(jobName, scenario, [
      minimumBytes - 1,
      minimumBytes - 1,
      minimumBytes,
      minimumBytes,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.cleanup).toEqual([sdkCleanup]);
    expect(
      fs.readFileSync(
        path.join(result.evidence, "disk-space-before.txt"),
        "utf8",
      ),
    ).toContain(String(minimumBytes - 1));
    expect(
      fs.readFileSync(
        path.join(result.evidence, "disk-space-after.txt"),
        "utf8",
      ),
    ).toContain(String(minimumBytes));
  });

  it("retains early failure evidence when SDK cleanup cannot establish capacity", () => {
    const result = lifecycleSetup(jobName, scenario, [0, 0, minimumBytes - 1]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Verifier preparation needs");
    expect(result.cleanup).toEqual([sdkCleanup]);
    expect(
      fs.readFileSync(
        path.join(result.evidence, "disk-space-before.txt"),
        "utf8",
      ),
    ).toContain("/fake");
  });
});

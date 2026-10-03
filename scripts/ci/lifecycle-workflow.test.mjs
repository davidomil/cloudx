import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
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

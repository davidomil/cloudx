import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const minimumBytes = 24 * 1024 ** 3;
const ampleBytes = 91_706_322_944;
const fixtures = [];
const cleanupArguments = [
  "rm",
  "-rf",
  "--",
  "/usr/local/lib/android/sdk",
  "/usr/share/dotnet",
];

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    fs.rmSync(fixture, { recursive: true, force: true });
});

function prepareVerifier(
  job,
  { available = [ampleBytes, ampleBytes], dfExit = 0, cleanupExit = 0 } = {},
) {
  const workflow = parseDocument(
    fs.readFileSync(".github/workflows/ci.yml", "utf8"),
  ).toJS();
  const step = workflow.jobs[job].steps.find(
    (step) =>
      step.name === "Free unused runner SDKs before building the verifier",
  );
  expect(step.if).toBe("runner.environment == 'github-hosted'");
  expect(step["timeout-minutes"]).toBe(5);
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx verifier disk "),
  );
  fixtures.push(fixture);
  const bin = path.join(fixture, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(fixture, "controller/scripts"), { recursive: true });
  fs.symlinkSync(
    path.resolve("scripts/ci"),
    path.join(fixture, "controller/scripts/ci"),
    "dir",
  );
  const counter = path.join(fixture, "df-count");
  const sudoLog = path.join(fixture, "sudo.jsonl");
  fs.writeFileSync(counter, "0");
  fs.writeFileSync(sudoLog, "");
  fs.writeFileSync(
    path.join(bin, "df"),
    `#!${process.execPath}
const fs = require("node:fs");
const count = Number(fs.readFileSync(process.env.DF_COUNTER, "utf8"));
fs.writeFileSync(process.env.DF_COUNTER, String(count + 1));
if (Number(process.env.DF_EXIT)) { console.error("fixture df failed"); process.exit(Number(process.env.DF_EXIT)); }
const values = JSON.parse(process.env.DF_VALUES);
if (count >= values.length) throw new Error("Unexpected extra disk check");
const available = values[count];
if (process.argv.includes("--output=avail")) console.log("Avail\\n" + available);
else console.log("Filesystem 1B-blocks Used Available Use% Mounted on\\n/fake 154894188544 63171088384 " + available + " 41% /");
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "sudo"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.SUDO_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (Number(process.env.CLEANUP_EXIT)) console.error("fixture SDK cleanup failed");
process.exit(Number(process.env.CLEANUP_EXIT));
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-euo", "pipefail", "-c", step.run],
    {
      cwd: fixture,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RUNNER_ENVIRONMENT: "github-hosted",
        DF_COUNTER: counter,
        DF_VALUES: JSON.stringify(available),
        DF_EXIT: String(dfExit),
        SUDO_LOG: sudoLog,
        CLEANUP_EXIT: String(cleanupExit),
      },
      timeout: 5_000,
      encoding: "utf8",
    },
  );
  return {
    ...result,
    checks: Number(fs.readFileSync(counter, "utf8")),
    cleanup: fs
      .readFileSync(sudoLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

describe.each(["isolated-lanes", "coverage-merge"])(
  "%s verifier disk preparation",
  (job) => {
    it("skips SDK deletion when the runner already has ample disk space", () => {
      const result = prepareVerifier(job);
      expect(result.status, result.stderr).toBe(0);
      expect(result.cleanup).toEqual([]);
      expect(result.checks).toBe(1);
      expect(result.stdout).toContain(String(ampleBytes));
    });

    it("admits exactly the policy floor without deleting SDKs", () => {
      const result = prepareVerifier(job, {
        available: [minimumBytes, minimumBytes],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.cleanup).toEqual([]);
      expect(result.checks).toBe(1);
    });

    it("deletes only the two existing SDK targets once when capacity is insufficient", () => {
      const result = prepareVerifier(job, {
        available: [minimumBytes - 1, minimumBytes],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.cleanup).toEqual([cleanupArguments]);
      expect(result.checks).toBe(2);
    });

    it("refuses the build if SDK cleanup does not establish the policy floor", () => {
      const result = prepareVerifier(job, {
        available: [minimumBytes - 2, minimumBytes - 1],
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Verifier preparation needs");
      expect(result.cleanup).toEqual([cleanupArguments]);
      expect(result.checks).toBe(2);
    });

    it("rejects invalid capacity without deleting SDKs", () => {
      const result = prepareVerifier(job, {
        available: ["unknown", "unknown"],
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Invalid available disk bytes");
      expect(result.cleanup).toEqual([]);
    });

    it("propagates a failed capacity inspection without deleting SDKs", () => {
      const result = prepareVerifier(job, { dfExit: 19 });
      expect(result.status).toBe(19);
      expect(result.stderr).toContain("fixture df failed");
      expect(result.cleanup).toEqual([]);
    });

    it("propagates cleanup failure without attempting admission again", () => {
      const result = prepareVerifier(job, { available: [0], cleanupExit: 23 });
      expect(result.status).toBe(23);
      expect(result.stderr).toContain("fixture SDK cleanup failed");
      expect(result.cleanup).toEqual([cleanupArguments]);
      expect(result.checks).toBe(1);
    });
  },
);

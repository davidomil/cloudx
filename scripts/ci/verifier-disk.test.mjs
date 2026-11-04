import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkflow } from "./local.mjs";

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

function prepareLifecycleDisk({
  available = [ampleBytes, ampleBytes],
  dfExit = 0,
  cleanupExit = 0,
} = {}) {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx verifier disk "),
  );
  fixtures.push(fixture);
  const bin = path.join(fixture, "bin");
  fs.mkdirSync(bin);
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
    [path.resolve("scripts/ci/prepare-verifier-disk.sh")],
    {
      cwd: fixture,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
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

describe("lifecycle disk preparation", () => {
  it("skips SDK deletion when the runner already has ample disk space", () => {
    const result = prepareLifecycleDisk();
    expect(result.status, result.stderr).toBe(0);
    expect(result.cleanup).toEqual([]);
    expect(result.checks).toBe(1);
    expect(result.stdout).toContain(String(ampleBytes));
  });

  it("admits exactly the policy floor without deleting SDKs", () => {
    const result = prepareLifecycleDisk({
      available: [minimumBytes, minimumBytes],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.cleanup).toEqual([]);
    expect(result.checks).toBe(1);
  });

  it("deletes only the two existing SDK targets once when capacity is insufficient", () => {
    const result = prepareLifecycleDisk({
      available: [minimumBytes - 1, minimumBytes],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.cleanup).toEqual([cleanupArguments]);
    expect(result.checks).toBe(2);
  });

  it("refuses the build if SDK cleanup does not establish the policy floor", () => {
    const result = prepareLifecycleDisk({
      available: [minimumBytes - 2, minimumBytes - 1],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Verifier preparation needs");
    expect(result.cleanup).toEqual([cleanupArguments]);
    expect(result.checks).toBe(2);
  });

  it("rejects invalid capacity without deleting SDKs", () => {
    const result = prepareLifecycleDisk({
      available: ["unknown", "unknown"],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid available disk bytes");
    expect(result.cleanup).toEqual([]);
  });

  it("propagates a failed capacity inspection without deleting SDKs", () => {
    const result = prepareLifecycleDisk({ dfExit: 19 });
    expect(result.status).toBe(19);
    expect(result.stderr).toContain("fixture df failed");
    expect(result.cleanup).toEqual([]);
  });

  it("propagates cleanup failure without attempting admission again", () => {
    const result = prepareLifecycleDisk({ available: [0], cleanupExit: 23 });
    expect(result.status).toBe(23);
    expect(result.stderr).toContain("fixture SDK cleanup failed");
    expect(result.cleanup).toEqual([cleanupArguments]);
    expect(result.checks).toBe(1);
  });
});

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fsp.rm(root, { recursive: true, force: true });
});

async function prepare({
  available = "91765067776",
  reclaimed = "60000000000",
  measurementFails = false,
  cleanupFails = false,
} = {}) {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "cloudx-verifier-disk-"),
  );
  roots.push(root);
  await fsp.writeFile(path.join(root, "available"), available);
  await fsp.writeFile(
    path.join(root, "df"),
    `#!/bin/bash
set -euo pipefail
if [[ $* == '-B1 /' ]]; then echo 'Filesystem Available'; exit 0; fi
[[ $* == '-B1 --output=avail /' ]] || exit 90
echo Available
cat "$DISK_FIXTURE/available"
[[ $DISK_MEASUREMENT_FAILS == false ]] || exit 91
`,
    { mode: 0o700 },
  );
  await fsp.writeFile(
    path.join(root, "sudo"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DISK_FIXTURE/cleanup"
[[ $DISK_CLEANUP_FAILS == false ]] || exit 92
printf '%s' "$DISK_RECLAIMED" > "$DISK_FIXTURE/available"
`,
    { mode: 0o700 },
  );
  const result = spawnSync("bash", ["scripts/ci/verifier-disk.sh"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      DISK_FIXTURE: root,
      DISK_RECLAIMED: reclaimed,
      DISK_MEASUREMENT_FAILS: String(measurementFails),
      DISK_CLEANUP_FAILS: String(cleanupFails),
    },
    timeout: 5_000,
  });
  const cleanup = await fsp
    .readFile(path.join(root, "cleanup"), "utf8")
    .catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  return { ...result, cleanup };
}

it("starts the verifier without traversing unused SDKs when the observed runner already has 91.8 GB free", async () => {
  const result = await prepare();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("91765067776 bytes free");
  expect(result.cleanup).toBe("");
});

it("keeps SDKs when capacity exactly meets the reserve, including padded df output", async () => {
  const result = await prepare({ available: "  25769803776  " });
  expect(result.status, result.stderr).toBe(0);
  expect(result.cleanup).toBe("");
});

it("reclaims only the two unused SDKs when the measured capacity is below the verifier reserve", async () => {
  const result = await prepare({ available: "14000000000" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.cleanup).toBe(
    "rm -rf -- /usr/local/lib/android/sdk /usr/share/dotnet\n",
  );
  expect(result.stdout).toContain("60000000000 bytes free");
});

it("fails clearly when one cleanup cannot supply the reserved capacity and never retries", async () => {
  const result = await prepare({
    available: "14000000000",
    reclaimed: "20000000000",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "insufficient disk space for the verifier build",
  );
  expect(result.cleanup.trim().split("\n")).toHaveLength(1);
});

it.each([
  { measurementFails: true },
  { available: "unavailable" },
  { cleanupFails: true, available: "14000000000" },
])("propagates failed disk preparation: %j", async (input) => {
  const result = await prepare(input);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("Verifier build capacity:");
  if (!input.cleanupFails) expect(result.cleanup).toBe("");
});

it("uses the same bounded hosted-only preparation before both verifier image builds", async () => {
  const { jobs } = await readWorkflow();
  for (const name of ["isolated-lanes", "coverage-merge"]) {
    const steps = jobs[name].steps;
    const index = steps.findIndex(
      (step) => step.run === "bash controller/scripts/ci/verifier-disk.sh",
    );
    expect(index).toBeGreaterThan(-1);
    expect(
      steps.filter((step) =>
        /scripts\/ci\/(?:prepare-verifier-disk|verifier-disk)\.sh/u.test(
          step.run ?? "",
        ),
      ),
    ).toEqual([steps[index]]);
    expect(steps[index]).toMatchObject({
      if: "runner.environment == 'github-hosted'",
      "timeout-minutes": 5,
    });
    expect(
      steps.findIndex((step) =>
        step.uses?.startsWith("docker/build-push-action@"),
      ),
    ).toBeGreaterThan(index);
  }
});

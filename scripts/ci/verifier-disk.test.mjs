import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { readWorkflow } from "./local.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function prepare({ available = "91765067776", reclaimed = "60000000000", measurementFails = false, cleanupFails = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-verifier-disk-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "available"), available);
  await fs.writeFile(path.join(root, "df"), `#!/bin/bash
set -euo pipefail
if [[ $* == '-B1 /' ]]; then echo 'Filesystem Available'; exit 0; fi
[[ $* == '-B1 --output=avail /' ]] || exit 90
echo Available
cat "$DISK_FIXTURE/available"
[[ $DISK_MEASUREMENT_FAILS == false ]] || exit 91
`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "sudo"), `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DISK_FIXTURE/cleanup"
[[ $DISK_CLEANUP_FAILS == false ]] || exit 92
printf '%s' "$DISK_RECLAIMED" > "$DISK_FIXTURE/available"
`, { mode: 0o700 });
  const result = spawnSync("bash", ["scripts/ci/verifier-disk.sh"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, DISK_FIXTURE: root,
      DISK_RECLAIMED: reclaimed, DISK_MEASUREMENT_FAILS: String(measurementFails), DISK_CLEANUP_FAILS: String(cleanupFails) },
    timeout: 5_000,
  });
  const cleanup = await fs.readFile(path.join(root, "cleanup"), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
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
  expect(result.cleanup).toBe("rm -rf -- /usr/local/lib/android/sdk /usr/share/dotnet\n");
  expect(result.stdout).toContain("60000000000 bytes free");
});

it("fails clearly when one cleanup cannot supply the reserved capacity and never retries", async () => {
  const result = await prepare({ available: "14000000000", reclaimed: "20000000000" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("insufficient disk space for the verifier build");
  expect(result.cleanup.trim().split("\n")).toHaveLength(1);
});

it.each([{ measurementFails: true }, { available: "unavailable" }, { cleanupFails: true, available: "14000000000" }])("propagates failed disk preparation: %j", async input => {
  const result = await prepare(input);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("Verifier build capacity:");
  if (!input.cleanupFails) expect(result.cleanup).toBe("");
});

it("uses the same bounded hosted-only preparation before both verifier image builds", async () => {
  const { jobs } = await readWorkflow();
  for (const name of ["isolated-lanes", "coverage-merge"]) {
    const steps = jobs[name].steps;
    const index = steps.findIndex(step => step.run === "bash controller/scripts/ci/verifier-disk.sh");
    expect(index).toBeGreaterThan(-1);
    expect(steps[index]).toMatchObject({ if: "runner.environment == 'github-hosted'", "timeout-minutes": 5 });
    expect(steps.findIndex(step => step.uses?.startsWith("docker/build-push-action@"))).toBeGreaterThan(index);
  }
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { completeVerificationEvidence } from "../../containers/ci/run.mjs";
import { reportBytes } from "../../containers/ci/reports.mjs";

const directories = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-verification-reports-"),
  );
  directories.push(root);
  await fs.mkdir(path.join(root, "test-results/timings"), { recursive: true });
  await fs.writeFile(
    path.join(root, "test-results/timings/vitest.json"),
    JSON.stringify({ tests: 1 }),
  );
  return root;
}

it.each(["passed", "failed"])(
  "never reads mutable candidate files after cleanup fails following a %s result",
  async (verdict) => {
    const root = await fixture();
    const lstat = vi.spyOn(fs, "lstat");
    const open = vi.spyOn(fs, "open");
    const settleCandidates = vi
      .fn()
      .mockRejectedValue(
        new Error("Candidate UID 10001 still owns live processes."),
      );

    const result = await completeVerificationEvidence({
      root,
      lane: "coverage-1",
      evidence: { verdict },
      settleCandidates,
    });

    expect(settleCandidates).toHaveBeenCalledOnce();
    expect(result.verdict).toBe("failed");
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        command: "terminate candidate processes",
        exit_code: 1,
      }),
    );
    expect(result.unavailable_reports).toEqual([
      {
        name: "candidate-reports",
        reason: "candidate-processes-not-quiescent",
      },
    ]);
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("timing_report");
    expect(result).not.toHaveProperty("lifecycle_reports");
  },
);

it("retains available failure evidence after final process quiescence and marks missing reports", async () => {
  const root = await fixture();
  let quiescent = false;
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation((...args) => {
    expect(quiescent).toBe(true);
    return open(...args);
  });

  const result = await completeVerificationEvidence({
    root,
    lane: "coverage-1",
    evidence: { verdict: "failed" },
    settleCandidates: async () => {
      quiescent = true;
    },
  });

  expect(result.verdict).toBe("failed");
  expect(JSON.parse(reportBytes(result.timing_report))).toEqual({ tests: 1 });
  expect(result.unavailable_reports).toEqual([
    { name: "coverage_report", reason: "not-produced" },
  ]);
  expect(result.lifecycle_reports.files).toEqual([]);
});

it("accepts complete reports only after quiescence and rejects missing success evidence", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, ".vitest-reports"));
  await fs.writeFile(
    path.join(root, ".vitest-reports/blob-1-4.json"),
    "coverage fixture",
  );
  const options = {
    root,
    lane: "coverage-1",
    settleCandidates: async () => {},
  };

  const complete = await completeVerificationEvidence({
    ...options,
    evidence: { verdict: "passed" },
  });
  expect(complete.verdict).toBe("passed");
  expect(reportBytes(complete.coverage_report).toString()).toBe(
    "coverage fixture",
  );

  await fs.unlink(path.join(root, ".vitest-reports/blob-1-4.json"));
  const missing = await completeVerificationEvidence({
    ...options,
    evidence: { verdict: "passed" },
  });
  expect(missing.verdict).toBe("failed");
  expect(missing.report_error).toContain("ENOENT");
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { verificationCommands } from "../../containers/ci/run.mjs";
import {
  coverageLanes,
  verificationLanes,
} from "../../containers/ci/lanes.mjs";
import { validateLanes } from "../../containers/ci/aggregate.mjs";
import { readReport, reportBytes } from "../../containers/ci/reports.mjs";

const sha = "a".repeat(40);
const tree = "b".repeat(64);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function evidence() {
  return verificationLanes.map((lane) => ({
    kind: "managed-container-verification",
    candidate_sha: sha,
    lane,
    verdict: "passed",
    tree_sha256_before: tree,
    tree_sha256_after: tree,
    commands: verificationCommands(lane).map((command) => ({
      command: [command.command, ...command.args].join(" "),
      exit_code: 0,
      tree_sha256_before: tree,
      tree_sha256_after: tree,
    })),
    ...(coverageLanes.includes(lane)
      ? {
          coverage_report: {
            name: `blob-${lane.slice(-1)}-4.json`,
            sha256: digest("{}"),
            base64: Buffer.from("{}").toString("base64"),
          },
        }
      : {}),
  }));
}

it("requires every lane of the same unchanged candidate and complete command plans", () => {
  expect(validateLanes(evidence(), sha).lanes).toHaveLength(
    verificationLanes.length,
  );
});

it.each([
  "missing",
  "duplicate",
  "failed",
  "cancelled",
  "wrong-commit",
  "wrong-tree",
  "mutation",
  "missing-command",
  "wrong-command",
  "wrong-report",
  "changed-report",
])("rejects %s shard evidence", (scenario) => {
  const items = evidence();
  if (scenario === "missing") items.pop();
  if (scenario === "duplicate") items[1] = items[0];
  if (["failed", "cancelled"].includes(scenario)) items[0].verdict = scenario;
  if (scenario === "wrong-commit") items[0].candidate_sha = "c".repeat(40);
  if (scenario === "wrong-tree")
    items[0].tree_sha256_before = items[0].tree_sha256_after = "c".repeat(64);
  if (scenario === "mutation")
    items[0].commands[0].tree_sha256_after = "c".repeat(64);
  if (scenario === "missing-command") items[0].commands.pop();
  if (scenario === "wrong-command") items[0].commands[0].command = "true";
  if (scenario === "wrong-report")
    items[0].coverage_report.name = "blob-2-4.json";
  if (scenario === "changed-report") items[0].coverage_report.base64 = "YQ==";
  expect(() => validateLanes(items, sha)).toThrow();
});

it("keeps thresholds on merged coverage, builds before tests, and rejects unknown lanes", () => {
  expect(verificationCommands("coverage-merge").at(-1).args).toEqual([
    "exec",
    "--",
    "vitest",
    "--merge-reports=/work/coverage-input",
    "--coverage",
  ]);
  for (const lane of [...coverageLanes, "browser-1", "browser-2"])
    expect(verificationCommands(lane)[1].args).toEqual(["run", "build"]);
  expect(() => verificationCommands("coverage-5")).toThrow("Unknown");
});

it("exports bounded report bytes without following candidate symlinks or traversal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-reports-"));
  try {
    await fs.mkdir(path.join(root, "reports"));
    await fs.writeFile(
      path.join(root, "reports/data.json"),
      "private test report",
    );
    const report = await readReport(root, "reports/data.json");
    expect(reportBytes(report).toString()).toBe("private test report");
    await fs.symlink("data.json", path.join(root, "reports/link.json"));
    await fs.symlink("reports", path.join(root, "linked"));
    await expect(readReport(root, "reports/link.json")).rejects.toThrow();
    await expect(readReport(root, "linked/data.json")).rejects.toThrow(
      "symlink",
    );
    await expect(readReport(root, "../data.json")).rejects.toThrow("Invalid");
    await expect(readReport(root, "reports")).rejects.toThrow("regular");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

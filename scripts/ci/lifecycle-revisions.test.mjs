import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parse } from "yaml";
import {
  selectLifecycleRevisions,
  SUPPORTED_BASELINE,
  verifyLifecycleRevisions,
} from "./lifecycle-revisions.mjs";

const sourceSha = "a".repeat(40);
const targetSha = "b".repeat(40);
let directory;
let history;

beforeAll(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-lifecycle-revisions-"),
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Lifecycle test");
  git("config", "user.email", "lifecycle@example.invalid");
  const commit = (label) => {
    git("commit", "--allow-empty", "-m", label);
    return git("rev-parse", "HEAD");
  };
  const old = commit("Unsupported history");
  const baselineSha = commit("First supported revision");
  const source = commit("Previous main tip");
  const target = commit("Candidate");
  git("checkout", "--detach", old);
  const divergent = commit("Unrelated source");
  history = {
    old,
    divergent,
    baselineSha,
    sourceSha: source,
    targetSha: target,
  };
});

afterAll(async () => fs.rm(directory, { recursive: true, force: true }));

it.each([
  [
    "pull_request",
    {
      pull_request: { base: { sha: sourceSha }, head: { sha: "c".repeat(40) } },
    },
    "pull-request-base",
  ],
  ["push", { before: sourceSha, after: targetSha }, "previous-main-tip"],
  [
    "workflow_dispatch",
    { inputs: { previous_supported_sha: sourceSha } },
    "explicit-supported-revision",
  ],
])(
  "pins source from the %s event and preserves the exact merge candidate",
  (eventName, event, sourceKind) => {
    expect(selectLifecycleRevisions({ eventName, event, targetSha })).toEqual({
      baselineSha: SUPPORTED_BASELINE,
      sourceSha,
      targetSha,
      sourceKind,
    });
  },
);

it.each([
  undefined,
  "main",
  "v0.1.3",
  "a".repeat(7),
  "0".repeat(40),
  `${sourceSha}\n`,
])("refuses missing, moving, abbreviated or zero revision %s", (source) => {
  expect(() =>
    selectLifecycleRevisions({
      eventName: "workflow_dispatch",
      event: { inputs: { previous_supported_sha: source } },
      targetSha,
    }),
  ).toThrow("full nonzero commit SHA");
  expect(() =>
    selectLifecycleRevisions({
      eventName: "workflow_dispatch",
      event: { inputs: { previous_supported_sha: sourceSha } },
      targetSha: source,
    }),
  ).toThrow("full nonzero commit SHA");
});

it("refuses identical versions and an event target that differs from the tested candidate", () => {
  expect(() =>
    selectLifecycleRevisions({
      eventName: "push",
      event: { before: targetSha, after: targetSha },
      targetSha,
    }),
  ).toThrow("must differ");
  expect(() =>
    selectLifecycleRevisions({
      eventName: "push",
      event: { before: sourceSha, after: sourceSha },
      targetSha,
    }),
  ).toThrow("immutable workflow SHA");
  expect(() =>
    selectLifecycleRevisions({ eventName: "release", event: {}, targetSha }),
  ).toThrow("Unsupported lifecycle event");
});

it("requires a forward upgrade from the supported baseline using local immutable objects", () => {
  expect(() => verifyLifecycleRevisions(history, directory)).not.toThrow();
  expect(() =>
    verifyLifecycleRevisions(
      { ...history, sourceSha: history.baselineSha },
      directory,
    ),
  ).not.toThrow();
  for (const source of [history.old, history.divergent]) {
    expect(() =>
      verifyLifecycleRevisions({ ...history, sourceSha: source }, directory),
    ).toThrow("supported baseline");
  }
  expect(() =>
    verifyLifecycleRevisions(
      { ...history, targetSha: history.baselineSha },
      directory,
    ),
  ).toThrow("descend from the pinned source");
  expect(() =>
    verifyLifecycleRevisions({ ...history, targetSha }, directory),
  ).toThrow();
});

it("records one verified revision pair and exposes the same SHAs to both CI jobs", async () => {
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const eventFile = path.join(directory, "event.json");
  const evidence = path.join(directory, "revisions.json");
  const outputs = path.join(directory, "outputs");
  await fs.writeFile(
    eventFile,
    JSON.stringify({ pull_request: { base: { sha: SUPPORTED_BASELINE } } }),
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/ci/lifecycle-revisions.mjs", evidence],
    {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_SHA: candidate,
        GITHUB_OUTPUT: outputs,
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(await fs.readFile(evidence, "utf8"))).toMatchObject({
    sourceSha: SUPPORTED_BASELINE,
    targetSha: candidate,
    result: "selected",
  });
  expect(await fs.readFile(outputs, "utf8")).toBe(
    `source-sha=${SUPPORTED_BASELINE}\ntarget-sha=${candidate}\n`,
  );

  await fs.writeFile(
    eventFile,
    JSON.stringify({ pull_request: { base: { sha: candidate } } }),
  );
  await fs.unlink(outputs);
  const failed = spawnSync(
    process.execPath,
    ["scripts/ci/lifecycle-revisions.mjs", evidence],
    {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_SHA: candidate,
        GITHUB_OUTPUT: outputs,
      },
    },
  );
  expect(failed.status).toBe(1);
  expect(JSON.parse(await fs.readFile(evidence, "utf8"))).toEqual({
    result: "failed",
    error: "Upgrade source and target must differ.",
  });
  await expect(fs.access(outputs)).rejects.toThrow();
});

it.each(["clean-install", "installed-upgrade"])(
  "cannot publish a passing aggregate when %s fails or skips",
  async (name) => {
    const workflow = parse(
      await fs.readFile(
        new URL("../../.github/workflows/ci.yml", import.meta.url),
        "utf8",
      ),
    );
    const gate = workflow.jobs.aggregate.steps.find((step) => step.run);
    const passing = Object.fromEntries(
      Object.keys(gate.env).map((key) => [
        key,
        key.endsWith("_RESULT") ? "success" : "current",
      ]),
    );
    passing.WORKFLOW_EVENT = "pull_request";
    const variable = Object.entries(gate.env).find(
      ([, value]) => value === `\${{ needs.${name}.result }}`,
    )?.[0];
    expect(variable).toBeDefined();
    for (const result of ["success", "failure", "skipped", "cancelled"]) {
      const command = spawnSync("bash", ["-e", "-c", gate.run], {
        env: { PATH: process.env.PATH, ...passing, [variable]: result },
        encoding: "utf8",
      });
      expect(command.status, command.stderr).toBe(result === "success" ? 0 : 1);
    }
  },
);

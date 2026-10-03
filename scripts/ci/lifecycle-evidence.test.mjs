import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  requireCompletedUpgrade,
  requireInstallerSuccess,
  requireReadyInstallation,
} from "./lifecycle-evidence.mjs";
import { runInstaller } from "./lifecycle.mjs";

const sourceSha = "a".repeat(40),
  targetSha = "b".repeat(40);
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function installation(
  commit = targetSha,
  invocation = "b".repeat(32),
  pid = 200,
) {
  return {
    readiness: {
      web: { status: "ready" },
      asr: { status: "ready" },
      documentation: { status: "ready" },
      terminals: { status: "ready", broker: "ready", direct: "ready" },
    },
    checkout: commit,
    terminalProbeCleaned: true,
    processMatches: true,
    runtime: {
      verification: "verified",
      pid,
      invocationId: invocation,
      build: { commit, sourceDirty: false, artifactSha256: "manifest" },
    },
    manifest: { artifactSha256: "manifest" },
    services: {
      web: {
        ActiveState: "active",
        MainPID: String(pid),
        InvocationID: invocation,
      },
      asr: { ActiveState: "active", MainPID: "210" },
      documentation: { ActiveState: "active", MainPID: "211" },
      terminal: {
        ActiveState: "active",
        MainPID: "212",
        InvocationID: "broker",
      },
    },
    frontend: [
      { path: "/index.html", diskSha256: "index", servedSha256: "index" },
      { path: "/assets/main.js", diskSha256: "web", servedSha256: "web" },
    ],
  };
}

function upgrade() {
  const after = installation();
  return {
    sourceSha,
    targetSha,
    before: installation(sourceSha, "a".repeat(32), 100),
    after,
    coordinatorSurvivedStop: true,
    record: {
      targetCommit: targetSha,
      run: { state: "succeeded" },
      transition: {
        sourceCommit: sourceSha,
        completed: ["prepare", "activate", "verify"],
        verifiedRuntime: after.runtime,
        runtimePlan: { requiresInterruption: false },
      },
    },
  };
}

it("requires a successful installer and complete clean-install evidence", () => {
  expect(() => requireInstallerSuccess({ status: 0 })).not.toThrow();
  expect(() =>
    requireReadyInstallation(installation(), targetSha),
  ).not.toThrow();
});

it("fails the host gate instead of skipping when disposable-host authorization is absent", () => {
  const evidenceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx-lifecycle-host-rejection-"),
  );
  directories.push(evidenceDir);
  const result = spawnSync(
    "bash",
    [
      "scripts/ci/lifecycle-host.sh",
      "install",
      sourceSha,
      targetSha,
      evidenceDir,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDX_LIFECYCLE_DISPOSABLE: "0" },
      timeout: 5000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("A disposable host is required");
  expect(
    JSON.parse(
      fs.readFileSync(path.join(evidenceDir, "host-result.json"), "utf8"),
    ),
  ).toMatchObject({ exitCode: 1, sourceSha, targetSha });
});

it("fails on the real installer subprocess exit and retains its diagnostic", () => {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx-installer-rejection-"),
  );
  directories.push(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, "install.sh"),
    "#!/bin/sh\necho installer-error >&2\nexit 23\n",
    { mode: 0o755 },
  );
  const logFile = path.join(repoRoot, "installer.log");
  expect(() =>
    runInstaller({
      repoRoot,
      answersPath: path.join(repoRoot, "answers.json"),
      logFile,
    }),
  ).toThrow("Installer failed (exit 23");
  expect(fs.readFileSync(logFile, "utf8")).toContain("installer-error");
});

it.each(["web", "asr", "documentation", "terminals"])(
  "rejects failed target %s readiness even when checkout and build match",
  (component) => {
    const observed = installation();
    observed.readiness[component].status = "not-ready";
    expect(() => requireReadyInstallation(observed, targetSha)).toThrow(
      `${component} readiness failed`,
    );
  },
);

it.each([
  [
    "unverified runtime",
    (observed) => {
      observed.runtime.verification = "unverified";
    },
    "unverified",
  ],
  [
    "mismatched running commit",
    (observed) => {
      observed.runtime.build.commit = sourceSha;
    },
    "Running commit differs",
  ],
  [
    "modified runtime sources",
    (observed) => {
      observed.runtime.build.sourceDirty = true;
    },
    "modified sources",
  ],
  [
    "stale manifest",
    (observed) => {
      observed.manifest.artifactSha256 = "stale";
    },
    "installed manifest",
  ],
  [
    "foreign process",
    (observed) => {
      observed.processMatches = false;
    },
    "process identity",
  ],
  [
    "terminal residue",
    (observed) => {
      observed.terminalProbeCleaned = false;
    },
    "receipts behind",
  ],
  [
    "inactive service",
    (observed) => {
      observed.services.asr.ActiveState = "failed";
    },
    "inactive",
  ],
  [
    "stale frontend",
    (observed) => {
      observed.frontend[1].servedSha256 = "old";
    },
    "Served frontend differs",
  ],
])("rejects %s", (_name, mutate, message) => {
  const observed = installation();
  mutate(observed);
  expect(() => requireReadyInstallation(observed, targetSha)).toThrow(message);
});

it("accepts a durable verified upgrade that preserved compatible terminal service", () => {
  expect(() => requireCompletedUpgrade(upgrade())).not.toThrow();
});

it.each([
  [
    "unchanged old web invocation",
    (value) => {
      value.after.services.web.InvocationID =
        value.before.services.web.InvocationID;
      value.after.runtime.invocationId = value.before.runtime.invocationId;
    },
    "Old web invocation",
  ],
  [
    "unchanged old web process",
    (value) => {
      value.after.runtime.pid = value.before.runtime.pid;
    },
    "Old web process",
  ],
  [
    "launch accepted without completion",
    (value) => {
      value.record.run.state = "running";
    },
    "durably succeed",
  ],
  [
    "success before readiness",
    (value) => {
      value.record.transition.completed = ["prepare", "activate"];
    },
    "before verification",
  ],
  [
    "coordinator killed with web",
    (value) => {
      value.coordinatorSurvivedStop = false;
    },
    "coordinator survived",
  ],
  [
    "unnecessary terminal restart",
    (value) => {
      value.after.services.terminal.InvocationID = "restarted";
    },
    "unnecessarily restarted",
  ],
  [
    "identical revisions",
    (value) => {
      value.sourceSha = value.targetSha;
    },
    "revisions must differ",
  ],
])("fails the upgrade gate for %s", (_name, mutate, message) => {
  const evidence = upgrade();
  mutate(evidence);
  expect(() => requireCompletedUpgrade(evidence)).toThrow(message);
});

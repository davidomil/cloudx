#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATE_B_CANDIDATE_REF,
  GATE_B_COMMIT_SUBJECTS,
  GATE_B_EXPECTED_OLD_CANDIDATE_SHA,
  GATE_B_EXPECTED_TARGET_BASE_SHA,
  GATE_B_LOCAL_CHANGE_BASE_SHA,
  GATE_B_PULL_REQUEST,
  GATE_B_REPOSITORY,
  GATE_B_TARGET_BASE_REF,
  validateGateBArtifactBundle,
} from "./validate-process.mjs";

const originPushUrl = "https://github.com/davidomil/cloudx";
const candidateBranch = GATE_B_CANDIDATE_REF.slice("refs/heads/".length);
const targetBaseBranch = GATE_B_TARGET_BASE_REF.slice("refs/heads/".length);
const pullRequestFields = [
  "number",
  "state",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "headRefOid",
  "isCrossRepository",
  "url",
].join(",");
const gitSha = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export function readGateBArtifactSnapshot(artifactDir) {
  const directory = path.resolve(artifactDir);
  const names = fs.readdirSync(directory).sort();
  const files = Object.fromEntries(
    names.map((name) => {
      const filePath = path.join(directory, name);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Gate B artifact must be a regular file: ${name}`);
      }
      return [name, fs.readFileSync(filePath)];
    }),
  );
  const manifest = artifactManifest(files);
  return {
    directory,
    files,
    manifest,
    manifestSha256: sha256(manifest),
  };
}

export async function publishGateBCandidate({
  artifactDir,
  authorizedManifestSha256,
  expectedOldHead,
  runCommand = defaultCommandRunner,
}) {
  if (!sha256Pattern.test(authorizedManifestSha256)) {
    throw new Error(
      "Gate B authorized manifest digest must be a SHA-256 digest.",
    );
  }
  if (!gitSha.test(expectedOldHead)) {
    throw new Error(
      "Gate B expected old candidate head must be a full Git SHA.",
    );
  }
  requireEqual(
    expectedOldHead,
    GATE_B_EXPECTED_OLD_CANDIDATE_SHA,
    "Gate B expected old candidate head",
  );

  const snapshot = readGateBArtifactSnapshot(artifactDir);
  const bundle = validateGateBArtifactBundle({ snapshot });
  if (snapshot.manifestSha256 !== authorizedManifestSha256) {
    throw new Error(
      "Gate B authorized manifest digest does not match the validated bundle.",
    );
  }

  const localHead = output(
    await checked(runCommand, "git", ["rev-parse", "HEAD"]),
  );
  requireEqual(localHead, bundle.headSha, "Gate B local head");
  requireEqual(
    bundle.localChangeBaseSha,
    GATE_B_LOCAL_CHANGE_BASE_SHA,
    "Gate B local change base",
  );
  const localBranch = output(
    await checked(runCommand, "git", ["symbolic-ref", "--short", "HEAD"]),
  );
  requireEqual(localBranch, candidateBranch, "Gate B local branch");

  const subjects = lines(
    (
      await checked(runCommand, "git", [
        "log",
        "--reverse",
        "--format=%s",
        `${GATE_B_LOCAL_CHANGE_BASE_SHA}..${localHead}`,
      ])
    ).stdout,
  );
  requireExactList(subjects, GATE_B_COMMIT_SUBJECTS, "Gate B commit subjects");
  await requireQuiet(runCommand, ["diff", "--cached", "--quiet"], "Git index");
  await requireQuiet(runCommand, ["diff", "--quiet"], "tracked worktree");

  const pushUrls = lines(
    (
      await checked(runCommand, "git", [
        "remote",
        "get-url",
        "--push",
        "--all",
        "origin",
      ])
    ).stdout,
  );
  requireExactList(pushUrls, [originPushUrl], "Gate B origin push URL");

  const ghVersion = output(await checked(runCommand, "gh", ["--version"]));
  if (!/^gh version \d+\.\d+\.\d+/u.test(ghVersion)) {
    throw new Error("Gate B GitHub CLI version output is malformed.");
  }
  const authentication = await checked(runCommand, "gh", [
    "auth",
    "status",
    "--active",
    "--hostname",
    "github.com",
  ]);
  if (
    !/logged in to github\.com/iu.test(
      `${authentication.stdout}\n${authentication.stderr}`,
    )
  ) {
    throw new Error("Gate B GitHub authentication output is malformed.");
  }
  const repositoryIdentity = parseJsonObject(
    (
      await checked(runCommand, "gh", [
        "repo",
        "view",
        GATE_B_REPOSITORY,
        "--json",
        "nameWithOwner,viewerPermission",
      ])
    ).stdout,
    "repository",
  );
  requireEqual(
    repositoryIdentity.nameWithOwner,
    GATE_B_REPOSITORY,
    "Gate B repository identity",
  );
  requireEqual(
    repositoryIdentity.viewerPermission,
    "ADMIN",
    "Gate B repository permission",
  );

  const remoteTargetBase = parseRemoteHead(
    (
      await checked(runCommand, "git", [
        "ls-remote",
        "origin",
        GATE_B_TARGET_BASE_REF,
      ])
    ).stdout,
    GATE_B_TARGET_BASE_REF,
  );
  requireEqual(
    remoteTargetBase,
    GATE_B_EXPECTED_TARGET_BASE_SHA,
    "Gate B expected target base",
  );
  const remoteCandidate = parseRemoteHead(
    (
      await checked(runCommand, "git", [
        "ls-remote",
        "origin",
        GATE_B_CANDIDATE_REF,
      ])
    ).stdout,
    GATE_B_CANDIDATE_REF,
  );
  requireEqual(
    remoteCandidate,
    expectedOldHead,
    "Gate B expected old candidate head",
  );
  await checked(runCommand, "git", [
    "merge-base",
    "--is-ancestor",
    expectedOldHead,
    localHead,
  ]);

  const beforePushPr = parsePullRequest(
    (
      await checked(runCommand, "gh", [
        "pr",
        "view",
        String(GATE_B_PULL_REQUEST),
        "--repo",
        GATE_B_REPOSITORY,
        "--json",
        pullRequestFields,
      ])
    ).stdout,
  );
  requirePullRequest(beforePushPr, expectedOldHead, "pre-push");
  await requireUnprotectedBranch(runCommand);
  const rules = parseJson(
    (
      await checked(runCommand, "gh", [
        "api",
        `repos/${GATE_B_REPOSITORY}/rules/branches/${candidateBranch}`,
      ])
    ).stdout,
    "candidate rules",
  );
  if (!Array.isArray(rules) || rules.length !== 0) {
    throw new Error("Gate B candidate branch must have no applicable rules.");
  }

  const freshSnapshot = readGateBArtifactSnapshot(snapshot.directory);
  if (
    freshSnapshot.manifestSha256 !== snapshot.manifestSha256 ||
    freshSnapshot.manifest !== snapshot.manifest
  ) {
    throw new Error("Gate B artifact bundle changed after validation.");
  }
  if (freshSnapshot.manifestSha256 !== authorizedManifestSha256) {
    throw new Error("Gate B authorized manifest changed before publication.");
  }

  let pushResult;
  try {
    pushResult = await runCommand(
      "git",
      ["push", "--porcelain", "origin", `HEAD:${GATE_B_CANDIDATE_REF}`],
      { timeoutMs: 300_000 },
    );
  } catch (error) {
    return manualReconciliation(snapshot, localHead, error);
  }
  if (!pushResult || pushResult.exitCode !== 0) {
    return manualReconciliation(
      snapshot,
      localHead,
      new Error("Gate B push command did not report success."),
    );
  }

  try {
    requireFastForwardPorcelain(pushResult.stdout, expectedOldHead, localHead);
    const postPushTargetBase = parseRemoteHead(
      (
        await checked(runCommand, "git", [
          "ls-remote",
          "origin",
          GATE_B_TARGET_BASE_REF,
        ])
      ).stdout,
      GATE_B_TARGET_BASE_REF,
    );
    const postPushCandidate = parseRemoteHead(
      (
        await checked(runCommand, "git", [
          "ls-remote",
          "origin",
          GATE_B_CANDIDATE_REF,
        ])
      ).stdout,
      GATE_B_CANDIDATE_REF,
    );
    const afterPushPr = parsePullRequest(
      (
        await checked(runCommand, "gh", [
          "pr",
          "view",
          String(GATE_B_PULL_REQUEST),
          "--repo",
          GATE_B_REPOSITORY,
          "--json",
          pullRequestFields,
        ])
      ).stdout,
    );
    requireEqual(
      postPushTargetBase,
      GATE_B_EXPECTED_TARGET_BASE_SHA,
      "Gate B post-push target base",
    );
    requireEqual(postPushCandidate, localHead, "Gate B post-push candidate");
    requirePullRequest(afterPushPr, localHead, "post-push");
  } catch (error) {
    return manualReconciliation(snapshot, localHead, error);
  }

  return {
    status: "published",
    headSha: localHead,
    manifestSha256: snapshot.manifestSha256,
    repository: GATE_B_REPOSITORY,
    targetBaseRef: GATE_B_TARGET_BASE_REF,
    targetBaseSha: GATE_B_EXPECTED_TARGET_BASE_SHA,
    candidateRef: GATE_B_CANDIDATE_REF,
    remoteHeadSha: localHead,
    pullRequest: GATE_B_PULL_REQUEST,
    reviewPrHandoffAuthorized: true,
  };
}

function manualReconciliation(snapshot, localHead, error) {
  return {
    status: "manual-reconciliation-required",
    pushAttempts: 1,
    headSha: localHead,
    manifestSha256: snapshot.manifestSha256,
    repository: GATE_B_REPOSITORY,
    candidateRef: GATE_B_CANDIDATE_REF,
    reviewPrHandoffAuthorized: false,
    reason: error instanceof Error ? error.message : String(error),
  };
}

async function requireQuiet(runCommand, args, label) {
  const result = requireCommandResult(
    await runCommand("git", args, { allowFailure: true }),
    `git ${args.join(" ")}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Gate B ${label} must be clean.`);
  }
}

async function requireUnprotectedBranch(runCommand) {
  const result = requireCommandResult(
    await runCommand(
      "gh",
      [
        "api",
        "--include",
        `repos/${GATE_B_REPOSITORY}/branches/${candidateBranch}/protection`,
      ],
      { allowFailure: true },
    ),
    "gh api branch protection",
  );
  const statuses = lines(`${result.stdout}\n${result.stderr}`).filter((line) =>
    /^HTTP\/\S+\s+\d{3}\b/u.test(line),
  );
  if (
    result.exitCode === 0 ||
    !/^HTTP\/\S+\s+404\b/u.test(statuses[0] ?? "") ||
    statuses.length !== 1
  ) {
    throw new Error("Gate B candidate branch must be confirmed non-protected.");
  }
}

async function checked(runCommand, command, args, options = {}) {
  const result = requireCommandResult(
    await runCommand(command, args, options),
    `${command} ${args.join(" ")}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Gate B command failed (${result.exitCode}): ${command} ${args.join(" ")}`,
    );
  }
  return result;
}

function requireCommandResult(result, command) {
  if (
    !result ||
    !Number.isInteger(result.exitCode) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw new Error(`Gate B command result is malformed: ${command}`);
  }
  return result;
}

function parsePullRequest(stdout) {
  return parseJsonObject(stdout, "pull-request readback");
}

function requirePullRequest(value, expectedHead, phase) {
  requireEqual(value.number, GATE_B_PULL_REQUEST, `Gate B ${phase} PR number`);
  requireEqual(value.state, "OPEN", `Gate B ${phase} PR state`);
  requireEqual(
    value.baseRefName,
    targetBaseBranch,
    `Gate B ${phase} PR base name`,
  );
  requireEqual(
    value.baseRefOid,
    GATE_B_EXPECTED_TARGET_BASE_SHA,
    `Gate B ${phase} PR base OID`,
  );
  requireEqual(
    value.headRefName,
    candidateBranch,
    `Gate B ${phase} PR head name`,
  );
  requireEqual(value.headRefOid, expectedHead, `Gate B ${phase} PR head OID`);
  requireEqual(
    value.isCrossRepository,
    false,
    `Gate B ${phase} same-repository identity`,
  );
  requireEqual(
    value.url,
    `https://github.com/${GATE_B_REPOSITORY}/pull/${GATE_B_PULL_REQUEST}`,
    `Gate B ${phase} PR repository URL`,
  );
}

function parseRemoteHead(stdout, expectedRef) {
  const entries = lines(stdout);
  if (entries.length !== 1) {
    throw new Error(`Gate B ${expectedRef} must resolve exactly once.`);
  }
  const [head, ref, ...extra] = entries[0].split(/\s+/u);
  if (!gitSha.test(head) || ref !== expectedRef || extra.length) {
    throw new Error(`Gate B ${expectedRef} remote ref is malformed.`);
  }
  return head;
}

function requireFastForwardPorcelain(stdout, expectedOldHead, expectedNewHead) {
  const entries = lines(stdout);
  if (
    entries.length !== 3 ||
    entries[0] !== `To ${originPushUrl}` ||
    entries[2] !== "Done"
  ) {
    throw new Error("Gate B push must report exactly one porcelain update.");
  }
  const match =
    /^ \tHEAD:refs\/heads\/architecture-and-new-codex\t([a-f0-9]{7,40})\.\.([a-f0-9]{7,40})$/u.exec(
      entries[1],
    );
  if (
    !match ||
    !expectedOldHead.startsWith(match[1]) ||
    !expectedNewHead.startsWith(match[2])
  ) {
    throw new Error(
      "Gate B push porcelain must be one exact non-force fast-forward update.",
    );
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Gate B ${label} must be valid JSON.`, { cause: error });
  }
}

function parseJsonObject(value, label) {
  const parsed = parseJson(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Gate B ${label} must be an object.`);
  }
  return parsed;
}

function artifactManifest(files) {
  return `${Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bytes]) => `${name}:${sha256(bytes)}`)
    .join("\n")}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function output(result) {
  return result.stdout.trim();
}

function lines(value) {
  return value.split(/\r?\n/u).filter(Boolean);
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} must equal ${String(expected)}.`);
  }
}

function requireExactList(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must match exactly.`);
  }
}

function defaultCommandRunner(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: options.timeoutMs ?? 60_000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode:
            typeof error?.code === "number" ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Gate B publisher arguments must be --name value pairs.");
    }
    const name = key.slice(2);
    if (Object.hasOwn(values, name)) {
      throw new Error(`Gate B publisher received duplicate --${name}.`);
    }
    values[name] = value;
  }
  const allowed = new Set([
    "artifact-dir",
    "authorized-manifest-sha256",
    "expected-old-head",
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key))) {
    throw new Error("Gate B publisher received an unsupported argument.");
  }
  for (const key of allowed) {
    if (!values[key]) throw new Error(`Gate B publisher requires --${key}.`);
  }
  return values;
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  const args = parseCliArguments(process.argv.slice(2));
  publishGateBCandidate({
    artifactDir: args["artifact-dir"],
    authorizedManifestSha256: args["authorized-manifest-sha256"],
    expectedOldHead: args["expected-old-head"],
  })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status === "manual-reconciliation-required") {
        process.exitCode = 2;
      }
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

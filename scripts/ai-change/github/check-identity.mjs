#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { loadPolicy } from "../policy.mjs";
import { createGitHubApi, repoRoute } from "./api.mjs";

export const ciIdentityArtifactName = "cloudx-ci-identity-v2";
export const ciIdentityArtifactFile = "identity.json";

const sha40 = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const runId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const repositoryName = /^[^/\s]+\/[^/\s]+$/u;
const actorName = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const identityFields = [
  "pullRequest",
  "baseSha",
  "headSha",
  "testMergeSha",
  "testMergeTreeSha",
  "policySha256",
];
const artifactKeys = [
  "base_sha",
  "head_sha",
  "kind",
  "policy_sha256",
  "pull_request",
  "repository",
  "schema_version",
  "test_merge_sha",
  "test_merge_tree_sha",
  "workflow_run_attempt",
  "workflow_run_id",
].sort();

const kindQualifier = Object.freeze({
  ci: null,
  review: ["manualReviewRequired", "subjectSha256"],
  "merge-intent": "actor",
  "protected-intent": "actor",
  "managed-intent": "managedSha256",
});

export function buildCheckExternalId(kind, identity, qualifier = {}) {
  validateMergeIdentity(identity);
  if (!Object.hasOwn(kindQualifier, kind)) {
    throw new Error(`Unsupported canonical check kind '${kind}'.`);
  }
  const expectedQualifier = kindQualifier[kind];
  const qualifierKeys = Object.keys(qualifier).sort();
  if (expectedQualifier === null && qualifierKeys.length > 0) {
    throw new Error(
      `Canonical check kind '${kind}' does not accept qualifiers.`,
    );
  }
  if (
    expectedQualifier !== null &&
    JSON.stringify(qualifierKeys) !==
      JSON.stringify(
        (Array.isArray(expectedQualifier)
          ? [...expectedQualifier]
          : [expectedQualifier]
        ).sort(),
      )
  ) {
    throw new Error(
      `Canonical check kind '${kind}' requires only ${Array.isArray(expectedQualifier) ? expectedQualifier.join(" and ") : expectedQualifier}.`,
    );
  }

  const prefix = [
    "cloudx",
    "v2",
    kind,
    "pr",
    identity.pullRequest,
    "base",
    identity.baseSha,
    "head",
    identity.headSha,
    "merge",
    identity.testMergeSha,
    "tree",
    identity.testMergeTreeSha,
    "policy",
    identity.policySha256,
  ].join(":");
  if (expectedQualifier === null) return prefix;
  if (kind === "review") {
    if (typeof qualifier.manualReviewRequired !== "boolean") {
      throw new Error("manualReviewRequired must be a boolean.");
    }
    if (!sha256.test(qualifier.subjectSha256 ?? "")) {
      throw new Error("subjectSha256 must be a SHA-256 digest.");
    }
    return `${prefix}:subject:${qualifier.subjectSha256}:manual:${qualifier.manualReviewRequired ? "required" : "not-required"}`;
  }
  if (expectedQualifier === "actor") {
    const actor = validateActor(qualifier.actor);
    return `${prefix}:actor:${Buffer.from(actor, "utf8").toString("base64url")}`;
  }
  const value = qualifier[expectedQualifier];
  if (!sha256.test(value ?? "")) {
    throw new Error(`${expectedQualifier} must be a SHA-256 digest.`);
  }
  const label = expectedQualifier === "subjectSha256" ? "subject" : "managed";
  return `${prefix}:${label}:${value}`;
}

export function parseCheckExternalId(value) {
  if (typeof value !== "string") {
    throw new Error("Check external ID must be text.");
  }
  const match =
    /^cloudx:v2:(ci|review|merge-intent|protected-intent|managed-intent):pr:([1-9]\d*):base:([a-f0-9]{40}):head:([a-f0-9]{40}):merge:([a-f0-9]{40}):tree:([a-f0-9]{40}):policy:([a-f0-9]{64})(?::(subject|actor|managed):([A-Za-z0-9_-]+)(?::manual:(required|not-required))?)?$/u.exec(
      value,
    );
  if (!match) throw new Error("Check external ID is not canonical v2.");
  const kind = match[1];
  const identity = validateMergeIdentity({
    pullRequest: positiveInteger(match[2], "pull request"),
    baseSha: match[3],
    headSha: match[4],
    testMergeSha: match[5],
    testMergeTreeSha: match[6],
    policySha256: match[7],
  });
  const qualifierLabel = match[8] ?? null;
  const qualifierValue = match[9] ?? null;
  const manualDisposition = match[10] ?? null;
  const expectedLabel = {
    ci: null,
    review: "subject",
    "merge-intent": "actor",
    "protected-intent": "actor",
    "managed-intent": "managed",
  }[kind];
  if (qualifierLabel !== expectedLabel) {
    throw new Error("Check external ID is not canonical v2 for its kind.");
  }
  if (
    (kind === "review" && manualDisposition === null) ||
    (kind !== "review" && manualDisposition !== null)
  ) {
    throw new Error("Check external ID manual-review disposition is invalid.");
  }
  const parsed = { kind, identity };
  if (qualifierLabel === "subject") {
    parsed.subjectSha256 = qualifierValue;
    parsed.manualReviewRequired = manualDisposition === "required";
  }
  if (qualifierLabel === "managed") parsed.managedSha256 = qualifierValue;
  if (qualifierLabel === "actor") {
    let actor;
    try {
      actor = Buffer.from(qualifierValue, "base64url").toString("utf8");
    } catch {
      throw new Error("Check external ID actor encoding is invalid.");
    }
    if (Buffer.from(actor, "utf8").toString("base64url") !== qualifierValue) {
      throw new Error("Check external ID actor encoding is not canonical.");
    }
    parsed.actor = validateActor(actor);
  }
  if (buildCheckExternalId(kind, identity, qualifierFor(parsed)) !== value) {
    throw new Error("Check external ID is not canonical v2.");
  }
  return parsed;
}

export async function mergeIdentityForPullRequest(
  api,
  pullRequest,
  policySha256,
) {
  const identity = validateMergeIdentity(
    {
      pullRequest: positiveInteger(pullRequest?.number, "pull request"),
      baseSha: pullRequest?.base?.sha,
      headSha: pullRequest?.head?.sha,
      testMergeSha: pullRequest?.merge_commit_sha,
      testMergeTreeSha: "0".repeat(40),
      policySha256,
    },
    { allowPlaceholderTree: true },
  );
  if (pullRequest?.base?.ref !== "main") {
    throw new Error("Pull request merge identity requires base branch main.");
  }
  if (pullRequest?.mergeable !== true) {
    throw new Error("Pull request test merge is not currently mergeable.");
  }
  const commit = await api.get(
    repoRoute(api.repository, `/git/commits/${identity.testMergeSha}`),
  );
  const parents = Array.isArray(commit?.parents)
    ? commit.parents.map((parent) => parent?.sha)
    : [];
  if (
    commit?.sha !== identity.testMergeSha ||
    parents.length !== 2 ||
    parents[0] !== identity.baseSha ||
    parents[1] !== identity.headSha
  ) {
    throw new Error(
      "Test merge commit parents must be the exact bound base and head in order.",
    );
  }
  return validateMergeIdentity({
    ...identity,
    testMergeTreeSha: commit?.tree?.sha,
  });
}

export function checkRunTargetForPullRequest(
  pullRequest,
  identity,
  repository,
) {
  const exact = validateMergeIdentity(identity);
  if (
    pullRequest?.number !== exact.pullRequest ||
    pullRequest?.head?.sha !== exact.headSha
  ) {
    throw new Error("Check target pull request identity is inconsistent.");
  }
  const targetRepository = validateRepository(repository);
  const headRepository = pullRequest?.head?.repo?.full_name;
  if (typeof headRepository !== "string" || headRepository.length === 0) {
    throw new Error("Pull request head repository is required.");
  }
  return headRepository === targetRepository
    ? exact.headSha
    : exact.testMergeSha;
}

export async function listAllCheckRuns(api, headSha) {
  const checks = await api.paginate(
    repoRoute(
      api.repository,
      `/commits/${gitSha(headSha, "check head SHA")}/check-runs?filter=all`,
    ),
    { arrayKey: "check_runs" },
  );
  if (checks.length >= 1_000) {
    throw new Error(
      "GitHub check-run listing reached its 1000-suite completeness limit.",
    );
  }
  return checks;
}

export function validateMergeIdentity(identity, options = {}) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("Merge identity must be an object.");
  }
  const result = {
    pullRequest: positiveInteger(identity.pullRequest, "pull request"),
    baseSha: gitSha(identity.baseSha, "base SHA"),
    headSha: gitSha(identity.headSha, "head SHA"),
    testMergeSha: gitSha(identity.testMergeSha, "test merge SHA"),
    testMergeTreeSha: gitSha(identity.testMergeTreeSha, "test merge tree SHA"),
    policySha256: digest(identity.policySha256, "policy SHA-256"),
  };
  if (
    options.allowPlaceholderTree !== true &&
    result.testMergeTreeSha === "0".repeat(40)
  ) {
    throw new Error("Test merge tree SHA cannot be a placeholder.");
  }
  return Object.freeze(result);
}

export function mergeIdentityDifferences(expected, actual) {
  const left = validateMergeIdentity(expected);
  const right = validateMergeIdentity(actual);
  return identityFields.filter((field) => left[field] !== right[field]);
}

export function ciIdentityArtifact(input) {
  const identity = validateMergeIdentity(input);
  const repository = validateRepository(input.repository);
  const workflowRunId = positiveInteger(input.workflowRunId, "workflow run");
  const workflowRunAttempt = positiveInteger(
    input.workflowRunAttempt,
    "workflow run attempt",
  );
  return Object.freeze({
    schema_version: 2,
    kind: "cloudx-ci-identity",
    repository,
    workflow_run_id: workflowRunId,
    workflow_run_attempt: workflowRunAttempt,
    pull_request: identity.pullRequest,
    base_sha: identity.baseSha,
    head_sha: identity.headSha,
    test_merge_sha: identity.testMergeSha,
    test_merge_tree_sha: identity.testMergeTreeSha,
    policy_sha256: identity.policySha256,
  });
}

export function validateCiIdentityArtifact(artifact, expected) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("CI identity artifact must be an object.");
  }
  const actualKeys = Object.keys(artifact).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(artifactKeys)) {
    throw new Error("CI identity artifact must contain the exact keys.");
  }
  const normalized = ciIdentityArtifact({
    repository: artifact.repository,
    workflowRunId: artifact.workflow_run_id,
    workflowRunAttempt: artifact.workflow_run_attempt,
    pullRequest: artifact.pull_request,
    baseSha: artifact.base_sha,
    headSha: artifact.head_sha,
    testMergeSha: artifact.test_merge_sha,
    testMergeTreeSha: artifact.test_merge_tree_sha,
    policySha256: artifact.policy_sha256,
  });
  if (artifact.schema_version !== 2 || artifact.kind !== "cloudx-ci-identity") {
    throw new Error("CI identity artifact kind or schema version is invalid.");
  }
  if (
    normalized.repository !== validateRepository(expected.repository) ||
    normalized.workflow_run_id !==
      positiveInteger(expected.workflowRunId, "workflow run") ||
    normalized.workflow_run_attempt !==
      positiveInteger(expected.workflowRunAttempt, "workflow run attempt")
  ) {
    throw new Error("CI identity artifact workflow run binding is invalid.");
  }
  return { artifact: normalized, identity: identityFromArtifact(normalized) };
}

export function managedIntentSha256(input) {
  const identity = validateMergeIdentity(input);
  const canonical = JSON.stringify({
    schema_version: 2,
    kind: "managed-automation-intent",
    pull_request: identity.pullRequest,
    issue: positiveInteger(input.issue, "managed issue"),
    run_id: managedRunId(input.runId),
    workflow_run_id: positiveInteger(
      input.workflowRunId,
      "managed workflow run",
    ),
    snapshot_sha256: digest(input.snapshotSha256, "snapshot SHA-256"),
    base_sha: identity.baseSha,
    head_sha: identity.headSha,
    test_merge_sha: identity.testMergeSha,
    test_merge_tree_sha: identity.testMergeTreeSha,
    policy_sha256: identity.policySha256,
    bundle_sha256: digest(input.bundleSha256, "bundle SHA-256"),
    evidence_sha256: digest(input.evidenceSha256, "evidence SHA-256"),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function identityFromArtifact(artifact) {
  return validateMergeIdentity({
    pullRequest: artifact.pull_request,
    baseSha: artifact.base_sha,
    headSha: artifact.head_sha,
    testMergeSha: artifact.test_merge_sha,
    testMergeTreeSha: artifact.test_merge_tree_sha,
    policySha256: artifact.policy_sha256,
  });
}

function qualifierFor(parsed) {
  if (parsed.kind === "review") {
    return {
      subjectSha256: parsed.subjectSha256,
      manualReviewRequired: parsed.manualReviewRequired,
    };
  }
  if (["merge-intent", "protected-intent"].includes(parsed.kind)) {
    return { actor: parsed.actor };
  }
  if (parsed.kind === "managed-intent") {
    return { managedSha256: parsed.managedSha256 };
  }
  return {};
}

function validateActor(value) {
  if (!actorName.test(value ?? "")) {
    throw new Error("Intent actor must be one canonical human GitHub login.");
  }
  return value;
}

function validateRepository(value) {
  if (!repositoryName.test(value ?? "")) {
    throw new Error("Repository must be owner/name.");
  }
  return value;
}

function positiveInteger(value, name) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/u.test(text)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer.`);
  }
  return parsed;
}

function gitSha(value, name) {
  if (!sha40.test(value ?? "")) {
    throw new Error(`${name} must be a lowercase 40-character Git SHA.`);
  }
  return value;
}

function digest(value, name) {
  if (!sha256.test(value ?? "")) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function managedRunId(value) {
  if (!runId.test(value ?? "")) {
    throw new Error("Managed run ID is invalid.");
  }
  return value;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || !["create-ci-artifact", "resolve"].includes(command)) {
    throw new Error("Usage: check-identity.mjs <create-ci-artifact|resolve>");
  }
  const policy = await loadPolicy();
  if (command === "create-ci-artifact") {
    if (required("GITHUB_EVENT_NAME") !== "pull_request") {
      throw new Error(
        "CI identity artifacts are valid only for pull_request runs.",
      );
    }
    const source = required("CI_SOURCE_DIRECTORY");
    const testMergeSha = git(source, "rev-parse", "HEAD");
    const testMergeTreeSha = git(source, "rev-parse", "HEAD^{tree}");
    const [commit, ...parents] = git(
      source,
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ).split(" ");
    const baseSha = required("PULL_REQUEST_BASE_SHA");
    const headSha = required("PULL_REQUEST_HEAD_SHA");
    if (
      commit !== testMergeSha ||
      testMergeSha !== required("GITHUB_SHA") ||
      parents.length !== 2 ||
      parents[0] !== baseSha ||
      parents[1] !== headSha
    ) {
      throw new Error(
        "CI checkout must be the exact GitHub test merge with bound base/head parents.",
      );
    }
    const artifact = ciIdentityArtifact({
      repository: required("GITHUB_REPOSITORY"),
      workflowRunId: required("GITHUB_RUN_ID"),
      workflowRunAttempt: required("GITHUB_RUN_ATTEMPT"),
      pullRequest: required("PULL_REQUEST_NUMBER"),
      baseSha,
      headSha,
      testMergeSha,
      testMergeTreeSha,
      policySha256: policy.policySha256,
    });
    await writeExclusive(required("CI_IDENTITY_OUTPUT"), artifact);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    return;
  }

  const api = createGitHubApi({
    token: required("GH_TOKEN"),
    repository: required("GITHUB_REPOSITORY"),
  });
  const pullRequest = await api.get(
    repoRoute(
      api.repository,
      `/pulls/${positiveInteger(required("PR_NUMBER"), "pull request")}`,
    ),
  );
  const identity = await mergeIdentityForPullRequest(
    api,
    pullRequest,
    policy.policySha256,
  );
  requireExpected("EXPECTED_BASE_SHA", identity.baseSha);
  requireExpected("EXPECTED_HEAD_SHA", identity.headSha);
  requireExpected("EXPECTED_TEST_MERGE_SHA", identity.testMergeSha);
  requireExpected("EXPECTED_TEST_MERGE_TREE_SHA", identity.testMergeTreeSha);
  requireExpected("EXPECTED_POLICY_SHA256", identity.policySha256);
  await writeOutputs(identity);
  process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);
}

function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
}

async function writeExclusive(file, value) {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function writeOutputs(identity) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    ["pr-number", identity.pullRequest],
    ["base-sha", identity.baseSha],
    ["head-sha", identity.headSha],
    ["test-merge-sha", identity.testMergeSha],
    ["test-merge-tree-sha", identity.testMergeTreeSha],
    ["policy-sha256", identity.policySha256],
  ].map(([name, value]) => `${name}=${value}`);
  await fs.appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function requireExpected(name, actual) {
  const expected = process.env[name];
  if (expected !== undefined && expected !== actual) {
    throw new Error(`${name} does not match the live pull request identity.`);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifact } from "./artifact-validation.mjs";
import { validateSchema } from "./schema-validator.mjs";

export const AREA_REVIEW_ROLES = Object.freeze([
  "review-agent-policy",
  "review-architecture",
  "review-automation",
  "review-documentation",
  "review-installer",
  "review-plugin-api",
  "review-python-services",
  "review-security",
  "review-server",
  "review-shared",
  "review-web",
]);

export const AREA_REVIEW_OUTPUTS = Object.freeze(
  Object.fromEntries(
    AREA_REVIEW_ROLES.map((role) => [role, role.replaceAll("-", "_")]),
  ),
);

const roleSet = new Set(AREA_REVIEW_ROLES);
const maximumReviewBytes = 48_000;
const maximumTriageBytes = 900_000;
const maximumCandidateBytes = 128_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const gitShaPattern = /^[a-f0-9]{40}$/u;

export function reviewRolePlan(skills) {
  const selected = exactRoleSet(skills);
  if (selected.length === 0) {
    throw new Error("At least one area reviewer must be selected.");
  }
  return Object.freeze(
    Object.fromEntries(
      AREA_REVIEW_ROLES.map((role) => [role, selected.includes(role)]),
    ),
  );
}

export function verifiedReviewRolePlan({
  triageBytes,
  candidateBytes,
  identity,
}) {
  requireFanoutIdentity(identity);
  const triage = parseBoundJson(
    triageBytes,
    maximumTriageBytes,
    "Managed triage artifact",
    (value) => validateSchema("managed-issue-triage", value),
  );
  const candidate = parseBoundJson(
    candidateBytes,
    maximumCandidateBytes,
    "Managed candidate metadata",
  );
  requireTriageIdentity(triage, identity, triageBytes);
  requireCandidateIdentity(candidate, identity, triage);
  const selectedRoles = exactRoleSet(candidate.skills);
  if (selectedRoles.length === 0) {
    throw new Error("At least one area reviewer must be selected.");
  }
  return Object.freeze({
    selectedRoles: Object.freeze(selectedRoles),
    plan: reviewRolePlan(selectedRoles),
  });
}

export function validateAreaReviewFanout({ outputs, selectedRoles, identity }) {
  const selected = exactRoleSet(selectedRoles);
  if (selected.length === 0) {
    throw new Error("At least one area reviewer must be selected.");
  }
  if (!isRecord(outputs)) {
    throw new Error("Area review outputs must be a role-keyed object.");
  }
  const unexpected = Object.keys(outputs).filter((role) => !roleSet.has(role));
  if (unexpected.length > 0) {
    throw new Error(`Unknown area review output '${unexpected.sort()[0]}'.`);
  }

  const artifacts = {};
  const reviews = [];
  for (const role of AREA_REVIEW_ROLES) {
    const output = outputs[role];
    if (!selected.includes(role)) {
      if (
        !isRecord(output) ||
        output.result !== "skipped" ||
        ![undefined, null, ""].includes(output.raw)
      ) {
        throw new Error(`Unselected area reviewer '${role}' was not skipped.`);
      }
      continue;
    }
    if (!isRecord(output) || output.result !== "success") {
      throw new Error(`Selected area reviewer '${role}' did not succeed.`);
    }
    if (
      typeof output.raw !== "string" ||
      output.raw.length === 0 ||
      Buffer.byteLength(output.raw, "utf8") > maximumReviewBytes
    ) {
      throw new Error(`Selected area reviewer '${role}' output is invalid.`);
    }
    let artifact;
    try {
      artifact = validateArtifact("review", JSON.parse(output.raw));
    } catch (error) {
      throw new Error(
        `Selected area reviewer '${role}' artifact is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    requireReviewIdentity(artifact, identity, role);
    const rendered = renderCanonicalJson(artifact);
    artifacts[role] = artifact;
    reviews.push({
      role,
      artifact_sha256: sha256(rendered),
      verdict: artifact.verdict,
      tags: artifact.tags,
      findings: artifact.findings,
    });
  }

  const manifest = {
    schema_version: 1,
    kind: "area-review-manifest",
    run_id: identity.runId,
    subject: identity.subject,
    subject_sha256: identity.subjectSha256,
    base_sha: identity.baseSha,
    head_sha: identity.headSha,
    policy_sha256: identity.policySha256,
    selected_roles: selected,
    blocked: reviews.some(({ verdict }) => verdict === "blocked"),
    reviews,
  };
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    manifest: Object.freeze(manifest),
    sha256: sha256(renderCanonicalJson(manifest)),
  });
}

export function validateAggregateReview({
  raw,
  jobResult,
  manifest,
  manifestSha256,
  identity,
  reviewerRole,
  selectedRoles = manifest?.selected_roles,
}) {
  requireAreaReviewManifest(manifest, identity, selectedRoles);
  if (sha256(renderCanonicalJson(manifest)) !== manifestSha256) {
    throw new Error("Area review manifest digest is stale.");
  }
  if (jobResult !== "success") {
    throw new Error(`Aggregate reviewer completed as ${jobResult}.`);
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > maximumReviewBytes
  ) {
    throw new Error("Aggregate review output is invalid.");
  }
  let artifact;
  try {
    artifact = validateArtifact("review", JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Aggregate review artifact is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  requireReviewIdentity(artifact, identity, reviewerRole);

  const remainingFindings = new Map();
  for (const finding of artifact.findings) {
    const key = canonicalJson(finding);
    remainingFindings.set(key, (remainingFindings.get(key) ?? 0) + 1);
  }
  const requiredFindings = manifest.reviews.flatMap(({ findings }) => findings);
  for (const finding of requiredFindings) {
    const key = canonicalJson(finding);
    const remaining = remainingFindings.get(key) ?? 0;
    if (remaining === 0) {
      throw new Error(
        `Aggregate review discarded area finding '${finding.id}'.`,
      );
    }
    remainingFindings.set(key, remaining - 1);
  }
  if (manifest.blocked && artifact.verdict !== "blocked") {
    throw new Error("Aggregate review cannot override a blocked area review.");
  }
  const requiredTags = new Set(manifest.reviews.flatMap(({ tags }) => tags));
  for (const tag of requiredTags) {
    if (!artifact.tags.includes(tag)) {
      throw new Error(`Aggregate review discarded area tag '${tag}'.`);
    }
  }
  return artifact;
}

export async function captureAreaReviewFanout({
  triageBytes,
  candidateBytes,
  identity,
  outputs,
  outputDirectory,
}) {
  const { selectedRoles } = verifiedReviewRolePlan({
    triageBytes,
    candidateBytes,
    identity,
  });
  const captured = validateAreaReviewFanout({
    outputs,
    selectedRoles,
    identity: reviewIdentity(identity),
  });
  const directory = path.resolve(outputDirectory);
  await fs.mkdir(directory, { recursive: true });
  for (const role of selectedRoles) {
    await fs.writeFile(
      path.join(directory, `${role}.json`),
      renderCanonicalJson(captured.artifacts[role]),
      { flag: "wx" },
    );
  }
  const manifestPath = path.join(directory, "area-review-manifest.json");
  await fs.writeFile(manifestPath, renderCanonicalJson(captured.manifest), {
    flag: "wx",
  });
  return Object.freeze({ ...captured, manifestPath });
}

export async function captureAggregateReview({
  triageBytes,
  candidateBytes,
  manifestBytes,
  manifestSha256,
  identity,
  raw,
  jobResult,
  outputPath,
}) {
  const { selectedRoles } = verifiedReviewRolePlan({
    triageBytes,
    candidateBytes,
    identity,
  });
  if (
    !Buffer.isBuffer(manifestBytes) ||
    manifestBytes.length < 1 ||
    manifestBytes.length > maximumTriageBytes ||
    sha256(manifestBytes) !== manifestSha256
  ) {
    throw new Error("Area review manifest bytes do not match their digest.");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Area review manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (renderCanonicalJson(manifest) !== manifestBytes.toString("utf8")) {
    throw new Error("Area review manifest is not exact canonical JSON.");
  }
  const artifact = validateAggregateReview({
    raw,
    jobResult,
    manifest,
    manifestSha256,
    identity: reviewIdentity(identity),
    reviewerRole: "review-change",
    selectedRoles,
  });
  const rendered = renderCanonicalJson(artifact);
  const resolvedOutput = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.writeFile(resolvedOutput, rendered, { flag: "wx" });
  return Object.freeze({
    artifact,
    path: resolvedOutput,
    sha256: sha256(rendered),
    verdict: artifact.verdict,
  });
}

function requireAreaReviewManifest(manifest, identity, selectedRoles) {
  if (
    !isRecord(manifest) ||
    manifest.schema_version !== 1 ||
    manifest.kind !== "area-review-manifest"
  ) {
    throw new Error("Area review manifest is invalid.");
  }
  const selected = exactRoleSet(selectedRoles);
  if (
    selected.length === 0 ||
    canonicalJson(manifest.selected_roles) !== canonicalJson(selected) ||
    !Array.isArray(manifest.reviews) ||
    manifest.reviews.length !== selected.length ||
    canonicalJson(manifest.reviews.map((review) => review?.role)) !==
      canonicalJson(selected)
  ) {
    throw new Error("Area review manifest role coverage is invalid.");
  }
  requireManifestIdentity(manifest, identity);
  const seen = new Set();
  for (const review of manifest.reviews) {
    if (
      !isRecord(review) ||
      !selected.includes(review.role) ||
      seen.has(review.role) ||
      !sha256Pattern.test(review.artifact_sha256 ?? "")
    ) {
      throw new Error("Area review manifest contains an invalid role entry.");
    }
    seen.add(review.role);
    validateArtifact("review", {
      schema_version: 1,
      kind: "change-review",
      run_id: identity.runId,
      subject: identity.subject,
      subject_sha256: identity.subjectSha256,
      base_sha: identity.baseSha,
      head_sha: identity.headSha,
      policy_sha256: identity.policySha256,
      reviewer_role: review.role,
      verdict: review.verdict,
      tags: review.tags,
      findings: review.findings,
    });
  }
  if (
    manifest.blocked !==
    manifest.reviews.some(({ verdict }) => verdict === "blocked")
  ) {
    throw new Error("Area review manifest blocked state is inconsistent.");
  }
}

function requireTriageIdentity(triage, identity, triageBytes) {
  for (const [actual, expected, name] of [
    [triage.run_id, identity.runId, "run ID"],
    [triage.base_sha, identity.baseSha, "base SHA"],
    [triage.snapshot_sha256, identity.snapshotSha256, "snapshot digest"],
    [triage.policy_sha256, identity.policySha256, "policy digest"],
    [sha256(triageBytes), identity.triageSha256, "artifact digest"],
  ]) {
    if (actual !== expected) {
      throw new Error(`Managed triage ${name} is stale.`);
    }
  }
  if (triage.admitted !== true) {
    throw new Error("Managed triage was not admitted.");
  }
}

function requireCandidateIdentity(candidate, identity, triage) {
  if (
    !isRecord(candidate) ||
    candidate.schema_version !== 1 ||
    candidate.kind !== "managed-candidate" ||
    !Array.isArray(candidate.areas) ||
    !Array.isArray(candidate.skills)
  ) {
    throw new Error("Managed candidate metadata is invalid.");
  }
  for (const [actual, expected, name] of [
    [candidate.run_id, identity.runId, "run ID"],
    [candidate.issue_number, identity.issueNumber, "issue number"],
    [candidate.base_sha, identity.baseSha, "base SHA"],
    [candidate.head_sha, identity.headSha, "head SHA"],
    [candidate.snapshot_sha256, identity.snapshotSha256, "snapshot digest"],
    [candidate.policy_sha256, identity.policySha256, "policy digest"],
    [candidate.triage_sha256, identity.triageSha256, "triage digest"],
    [
      candidate.verification_sha256,
      identity.verificationSha256,
      "verification digest",
    ],
    [
      candidate.candidate_subject_sha256,
      identity.subjectSha256,
      "subject digest",
    ],
    [candidate.type, triage.type, "change type"],
  ]) {
    if (actual !== expected) {
      throw new Error(`Managed candidate ${name} is stale.`);
    }
  }
  if (candidate.areas.some((area) => !triage.areas.includes(area))) {
    throw new Error("Managed candidate areas exceed accepted triage.");
  }
}

function requireFanoutIdentity(identity) {
  if (
    !isRecord(identity) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(identity.runId ?? "") ||
    !Number.isSafeInteger(identity.issueNumber) ||
    identity.issueNumber < 1 ||
    !gitShaPattern.test(identity.baseSha ?? "") ||
    !gitShaPattern.test(identity.headSha ?? "") ||
    !sha256Pattern.test(identity.snapshotSha256 ?? "") ||
    !sha256Pattern.test(identity.policySha256 ?? "") ||
    !sha256Pattern.test(identity.triageSha256 ?? "") ||
    !sha256Pattern.test(identity.verificationSha256 ?? "") ||
    !sha256Pattern.test(identity.subjectSha256 ?? "")
  ) {
    throw new Error("Managed review fanout identity is invalid.");
  }
}

function requireReviewIdentity(artifact, identity, reviewerRole) {
  for (const [actual, expected, name] of [
    [artifact.run_id, identity.runId, "run ID"],
    [artifact.subject, identity.subject, "subject"],
    [artifact.subject_sha256, identity.subjectSha256, "subject digest"],
    [artifact.base_sha, identity.baseSha, "base SHA"],
    [artifact.head_sha, identity.headSha, "head SHA"],
    [artifact.policy_sha256, identity.policySha256, "policy digest"],
    [artifact.reviewer_role, reviewerRole, "reviewer role"],
  ]) {
    if (actual !== expected) {
      throw new Error(`Review artifact ${name} is stale.`);
    }
  }
}

function requireManifestIdentity(manifest, identity) {
  for (const [actual, expected] of [
    [manifest.run_id, identity.runId],
    [manifest.subject, identity.subject],
    [manifest.subject_sha256, identity.subjectSha256],
    [manifest.base_sha, identity.baseSha],
    [manifest.head_sha, identity.headSha],
    [manifest.policy_sha256, identity.policySha256],
  ]) {
    if (actual !== expected) {
      throw new Error("Area review manifest identity is stale.");
    }
  }
}

function exactRoleSet(roles) {
  if (
    !Array.isArray(roles) ||
    roles.some((role) => typeof role !== "string" || !roleSet.has(role)) ||
    new Set(roles).size !== roles.length
  ) {
    throw new Error("Area reviewer roles must be unique known role names.");
  }
  return [...roles].sort();
}

function reviewIdentity(identity) {
  return Object.freeze({
    runId: identity.runId,
    subject: "implementation",
    subjectSha256: identity.subjectSha256,
    baseSha: identity.baseSha,
    headSha: identity.headSha,
    policySha256: identity.policySha256,
  });
}

function parseBoundJson(
  bytes,
  maximumBytes,
  name,
  validate = (value) => value,
) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > maximumBytes
  ) {
    throw new Error(`${name} bytes are invalid.`);
  }
  try {
    return validate(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error(
      `${name} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function renderCanonicalJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function identityFromEnvironment(environment) {
  return Object.freeze({
    runId: environment.MANAGED_RUN_ID,
    issueNumber: Number(environment.MANAGED_ISSUE_NUMBER),
    baseSha: environment.MANAGED_BASE_SHA,
    headSha: environment.MANAGED_CANDIDATE_HEAD_SHA,
    snapshotSha256: environment.MANAGED_SNAPSHOT_SHA256,
    policySha256: environment.MANAGED_POLICY_SHA256,
    triageSha256: environment.MANAGED_TRIAGE_SHA256,
    verificationSha256: environment.MANAGED_VERIFICATION_SHA256,
    subjectSha256: environment.MANAGED_CANDIDATE_SUBJECT_SHA256,
  });
}

function reviewerOutputsFromEnvironment(environment) {
  return Object.fromEntries(
    AREA_REVIEW_ROLES.map((role) => {
      const prefix = `MANAGED_${role.toUpperCase().replaceAll("-", "_")}`;
      return [
        role,
        {
          result: environment[`${prefix}_RESULT`],
          raw: environment[`${prefix}_JSON`] ?? "",
        },
      ];
    }),
  );
}

async function writeWorkflowOutputs(values, environment) {
  const outputPath = environment.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required.");
  const lines = Object.entries(values).map(([name, value]) => {
    if (!/^[a-z][a-z0-9_]*$/u.test(name) || /[\r\n]/u.test(String(value))) {
      throw new Error("Managed review workflow output is unsafe.");
    }
    return `${name}=${String(value)}\n`;
  });
  await fs.appendFile(outputPath, lines.join(""), "utf8");
}

function parseCommand(args) {
  const [command, ...options] = args;
  if (!["plan", "capture", "aggregate"].includes(command)) {
    throw new Error(
      "Expected review fanout command: plan, capture, or aggregate.",
    );
  }
  const parsed = {};
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (
      !option?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      Object.hasOwn(parsed, option)
    ) {
      throw new Error("Review fanout options must be unique name/value pairs.");
    }
    parsed[option] = value;
  }
  const required = {
    plan: ["--triage", "--candidate"],
    capture: ["--triage", "--candidate", "--output-dir"],
    aggregate: ["--triage", "--candidate", "--manifest", "--output"],
  }[command];
  if (
    Object.keys(parsed).length !== required.length ||
    required.some((option) => !parsed[option])
  ) {
    throw new Error(`Review fanout ${command} options are incomplete.`);
  }
  return { command, options: parsed };
}

async function main() {
  const { command, options } = parseCommand(process.argv.slice(2));
  const identity = identityFromEnvironment(process.env);
  const triageBytes = await fs.readFile(options["--triage"]);
  const candidateBytes = await fs.readFile(options["--candidate"]);
  if (command === "plan") {
    const { selectedRoles, plan } = verifiedReviewRolePlan({
      triageBytes,
      candidateBytes,
      identity,
    });
    await writeWorkflowOutputs(
      {
        selected_roles: JSON.stringify(selectedRoles),
        ...Object.fromEntries(
          AREA_REVIEW_ROLES.map((role) => [
            AREA_REVIEW_OUTPUTS[role],
            plan[role],
          ]),
        ),
      },
      process.env,
    );
    return;
  }
  if (command === "capture") {
    const captured = await captureAreaReviewFanout({
      triageBytes,
      candidateBytes,
      identity,
      outputs: reviewerOutputsFromEnvironment(process.env),
      outputDirectory: options["--output-dir"],
    });
    await writeWorkflowOutputs(
      { manifest_sha256: captured.sha256 },
      process.env,
    );
    return;
  }
  const captured = await captureAggregateReview({
    triageBytes,
    candidateBytes,
    manifestBytes: await fs.readFile(options["--manifest"]),
    manifestSha256: process.env.MANAGED_AREA_REVIEW_MANIFEST_SHA256,
    identity,
    raw: process.env.MANAGED_AGGREGATE_REVIEW_JSON,
    jobResult: process.env.MANAGED_AGGREGATE_REVIEW_RESULT,
    outputPath: options["--output"],
  });
  await writeWorkflowOutputs(
    { artifact_sha256: captured.sha256, verdict: captured.verdict },
    process.env,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

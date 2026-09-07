#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { minimatch } from "minimatch";

import { validateArtifact } from "./artifact-validation.mjs";
import { classifyChange, loadPolicy } from "./policy.mjs";
import {
  AREA_REVIEW_ROLES,
  validateAreaReviewFanout,
  validateAggregateReview,
} from "./review-fanout.mjs";
import { GATE_B_LOCAL_CHANGE_BASE_SHA } from "./validate-process.mjs";
import {
  calculateWorktreeDigest,
  displayCommand,
  readHeadSha,
  runCommand,
  verificationPlan,
} from "./verify.mjs";

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const maximumFileBytes = 1024 * 1024;
const maximumTotalBytes = 8 * maximumFileBytes;
const maximumGitBytes = 4 * maximumFileBytes;
const maximumPaths = 10_000;
const maximumAttributeArgumentBytes = 32 * 1024;
const gitControls = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.ignoreSubmodules=none",
]);
const conversionAttributes = Object.freeze([
  "filter",
  "text",
  "eol",
  "crlf",
  "ident",
  "working-tree-encoding",
]);
const localContexts = new WeakMap();
const maximumReviewBytes = 48_000;
const digestPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const decoder = () =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sortedUnique = (values) => [...new Set(values)].sort();

/** A read-only local convenience. It has no finding disposition or hosting authority. */
export async function reviewLocal(options, dependencies = {}) {
  validateOptions(options);
  const repositoryRoot = await fs.realpath(
    dependencies.repositoryRoot ?? defaultRoot,
  );
  const files = new EvidenceSnapshot(repositoryRoot);
  const planFile = await files.add(options.plan, "plan");
  const plan = parseArtifact("plan", planFile);
  if (plan.base_sha === GATE_B_LOCAL_CHANGE_BASE_SHA)
    throw new Error("Gate-B cannot use local review aggregation.");
  const planReview = parseArtifact(
    "review",
    await files.add(options.planReview, "plan review"),
  );
  const implementationFile = await files.add(
    options.implementation,
    "implementation",
  );
  const implementation = parseArtifact("implementation", implementationFile);
  const verificationFile = await files.add(
    options.verification,
    "verification",
  );
  const verification = parseArtifact("verification", verificationFile);
  validatePrerequisites({
    plan,
    planReview,
    implementation,
    verification,
    planDigest: planFile.sha256,
  });

  const policyPath = path.join(repositoryRoot, ".agents/pr-review-policy.toml");
  const policyFile = await files.add(policyPath, "policy", { external: false });
  const policy = await loadPolicy(policyPath, {
    readSource: async () => decode(policyFile.bytes),
  });
  requireEqual(
    plan.policy_sha256,
    policy.policySha256,
    "Current policy digest",
  );
  const context = await createLocalGitReadContext({
    repositoryRoot,
    gitRunner: dependencies.gitRunner,
  });
  const gitRunner = context.gitRunner;
  const readHead =
    dependencies.readHead ?? (() => readHeadSha({ processRunner: gitRunner }));
  const worktreeDigest =
    dependencies.worktreeDigest ??
    (() => calculateWorktreeDigest({ processRunner: gitRunner }));
  const head = await readHead();
  requireEqual(head, implementation.head_sha, "Current HEAD");
  const observed = await discoverLocalPaths({
    repositoryRoot,
    baseSha: plan.base_sha,
    headSha: head,
    gitRunner,
  });
  validateScope(observed.paths, plan, implementation);
  const classification = classifyChange(policy, {
    paths: observed.paths,
    type: plan.classification.type,
  });
  const selectedRoles = sortedUnique([
    ...classification.skills,
    ...plan.classification.skills,
  ]);
  if (
    selectedRoles.length === 0 ||
    selectedRoles.some((role) => !AREA_REVIEW_ROLES.includes(role))
  )
    throw new Error("Unknown required area review role.");
  for (const role of selectedRoles) {
    if (!Object.hasOwn(plan.skill_versions, role))
      throw new Error(`Missing current skill digest for ${role}.`);
  }
  const skills = Object.entries(plan.skill_versions);
  if (skills.length > 64) throw new Error("Too many declared skill digests.");
  for (const [name, digest] of skills) {
    if (!/^[a-z][a-z0-9-]{0,99}$/u.test(name))
      throw new Error("Invalid skill name.");
    const skill = await files.add(
      path.join(repositoryRoot, ".agents/skills", name, "SKILL.md"),
      "skill",
      { external: false },
    );
    requireEqual(skill.sha256, digest, `Current skill digest for ${name}`);
  }
  requireEqual(
    await worktreeDigest(),
    verification.tree_sha256_after,
    "Current worktree digest",
  );
  const subject = sha256(
    `cloudx-local-review-v1\n${implementationFile.sha256}\n${verificationFile.sha256}\n`,
  );
  let rendered = `${subject}\n`;
  if (!options.printSubject) {
    requireEqual(options.subjectSha256, subject, "Local subject digest");
    const identity = {
      runId: verification.run_id,
      subject: "implementation",
      subjectSha256: subject,
      baseSha: plan.base_sha,
      headSha: head,
      policySha256: policy.policySha256,
    };
    const outputs = Object.fromEntries(
      AREA_REVIEW_ROLES.map((role) => [role, { result: "skipped" }]),
    );
    for (const filename of options.reviews) {
      const file = await files.add(filename, "area review", {
        maximumBytes: maximumReviewBytes,
      });
      const review = parseArtifact("review", file);
      const role = review.reviewer_role;
      if (!selectedRoles.includes(role))
        throw new Error("Unexpected area review role.");
      if (outputs[role].result !== "skipped")
        throw new Error("Duplicate area review role.");
      outputs[role] = { result: "success", raw: decode(file.bytes) };
    }
    const fanout = validateAreaReviewFanout({
      outputs,
      selectedRoles,
      identity,
    });
    if (
      fanout.manifest.blocked ||
      fanout.manifest.reviews.some((review) => review.findings.length !== 0)
    )
      throw new Error("Area findings require fresh review-change judgment.");
    const tags = sortedUnique([
      ...planReview.tags,
      ...fanout.manifest.reviews.flatMap((review) => review.tags),
      ...(classification.humanReviewRequired ||
      plan.classification.human_review_required ||
      plan.classification.risk === "human-required"
        ? ["manual-review"]
        : []),
    ]);
    const aggregate = {
      schema_version: 1,
      kind: "change-review",
      run_id: identity.runId,
      subject: identity.subject,
      subject_sha256: subject,
      base_sha: identity.baseSha,
      head_sha: head,
      policy_sha256: identity.policySha256,
      reviewer_role: "review-change",
      verdict: "clean",
      tags,
      findings: [],
    };
    rendered = canonicalJson(aggregate);
    validateAggregateReview({
      raw: rendered,
      jobResult: "success",
      manifest: fanout.manifest,
      manifestSha256: fanout.sha256,
      identity,
      reviewerRole: "review-change",
      selectedRoles,
    });
  }

  // All reads and review validation precede this final admission check. No output
  // or file mutation occurs until every original snapshot is still current.
  requireEqual(
    await worktreeDigest(),
    verification.tree_sha256_after,
    "Final worktree digest",
  );
  requireEqual(await readHead(), head, "Final HEAD");
  const finalObserved = await discoverLocalPaths({
    repositoryRoot,
    baseSha: plan.base_sha,
    headSha: head,
    gitRunner,
  });
  requireEqual(
    JSON.stringify(finalObserved),
    JSON.stringify(observed),
    "Final observed path and index snapshot",
  );
  requireEqual(
    await worktreeDigest(),
    verification.tree_sha256_after,
    "Final worktree digest",
  );
  await files.assertCurrent();
  requireEqual(await readHead(), head, "Final HEAD");
  await context.assertCurrent();
  return rendered;
}

function validatePrerequisites({
  plan,
  planReview,
  implementation,
  verification,
  planDigest,
}) {
  for (const artifact of [planReview, implementation, verification]) {
    requireEqual(artifact.base_sha, plan.base_sha, "Artifact base SHA");
    requireEqual(
      artifact.policy_sha256,
      plan.policy_sha256,
      "Artifact policy digest",
    );
  }
  requireEqual(planReview.subject, "plan", "Plan review subject");
  requireEqual(planReview.reviewer_role, "review-plan", "Plan review role");
  requireEqual(planReview.subject_sha256, planDigest, "Plan review digest");
  requireEqual(planReview.head_sha, plan.head_sha, "Plan review planning HEAD");
  requireEqual(planReview.verdict, "clean", "Plan review verdict");
  if (planReview.findings.length !== 0)
    throw new Error("Plan review has findings.");
  requireEqual(
    implementation.plan_sha256,
    planDigest,
    "Implementation plan digest",
  );
  requireEqual(
    verification.head_sha,
    implementation.head_sha,
    "Verification HEAD",
  );
  requireEqual(verification.verdict, "passed", "Full verification verdict");
  if (implementation.deviations.length !== 0)
    throw new Error("Implementation has deviations.");
  const claims = plan.claims.map((claim) => claim.id).sort();
  const evidence = implementation.claim_evidence
    .map((claim) => claim.claim_id)
    .sort();
  if (
    new Set(claims).size !== claims.length ||
    new Set(evidence).size !== evidence.length ||
    JSON.stringify(claims) !== JSON.stringify(evidence)
  )
    throw new Error(
      "Implementation claim evidence must exactly cover the plan once.",
    );
  const commands = verificationPlan("full").map(displayCommand);
  requireEqual(
    JSON.stringify(plan.verification),
    JSON.stringify(commands),
    "Accepted full verification commands",
  );
  requireEqual(
    JSON.stringify(verification.commands.map((command) => command.command)),
    JSON.stringify(commands),
    "Executed full verification commands",
  );
}

function validateScope(observed, plan, implementation) {
  const declared = implementation.changed_files.map(requireRepoPath).sort();
  if (JSON.stringify(observed) !== JSON.stringify(declared))
    throw new Error(
      "Observed scope must exactly equal implementation.changed_files; return the scope gap to planning.",
    );
  const allowed = new Set(plan.allowed_paths.map(requireRepoPath));
  if (
    observed.some(
      (filename) =>
        !allowed.has(filename) ||
        plan.forbidden_paths.some((pattern) =>
          minimatch(filename, pattern, { dot: true }),
        ),
    )
  )
    throw new Error(
      "Observed scope must be explicitly allowed and not forbidden.",
    );
}

/** The optional shortcut alone requires an index equal to HEAD. */
export async function discoverLocalPaths(options) {
  const observed = await readLocalReviewScope(options);
  if (observed.staged.length !== 0)
    throw new Error(
      "Local shortcut requires index equal to HEAD; staged changes are unsupported.",
    );
  return observed;
}

/** Observe ordinary local work, including stage-0 entries, without approving it. */
export async function readLocalReviewScope({
  repositoryRoot,
  baseSha,
  headSha,
  gitRunner,
}) {
  if (
    typeof baseSha !== "string" ||
    typeof headSha !== "string" ||
    !commitPattern.test(baseSha) ||
    !commitPattern.test(headSha)
  )
    throw new Error("Local scope requires exact commit SHA inputs.");
  const root = await fs.realpath(repositoryRoot);
  const context = await createLocalGitReadContext({
    repositoryRoot: root,
    gitRunner,
  });
  const runner = context.gitRunner;
  const query = async (args) => {
    const result = await runner({
      command: "git",
      args,
      timeoutMs: 30_000,
      maxStdoutBytes: maximumGitBytes,
      maxStderrBytes: 16_384,
    });
    if (
      result?.exitCode !== 0 ||
      !Buffer.isBuffer(result.stdout) ||
      result.stdout.length > maximumGitBytes ||
      !Buffer.isBuffer(result.stderr) ||
      result.stderr.length > 16_384
    )
      throw new Error("Bounded Git scope query failed.");
    return result.stdout;
  };
  const top = decode(await query(["rev-parse", "--show-toplevel"]));
  if (top !== `${root}\n` && top !== `${repositoryRoot}\n`)
    throw new Error("Git query must run at the repository root.");
  for (const commit of sortedUnique([baseSha, headSha])) {
    requireEqual(
      decode(await query(["cat-file", "-t", commit])),
      "commit\n",
      "Git input object type",
    );
  }
  const committed = parsePaths(
    await query([
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      `${baseSha}..${headSha}`,
      "--",
    ]),
  );
  const staged = parsePaths(
    await query([
      "diff",
      "--cached",
      "--ita-visible-in-index",
      "--name-only",
      "-z",
      "--no-renames",
      "HEAD",
      "--",
    ]),
  );
  const unstaged = parsePaths(
    await query(["diff", "--name-only", "-z", "--no-renames", "--"]),
  );
  const untracked = parsePaths(
    await query(["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  const indexBytes = await query([
    "ls-files",
    "--stage",
    "-v",
    "--sparse",
    "-z",
  ]);
  const index = parseNul(indexBytes);
  const names = new Set();
  for (const entry of index) {
    const match = /^H (100644|100755|120000) [a-f0-9]{40} 0\t([\s\S]+)$/u.exec(
      entry,
    );
    if (!match)
      throw new Error(
        "Unsupported unmerged, sparse, assume-unchanged or gitlink index state.",
      );
    const name = requireRepoPath(match[2]);
    if (names.has(name)) throw new Error("Duplicate index path.");
    names.add(name);
  }
  for (const filename of untracked) {
    const absolute = path.join(root, filename);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || (await fs.realpath(absolute)) !== absolute)
      throw new Error(
        "Untracked scope requires regular files inside the repository.",
      );
  }
  const paths = sortedUnique([
    ...committed,
    ...staged,
    ...unstaged,
    ...untracked,
  ]);
  if (paths.length > maximumPaths)
    throw new Error("Observed scope exceeds path count limit.");
  await context.assertCurrent();
  return {
    paths,
    committed,
    staged,
    unstaged,
    untracked,
    indexSha256: sha256(indexBytes),
  };
}

/** Share one frozen Git admission snapshot throughout an ordinary handoff. */
export async function createLocalGitReadContext({
  repositoryRoot,
  gitRunner,
} = {}) {
  const root = await fs.realpath(repositoryRoot ?? defaultRoot);
  const existing = gitRunner && localContexts.get(gitRunner);
  if (existing) {
    existing.requireRoot(root);
    return existing;
  }
  const environment = Object.freeze({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
  const context = await LocalGitReadContext.create(
    root,
    gitRunner ?? ((planned) => boundedGit(planned, root, environment)),
  );
  localContexts.set(context.gitRunner, context);
  return Object.freeze(context);
}

// Raw configuration and effective attributes remain bounded private memory.
// Repeated observations reject persistent drift; they are not an atomic lock
// against arbitrary concurrent local writers.
class LocalGitReadContext {
  #root;
  #runner;
  #snapshot;

  constructor(root, runner) {
    this.#root = root;
    this.#runner = runner;
    this.gitRunner = async (planned) => {
      if (
        planned.command !== "git" ||
        !["rev-parse", "cat-file", "diff", "ls-files"].includes(
          planned.args?.[0],
        )
      )
        throw new Error("Local reader accepts only Git evidence reads.");
      const converting = planned.args[0] === "diff";
      if (converting) await this.assertCurrent();
      const result = await this.#query(planned.args);
      if (converting) await this.assertCurrent();
      return result;
    };
  }

  requireRoot(root) {
    requireEqual(root, this.#root, "Local reader repository root");
  }

  static async create(root, runner) {
    const context = new LocalGitReadContext(root, runner);
    requireEqual(
      decode((await context.#query(["rev-parse", "--show-toplevel"])).stdout),
      `${root}\n`,
      "Local reader repository root",
    );
    context.#snapshot = await context.#observe();
    return context;
  }

  async assertCurrent() {
    requireEqual(
      await this.#observe(),
      this.#snapshot,
      "Effective Git config and conversion attributes",
    );
  }

  async #query(args) {
    let result;
    try {
      result = await this.#runner({
        command: "git",
        args,
        timeoutMs: 30_000,
        maxStdoutBytes: maximumGitBytes,
        maxStderrBytes: 16_384,
      });
    } catch {
      throw new Error("Bounded Git read failed.");
    }
    if (
      result?.exitCode !== 0 ||
      !Buffer.isBuffer(result.stdout) ||
      result.stdout.length > maximumGitBytes ||
      !Buffer.isBuffer(result.stderr) ||
      result.stderr.length > 16_384
    )
      throw new Error("Bounded Git read failed.");
    return result;
  }

  async #configuration() {
    const { stdout } = await this.#query([
      "--no-pager",
      "config",
      "--null",
      "--list",
      "--show-origin",
      "--show-scope",
      "--includes",
    ]);
    const fields = nulFields(stdout, "config");
    if (fields.length % 3 !== 0)
      throw new Error("Malformed effective Git config records.");
    for (let offset = 0; offset < fields.length; offset += 3) {
      const [scope, origin, record] = fields.slice(offset, offset + 3);
      const delimiter = record.indexOf("\n");
      const key = delimiter === -1 ? record : record.slice(0, delimiter);
      if (
        ![
          "unknown",
          "system",
          "global",
          "local",
          "worktree",
          "command",
        ].includes(scope) ||
        !/^(file|command line|standard input|blob):[\s\S]*$/u.test(origin) ||
        !/^[a-z0-9-]+\.(?:[^\n]*\.)?[a-z][a-z0-9-]*$/iu.test(key)
      )
        throw new Error("Malformed effective Git config records.");
      // Check every definition, including overridden, empty and valueless ones.
      if (/^filter\.[\s\S]*\.(clean|process)$/iu.test(key))
        throw new Error(
          "Local Git filter clean/process definitions are unsupported.",
        );
    }
    return sha256(stdout);
  }

  async #observe() {
    const config = await this.#configuration();
    const tracked = (await this.#query(["ls-files", "--cached", "-z"])).stdout;
    const untracked = (
      await this.#query(["ls-files", "--others", "--exclude-standard", "-z"])
    ).stdout;
    if (tracked.length + untracked.length > maximumGitBytes)
      throw new Error("Git attribute universe exceeds output bound.");
    const paths = sortedUnique([
      ...parsePaths(tracked),
      ...parsePaths(untracked),
    ]);
    if (paths.length > maximumPaths)
      throw new Error("Git attribute universe exceeds path count limit.");
    const hash = createHash("sha256").update(config).update("\0");
    const prefix = ["check-attr", "-z", ...conversionAttributes, "--"];
    const prefixBytes = [...gitControls, ...prefix].reduce(
      (size, arg) => size + Buffer.byteLength(arg) + 1,
      0,
    );
    let batch = [];
    let argumentBytes = prefixBytes;
    let outputBytes = 0;
    const capture = async () => {
      if (batch.length === 0) return;
      const { stdout } = await this.#query([...prefix, ...batch]);
      outputBytes += stdout.length;
      if (outputBytes > maximumGitBytes)
        throw new Error("Git attribute snapshot exceeds output bound.");
      const fields = nulFields(stdout, "attribute");
      if (fields.length !== batch.length * conversionAttributes.length * 3)
        throw new Error("Incomplete Git conversion attribute records.");
      let offset = 0;
      for (const filename of batch) {
        for (const attribute of conversionAttributes) {
          if (fields[offset] !== filename || fields[offset + 1] !== attribute)
            throw new Error("Malformed Git conversion attribute coverage.");
          if (attribute === "ident" && fields[offset + 2] === "set")
            throw new Error("Active Git ident conversion is unsupported.");
          offset += 3;
        }
      }
      hash.update(stdout);
    };
    for (const filename of paths) {
      const bytes = Buffer.byteLength(filename) + 1;
      if (argumentBytes + bytes > maximumAttributeArgumentBytes) {
        await capture();
        batch = [];
        argumentBytes = prefixBytes;
      }
      batch.push(filename);
      argumentBytes += bytes;
    }
    await capture();
    requireEqual(
      await this.#configuration(),
      config,
      "Effective Git config during attribute acquisition",
    );
    return hash.digest("hex");
  }
}

function nulFields(bytes, label) {
  const value = decode(bytes);
  if (value === "") return [];
  if (!value.endsWith("\0"))
    throw new Error(`Malformed Git ${label} NUL records.`);
  return value.slice(0, -1).split("\0");
}

// Reuse the verifier's bounded process lifetime, output capture and owned-group
// cleanup. Capture stdout as bytes before runCommand's display-only decoding.
async function boundedGit(planned, repositoryRoot, environment) {
  if (planned.command !== "git")
    throw new Error("Local review can execute only Git reads.");
  const args = [...gitControls, ...planned.args];
  if (planned.args[0] === "diff")
    args.splice(
      5,
      0,
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
    );
  const chunks = [];
  let length = 0;
  const result = await runCommand(
    { ...planned, args },
    {
      writeOutput: () => undefined,
      spawnProcess: (command, commandArgs, options) => {
        const child = spawn(command, commandArgs, {
          ...options,
          cwd: repositoryRoot,
          env: environment,
        });
        child.stdout.on("data", (chunk) => {
          const retained = Buffer.from(
            chunk.subarray(0, Math.max(0, planned.maxStdoutBytes - length)),
          );
          if (retained.length > 0) chunks.push(retained);
          length += retained.length;
        });
        return child;
      },
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: Buffer.concat(chunks, length),
    stderr: Buffer.from(result.stderr),
  };
}

class EvidenceSnapshot {
  constructor(repositoryRoot) {
    this.repositoryRoot = repositoryRoot;
    this.files = new Map();
    this.totalBytes = 0;
  }

  async add(
    filename,
    label,
    { external = true, maximumBytes = maximumFileBytes } = {},
  ) {
    const absolute = path.resolve(filename);
    const resolved = await fs.realpath(absolute);
    if (external && isInside(this.repositoryRoot, resolved))
      throw new Error("Keep all local review evidence outside the repository.");
    if (!external && !isInside(this.repositoryRoot, resolved))
      throw new Error("Policy and skills must remain inside the repository.");
    if (this.files.has(resolved))
      throw new Error("Duplicate evidence file path.");
    if (this.files.size >= 80 || this.totalBytes >= maximumTotalBytes)
      throw new Error("Evidence snapshot exceeds aggregate bounds.");
    const file = await readStableFile(
      absolute,
      Math.min(maximumBytes, maximumTotalBytes - this.totalBytes),
    );
    this.totalBytes += file.bytes.length;
    const record = {
      ...file,
      filename: absolute,
      resolved,
      label,
      maximumBytes,
    };
    this.files.set(resolved, record);
    return record;
  }

  async assertCurrent() {
    for (const previous of this.files.values()) {
      requireEqual(
        await fs.realpath(previous.filename),
        previous.resolved,
        "Evidence resolved path",
      );
      const current = await readStableFile(
        previous.filename,
        previous.maximumBytes,
      );
      requireEqual(
        current.identity,
        previous.identity,
        "Evidence file identity",
      );
      requireEqual(current.sha256, previous.sha256, "Evidence bytes");
    }
  }
}

async function readStableFile(filename, maximumBytes) {
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.size > BigInt(maximumBytes))
    throw new Error("Evidence must be a bounded regular nonsymlink file.");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    requireEqual(
      statIdentity(opened),
      statIdentity(before),
      "Evidence open identity",
    );
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== Number(opened.size))
      throw new Error("Evidence size changed while reading.");
    const identity = statIdentity(opened);
    requireEqual(
      statIdentity(await handle.stat({ bigint: true })),
      identity,
      "Evidence read identity",
    );
    requireEqual(
      statIdentity(await fs.lstat(filename, { bigint: true })),
      identity,
      "Evidence path identity",
    );
    const bytes = buffer.subarray(0, offset);
    return { bytes, identity, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

function statIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function isInside(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function decode(bytes) {
  return decoder().decode(bytes);
}

function parseArtifact(kind, file) {
  return validateArtifact(kind, JSON.parse(decode(file.bytes)));
}

function parseNul(bytes) {
  const value = decode(bytes);
  if (value === "") return [];
  if (!value.endsWith("\0"))
    throw new Error("Malformed NUL-delimited Git output.");
  const entries = value.slice(0, -1).split("\0");
  if (entries.length > maximumPaths || entries.some((entry) => !entry))
    throw new Error("Malformed or excessive Git path count.");
  return entries;
}

function parsePaths(bytes) {
  return sortedUnique(parseNul(bytes).map(requireRepoPath));
}

function requireRepoPath(filename) {
  if (
    typeof filename !== "string" ||
    !filename.trim() ||
    filename.includes("\0") ||
    filename.includes("\\") ||
    /^[A-Za-z]:/u.test(filename) ||
    path.posix.isAbsolute(filename) ||
    path.posix.normalize(filename) !== filename ||
    filename
      .split("/")
      .some(
        (part) =>
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          part === "",
      ) ||
    Buffer.byteLength(filename) > 4096
  )
    throw new Error("Noncanonical repository path in local scope.");
  return filename;
}

function canonicalJson(value) {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} is stale or invalid.`);
}

const optionNames = {
  "--mode": "mode",
  "--plan": "plan",
  "--plan-review": "planReview",
  "--implementation": "implementation",
  "--verification": "verification",
  "--subject-sha256": "subjectSha256",
  "--review": "reviews",
  "--print-subject": "printSubject",
};

export function parseLocalReviewArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = Object.hasOwn(optionNames, args[index])
      ? optionNames[args[index]]
      : undefined;
    if (!name) throw new Error("Unknown local review option.");
    if (name !== "reviews" && Object.hasOwn(options, name))
      throw new Error("Duplicate local review option.");
    if (name === "printSubject") {
      options.printSubject = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error("Local review option requires a value.");
    if (name === "reviews") (options.reviews ??= []).push(value);
    else options[name] = value;
  }
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (name) => !Object.values(optionNames).includes(name),
    )
  )
    throw new Error("Invalid local review option.");
  if (options.mode !== "local")
    throw new Error("Explicit --mode local is required.");
  for (const name of ["plan", "planReview", "implementation", "verification"]) {
    if (
      typeof options[name] !== "string" ||
      !options[name].trim() ||
      options[name].includes("\0")
    )
      throw new Error("All four local prerequisite paths are required.");
  }
  if (options.printSubject !== undefined && options.printSubject !== true)
    throw new Error("Invalid print-subject option.");
  if (options.printSubject) {
    if (options.subjectSha256 !== undefined || options.reviews !== undefined)
      throw new Error("Print-subject is incompatible with review inputs.");
    return;
  }
  if (
    !digestPattern.test(options.subjectSha256 ?? "") ||
    !Array.isArray(options.reviews) ||
    options.reviews.length === 0 ||
    options.reviews.length > AREA_REVIEW_ROLES.length ||
    options.reviews.some(
      (filename) =>
        typeof filename !== "string" ||
        !filename.trim() ||
        filename.includes("\0"),
    )
  )
    throw new Error(
      "Aggregation requires a subject digest and bounded review paths.",
    );
  if (
    new Set(options.reviews.map((filename) => path.resolve(filename))).size !==
    options.reviews.length
  )
    throw new Error("Duplicate local review path.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseLocalReviewArgs(process.argv.slice(2));
    process.stdout.write(await reviewLocal(options));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Local review rejected.";
    // ASCII escaping keeps diagnostics bounded without splitting UTF-8 or
    // allowing untrusted artifact text to control the terminal.
    process.stderr.write(
      `${JSON.stringify(message)
        .replace(/[^\x20-\x7e]/gu, "?")
        .slice(0, 1000)}\n`,
    );
    process.exitCode = 1;
  }
}

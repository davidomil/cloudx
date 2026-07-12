#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyChange, loadPolicy } from "./policy.mjs";
import { validateSchema } from "./schema-validator.mjs";

const scriptPath = fileURLToPath(import.meta.url);

export async function classifyInput(input, options = {}) {
  validateSchema("classification-input", input);
  const changes = normalizeChanges(input.changes);
  const paths = sortedUnique(
    changes.flatMap((change) => [change.previous_path, change.path]),
  );
  const policy = options.policy ?? (await loadPolicy(options.policyPath));
  const routed = classifyChange(policy, { type: input.type, paths });
  const classification = {
    schema_version: 1,
    kind: "change-classification",
    base_sha: input.base_sha,
    head_sha: input.head_sha,
    policy_sha256: policy.policySha256,
    type: routed.type,
    changes,
    paths: [...routed.paths],
    areas: [...routed.areas],
    risk: routed.risk,
    skills: [...routed.skills],
    checks: [...routed.checks],
    human_review_required: routed.humanReviewRequired,
    automerge_eligible: routed.automergeEligible,
    generated_paths: [...routed.generatedPaths],
    matched_rules: [...routed.matchedRules],
    labels: [...routed.labels].sort(),
  };
  return validateSchema("classification", classification);
}

export function gitClassificationInput({
  base,
  head,
  type,
  cwd = process.cwd(),
}) {
  const baseSha = resolveCommit(cwd, base);
  const headSha = resolveCommit(cwd, head);
  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      `${baseSha}...${headSha}`,
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return validateSchema("classification-input", {
    schema_version: 1,
    kind: "change-classification-input",
    base_sha: baseSha,
    head_sha: headSha,
    type,
    changes: parseGitNameStatus(output),
  });
}

export function parseGitNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (!code) {
      throw new Error("Git returned an empty change status.");
    }
    if (/^R\d{0,3}$/u.test(code)) {
      const previousPath = requiredGitField(fields[index++], code);
      const changedPath = requiredGitField(fields[index++], code);
      changes.push({
        status: "renamed",
        previous_path: previousPath,
        path: changedPath,
      });
      continue;
    }
    const status = { A: "added", M: "modified", D: "deleted" }[code];
    if (!status) {
      throw new Error(`Unsupported git change status '${code}'.`);
    }
    changes.push({ status, path: requiredGitField(fields[index++], code) });
  }
  return changes;
}

export function parseClassifierArgs(argv) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (
      !["--input", "--base", "--head", "--type", "--policy"].includes(argument)
    ) {
      throw new Error(`Unknown classifier option: ${argument}`);
    }
    if (seen.has(argument)) {
      throw new Error(`${argument} may be specified only once.`);
    }
    seen.add(argument);
    const value = argv[++index];
    if (!value) {
      throw new Error(`${argument} requires a value.`);
    }
    options[argument.slice(2)] = value;
  }
  if (options.help) {
    return options;
  }
  const gitArguments = [options.base, options.head, options.type].filter(
    Boolean,
  );
  if (options.input && gitArguments.length > 0) {
    throw new Error("Use either --input or --base/--head/--type, not both.");
  }
  if (!options.input && gitArguments.length !== 3) {
    throw new Error("Git classification requires --base, --head, and --type.");
  }
  return options;
}

export async function runClassifier(argv, options = {}) {
  const parsed = parseClassifierArgs(argv);
  if (parsed.help) {
    return { help: classifierHelp() };
  }
  const cwd = options.cwd ?? process.cwd();
  const policyPath = parsed.policy
    ? path.resolve(cwd, parsed.policy)
    : undefined;
  const input = parsed.input
    ? JSON.parse(fs.readFileSync(path.resolve(cwd, parsed.input), "utf8"))
    : gitClassificationInput({
        base: parsed.base,
        head: parsed.head,
        type: parsed.type,
        cwd,
      });
  return { classification: await classifyInput(input, { policyPath }) };
}

function normalizeChanges(changes) {
  const normalized = changes.map((change) => ({
    status: change.status,
    path: normalizeRepoPath(change.path),
    ...(change.previous_path === undefined
      ? {}
      : { previous_path: normalizeRepoPath(change.previous_path) }),
    ...(change.binary === undefined ? {} : { binary: change.binary }),
  }));
  const unique = new Map(
    normalized.map((change) => [JSON.stringify(change), change]),
  );
  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.status, right.status) ||
      compareText(left.previous_path ?? "", right.previous_path ?? ""),
  );
}

function normalizeRepoPath(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error("Changed paths must be non-empty strings.");
  }
  const portable = candidate
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "");
  if (
    portable.startsWith("/") ||
    /^[A-Za-z]:\//u.test(portable) ||
    portable.includes("\0")
  ) {
    throw new Error(`Changed path must be repository-relative: ${candidate}`);
  }
  const segments = portable.split("/");
  if (segments.includes("..")) {
    throw new Error(`Changed path must be repository-relative: ${candidate}`);
  }
  const normalized = segments
    .filter((segment) => segment && segment !== ".")
    .join("/");
  if (!normalized) {
    throw new Error(`Changed path must be repository-relative: ${candidate}`);
  }
  return normalized;
}

function resolveCommit(cwd, reference) {
  try {
    return execFileSync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`],
      { cwd, encoding: "utf8" },
    ).trim();
  } catch {
    throw new Error(`Cannot resolve git commit '${reference}'.`);
  }
}

function requiredGitField(value, status) {
  if (!value) {
    throw new Error(`Git change status '${status}' is missing a path.`);
  }
  return value;
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function classifierHelp() {
  return [
    "Classify changed repository paths with the tracked AI review policy.",
    "",
    "Usage:",
    "  node scripts/ai-change/classify.mjs --input change.json [--policy policy.toml]",
    "  node scripts/ai-change/classify.mjs --base <ref> --head <ref> --type <type> [--policy policy.toml]",
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runClassifier(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(
        `${result.help ?? JSON.stringify(result.classification, null, 2)}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

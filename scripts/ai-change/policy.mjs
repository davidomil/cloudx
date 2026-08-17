import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { minimatch } from "minimatch";
import { parse } from "smol-toml";

import { validateSchema } from "./schema-validator.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const defaultPolicyPath = path.join(
  repoRoot,
  ".agents",
  "pr-review-policy.toml",
);
const riskOrder = new Map([
  ["low", 0],
  ["medium", 1],
  ["high", 2],
  ["human-required", 3],
]);

export async function loadPolicy(policyPath = defaultPolicyPath) {
  const source = await fs.readFile(policyPath, "utf8");
  const policy = validateSchema("policy", parse(source));
  const appSlugs = [
    policy.activation.manager_app_slug,
    policy.activation.publisher_app_slug,
    policy.activation.merge_app_slug,
  ];
  if (new Set(appSlugs).size !== appSlugs.length) {
    throw new Error(
      "Manager, Candidate Publisher, and Merge Authority App slugs must be distinct.",
    );
  }
  if (
    policy.activation.publisher_app_slug !==
      policy.managed_generation.provenance_app_slug ||
    policy.activation.merge_app_slug !==
      policy.managed_generation.intent_app_slug
  ) {
    throw new Error(
      "Activation App slugs must match the managed generation authorities.",
    );
  }
  return Object.freeze({
    ...policy,
    policySha256: createHash("sha256").update(source).digest("hex"),
  });
}

export function classifyChange(policy, { paths, type }) {
  if (!policy.labels.types.includes(type)) {
    throw new Error(
      `Unsupported change type '${type}'. Expected one of: ${policy.labels.types.join(", ")}.`,
    );
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("A change must contain at least one path.");
  }

  const normalizedPaths = [...new Set(paths.map(normalizeRepoPath))].sort();
  const routes = normalizedPaths.flatMap((changedPath) =>
    routesForPath(policy, changedPath),
  );
  const areas = sortedUnique(
    routes.flatMap((route) => route.areas ?? [route.area]),
  );
  const skills = new Set(routes.flatMap((route) => route.skills));
  const checks = new Set(routes.flatMap((route) => route.checks));
  let risk = strongestRisk(routes.map((route) => route.risk));

  if (areas.length > 1) {
    risk = strongestRisk([risk, policy.cross_area.risk]);
    policy.cross_area.skills.forEach((skill) => skills.add(skill));
  }

  const humanReviewRequired =
    routes.some((route) => route.human_review) || risk === "human-required";
  const automergeEligible =
    !humanReviewRequired && routes.every((route) => route.automerge);
  const generatedPaths = normalizedPaths.filter((changedPath) =>
    isGeneratedPath(policy, changedPath),
  );
  const labels = [
    `type:${type}`,
    ...areas.map((area) => `area:${area}`),
    `risk:${risk}`,
    ...(humanReviewRequired ? [policy.labels.manual_review] : []),
  ];

  return {
    type,
    paths: normalizedPaths,
    areas,
    risk,
    skills: [...skills].sort(),
    checks: [...checks].sort(),
    humanReviewRequired,
    automergeEligible,
    generatedPaths,
    matchedRules: sortedUnique(routes.map((route) => route.name ?? "defaults")),
    labels,
  };
}

export function reconcileLabels(
  policy,
  { current, classification, reviewState, invalidateMergeIntent = false },
) {
  if (!policy.labels.review_states.includes(reviewState)) {
    throw new Error(`Unsupported review state '${reviewState}'.`);
  }
  const managedPrefixes = ["type:", "area:", "risk:", "ai:review-"];
  const managedExact = new Set([policy.labels.manual_review]);
  if (invalidateMergeIntent) {
    managedExact.add(policy.labels.intent);
  }
  const preserved = current.filter(
    (label) =>
      !managedExact.has(label) &&
      !managedPrefixes.some((prefix) => label.startsWith(prefix)),
  );
  return [
    ...new Set([
      ...preserved,
      ...classification.labels,
      `ai:review-${reviewState}`,
    ]),
  ];
}

function routesForPath(policy, changedPath) {
  const matches = policy.path_rules.filter((rule) =>
    rule.globs.some((glob) => minimatch(changedPath, glob, { dot: true })),
  );
  return matches.length > 0
    ? matches
    : [{ name: "defaults", ...policy.defaults, areas: [policy.defaults.area] }];
}

function isGeneratedPath(policy, changedPath) {
  return policy.generated_rules.some((rule) =>
    rule.globs.some((glob) => minimatch(changedPath, glob, { dot: true })),
  );
}

function normalizeRepoPath(candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error("Changed paths must be non-empty strings.");
  }
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Changed path must be repository-relative: ${candidate}`);
  }
  return normalized;
}

function strongestRisk(risks) {
  return risks.reduce((strongest, risk) => {
    if (!riskOrder.has(risk)) {
      throw new Error(`Unknown risk tier '${risk}'.`);
    }
    return riskOrder.get(risk) > riskOrder.get(strongest) ? risk : strongest;
  }, "low");
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

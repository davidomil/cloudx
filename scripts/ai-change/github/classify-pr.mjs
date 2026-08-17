#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { classifyChange, loadPolicy, reconcileLabels } from "../policy.mjs";
import { createGitHubApi, repoRoute } from "./api.mjs";
import { reconcileIssueLabels } from "./label-reconciliation.mjs";
import { changedPathsForPullRequest } from "./pull-request-files.mjs";

const labelPresentation = {
  "ai:generated": [
    "1d76db",
    "Change was authored through the repository AI process.",
  ],
  "manual review": [
    "b60205",
    "Policy requires a maintainer decision or review.",
  ],
  "ai:review-pending": ["fbca04", "Exact-head AI review has not completed."],
  "ai:review-clean": [
    "0e8a16",
    "Exact-head AI review completed without findings.",
  ],
  "ai:review-blocked": [
    "b60205",
    "AI review or repository policy found blocking issues.",
  ],
  "ai:review-stale": ["d4c5f9", "Review evidence belongs to an earlier head."],
  "trusted-auto-merge": [
    "0e8a16",
    "Maintainer requests exact-head merge after every gate passes.",
  ],
};

export function declaredChangeType(body, allowedTypes) {
  const matches = [
    ...String(body ?? "").matchAll(/^Change-Type:\s*([a-z-]+)\s*$/gim),
  ].map((match) => match[1].toLowerCase());
  if (matches.length !== 1 || !allowedTypes.includes(matches[0])) return null;
  return matches[0];
}

export function labelsForUnclassifiedPullRequest(
  policy,
  current,
  { invalidateMergeIntent },
) {
  const managed = current.filter(
    (label) =>
      !["type:", "area:", "risk:", "ai:review-"].some((prefix) =>
        label.startsWith(prefix),
      ) &&
      label !== policy.labels.manual_review &&
      (!invalidateMergeIntent || label !== policy.labels.intent),
  );
  return [
    ...new Set([...managed, policy.labels.manual_review, "ai:review-blocked"]),
  ];
}

export async function classifyPullRequest({
  api,
  policy,
  pullRequest,
  invalidateMergeIntent = false,
}) {
  const paths = await changedPathsForPullRequest(api, pullRequest);
  const current = pullRequest.labels.map((label) => label.name);
  const type = declaredChangeType(pullRequest.body, policy.labels.types);
  if (!type) {
    return {
      classification: null,
      labels: labelsForUnclassifiedPullRequest(policy, current, {
        invalidateMergeIntent,
      }),
    };
  }
  const classification = classifyChange(policy, { type, paths });
  const labels = reconcileLabels(policy, {
    current,
    classification,
    reviewState: "pending",
    invalidateMergeIntent,
  });
  return { classification, labels };
}

export function presentationForLabel(label) {
  if (labelPresentation[label]) return labelPresentation[label];
  if (label.startsWith("type:"))
    return ["5319e7", `Change type: ${label.slice(5)}.`];
  if (label.startsWith("area:"))
    return ["1d76db", `Affected area: ${label.slice(5)}.`];
  if (label.startsWith("risk:"))
    return [
      label === "risk:human-required" ? "b60205" : "fbca04",
      `Policy risk: ${label.slice(5)}.`,
    ];
  throw new Error(
    `No presentation metadata exists for managed label '${label}'.`,
  );
}

async function main() {
  const api = createGitHubApi({
    token: process.env.GH_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
  });
  const number = positiveInteger(process.env.PR_NUMBER, "PR_NUMBER");
  const policy = await loadPolicy();
  const pullRequest = await api.get(
    repoRoute(api.repository, `/pulls/${number}`),
  );
  const result = await classifyPullRequest({
    api,
    policy,
    pullRequest,
    invalidateMergeIntent: process.env.INVALIDATE_MERGE_INTENT === "true",
  });

  for (const label of result.labels.filter(isManagedLabel)) {
    const [color, description] = presentationForLabel(label);
    try {
      await api.post(repoRoute(api.repository, "/labels"), {
        name: label,
        color,
        description,
      });
    } catch (error) {
      if (error.status !== 422) throw error;
    }
  }
  await reconcileIssueLabels({
    api,
    number,
    current: pullRequest.labels.map((label) => label.name),
    desired: result.labels,
    manages: isManagedLabel,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isManagedLabel(label) {
  return (
    ["type:", "area:", "risk:", "ai:review-"].some((prefix) =>
      label.startsWith(prefix),
    ) || labelPresentation[label] !== undefined
  );
}

function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value ?? ""))
    throw new Error(`${name} must be a positive integer.`);
  return Number(value);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

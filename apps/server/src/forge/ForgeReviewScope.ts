import type { ForgeReviewScope } from "@cloudx/shared";

export function reviewScopeSummary(scope: ForgeReviewScope): string {
  return scope.previous
    ? `Review scope: ${scope.kind}, ${scope.previous.headSha} → ${scope.current.headSha} (merge bases ${scope.previous.mergeBaseSha} → ${scope.current.mergeBaseSha}).`
    : `Review scope: initial, ${scope.current.baseSha}...${scope.current.headSha} (merge base ${scope.current.mergeBaseSha}).`;
}

export function reviewScopeInstructions(scope: ForgeReviewScope): string {
  const { current, previous } = scope;
  const instructions = [
    "Continue this request's review in the same conversation. Read the current task, previousReviews, and feedback again. Earlier findings remain relevant until verified as addressed; earlier approvals do not approve a changed commit.",
    reviewScopeSummary(scope),
    "Both revisions and their base history are retained in the owned checkout. Do not use the provider's downloadable diff, which may omit large changes. If output is clipped, inspect smaller relevant file ranges.",
  ];
  if (!previous) {
    instructions.push(`No review has completed yet: review the full pinned PR/MR comparison with git diff --no-ext-diff --no-textconv ${current.baseSha}...${current.headSha} --. Inspect every changed file.`);
  } else {
    instructions.push(
      `The last completed review examined ${previous.headSha}; the current pinned head is ${current.headSha}. Compare with git diff --no-ext-diff --no-textconv ${previous.headSha} ${current.headSha} --.`,
      "Review this delta and verify how previous findings were addressed. Examine surrounding code only as needed to understand consequences of the changes. Keep effort proportional: a documentation-only follow-up needs the documentation delta; a small fix needs the affected behavior and relevant validation. Do not repeat a full implementation audit or full test-suite run merely because a new round started. Required CI and merge checks still apply.",
    );
    if (scope.kind === "unchanged") {
      instructions.push("The head trees and effective base are unchanged. Process new feedback and unresolved findings without repeating the code review. Produce a fresh decision for the current pinned head.");
    }
    if (scope.kind === "rewritten") {
      instructions.push(
        `History or the effective base changed. Distinguish already-reviewed work and upstream changes from new edits with git diff --no-ext-diff --no-textconv ${previous.mergeBaseSha} ${current.mergeBaseSha} -- and git range-diff --no-color ${previous.mergeBaseSha}..${previous.headSha} ${current.mergeBaseSha}..${current.headSha} --.`,
        `Range-diff is a human review aid, not machine-readable proof; it ignores merge commits by default. Keep the endpoint diff as evidence of final tree changes. Identify newly introduced merges with git log --merges --format=%H ${current.mergeBaseSha}..${current.headSha} --not ${previous.headSha} --. Inspect their resolutions with git show --remerge-diff --no-ext-diff --no-textconv <mergeSha> --, and compare against each parent for octopus merges or changes the remerge view cannot explain.`,
        `Use the retained old base/head (${previous.baseSha}, ${previous.headSha}) and current base/head (${current.baseSha}, ${current.headSha}) to inspect affected patches and interactions. A rewritten SHA alone does not make already-reviewed work new. Account explicitly for conflict-resolution edits and changes dropped during a rebase; keep small resolutions focused on effective changes and affected interactions.`,
      );
    }
    instructions.push("Expand review scope only where actual changes invalidate earlier conclusions, and explain the concrete reason for any wider review.");
  }
  instructions.push(`Briefly record the compared SHAs, scope, relevant validation, and any scope expansion in the report body. The report headSha and all inline findings must apply to the current pinned head ${current.headSha}; use its file paths and line numbers.`);
  return instructions.join(" ");
}

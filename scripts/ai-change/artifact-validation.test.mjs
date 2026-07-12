import { describe, expect, it } from "vitest";

import { validateArtifact } from "./artifact-validation.mjs";

const sha = (character) => character.repeat(64);
const gitSha = (character) => character.repeat(40);

function validPlan() {
  return {
    schema_version: 1,
    kind: "change-plan",
    run_id: "run-123",
    base_sha: gitSha("a"),
    head_sha: gitSha("a"),
    policy_sha256: sha("1"),
    skill_versions: { "plan-change": sha("2") },
    task: "Keep layout state consistent when a tab is removed.",
    classification: {
      type: "bug",
      areas: ["web"],
      risk: "medium",
      skills: ["review-web"],
      human_review_required: false,
      automerge_eligible: true,
    },
    anchors: [
      {
        path: "apps/web/src/ui/layout.ts",
        line: 10,
        reason: "Owns layout transitions.",
      },
      {
        path: "apps/web/src/ui/layout.test.ts",
        line: 20,
        reason: "Shows state transition tests.",
      },
    ],
    claims: [
      {
        id: "CLAIM-1",
        behavior: "Removing a tab removes its layout projection.",
        production_seam: "removeTabFromLayout",
        test: "layout test fails when the production change is reverted",
        negative_cases: ["another tab remains active"],
      },
    ],
    allowed_paths: [
      "apps/web/src/ui/layout.ts",
      "apps/web/src/ui/layout.test.ts",
    ],
    forbidden_paths: [".github/**", ".agents/**"],
    verification: ["npm run typecheck", "npm test -- --run"],
  };
}

function validReview(verdict = "clean") {
  return {
    schema_version: 1,
    kind: "change-review",
    run_id: "run-123",
    subject: "plan",
    subject_sha256: sha("3"),
    base_sha: gitSha("a"),
    head_sha: gitSha("a"),
    policy_sha256: sha("1"),
    reviewer_role: "review-plan",
    verdict,
    tags: [],
    findings:
      verdict === "clean"
        ? []
        : [
            {
              id: "ARCH-001",
              severity: "high",
              category: "architecture",
              path: "apps/web/src/ui/App.tsx",
              line: 100,
              evidence: "The plan changes a projection instead of its owner.",
              required_fix: "Move the change to layout.ts.",
            },
          ],
  };
}

describe("AI change artifacts", () => {
  it("accepts a plan with anchors, claims, and revert-failing proof", () => {
    expect(validateArtifact("plan", validPlan())).toEqual(validPlan());
  });

  it("rejects plans that omit claim-to-test evidence", () => {
    const plan = validPlan();
    delete plan.claims[0].test;

    expect(() => validateArtifact("plan", plan)).toThrow(/test/);
  });

  it("requires a clean review to have no findings", () => {
    const review = validReview("clean");
    review.findings = validReview("blocked").findings;

    expect(() => validateArtifact("review", review)).toThrow(/findings/);
  });

  it("supports an independent issue-classification review subject", () => {
    const review = validReview("clean");
    review.subject = "issue-classification";
    review.reviewer_role = "review-issue-triage";

    expect(validateArtifact("review", review)).toEqual(review);
  });

  it("accepts a clean manual disposition and rejects unknown or duplicate tags", () => {
    const review = { ...validReview("clean"), tags: ["manual-review"] };

    expect(validateArtifact("review", review)).toEqual(review);
    expect(() =>
      validateArtifact("review", { ...review, tags: ["invented"] }),
    ).toThrow(/tags/);
    expect(() =>
      validateArtifact("review", {
        ...review,
        tags: ["manual-review", "manual-review"],
      }),
    ).toThrow(/tags/);
  });

  it("requires a blocked review to identify at least one finding", () => {
    const review = validReview("blocked");
    review.findings = [];

    expect(() => validateArtifact("review", review)).toThrow(/findings/);
  });

  it("rejects undeclared fields rather than silently dropping evidence", () => {
    const plan = validPlan();
    plan.conversation_summary = "untyped context";

    expect(() => validateArtifact("plan", plan)).toThrow(
      /conversation_summary/,
    );
  });

  it("requires every passing verification command to bind one unchanged tree", () => {
    const verification = {
      schema_version: 1,
      kind: "change-verification",
      run_id: "run-123",
      base_sha: gitSha("a"),
      head_sha: gitSha("b"),
      policy_sha256: sha("1"),
      tree_sha256_before: sha("2"),
      tree_sha256_after: sha("2"),
      verdict: "passed",
      commands: [
        {
          command: "npm test",
          exit_code: 0,
          stdout_sha256: sha("3"),
          stderr_sha256: sha("4"),
          tree_sha256_before: sha("2"),
          tree_sha256_after: sha("2"),
        },
      ],
    };

    expect(validateArtifact("verification", verification)).toEqual(
      verification,
    );
    verification.commands[0].tree_sha256_after = sha("5");
    expect(() => validateArtifact("verification", verification)).toThrow(
      /every command/i,
    );
  });
});

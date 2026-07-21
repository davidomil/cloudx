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

function validVerification(command = "npm test") {
  return {
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
        command,
        exit_code: 0,
        stdout_sha256: sha("3"),
        stderr_sha256: sha("4"),
        tree_sha256_before: sha("2"),
        tree_sha256_after: sha("2"),
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
    const verification = validVerification();

    expect(validateArtifact("verification", verification)).toEqual(
      verification,
    );
    verification.commands[0].tree_sha256_after = sha("5");
    expect(() => validateArtifact("verification", verification)).toThrow(
      /every command/i,
    );
  });

  it.each([
    "git push origin HEAD:refs/heads/candidate",
    "git -c credential.helper= push origin HEAD:candidate",
    "git --config-env=credential.helper=HELPER push origin HEAD:candidate",
    "git -c diff.external=malicious diff HEAD^",
    "git --config-env=diff.external=HELPER diff HEAD^",
    "git --exec-path=/tmp/alternate-git diff HEAD^",
    "env TOKEN=value git push origin HEAD:candidate",
    "command git push origin HEAD:candidate",
    "gh api --method POST repos/davidomil/cloudx/issues",
    "gh pr comment 1 --body approved",
    "gh issue close 1",
    "gh repo edit davidomil/cloudx --enable-issues=false",
    "gh release create v1",
    "gh workflow run ci.yml",
    "sh -c 'git push origin HEAD:candidate'",
    "bash --command 'gh pr merge 1'",
    "curl -X POST https://api.github.com/repos/davidomil/cloudx/issues",
    'node -e \'execFileSync("git", ["push", "origin", "HEAD:candidate"])\'',
    'node -e \'execFileSync("g"+"it", ["p"+"ush", "origin", "HEAD:candidate"])\'',
    'node -e \'import fs from "node:fs"; fs.writeFileSync("mutation", "data")\'',
    'node -e \'import fs from "node:fs/promises"; import {execFileSync} from "node:child_process"; execFileSync("git", ["status"]); fs.writeFile("mutation", "data")\'',
    'node -e \'fetch("https://"+"api.github.com/repos/davidomil/cloudx")\'',
    'node -e \'process.mainModule.require("node:child_process").execFileSync("git", ["push"])\'',
    'python -c \'subprocess.run(["gh", "pr", "merge", "1"])\'',
  ])("rejects mutation command %s at both artifact boundaries", (command) => {
    const plan = validPlan();
    plan.verification = [command];

    expect(() => validateArtifact("plan", plan)).toThrow(/read-only/i);
    expect(() =>
      validateArtifact("verification", validVerification(command)),
    ).toThrow(/read-only/i);
  });

  it.each([
    "npm run policy:validate",
    "npx vitest run scripts/ai-change",
    "git diff --check HEAD^..HEAD",
    "node scripts/install-cloudx.mjs --dry-run --yes",
    "services/asr/.venv/bin/python -m pytest services/asr/tests",
    'node --input-type=module -e \'import {execFileSync} from "node:child_process"; execFileSync("git",["rev-parse","HEAD"]);\'',
    'test -z "$(git diff --name-only HEAD^..HEAD -- .github)"',
  ])("accepts recognized local read-only command %s", (command) => {
    const plan = validPlan();
    plan.verification = [command];

    expect(validateArtifact("plan", plan)).toEqual(plan);
    expect(
      validateArtifact("verification", validVerification(command)),
    ).toEqual(validVerification(command));
  });

  it("rejects an unsafe accepted plan before dispatching a command", () => {
    const plan = validPlan();
    plan.verification = [
      "git -c credential.helper= push origin HEAD:candidate",
    ];
    const dispatched = [];
    const dispatchAcceptedPlan = (candidate, runner) => {
      validateArtifact("plan", candidate);
      return candidate.verification.map(runner);
    };

    expect(() =>
      dispatchAcceptedPlan(plan, (command) => dispatched.push(command)),
    ).toThrow(/read-only/i);
    expect(dispatched).toEqual([]);
  });
});

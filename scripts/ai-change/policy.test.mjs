import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { classifyChange, loadPolicy, reconcileLabels } from "./policy.mjs";

const policy = await loadPolicy();

describe("AI change policy", () => {
  it("defines layered activation and three least-privilege App authorities", () => {
    expect(policy.activation).toMatchObject({
      branch: "main",
      controller_tag: "cloudx-ai-controller-v3",
      update_authority_ruleset_name: "CloudX main update authority",
      integrity_ruleset_name: "CloudX main integrity",
      controller_tag_ruleset_name: "CloudX controller tag immutability",
      protected_environment: "cloudx-protected-merge",
      controller_environment: "cloudx-controller",
      require_private_repository: false,
      model_runner_labels: ["self-hosted", "Linux", "X64", "cloudx-codex"],
      manager_app_slug: "cloudx-ai-manager",
      publisher_app_slug: "cloudx-ai-publisher",
      merge_app_slug: "cloudx-ai-merge",
      required_check_app_slug: "cloudx-ai-publisher",
      intent_check_app_slug: "github-actions",
      manager_permissions: [
        "actions:read",
        "checks:read",
        "contents:read",
        "issues:write",
        "metadata:read",
        "pull_requests:read",
      ],
      publisher_permissions: [
        "checks:write",
        "contents:write",
        "issues:write",
        "metadata:read",
        "pull_requests:write",
      ],
      merge_permissions: [
        "checks:write",
        "contents:write",
        "metadata:read",
        "pull_requests:read",
      ],
    });
    expect(policy.activation.required_repository_secrets).toEqual([]);
    expect(policy.activation.controller_environment_secrets).toEqual([
      "CLOUDX_MANAGER_ARTIFACT_TOKEN",
      "CLOUDX_MANAGER_RESULT_TOKEN",
      "CLOUDX_MERGE_APP_PRIVATE_KEY",
      "CLOUDX_PUBLISHER_APP_PRIVATE_KEY",
    ]);
    expect(policy.activation.protected_environment_secrets).toEqual([
      "CLOUDX_MERGE_APP_PRIVATE_KEY",
    ]);
    expect(policy.activation.required_workflows).toContain(
      ".github/workflows/protected-merge.yml",
    );
    expect(policy.activation.allowed_action_patterns).toEqual([
      "astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b",
    ]);
  });

  it("rejects the legacy single-ruleset activation shape", async () => {
    const source = await fs.readFile(
      path.resolve(".agents/pr-review-policy.toml"),
      "utf8",
    );
    const legacy = source.replace(
      /\[activation\][\s\S]*?\n\[managed_generation\]/u,
      `[activation]\nruleset_name = "CloudX exact-head merge authority"\nbranch = "main"\nallowed_action_patterns = ["example/action@${"a".repeat(40)}"]\n\n[managed_generation]`,
    );
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-legacy-policy-"),
    );
    const policyPath = path.join(directory, "policy.toml");
    await fs.writeFile(policyPath, legacy);

    await expect(loadPolicy(policyPath)).rejects.toThrow(/activation/i);
  });

  it("defines one bounded generated-change authority", () => {
    expect(policy.labels.issue_approved).toBe("ai:issue-approved");
    expect(policy.managed_generation).toMatchObject({
      provenance_app_slug: "cloudx-ai-publisher",
      intent_app_slug: "cloudx-ai-merge",
      author_login: "cloudx-ai-publisher[bot]",
      branch_prefix: "ai/issue-",
      publication_allowed_risks: ["low", "medium", "high", "human-required"],
      automerge_allowed_risks: ["low", "medium"],
      provenance_check: "Managed Generation / head",
      intent_check: "Automation Intent / head",
    });
    expect(policy.managed_generation.max_files).toBeGreaterThan(0);
    expect(policy.managed_generation.max_patch_bytes).toBeLessThan(1_000_000);
  });
  it("selects every affected area and the strongest required review", () => {
    const change = classifyChange(policy, {
      type: "feature",
      paths: ["apps/server/src/asrClient.ts", "apps/web/src/ui/App.tsx"],
    });

    expect(change).toMatchObject({
      type: "feature",
      areas: ["server", "web"],
      risk: "high",
      humanReviewRequired: false,
      automergeEligible: true,
    });
    expect(change.skills).toEqual(
      expect.arrayContaining([
        "review-server",
        "review-web",
        "review-security",
      ]),
    );
    expect(change.labels).toEqual(
      expect.arrayContaining([
        "type:feature",
        "area:server",
        "area:web",
        "risk:high",
      ]),
    );
  });

  it("makes repository governance human-only regardless of declared type", () => {
    const change = classifyChange(policy, {
      type: "docs",
      paths: ["AGENTS.md", ".github/workflows/ci.yml"],
    });

    expect(change).toMatchObject({
      areas: ["agent-policy", "ci"],
      risk: "human-required",
      humanReviewRequired: true,
      automergeEligible: false,
    });
    expect(change.labels).toContain("manual review");
    expect(change.skills).toEqual(
      expect.arrayContaining(["review-agent-policy", "review-security"]),
    );
  });

  it("routes process execution changes through adversarial review", () => {
    const change = classifyChange(policy, {
      type: "bug",
      paths: ["apps/server/src/automation/AutomationExecutor.ts"],
    });

    expect(change.areas).toEqual(["automation", "server"]);
    expect(change.risk).toBe("human-required");
    expect(change.humanReviewRequired).toBe(true);
    expect(change.skills).toEqual(
      expect.arrayContaining(["review-automation", "review-security"]),
    );
  });

  it.each([
    ["apps/server/src/appServer/AppServerClient.ts", "codex-process-launch"],
    [
      "apps/server/src/terminal/NodePtyTerminalProcess.ts",
      "terminal-process-control",
    ],
    ["apps/server/src/git/WorktreeService.ts", "git-worktree-mutation"],
    [
      "apps/server/src/archive/ArchiveExtractionService.ts",
      "archive-and-subprocess-control",
    ],
    ["services/asr/src/cloudx_asr/main.py", "archive-and-subprocess-control"],
    [
      "services/documentation-indexer/src/cloudx_documentation_indexer/archive.py",
      "archive-and-subprocess-control",
    ],
    ["apps/server/src/configSecretStore.ts", "secret-persistence"],
    ["apps/server/src/server.ts", "server-composition"],
  ])(
    "requires human review for host capability owner %s",
    (changedPath, expectedRule) => {
      const change = classifyChange(policy, {
        type: "refactor",
        paths: [changedPath],
      });

      expect(change).toMatchObject({
        risk: "human-required",
        humanReviewRequired: true,
        automergeEligible: false,
      });
      expect(change.matchedRules).toContain(expectedRule);
      expect(change.skills).toContain("review-security");
    },
  );

  it.each([
    "docs/AI_CHANGE_PROCESS.md",
    "docs/architecture/state-invariants.md",
    "apps/web/package.json",
    "services/asr/pyproject.toml",
    "SECURITY.md",
    "apps/server/src/pathPolicy.ts",
    "apps/server/src/configSecretStore.ts",
  ])(
    "requires human review for self-modifying or security path %s",
    (changedPath) => {
      const change = classifyChange(policy, {
        type: "chore",
        paths: [changedPath],
      });

      expect(change).toMatchObject({
        risk: "human-required",
        humanReviewRequired: true,
        automergeEligible: false,
      });
      expect(change.labels).toContain("manual review");
      expect(change.skills).toContain("review-security");
    },
  );

  it("uses a visible maintainer route for an otherwise unclassified path", () => {
    const change = classifyChange(policy, {
      type: "chore",
      paths: ["new-root-tool.conf"],
    });

    expect(change).toMatchObject({
      areas: ["repository"],
      risk: "high",
      humanReviewRequired: true,
      automergeEligible: false,
    });
  });

  it.each([
    ["AGENTS.md", "ai-automation"],
    [".agents/schemas/review.schema.json", "ai-automation"],
    ["scripts/ai-change/policy.mjs", "ai-automation"],
    [".agents/skills/review-change/SKILL.md", "ai-skills"],
    [".github/workflows/ci.yml", "continuous-integration"],
    ["containers/ci/run.mjs", "continuous-integration"],
    ["scripts/setup-test-environment.mjs", "continuous-integration"],
    ["vitest.config.ts", "continuous-integration"],
  ])("classifies sensitive theme path %s through %s", (changedPath, rule) => {
    const change = classifyChange(policy, {
      type: "chore",
      paths: [changedPath],
    });

    expect(change).toMatchObject({
      risk: "human-required",
      humanReviewRequired: true,
      automergeEligible: false,
    });
    expect(change.matchedRules).toContain(rule);
    expect(change.labels).toContain("manual review");
  });

  it("rejects undeclared change types and empty changes", () => {
    expect(() =>
      classifyChange(policy, { type: "hotfix", paths: ["README.md"] }),
    ).toThrow(/change type/i);
    expect(() => classifyChange(policy, { type: "docs", paths: [] })).toThrow(
      /at least one path/i,
    );
  });

  it("reconciles managed labels instead of leaving stale review state", () => {
    const change = classifyChange(policy, {
      type: "bug",
      paths: ["apps/web/src/api.ts"],
    });

    const labels = reconcileLabels(policy, {
      current: [
        "type:feature",
        "area:server",
        "risk:low",
        "ai:review-clean",
        "trusted-auto-merge",
        "help wanted",
      ],
      classification: change,
      reviewState: "pending",
      invalidateMergeIntent: true,
    });

    expect(labels).toEqual([
      "help wanted",
      "type:bug",
      "area:web",
      "risk:medium",
      "ai:review-pending",
    ]);
  });
});

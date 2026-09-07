import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { loadPolicy } from "../policy.mjs";
import {
  classifyPullRequest,
  declaredChangeType,
  labelsForUnclassifiedPullRequest,
  presentationForLabel,
} from "./classify-pr.mjs";

const policy = await loadPolicy();

describe("public pull request classification", () => {
  it("accepts every supported change type in the pull request template", async () => {
    const template = await readFile(
      new URL("../../../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url),
      "utf8",
    );
    for (const type of policy.labels.types) {
      const body = template.replace(
        "Change-Type: <type>",
        `Change-Type: ${type}`,
      );
      expect(declaredChangeType(body, policy.labels.types)).toBe(type);
    }
    expect(declaredChangeType(template, policy.labels.types)).toBeNull();
  });

  it("requires exactly one explicit supported Change-Type trailer", () => {
    expect(declaredChangeType("Change-Type: docs", policy.labels.types)).toBe(
      "docs",
    );
    expect(declaredChangeType("Fix the docs", policy.labels.types)).toBeNull();
    expect(
      declaredChangeType(
        "Change-Type: docs\nChange-Type: chore",
        policy.labels.types,
      ),
    ).toBeNull();
  });

  it("applies durable manual review to AI automation, skills, and CI paths", async () => {
    for (const filename of [
      ".agents/pr-review-policy.toml",
      ".agents/skills/review-security/SKILL.md",
      ".github/workflows/ci.yml",
    ]) {
      const api = {
        repository: "davidomil/cloudx",
        paginate: vi.fn(async () => [{ filename }]),
      };
      const result = await classifyPullRequest({
        api,
        policy,
        pullRequest: {
          number: 42,
          changed_files: 1,
          body: "Change-Type: chore",
          labels: [],
        },
      });

      expect(result.classification.humanReviewRequired).toBe(true);
      expect(result.labels).toContain("manual review");
      expect(result.labels).not.toContain("trusted-auto-merge");
    }
  });

  it("blocks an unclassified pull request and removes stale authorization", () => {
    expect(
      labelsForUnclassifiedPullRequest(
        policy,
        ["type:bug", "trusted-auto-merge", "help wanted"],
        { invalidateMergeIntent: true },
      ),
    ).toEqual(["help wanted", "manual review", "ai:review-blocked"]);
  });

  it("has presentation metadata for the manual-review label", () => {
    expect(presentationForLabel("manual review")).toEqual([
      "b60205",
      "Policy requires a maintainer decision or review.",
    ]);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import {
  validatePolicyReferences,
  validateProcess,
  validateWorkflow,
} from "./validate-process.mjs";

describe("public repository AI process validation", () => {
  it("accepts the checked-in public policy, skills, schemas, and workflows", async () => {
    const result = await validateProcess();

    expect(result.workflows).toEqual(["ci.yml", "classify-pr.yml"]);
    expect(result.skills).toContain("review-agent-policy");
    expect(result.schemas).toContain("review.schema.json");
    expect(result.policy_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps every self-hosted model job out of the public workflows", () => {
    for (const name of ["ci.yml", "classify-pr.yml"]) {
      const source = fs.readFileSync(`.github/workflows/${name}`, "utf8");

      expect(source).not.toContain("self-hosted");
      expect(source).not.toContain("cloudx-codex");
      expect(source).not.toContain("codex login");
      expect(source).not.toMatch(/secrets\.[A-Z0-9_]+/u);
    }
  });

  it("rejects mutable external action references", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-public-ai-"));
    const workflow = parseDocument(`
name: Unsafe
on: pull_request
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`).toJS();
    const issues = [];

    validateWorkflow(root, "unsafe.yml", workflow, issues);

    expect(issues).toContainEqual(
      expect.stringMatching(/full-length commit SHA/i),
    );
  });

  it("rejects a write-authority job that executes pull-request head code", () => {
    const workflow = parseDocument(`
name: Unsafe target
on: pull_request_target
permissions: {}
jobs:
  mutate:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/checkout@1111111111111111111111111111111111111111
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm test
`).toJS();
    const issues = [];

    validateWorkflow(process.cwd(), "unsafe-target.yml", workflow, issues);

    expect(issues).toContainEqual(
      expect.stringMatching(/privileged.*pull-request head/i),
    );
  });

  it("rejects a dependency on a removed private-controller job", () => {
    const workflow = parseDocument(`
name: Stale dependency
on: push
permissions: {}
jobs:
  public-check:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  aggregate:
    needs: [public-check, manager-postgres]
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`).toJS();
    const issues = [];

    validateWorkflow(process.cwd(), "ci.yml", workflow, issues);

    expect(issues).toContainEqual(
      expect.stringMatching(/aggregate.*undefined job.*manager-postgres/i),
    );
  });

  it("fails closed when policy references a skill that is not synchronized", () => {
    const issues = [];
    validatePolicyReferences(
      {
        labels: { areas: ["repository"] },
        defaults: {
          area: "repository",
          skills: ["missing-skill"],
        },
        cross_area: { areas: ["repository"], skills: [] },
        path_rules: [],
      },
      ["review-architecture"],
      issues,
    );

    expect(issues).toEqual([
      "Policy route 'defaults' references missing skill 'missing-skill'.",
    ]);
  });
});

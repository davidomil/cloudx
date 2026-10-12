import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GitHubWorkflowDependencies } from "./GitHubWorkflowDependencies.js";

const terminal = (name: string, conclusion = "success") => ({ name, status: "completed", conclusion });

describe("Pinned workflow dependencies", () => {
  it("resolves the real CI aggregate's failed installed-upgrade producer, including literal matrix sibling names", async () => {
    const workflow = new GitHubWorkflowDependencies(await fs.readFile(".github/workflows/ci.yml", "utf8"));
    const names = ["Repository policy", "TypeScript (build, type-check, test)", "Codex native recovery (installer)",
      "Codex native recovery (0.156.1)", "Terminal stress (Node 22, 2 CPUs, 7 GiB)", "Pinned lifecycle revisions",
      "Clean installation", "Installed previous-version upgrade", "Python services (pytest)",
      "Browser smoke (desktop and mobile)", "Isolated full verifier", "Trusted merge identity"];
    const jobs = names.map(name => terminal(name, name === "Installed previous-version upgrade" ? "failure" : "success"));
    jobs.push(terminal("Unrelated optional job", "failure"));
    expect(workflow.failedDependencies(terminal("CI aggregate", "failure"), jobs)).toEqual([jobs[7]]);
  });

  it("expands literal matrices with include/exclude and chooses only failed dependencies", () => {
    const workflow = new GitHubWorkflowDependencies(`jobs:
  gate:
    needs: test
  test:
    name: Test (\${{ matrix.os }}, \${{ matrix.mode }})
    strategy:
      matrix:
        os: [linux, mac]
        mode: [fast]
        exclude: [{os: mac}]
        include: [{os: windows, mode: slow}]
`);
    const failed = terminal("Test (windows, slow)", "timed_out");
    expect(workflow.failedDependencies(terminal("gate"), [terminal("Test (linux, fast)"), failed])).toEqual([failed]);
  });

  it("keeps every literal include-only matrix row", () => {
    const workflow = new GitHubWorkflowDependencies("jobs: {gate: {needs: test}, test: {name: 'Test (${{ matrix.os }})', strategy: {matrix: {include: [{os: linux}, {os: mac}]}}}}");
    const failed = terminal("Test (linux)", "failure");
    expect(workflow.failedDependencies(terminal("gate"), [failed, terminal("Test (mac)")])).toEqual([failed]);
  });

  it.each([
    "jobs: {gate: {needs: missing}}",
    "jobs: {gate: {needs: test}, test: {name: Duplicate}, other: {name: Duplicate}}",
    "jobs: {gate: {needs: gate}}",
    "jobs: {gate: {needs: [test, test]}, test: {}}",
    "jobs: {gate: {needs: test}, test: {name: '${{ inputs.name }}'}}",
    "jobs: {gate: {needs: test}, test: {name: '${{ matrix.os }}', strategy: {matrix: '${{ fromJSON(needs.setup.outputs.matrix) }}'}}}",
    "jobs: {gate: {needs: test}, test: {}, test: {}}",
    "jobs: &jobs {gate: {needs: test}, test: *jobs}",
  ])("rejects unknown, ambiguous or dynamic dependency identities: %s", text => {
    expect(() => new GitHubWorkflowDependencies(text).failedDependencies(terminal("gate"), [terminal("test", "failure")])).toThrow();
  });

  it("rejects policy, cancelled and running siblings even beside a code failure", () => {
    const workflow = new GitHubWorkflowDependencies("jobs: {gate: {needs: [test, sibling]}, test: {}, sibling: {}}");
    for (const sibling of [terminal("sibling", "action_required"), terminal("sibling", "startup_failure"), terminal("sibling", "cancelled"), { name: "sibling", status: "queued", conclusion: null }]) {
      expect(() => workflow.failedDependencies(terminal("gate"), [terminal("test", "failure"), sibling])).toThrow();
    }
  });

  it("bounds workflow input and literal matrix expansion", () => {
    expect(() => new GitHubWorkflowDependencies(" ".repeat(1_000_001))).toThrow();
    const matrix = Array.from({ length: 65 }, (_, index) => index);
    const workflow = new GitHubWorkflowDependencies(`jobs: {gate: {needs: test}, test: {name: '\${{ matrix.value }}', strategy: {matrix: {value: [${matrix.join(",")}]}}}}`);
    expect(() => workflow.failedDependencies(terminal("gate"), [])).toThrow();
  });
});

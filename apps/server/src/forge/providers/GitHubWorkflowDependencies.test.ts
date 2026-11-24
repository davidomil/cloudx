import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GitHubWorkflowDependencies } from "./GitHubWorkflowDependencies.js";

const terminal = (name: string, conclusion = "success") => ({ name, status: "completed", conclusion });
const artifactAction = "actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0";
const artifactStep = { name: "Download artifacts", number: 5, status: "completed", conclusion: "failure" };

describe("Pinned workflow dependencies", () => {
  it.each(["Installed previous-version upgrade", "Codex native recovery (0.166.0)", "Codex native recovery (0.172.0)"])("resolves the real CI aggregate's failed %s producer, including every literal matrix sibling", async failedName => {
    const workflow = new GitHubWorkflowDependencies(await fs.readFile(".github/workflows/ci.yml", "utf8"));
    const names = ["Repository policy", "TypeScript (build, type-check, test)", "Codex native recovery (installer)",
      "Codex native recovery (0.156.1)", "Codex native recovery (0.166.0)", "Codex native recovery (0.172.0)", "Terminal stress (Node 22, 2 CPUs, 7 GiB)", "Pinned lifecycle revisions",
      "Clean installation", "Installed previous-version upgrade", "Python services (pytest)",
      "Browser smoke (desktop and mobile)", "Isolated full verifier", "Trusted merge identity"];
    const jobs = names.map(name => terminal(name, name === failedName ? "failure" : "success"));
    jobs.push(terminal("Unrelated optional job", "failure"));
    expect(workflow.failedDependencies(terminal("CI aggregate", "failure"), jobs)).toEqual([jobs.find(job => job.name === failedName)]);
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

  it("proves that an independently failed gate has only successful dependencies", () => {
    const workflow = new GitHubWorkflowDependencies("jobs: {gate: {needs: [test, sibling]}, test: {}, sibling: {}}");
    expect(workflow.failedDependencies(terminal("gate", "failure"), [terminal("test"), terminal("sibling")])).toEqual([]);
  });

  it("resolves the real verifier's failed matrix lane through the skipped coverage merge exactly once", async () => {
    const workflow = new GitHubWorkflowDependencies(await fs.readFile(".github/workflows/ci.yml", "utf8"));
    const lanes = ["static", "coverage-1", "coverage-2", "coverage-3", "coverage-4", "asr", "documentation", "browser-1", "browser-2"];
    const jobs = lanes.map(lane => terminal(`Isolated verifier (${lane})`, lane === "coverage-3" ? "failure" : "success"));
    jobs.push(terminal("Merged isolated coverage", "skipped"));
    expect(workflow.failedDependencies(terminal("Isolated full verifier", "failure"), jobs))
      .toEqual([jobs.find(job => job.name === "Isolated verifier (coverage-3)")]);
  });

  it("deduplicates failures reached through direct, nested and shared skipped paths", () => {
    const workflow = new GitHubWorkflowDependencies(`jobs:
  gate: {needs: [first, outer, second]}
  outer: {needs: [inner, sibling]}
  inner: {needs: [first, second, sibling]}
  first: {}
  second: {}
  sibling: {}
`);
    const first = terminal("first", "failure");
    const second = terminal("second", "timed_out");
    const jobs = [first, second, terminal("outer", "skipped"), terminal("inner", "skipped"), terminal("sibling")];
    expect(workflow.failedDependencies(terminal("gate", "failure"), jobs)).toEqual([first, second]);
  });

  it("memoizes shared skipped subgraphs within each evidence snapshot", () => {
    const definitions: Record<string, unknown> = { gate: { needs: ["left0", "right0"] }, producer: {} };
    const jobs = [terminal("producer", "failure")];
    for (let level = 0; level < 16; level++) {
      const needs = level === 15 ? ["producer"] : [`left${level + 1}`, `right${level + 1}`];
      for (const side of ["left", "right"]) {
        const name = `${side}${level}`;
        definitions[name] = { needs };
        jobs.push(terminal(name, "skipped"));
      }
    }
    const workflow = new GitHubWorkflowDependencies(`jobs: ${JSON.stringify(definitions)}`);
    const observed = vi.fn();
    expect(workflow.failedDependencies(terminal("gate", "failure"), jobs, observed)).toEqual([jobs[0]]);
    expect(new Set(observed.mock.calls.map(([job]) => job)).size).toBe(jobs.length);
    expect(observed.mock.calls.length).toBeLessThanOrEqual(64);
    jobs[0].conclusion = "success";
    expect(() => workflow.failedDependencies(terminal("gate", "failure"), jobs)).toThrow("unambiguous");
  });

  it.each([false, true, null, "", "success()", "${{ success() }}", "always()", "failure()", "github.ref == 'refs/heads/main'"])
    ("rejects skipped jobs with an explicit condition: %j", condition => {
      const workflow = new GitHubWorkflowDependencies(`jobs: ${JSON.stringify({
        gate: { needs: ["producer", "coverage"] }, coverage: { needs: "producer", if: condition }, producer: {},
      })}`);
      expect(() => workflow.failedDependencies(terminal("gate", "failure"), [terminal("producer", "failure"), terminal("coverage", "skipped")]))
        .toThrow("unambiguous");
    });

  it("rejects an unexplained skip even alongside a separate failed dependency", () => {
    const workflow = new GitHubWorkflowDependencies("jobs: {gate: {needs: [failed, coverage]}, coverage: {needs: successful}, failed: {}, successful: {}}");
    expect(() => workflow.failedDependencies(terminal("gate", "failure"), [terminal("failed", "failure"), terminal("successful"), terminal("coverage", "skipped")]))
      .toThrow("unambiguous");
  });

  it.each([
    [], [terminal("sibling"), terminal("sibling")],
    ...["skipped", "cancelled", "action_required", "startup_failure", "neutral", "unknown"].map(conclusion => [terminal("sibling", conclusion)]),
    [{ name: "sibling", status: "in_progress", conclusion: null }],
    [{ name: "sibling", status: "queued", conclusion: null }],
  ])("requires complete, unique and terminal ancestors before explaining a skip: %j", (...siblings) => {
    const workflow = new GitHubWorkflowDependencies("jobs: {gate: {needs: coverage}, coverage: {needs: [failed, sibling]}, failed: {}, sibling: {}}");
    expect(() => workflow.failedDependencies(terminal("gate", "failure"), [terminal("coverage", "skipped"), terminal("failed", "failure"), ...siblings]))
      .toThrow();
  });

  it.each([
    "jobs: {gate: {needs: missing}}",
    "jobs: {gate: {needs: test}, test: {name: Duplicate}, other: {name: Duplicate}}",
    "jobs: {gate: {needs: gate}}",
    "jobs: {gate: {needs: [test, test]}, test: {}}",
    "jobs: {gate: {needs: test}, test: {name: '${{ inputs.name }}'}}",
    "jobs: {gate: {needs: test}, test: {name: '${{ matrix.os }}', strategy: {matrix: '${{ fromJSON(needs.setup.outputs.matrix) }}'}}}",
    "jobs: {gate: {needs: test}, test: {name: '${{ matrix.os }}', strategy: {matrix: {os: [test, test]}}}}",
    "jobs: {gate: {needs: test}, test: {}, test: {}}",
    "jobs: {gate: {needs: '${{ inputs.job }}'}, test: {}}",
    "jobs: {gate: {needs: test}, test: {needs: gate}}",
    "jobs: {gate: {needs: test}, test: {needs: missing}}",
    "jobs: &jobs {gate: {needs: test}, test: *jobs}",
  ])("rejects unknown, ambiguous or dynamic dependency identities: %s", text => {
    expect(() => new GitHubWorkflowDependencies(text).failedDependencies(terminal("gate"), [terminal("test", "failure")])).toThrow();
  });

  it("rejects missing, duplicate and skipped successful dependency evidence", () => {
    const workflow = new GitHubWorkflowDependencies("jobs: {gate: {needs: test}, test: {}}");
    for (const jobs of [[], [terminal("test"), terminal("test")], [terminal("test", "skipped")]])
      expect(() => workflow.failedDependencies(terminal("gate", "failure"), jobs)).toThrow();
  });

  it("rejects cycles even when every reported dependency succeeded", () => {
    const workflow = new GitHubWorkflowDependencies("jobs: {gate: {needs: test}, test: {needs: gate}}");
    expect(() => workflow.failedDependencies(terminal("gate", "failure"), [terminal("test")])).toThrow("cycle");
  });

  it.each([
    { uses: "actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0", trusted: true },
    { uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", trusted: true },
    { uses: "actions/download-artifact@v4", trusted: false },
    { uses: "custom/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0", trusted: false },
  ])("binds retry trust to the exact literal artifact action: $uses", ({ uses, trusted }) => {
    const workflow = new GitHubWorkflowDependencies(`jobs: {gate: {steps: [{uses: '${uses}'}]}}`);
    const step = { ...artifactStep, name: `Run ${uses}` };
    expect(workflow.pinnedArtifactStep({ ...terminal("gate"), steps: [step] }, step, [])).toBe(trusted);
  });

  it("binds the failed runtime number without assuming a YAML step ordinal", () => {
    const workflow = new GitHubWorkflowDependencies(`jobs: {gate: {steps: [{name: Download artifacts, uses: '${artifactAction}'}]}}`);
    const job = { ...terminal("gate", "failure"), steps: [
      { ...terminal("Set up job"), number: 1 }, { ...terminal("Pre setup"), number: 2 }, artifactStep,
    ] };
    expect(workflow.pinnedArtifactStep(job, artifactStep, [])).toBe(true);
    expect(workflow.pinnedArtifactStep(job, { ...artifactStep, number: 2 }, [])).toBe(false);
  });

  it("rejects a successful action and failed expression-named script with the same runtime name", () => {
    const workflow = new GitHubWorkflowDependencies(`jobs:
  gate:
    steps:
      - name: Download artifacts
        uses: ${artifactAction}
      - name: \${{ 'Download artifacts' }}
        run: exit 1
`);
    const failed = { ...artifactStep, number: 3 };
    const job = { ...terminal("gate", "failure"), steps: [
      { ...artifactStep, number: 2, conclusion: "success" }, failed,
    ] };
    expect(workflow.pinnedArtifactStep(job, failed, [])).toBe(false);
  });

  it.each([
    { name: "literal duplicate", step: { name: artifactStep.name, run: "exit 1" } },
    { name: "expression name", step: { name: "${{ 'Download artifacts' }}", run: "exit 1" } },
    { name: "expression suffix", step: { name: "Download ${{ inputs.kind }}", run: "exit 1" } },
    { name: "multiline name", step: { name: " \nDownload artifacts\nother text", run: "exit 1" } },
  ])("rejects unresolved workflow display-name collisions: $name", ({ step }) => {
    const workflow = new GitHubWorkflowDependencies(`jobs: ${JSON.stringify({ gate: { steps: [
      { name: artifactStep.name, uses: artifactAction }, step,
    ] } })}`);
    expect(workflow.pinnedArtifactStep({ ...terminal("gate"), steps: [artifactStep] }, artifactStep, [])).toBe(false);
  });

  it.each([
    { run: artifactAction }, { run: ` \n${artifactAction}\necho done` },
    { run: "${{ inputs.command }}" }, { uses: "${{ inputs.action }}" },
  ])("rejects colliding generated script or action display names: %j", step => {
    const workflow = new GitHubWorkflowDependencies(`jobs: ${JSON.stringify({ gate: { steps: [{ uses: artifactAction }, step] } })}`);
    const failed = { ...artifactStep, name: `Run ${artifactAction}` };
    expect(workflow.pinnedArtifactStep({ ...terminal("gate"), steps: [failed] }, failed, [])).toBe(false);
  });

  it("permits expression-based display names whose literal prefix cannot collide", () => {
    const workflow = new GitHubWorkflowDependencies(`jobs: ${JSON.stringify({ gate: { steps: [
      { uses: artifactAction }, { run: 'node aggregate.mjs "${{ github.sha }}"' }, { name: "Verify ${{ inputs.lane }}", run: "exit 1" },
    ] } })}`);
    const failed = { ...artifactStep, name: `Run ${artifactAction}` };
    expect(workflow.pinnedArtifactStep({ ...terminal("gate"), steps: [failed] }, failed, [])).toBe(true);
  });

  it.each([
    undefined, [], [{ ...artifactStep, conclusion: "success" }], [{ ...artifactStep, status: "in_progress" }],
    [{ ...artifactStep, number: 2 }], [artifactStep, { ...artifactStep, number: 6, conclusion: "success" }],
    [artifactStep, { ...artifactStep, name: "Other step" }], [artifactStep, { ...artifactStep, name: "Other step", number: 0 }],
  ])("requires one unique failed runtime name and number: %j", steps => {
    const workflow = new GitHubWorkflowDependencies(`jobs: {gate: {steps: [{name: Download artifacts, uses: '${artifactAction}'}]}}`);
    expect(workflow.pinnedArtifactStep({ ...terminal("gate"), steps }, artifactStep, [])).toBe(false);
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

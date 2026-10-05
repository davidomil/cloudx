import { describe, expect, it } from "vitest";

import { LOCAL_JOBS, readWorkflow, stepRuns, substitute } from "./local.mjs";

const context = { sha: "a".repeat(40), lane: "coverage-2", needs: { "isolated-lanes": "success" } };

describe("local CI runner", () => {
  it("replaces the workflow expressions the reproduced jobs use and rejects others", () => {
    expect(substitute('cloudx-ci-verifier:${{ github.sha }} "${{ matrix.lane }}"', context)).toBe(`cloudx-ci-verifier:${"a".repeat(40)} "coverage-2"`);
    expect(substitute("${{ needs.isolated-lanes.result }} ${{ needs.coverage-merge.result }}", context)).toBe("success skipped");
    expect(() => substitute("${{ secrets.TOKEN }}", context)).toThrow("Unsupported workflow expression");
  });

  it("evaluates the step conditions in those jobs", () => {
    expect(stepRuns(undefined, context, false)).toBe(true);
    expect(stepRuns(undefined, context, true)).toBe(false);
    expect(stepRuns("always()", context, true)).toBe(true);
    expect(stepRuns("failure()", context, true)).toBe(true);
    expect(stepRuns("startsWith(matrix.lane, 'coverage-')", context, false)).toBe(true);
    expect(stepRuns("startsWith(matrix.lane, 'coverage-')", { ...context, lane: "static" }, false)).toBe(false);
    expect(() => stepRuns("github.event_name == 'push'", context, false)).toThrow("Unsupported step condition");
  });

  it("covers every step of the reproduced CI jobs", async () => {
    const { jobs } = await readWorkflow();
    for (const name of LOCAL_JOBS) {
      expect(jobs[name], name).toBeDefined();
      for (const step of jobs[name].steps) {
        expect(() => stepRuns(step.if, { ...context, lane: "coverage-1" }, false), `${name}: ${step.name ?? step.run}`).not.toThrow();
        for (const text of [step.run, ...Object.values(step.env ?? {}), ...Object.values(step.with ?? {})])
          if (typeof text === "string") expect(() => substitute(text, { ...context, lane: "coverage-1" }), `${name}: ${text}`).not.toThrow();
        const supported = step.run !== undefined || ["actions/checkout@", "actions/setup-node@", "actions/upload-artifact@", "actions/download-artifact@", "docker/build-push-action@", "docker/setup-buildx-action@"]
          .some(prefix => step.uses?.startsWith(prefix));
        expect(supported, `${name}: ${step.uses}`).toBe(true);
      }
    }
  });
});

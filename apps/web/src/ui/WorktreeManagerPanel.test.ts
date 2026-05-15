import { describe, expect, it } from "vitest";

import type { WorktreeProjectState, WorktreeRef } from "@cloudx/shared";

import { REF_OPTION_LIMIT, detectionSummary, filterRefOptions, formatBytes, prefillBranchPrefix } from "./WorktreeManagerPanel.js";

describe("prefillBranchPrefix", () => {
  it("prefills only empty new-branch names", () => {
    expect(prefillBranchPrefix("new_branch", "", "david/")).toBe("david/");
    expect(prefillBranchPrefix("new_branch", "feature", "david/")).toBe("feature");
    expect(prefillBranchPrefix("remote_branch", "", "david/")).toBe("");
  });
});

describe("filterRefOptions", () => {
  it("keeps the default ref suggestion list large enough for branch-heavy repos", () => {
    expect(REF_OPTION_LIMIT).toBeGreaterThanOrEqual(50);
  });

  it("keeps writable ref suggestions filtered and capped", () => {
    const refs = [
      ref("origin/main", "remote"),
      ref("origin/feature-login", "remote"),
      ref("origin/release/2026.15", "remote"),
      ref("feature-local", "local")
    ];

    expect(filterRefOptions(refs, "feature", 2).map((match) => match.name)).toEqual(["feature-local", "origin/feature-login"]);
  });

  it("shows the first refs when there is no query", () => {
    expect(filterRefOptions([ref("origin/main", "remote"), ref("feature", "local")], "", 1).map((match) => match.name)).toEqual(["origin/main"]);
  });
});

describe("formatBytes", () => {
  it("formats folder sizes compactly", () => {
    expect(formatBytes(42)).toBe("42 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(2_621_440)).toBe("2.50 MB");
  });
});

describe("detectionSummary", () => {
  it("describes selected bare directories and selected worktree directories", () => {
    expect(detectionSummary(projectState({ detectedFrom: "bare_dir" }))).toBe("Detected bare repository; managing sibling worktrees in /repo.");
    expect(detectionSummary(projectState({ detectedFrom: "worktree_dir", cwd: "/repo/feature" }))).toBe("Detected from linked worktree; managing project /repo.");
    expect(detectionSummary(projectState({ detectedFrom: "project_dir" }))).toBeUndefined();
  });
});

function projectState(overrides: Partial<WorktreeProjectState> = {}): WorktreeProjectState {
  return {
    cwd: "/repo",
    projectDir: "/repo",
    barePath: "/repo/.bare",
    bareName: ".bare",
    detectedFrom: "project_dir",
    status: "ready",
    folderEmpty: false,
    refs: [],
    worktrees: [],
    setup: { canInitialize: false, canClone: false },
    ...overrides
  };
}

function ref(name: string, kind: WorktreeRef["kind"]): WorktreeRef {
  return {
    name,
    fullName: `refs/${kind}/${name}`,
    kind,
    commit: "abc123"
  };
}

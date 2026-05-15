import { describe, expect, it } from "vitest";

import type { WorktreeProjectState } from "@cloudx/shared";

import { detectionSummary, worktreeSuggestionFromRef } from "./WorktreeManagerPanel.js";

describe("worktreeSuggestionFromRef", () => {
  it("suggests branch and folder names from remote refs", () => {
    expect(worktreeSuggestionFromRef("origin/feature/deep-linking", "remote_branch")).toEqual({
      branchName: "feature/deep-linking",
      folderName: "feature-deep-linking"
    });
  });

  it("suggests a new branch name from a base ref without using slash folders", () => {
    expect(worktreeSuggestionFromRef("origin/main", "new_branch")).toEqual({
      branchName: "main-worktree",
      folderName: "main-worktree"
    });
  });

  it("keeps local branch names while making direct-child folder names", () => {
    expect(worktreeSuggestionFromRef("feature/search", "existing_branch")).toEqual({
      branchName: "feature/search",
      folderName: "feature-search"
    });
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

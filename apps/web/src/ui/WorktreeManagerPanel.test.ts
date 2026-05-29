// @vitest-environment jsdom

import { createElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorktreeProjectState, WorktreeRef, WorkspaceTab } from "@cloudx/shared";

import { runTabAction } from "../api.js";
import { REF_OPTION_LIMIT, WorktreeManagerPanel, copyWorktreeValueToClipboard, detectionSummary, filterRefOptions, formatBytes, prefillBranchPrefix } from "./WorktreeManagerPanel.js";

vi.mock("../api.js", () => ({
  runTabAction: vi.fn()
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.mocked(runTabAction).mockReset();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

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

describe("copyWorktreeValueToClipboard", () => {
  it("copies exact worktree values without transforming paths or branch names", async () => {
    const writes: string[] = [];

    await copyWorktreeValueToClipboard("/repo/worktrees/feature/ui", { writeText: async (value) => { writes.push(value); } });
    await copyWorktreeValueToClipboard("feature/ui", { writeText: async (value) => { writes.push(value); } });

    expect(writes).toEqual(["/repo/worktrees/feature/ui", "feature/ui"]);
  });
});

describe("WorktreeManagerPanel", () => {
  it("copies the row path and branch click targets", async () => {
    const writes: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async (value: string) => { writes.push(value); }) } });
    vi.mocked(runTabAction).mockResolvedValueOnce(projectState({
      originUrl: "git@example.test:repo.git",
      refs: [ref("origin/main", "remote")],
      worktrees: [{
        path: "/repo/worktrees/feature-ui",
        folderName: "feature-ui",
        branch: "feature/ui",
        head: "abc123",
        detached: false,
        dirty: { dirty: false, staged: 0, unstaged: 0, untracked: 0 }
      }]
    }));
    const root = await render(createElement(WorktreeManagerPanel, { tab: workspaceTab(), config: { showFolderSize: false } }));
    const pathButton = await waitForButton('[aria-label="Copy path for feature-ui"]');
    const branchButton = await waitForButton('[aria-label="Copy branch for feature-ui"]');

    pathButton.click();
    await flushEffects();
    branchButton.click();
    await flushEffects();

    expect(writes).toEqual(["/repo/worktrees/feature-ui", "feature/ui"]);
    await act(async () => root.unmount());
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

function workspaceTab(): WorkspaceTab {
  return {
    id: "tab-worktree",
    pluginId: "worktree-manager",
    title: "Worktrees",
    cwd: "/repo",
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

async function render(element: ReactElement): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return root;
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForButton(selector: string): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const button = document.querySelector(selector);
    if (button instanceof HTMLButtonElement) {
      return button;
    }
    await flushEffects();
  }
  throw new Error(`Missing button ${selector}. Rendered: ${document.body.textContent ?? ""}`);
}

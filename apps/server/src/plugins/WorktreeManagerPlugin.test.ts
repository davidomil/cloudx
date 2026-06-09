import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { WorktreeProjectState, WorkspaceTab } from "@cloudx/shared";

import { WorktreeManagerPlugin } from "./WorktreeManagerPlugin.js";

describe("WorktreeManagerPlugin", () => {
  it("describes a creatable directory-backed worktree panel with safe voice actions", () => {
    const plugin = new WorktreeManagerPlugin();

    expect(plugin.descriptor()).toMatchObject({
      id: "worktree-manager",
      panelKind: "worktree-manager",
      creatable: true,
      requiresDirectory: true
    });
    expect(plugin.actions.find((action) => action.name === "delete_worktree")?.voiceExposed).toBe(false);
    expect(plugin.actions.find((action) => action.name === "get_worktree_project")?.voiceExposed).toBe(true);
    expect(plugin.descriptor().triggers?.map((trigger) => trigger.id)).toEqual(["worktree.createRequested", "worktree.created"]);
    expect(plugin.descriptor().triggers?.find((trigger) => trigger.id === "worktree.createRequested")).toMatchObject({
      title: "New Worktree Play Clicked",
      exposures: expect.arrayContaining(["http", "automation"]),
      payloadSchema: {
        required: expect.arrayContaining(["eventId", "mode", "folderName", "branchName", "projectDir", "detectedAt"])
      }
    });
    expect(plugin.descriptor().configFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "branchPrefix", type: "string", defaultValue: "" }),
        expect.objectContaining({ key: "showFolderSize", type: "boolean", defaultValue: true })
      ])
    );
  });

  it("returns project state and exposes it through voice context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-plugin-"));
    const session = new WorktreeManagerPlugin().createSession({
      tab: tab(root),
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    await expect(session.handleAction("get_worktree_project", {})).resolves.toMatchObject({
      status: "empty",
      setup: { canInitialize: true, canClone: true }
    });
    await expect(Promise.resolve(session.voiceContext())).resolves.toMatchObject({
      kind: "worktree-manager",
      cwd: root,
      metadata: { projectStatus: "empty" }
    });
  });

  it("keeps folder sizes opt-in for worktree state actions", async () => {
    const fakeWorktrees = new FakeWorktreeService();
    const session = new WorktreeManagerPlugin(fakeWorktrees as never).createSession({
      tab: tab("/repo"),
      cwd: "/repo",
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    await session.handleAction("get_worktree_project", {});
    expect(fakeWorktrees.lastOptions).toEqual({ includeSizes: false });

    await session.handleAction("get_worktree_project", { includeSizes: true });
    expect(fakeWorktrees.lastOptions).toEqual({ includeSizes: true });
  });
});

function tab(cwd: string): WorkspaceTab {
  return {
    id: "tab-1",
    pluginId: "worktree-manager",
    title: "Worktrees",
    cwd,
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

class FakeWorktreeService {
  lastOptions: unknown;

  async getState(projectDir: string, options: unknown): Promise<WorktreeProjectState> {
    this.lastOptions = options;
    return {
      cwd: projectDir,
      projectDir,
      barePath: path.join(projectDir, ".bare"),
      bareName: ".bare",
      detectedFrom: "project_dir",
      status: "ready",
      folderEmpty: false,
      refs: [],
      worktrees: [],
      setup: { canInitialize: false, canClone: false }
    };
  }
}

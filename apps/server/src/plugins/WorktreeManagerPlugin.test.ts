import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

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

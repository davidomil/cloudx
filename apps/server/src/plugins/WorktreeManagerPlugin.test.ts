import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AutomationGroup, AutomationRunSummary, TriggerEvent, WorktreeProjectState, WorkspaceTab } from "@cloudx/shared";

import { AutomationCatalogService } from "../automation/AutomationCatalogService.js";
import { AutomationCompiler } from "../automation/AutomationCompiler.js";
import { AutomationExecutor } from "../automation/AutomationExecutor.js";
import { AutomationRepository } from "../automation/AutomationRepository.js";
import { AutomationService } from "../automation/AutomationService.js";
import { AutomationTypeService } from "../automation/AutomationTypeService.js";
import { TabContextService } from "../context/TabContextService.js";
import { HookRegistry } from "../hooks/HookRegistry.js";
import { PathPolicy } from "../pathPolicy.js";
import { PluginRegistry } from "../pluginRegistry.js";
import { SessionStore } from "../sessionStore.js";
import { TriggerRegistry } from "../triggers/TriggerRegistry.js";
import { WorktreeService } from "../git/WorktreeService.js";
import { WorktreeManagerPlugin } from "./WorktreeManagerPlugin.js";

describe("WorktreeManagerPlugin", () => {
  it("describes a creatable directory-backed worktree panel with safe voice actions", () => {
    const plugin = new WorktreeManagerPlugin(new FakeWorktreeService() as never);

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
    expect(plugin.descriptor().triggers?.find((trigger) => trigger.id === "worktree.created")).toMatchObject({
      payloadSchema: {
        required: expect.arrayContaining(["eventId"]),
        properties: { eventId: { type: "string" } }
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
    const session = new WorktreeManagerPlugin(new WorktreeService(new PathPolicy([root]))).createSession({
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

  it("passes the exact action signal to a worktree mutation", async () => {
    const fakeWorktrees = new FakeWorktreeService();
    const session = new WorktreeManagerPlugin(fakeWorktrees as never).createSession({
      tab: tab("/repo"),
      cwd: "/repo",
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });
    const controller = new AbortController();

    await session.handleAction(
      "create_worktree",
      { mode: "new_branch", folderName: "feature", branchName: "feature" },
      { signal: controller.signal, caller: { kind: "ui" } }
    );

    expect(fakeWorktrees.lastOptions).toMatchObject({ signal: controller.signal });
  });

  it("rejects a cancelled create before mutation and emits no success trigger", async () => {
    const fakeWorktrees = new FakeWorktreeService();
    const emitTrigger = vi.fn();
    const session = new WorktreeManagerPlugin(fakeWorktrees as never).createSession({
      tab: tab("/repo"),
      cwd: "/repo",
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined },
      app: { emitTrigger } as never
    });
    const cancellation = new Error("cancelled before mutation");
    const controller = new AbortController();
    controller.abort(cancellation);

    await expect(
      session.handleAction(
        "create_worktree",
        { mode: "new_branch", folderName: "feature", branchName: "feature" },
        { signal: controller.signal, caller: { kind: "ui" } }
      )
    ).rejects.toBe(cancellation);

    expect(fakeWorktrees.createCalls).toBe(0);
    expect(emitTrigger).not.toHaveBeenCalled();
  });

  it("emits one durable worktree.created identity through the production session path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-worktree-production-event-"));
    const fakeWorktrees = new FakeWorktreeService();
    const plugin = new WorktreeManagerPlugin(fakeWorktrees as never);
    const plugins = new PluginRegistry();
    plugins.register(plugin);
    const repository = new AutomationRepository(path.join(root, ".cloudx"));
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(plugin.triggers.find((trigger) => trigger.id === "worktree.created")!);
    const hooks = new HookRegistry();
    let effects = 0;
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record one external effect.",
      exposures: ["automation"],
      automationSafety: "external",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        effects += 1;
        return {};
      }
    });
    const types = new AutomationTypeService();
    const automation = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(types, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(types),
      new AutomationExecutor()
    );
    await automation.saveGroup(worktreeAutomationGroup());
    const sessions = new SessionStore(plugins, new PathPolicy([root]), new TabContextService(path.join(root, ".cloudx")));
    sessions.setTriggerRegistry(triggers);
    const workspaceTab = await sessions.createTab({ pluginId: plugin.id, cwd: root });

    const action = await sessions.executePluginAction(workspaceTab.id, "create_worktree", {
      mode: "new_branch",
      folderName: "feature-a",
      branchName: "feature/a"
    });
    const runs = await waitForRuns(repository);
    const persisted = JSON.parse(await fs.readFile(path.join(root, ".cloudx", "automation.json"), "utf8")) as {
      triggerEvents: TriggerEvent[];
    };

    expect(action).toMatchObject({ createdFolderName: "feature-a", createdBranchName: "feature/a" });
    expect(persisted.triggerEvents).toHaveLength(1);
    expect(persisted.triggerEvents[0]!.payload.eventId).toEqual(expect.any(String));
    expect(persisted.triggerEvents[0]!.id).toBe(`plugin:worktree-manager:worktree.created:${String(persisted.triggerEvents[0]!.payload.eventId)}`);
    expect(runs).toEqual([expect.objectContaining({ triggerEventId: persisted.triggerEvents[0]!.id, status: "succeeded" })]);
    expect(effects).toBe(1);

    await sessions.dispose();
    await automation.dispose();
  });
});

function worktreeAutomationGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "worktree-effect",
    name: "Worktree effect",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 2,
      allowedSafety: ["external"],
      nodes: [
        { id: "trigger", typeId: "trigger:worktree.created", position: { x: 0, y: 0 } },
        { id: "effect", typeId: "hook:fake.record", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "effect", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}

async function waitForRuns(repository: AutomationRepository): Promise<AutomationRunSummary[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const runs = await repository.listRuns();
    if (runs.length === 1 && runs[0]!.status === "succeeded") {
      return runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return repository.listRuns();
}

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
  createCalls = 0;

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

  async createWorktree(projectDir: string, input: { folderName: string; branchName: string }, options: unknown): Promise<WorktreeProjectState> {
    this.createCalls += 1;
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
      worktrees: [{
        folderName: input.folderName,
        path: path.join(projectDir, input.folderName),
        branch: input.branchName,
        detached: false,
        dirty: { dirty: false, staged: 0, unstaged: 0, untracked: 0 }
      }],
      setup: { canInitialize: false, canClone: false }
    };
  }
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PluginSessionNotStartedError } from "@cloudx/plugin-api";

import {
  RULES_SKILLS_PLUGIN_ID,
  type CodexReasoningEffort,
  type ForgeRepository,
  type ForgeCredentialRole,
  type WorkspaceTab,
} from "@cloudx/shared";

import { JsonStateFile, openOwnedDirectoryNoFollow, requireSafeDirectory } from "../jsonStateFile.js";
import type { PathPolicy } from "../pathPolicy.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import type { SessionStore } from "../sessionStore.js";
import type { WorkspaceCommandService } from "../workspace/WorkspaceCommandService.js";
import type { WorkspaceLayoutStore } from "../workspace/WorkspaceLayoutStore.js";
import { validateRepository } from "./providers/ForgeCredentials.js";

export interface ForgeWorkspace {
  id: string;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  expectedHeadSha?: string;
}

export interface ForgeRuntimeDependencies {
  sessions: Pick<
    SessionStore,
    | "getTab"
    | "getContextDirectory"
    | "listTabs"
    | "executePluginAction"
    | "discardPreparedTab"
    | "getActiveTabId"
  >;
  workspaceCommands: Pick<WorkspaceCommandService, "createTab">;
  workspace: Pick<WorkspaceLayoutStore, "state">;
  rulesSkills: Pick<RulesSkillsCatalogService, "list">;
  pathPolicy: PathPolicy;
  dataDir: string;
  isRepositoryTrusted?: (repository: ForgeRepository) => boolean;
  gitAccess: (
    repository: ForgeRepository,
    role: ForgeCredentialRole,
    signal?: AbortSignal,
  ) => Promise<{ cloneUrl: string; authorization: string }>;
  git?: (
    cwd: string,
    args: string[],
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
  ) => Promise<string>;
}

interface DirectoryIdentity {
  path: string;
  dev: string;
  ino: string;
}

interface OwnedWorkspace extends ForgeWorkspace {
  repository: DirectoryIdentity;
  worktree: DirectoryIdentity;
  origin: string;
  expectedRepository: ForgeRepository;
  role: ForgeCredentialRole;
  gitDirectory?: DirectoryIdentity;
  gitConfigHash?: string;
  gitPending: boolean;
  branchOwned: boolean;
  cleaned: boolean;
  cleanupHeadSha?: string;
  baseCommit: string;
  prepared: boolean;
  launchPending: boolean;
}

interface OwnedTab {
  tabId: string;
  workerId: string;
  context?: DirectoryIdentity;
  launch?: DirectoryIdentity;
  closed: boolean;
  quiescent: boolean;
}

/** Owns Git checkouts and Codex tabs; the service owns issue/review decisions. */
export class ForgeRuntime {
  private static readonly operations = new Map<string, Promise<void>>();
  private readonly ownedTabs = new Map<string, OwnedTab>();

  constructor(private readonly dependencies: ForgeRuntimeDependencies) {}

  isActive(tabId: string): boolean {
    const tab = this.dependencies.sessions
      .listTabs()
      .find((tab) => tab.id === tabId);
    return Boolean(
      tab && !["failed", "completed", "stopped"].includes(tab.status),
    );
  }

  async prepareWorkspace(
    input: {
      id: string;
      expectedRepository: ForgeRepository;
      baseBranch: string;
      headSha?: string;
      baseSha?: string;
      review: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{ repositoryPath: string; worktreePath: string; branch: string }> {
    return this.serialize(input.id, async () => {
      signal?.throwIfAborted();
      if (input.review && !input.headSha)
        throw new Error("A review requires an exact head commit.");
      if (input.headSha && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(input.headSha))
        throw new Error("Invalid review head commit.");
      if (input.review && !input.baseSha)
        throw new Error("A review requires an exact base commit.");
      if (input.review && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(input.baseSha!))
        throw new Error("Invalid review base commit.");
      const existing = await this.manifest(input.id).read<OwnedWorkspace>();
      if (existing && !(await this.readOwned(input.id)).cleaned)
        throw new Error("This worker already owns a workspace.");
      const baseBranch = input.baseBranch.trim();
      if (
        !baseBranch ||
        baseBranch.startsWith("-") ||
        /[\r\n\0]/u.test(baseBranch)
      )
        throw new Error("A valid base branch is required.");
      const role = input.review ? "reviewer" : "worker";
      const access = await this.access(input.expectedRepository, role, signal);
      const worktreePath = this.checkoutPath(input.id);
      await requireSafeDirectory(
        this.dependencies.dataDir,
        path.dirname(worktreePath),
        {
          create: true,
          label: "Forge checkout directory",
        },
      );
      await this.runGit(
        path.dirname(worktreePath),
        ["check-ref-format", "--branch", baseBranch],
        signal,
      );
      signal?.throwIfAborted();
      await fs.mkdir(worktreePath, { mode: 0o700 });
      const checkout = await this.directory(worktreePath);
      const owned: OwnedWorkspace = {
        id: input.id,
        repositoryPath: worktreePath,
        worktreePath,
        branch: input.review ? "" : `cloudx/forge/${input.id}`,
        repository: checkout,
        worktree: checkout,
        origin: access.cloneUrl,
        expectedRepository: input.expectedRepository,
        role,
        branchOwned: false,
        cleaned: false,
        baseCommit: "",
        prepared: false,
        launchPending: false,
        gitPending: false,
      };
      try {
        await this.manifest(input.id).write(owned);
        await this.runOwnedGit(
          owned,
          ["init", "--template=", "--initial-branch=cloudx-preparing"],
          signal,
        );
        owned.gitDirectory = await this.directory(
          path.join(worktreePath, ".git"),
        );
        await this.manifest(input.id).write(owned);
        await this.runOwnedGit(
          owned,
          [
            "config",
            "user.name",
            `CloudX ${input.review ? "reviewer" : "issue worker"}`,
          ],
          signal,
        );
        await this.runOwnedGit(
          owned,
          ["config", "user.email", `forge-${role}@cloudx.local`],
          signal,
        );
        await this.runOwnedGit(
          owned,
          ["remote", "add", "origin", access.cloneUrl],
          signal,
        );
        await this.runOwnedGit(
          owned,
          [
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            access.cloneUrl,
            input.headSha ?? `refs/heads/${baseBranch}`,
          ],
          signal,
          access.authorization,
        );
        const commit = (
          await this.runGit(
            worktreePath,
            ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
            signal,
          )
        ).trim();
        if (
          input.headSha &&
          commit.toLowerCase() !== input.headSha.toLowerCase()
        )
          throw new Error(
            "Fetched review commit does not match the requested head.",
          );
        if (input.review)
          await this.prepareReviewComparison(owned, commit, input.baseSha!, access, signal);
        owned.baseCommit = commit;
        await this.manifest(input.id).write(owned);
        if (!input.review)
          await this.runOwnedGit(owned, ["checkout", "--detach", commit], signal);
        if (owned.branch) {
          await this.runOwnedGit(owned, ["switch", "-c", owned.branch], signal);
          owned.branchOwned = true;
        }
        owned.gitConfigHash = await this.configHash(owned);
        owned.prepared = true;
        await this.manifest(input.id).write(owned);
        return {
          repositoryPath: worktreePath,
          worktreePath,
          branch: owned.branch,
        };
      } catch (error) {
        try {
          await this.cleanupOwned(owned);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Worker preparation failed and workspace cleanup is incomplete.",
          );
        }
        throw error;
      }
    });
  }

  private async prepareReviewComparison(
    owned: OwnedWorkspace,
    headSha: string,
    baseSha: string,
    access: { cloneUrl: string; authorization: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.runOwnedGit(owned, ["checkout", "--detach", headSha], signal);
    await this.runOwnedGit(owned, [
      "fetch", "--no-tags", "--no-recurse-submodules", access.cloneUrl,
      `${baseSha}:refs/cloudx/review-base`,
    ], signal, access.authorization);
    const fetchedBase = (await this.runGit(
      owned.worktreePath,
      ["rev-parse", "--verify", "refs/cloudx/review-base^{commit}"],
      signal,
    )).trim();
    if (fetchedBase.toLowerCase() !== baseSha.toLowerCase())
      throw new Error("Fetched review base does not match the requested base commit.");
    let mergeBases: string[];
    try {
      mergeBases = (await this.runGit(
        owned.worktreePath,
        ["merge-base", "--all", baseSha, headSha],
        signal,
      )).trim().split(/\s+/u);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error("The review commits have no available merge base for comparison.", { cause: error });
    }
    if (mergeBases.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(mergeBases[0]!))
      throw new Error("The review commits do not have a unique merge base for comparison.");
  }

  async launch(
    input: {
      id: string;
      worktreePath: string;
      templateId: string;
      model: string;
      reasoningEffort: CodexReasoningEffort;
      prompt: string;
      windowId: string;
      paneId: string;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const owned = await this.readOwned(input.id);
    if (
      owned.cleaned ||
      !owned.prepared ||
      owned.gitPending ||
      owned.launchPending ||
      input.worktreePath !== owned.worktreePath
    )
      throw new Error(
        "Worker workspace ownership does not match or a previous launch is unresolved.",
      );
    await this.assertIdentity(owned.worktree);
    this.dependencies.pathPolicy.resolve(owned.worktreePath);
    const catalog = await this.dependencies.rulesSkills.list();
    if (!catalog.templates.some((template) => template.id === input.templateId))
      throw new Error(
        `Unknown worker personality template: ${input.templateId}`,
      );
    const authorizeProjectTrust = this.dependencies.isRepositoryTrusted?.(owned.expectedRepository)
      ? () => this.authorizeProjectTrust(owned)
      : undefined;
    owned.launchPending = true;
    await this.manifest(owned.id).write(owned);
    const { tab } = await this.dependencies.workspaceCommands.createTab({
      pluginId: "codex-terminal",
      cwd: owned.worktreePath,
      title: `Forge ${input.id}`,
      windowId: input.windowId,
      paneId: input.paneId,
      initialInput: { prompt: input.prompt, model: input.model, reasoningEffort: input.reasoningEffort },
      pluginMetadata: {
        [RULES_SKILLS_PLUGIN_ID]: { selectedTemplateId: input.templateId },
        "forge-workers": { workerId: input.id },
      },
    }, {
      ownerPluginId: "forge",
      authorizeProjectTrust,
    }).catch(async error => {
      if (error instanceof PluginSessionNotStartedError) {
        owned.launchPending = false;
        await this.manifest(owned.id).write(owned);
      }
      throw error;
    });
    const ownedTab: OwnedTab = {
      tabId: tab.id,
      workerId: input.id,
      closed: false,
      quiescent: false,
    };
    this.ownedTabs.set(tab.id, ownedTab);
    try {
      await this.captureTab(tab, ownedTab);
      owned.launchPending = false;
      await this.manifest(owned.id).write(owned);
      signal?.throwIfAborted();
      return tab.id;
    } catch (error) {
      try {
        await this.close(tab.id);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Worker launch failed and tab cleanup is incomplete.",
        );
      }
      owned.launchPending = false;
      await this.manifest(owned.id).write(owned);
      throw error;
    }
  }

  async pause(tabId: string): Promise<void> {
    await this.requireWorkerTab(tabId);
    await this.dependencies.sessions.executePluginAction(tabId, "stop", {});
    await this.recordQuiescence(tabId);
  }

  async close(tabId: string): Promise<void> {
    const owned =
      this.ownedTabs.get(tabId) ??
      (await this.tabManifest(tabId).read<OwnedTab>());
    if (
      owned &&
      (owned.tabId !== tabId ||
        typeof owned.workerId !== "string" ||
        typeof owned.closed !== "boolean")
    )
      throw new Error("Worker tab ownership record is invalid.");
    if (this.dependencies.sessions.listTabs().some((tab) => tab.id === tabId)) {
      await this.requireWorkerTab(tabId);
      await this.dependencies.sessions.executePluginAction(tabId, "stop", {});
      if (owned) {
        owned.quiescent = true;
        await this.tabManifest(tabId).write(owned);
      }
      if (owned?.context) await this.assertContextIdentity(owned.context);
      await this.dependencies.sessions.discardPreparedTab(tabId);
    } else if (owned && !owned.closed && !owned.quiescent) {
      throw new Error(
        "Worker process ownership is unresolved after its terminal disappeared. Local resources were preserved.",
      );
    }
    await this.dependencies.workspace.state(
      this.dependencies.sessions.listTabs(),
      this.dependencies.sessions.getActiveTabId(),
    );
    if (owned && !owned.closed) {
      if (owned.context) await this.removeContext(owned.context);
      if (owned.launch) await this.removeLaunch(owned.launch, tabId);
      owned.closed = true;
      await this.tabManifest(tabId).write(owned);
      this.ownedTabs.delete(tabId);
    }
  }

  recover(
    id: string,
  ): Promise<{ workspace?: ForgeWorkspace; tabIds: string[] }> {
    return this.serialize(id, async () => {
      const stored = await this.manifest(id).read<OwnedWorkspace>();
      const owned = stored ? await this.readOwned(id) : undefined;
      if (owned && !owned.cleaned && owned.gitPending)
        throw new Error(
          "A worker Git operation was interrupted before process exit was recorded. Its checkout was preserved.",
        );
      if (owned && !owned.cleaned && !owned.prepared)
        await this.recoverPreparation(owned);
      const tabIds = new Set<string>();
      const directory = path.join(
        this.dependencies.dataDir,
        "forge-workers",
        "tabs",
      );
      if (
        await requireSafeDirectory(this.dependencies.dataDir, directory, {
          create: false,
          label: "Forge tab ownership directory",
        })
      ) {
        for (const file of await fs.readdir(directory)) {
          if (!file.endsWith(".json")) continue;
          const tabId = file.slice(0, -5);
          const tab = await this.tabManifest(tabId).read<OwnedTab>();
          if (tab?.workerId === id && !tab.closed) tabIds.add(tabId);
        }
      }
      for (const tab of this.dependencies.sessions.listTabs()) {
        if (
          tab.pluginId !== "codex-terminal" ||
          tab.ownerPluginId !== "forge" ||
          tab.pluginMetadata?.["forge-workers"]?.workerId !== id
        )
          continue;
        if (!owned || owned.cleaned || tab.cwd !== owned.worktreePath)
          throw new Error(
            "Recovered worker tab does not match its workspace ownership.",
          );
        if (!tabIds.has(tab.id)) {
          const tabOwnership: OwnedTab = {
            tabId: tab.id,
            workerId: id,
            closed: false,
            quiescent: false,
          };
          this.ownedTabs.set(tab.id, tabOwnership);
          await this.captureTab(tab, tabOwnership);
        }
        tabIds.add(tab.id);
      }
      if (owned?.launchPending) {
        if (tabIds.size === 0)
          throw new Error(
            "A worker launch was interrupted before its process ownership was recorded. Local resources were preserved.",
          );
        owned.launchPending = false;
        await this.manifest(id).write(owned);
      }
      const workspace =
        owned && !owned.cleaned
          ? {
              id,
              repositoryPath: owned.repositoryPath,
              worktreePath: owned.worktreePath,
              branch: owned.branch,
            }
          : undefined;
      return { workspace, tabIds: [...tabIds] };
    });
  }

  async publishBranch(
    workspace: ForgeWorkspace,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.serialize(workspace.id, async () => {
      const owned = await this.matchOwned(workspace);
      if (!owned.branchOwned || !owned.branch || owned.cleaned)
        throw new Error("Only an owned issue branch can be published.");
      await this.assertQuiescent(owned);
      await this.assertCheckout(owned);
      const headSha = await this.requireBranchHead(owned, signal);
      await this.verifyCleanHead(owned, headSha, signal);
      const access = await this.access(
        owned.expectedRepository,
        "worker",
        signal,
      );
      if (access.cloneUrl !== owned.origin)
        throw new Error(
          "Repository origin changed while the worker was running.",
        );
      await this.runOwnedGit(
        owned,
        ["push", access.cloneUrl, `${headSha}:refs/heads/${owned.branch}`],
        signal,
        access.authorization,
      );
      await this.verifyCleanHead(owned, headSha, signal);
      return headSha;
    });
  }

  cleanup(workspace: ForgeWorkspace, signal?: AbortSignal): Promise<void> {
    return this.serialize(workspace.id, async () => {
      const owned = await this.matchOwned(workspace);
      if (owned.launchPending)
        throw new Error("A worker launch is unresolved; cleanup is blocked.");
      if (!owned.cleaned) await this.assertQuiescent(owned);
      if (owned.branchOwned && !owned.cleaned) {
        if (!workspace.expectedHeadSha)
          throw new Error("Issue cleanup requires the published head commit.");
        if (await optionalIdentity(owned.worktreePath))
          await this.verifyCleanHead(owned, workspace.expectedHeadSha, signal);
        else if (owned.cleanupHeadSha !== workspace.expectedHeadSha)
          throw new Error(
            "Owned checkout disappeared before cleanup; ownership was preserved.",
          );
      }
      await this.cleanupOwned(owned, signal, workspace.expectedHeadSha);
    });
  }

  verifyPublishedWorkspace(
    workspace: ForgeWorkspace,
    expectedHeadSha: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.serialize(workspace.id, async () => {
      const owned = await this.matchOwned(workspace);
      if (owned.cleaned || !owned.branchOwned)
        throw new Error(
          "The published issue workspace is no longer available.",
        );
      await this.verifyCleanHead(owned, expectedHeadSha, signal);
    });
  }

  private async verifyCleanHead(
    owned: OwnedWorkspace,
    expectedHeadSha: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assertCheckout(owned);
    if (
      !/^[a-f0-9]{40,64}$/iu.test(expectedHeadSha) ||
      (await this.requireBranchHead(owned, signal)) !== expectedHeadSha
    )
      throw new Error(
        "Worker head differs from the published commit; local changes were preserved.",
      );
    if (
      (
        await this.runGit(
          owned.worktreePath,
          ["status", "--porcelain=v1", "--untracked-files=all"],
          signal,
        )
      ).trim()
    )
      throw new Error(
        "Commit all worker changes before publishing, merging, or cleanup.",
      );
  }

  private async cleanupOwned(
    owned: OwnedWorkspace,
    signal?: AbortSignal,
    expectedHeadSha?: string,
  ): Promise<void> {
    if (owned.cleaned) return;
    if (owned.gitPending)
      throw new Error(
        "A worker Git operation is unresolved; its checkout was preserved.",
      );
    const current = await optionalIdentity(owned.worktreePath);
    if (current) {
      await this.assertIdentity(owned.worktree);
      if (owned.gitDirectory) {
        await this.assertCheckout(owned);
        const registered = await this.runGit(
          owned.worktreePath,
          ["worktree", "list", "--porcelain", "-z"],
          signal,
        );
        if (
          registered
            .split("\0")
            .some(
              (field) =>
                field.startsWith("worktree ") &&
                field !== `worktree ${owned.worktreePath}`,
            )
        )
          throw new Error(
            "Another checkout is using the worker repository; cleanup is blocked.",
          );
      }
      if (expectedHeadSha && owned.branchOwned)
        await this.verifyCleanHead(owned, expectedHeadSha, signal);
      owned.cleanupHeadSha = expectedHeadSha;
      await this.manifest(owned.id).write(owned);
      signal?.throwIfAborted();
      await this.assertIdentity(owned.worktree);
      await fs.rm(owned.worktreePath, { recursive: true });
    } else if (owned.branchOwned && !owned.cleanupHeadSha) {
      throw new Error(
        "Owned checkout disappeared before cleanup; ownership was preserved.",
      );
    }
    owned.cleaned = true;
    await this.manifest(owned.id).write(owned);
  }

  private async recoverPreparation(owned: OwnedWorkspace): Promise<void> {
    if (owned.gitPending)
      throw new Error(
        "A worker Git operation was interrupted before process exit was recorded. Its checkout was preserved.",
      );
    await this.assertIdentity(owned.worktree);
    if (!owned.baseCommit || !owned.gitDirectory) {
      await this.cleanupOwned(owned);
      return;
    }
    await this.assertCheckout(owned);
    const head = (
      await this.runGit(owned.worktreePath, ["rev-parse", "HEAD"])
    ).trim();
    const branch = (
      await this.runGit(owned.worktreePath, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])
    ).trim();
    if (
      head !== owned.baseCommit ||
      ![owned.branch || "HEAD", "HEAD"].includes(branch)
    )
      throw new Error(
        "Interrupted worker preparation changed unexpectedly; local changes were preserved.",
      );
    if (owned.branch && branch === "HEAD") {
      await this.cleanupOwned(owned);
      return;
    }
    owned.branchOwned = Boolean(owned.branch);
    owned.gitConfigHash = await this.configHash(owned);
    owned.prepared = true;
    await this.manifest(owned.id).write(owned);
  }

  private async requireBranchHead(
    owned: OwnedWorkspace,
    signal?: AbortSignal,
  ): Promise<string> {
    const branch = (
      await this.runGit(
        owned.worktreePath,
        ["symbolic-ref", "--short", "HEAD"],
        signal,
      )
    ).trim();
    if (branch !== owned.branch)
      throw new Error(
        "Worker checkout changed branch; cleanup and publication are blocked.",
      );
    return (
      await this.runGit(
        owned.worktreePath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        signal,
      )
    ).trim();
  }

  private async requireWorkerTab(tabId: string): Promise<void> {
    const tab = this.dependencies.sessions.getTab(tabId);
    const owned =
      this.ownedTabs.get(tabId) ??
      (await this.tabManifest(tabId).read<OwnedTab>());
    if (
      tab.pluginId !== "codex-terminal" ||
      tab.ownerPluginId !== "forge" ||
      !owned ||
      owned.closed ||
      tab.pluginMetadata?.["forge-workers"]?.workerId !== owned.workerId
    )
      throw new Error("The tab is not an owned Forge worker.");
  }

  private async authorizeProjectTrust(owned: OwnedWorkspace): Promise<string> {
    const current = await this.readOwned(owned.id);
    if (
      current.cleaned || !current.prepared ||
      current.expectedRepository.provider !== owned.expectedRepository.provider ||
      current.expectedRepository.apiUrl !== owned.expectedRepository.apiUrl ||
      current.expectedRepository.projectPath !== owned.expectedRepository.projectPath ||
      !this.dependencies.isRepositoryTrusted?.(owned.expectedRepository)
    ) throw new Error("Forge repository trust is no longer approved for this checkout.");
    await this.assertCheckout(current);
    await this.assertCheckout(owned);
    this.dependencies.pathPolicy.resolve(owned.worktreePath);
    return fs.realpath(owned.worktreePath);
  }

  private async matchOwned(input: ForgeWorkspace): Promise<OwnedWorkspace> {
    const owned = await this.readOwned(input.id);
    if (
      input.repositoryPath !== owned.repositoryPath ||
      input.worktreePath !== owned.worktreePath ||
      input.branch !== owned.branch
    )
      throw new Error("Worker workspace ownership does not match.");
    return owned;
  }

  private async readOwned(id: string): Promise<OwnedWorkspace> {
    const value = await this.manifest(id).read<OwnedWorkspace>();
    if (
      !value ||
      value.id !== id ||
      typeof value.repositoryPath !== "string" ||
      typeof value.worktreePath !== "string" ||
      typeof value.branch !== "string" ||
      typeof value.origin !== "string" ||
      !value.expectedRepository ||
      !["worker", "reviewer"].includes(value.role) ||
      typeof value.gitPending !== "boolean" ||
      typeof value.branchOwned !== "boolean" ||
      typeof value.cleaned !== "boolean" ||
      typeof value.prepared !== "boolean" ||
      typeof value.launchPending !== "boolean" ||
      typeof value.baseCommit !== "string" ||
      (value.role === "reviewer") !== (value.branch === "") ||
      (value.role === "reviewer" && value.branchOwned) ||
      (value.prepared &&
        (!value.gitDirectory ||
          !value.gitConfigHash ||
          !/^[a-f0-9]{40,64}$/iu.test(value.baseCommit))) ||
      !isIdentity(value.repository) ||
      !isIdentity(value.worktree) ||
      value.repository.path !== value.repositoryPath ||
      value.worktree.path !== value.worktreePath ||
      value.repositoryPath !== this.checkoutPath(id) ||
      value.worktreePath !== value.repositoryPath ||
      (value.gitDirectory !== undefined &&
        (!isIdentity(value.gitDirectory) ||
          value.gitDirectory.path !== path.join(value.worktreePath, ".git"))) ||
      (value.gitConfigHash !== undefined &&
        !/^[a-f0-9]{64}$/u.test(value.gitConfigHash)) ||
      (value.branch !== "" && value.branch !== `cloudx/forge/${id}`)
    )
      throw new Error(
        "Worker workspace ownership record is missing or invalid.",
      );
    assertForgeOrigin(value.origin, value.expectedRepository);
    return value;
  }

  private checkoutPath(id: string): string {
    return path.join(
      path.resolve(this.dependencies.dataDir),
      "forge-workers",
      "checkouts",
      safeId(id),
    );
  }

  private manifest(id: string): JsonStateFile {
    return new JsonStateFile(
      this.dependencies.dataDir,
      `forge-workers/workspaces/${safeId(id)}.json`,
      "Forge workspace ownership",
    );
  }

  private runGit(
    cwd: string,
    args: string[],
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
  ): Promise<string> {
    return (this.dependencies.git ?? git)(cwd, args, signal, environment);
  }

  private async access(
    repository: ForgeRepository,
    role: ForgeCredentialRole,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const access = await this.dependencies.gitAccess(repository, role, signal);
    signal?.throwIfAborted();
    assertForgeOrigin(access.cloneUrl, repository);
    if (
      !access.authorization ||
      /[\r\n\0]/u.test(access.authorization) ||
      access.authorization.length > 64_000
    )
      throw new Error("Forge Git authorization is invalid.");
    return access;
  }

  private async runOwnedGit(
    owned: OwnedWorkspace,
    args: string[],
    signal?: AbortSignal,
    authorization?: string,
  ): Promise<string> {
    owned.gitPending = true;
    await this.manifest(owned.id).write(owned);
    try {
      return await this.runGit(
        owned.worktreePath,
        args,
        signal,
        authorization
          ? {
              GIT_CONFIG_COUNT: "2",
              GIT_CONFIG_KEY_0: "http.extraHeader",
              GIT_CONFIG_VALUE_0: "",
              GIT_CONFIG_KEY_1: `http.${owned.origin}.extraHeader`,
              GIT_CONFIG_VALUE_1: `Authorization: ${authorization}`,
            }
          : undefined,
      );
    } finally {
      owned.gitPending = false;
      await this.manifest(owned.id).write(owned);
    }
  }

  private async configHash(owned: OwnedWorkspace): Promise<string> {
    const handle = await fs.open(
      path.join(owned.worktreePath, ".git", "config"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64_000)
        throw new Error("Worker Git configuration is invalid.");
      const content = Buffer.alloc(64_001);
      const { bytesRead } = await handle.read(content, 0, content.length, 0);
      if (bytesRead > 64_000 || bytesRead !== stat.size)
        throw new Error("Worker Git configuration changed while reading.");
      return createHash("sha256")
        .update(content.subarray(0, bytesRead))
        .digest("hex");
    } finally {
      await handle.close();
    }
  }

  private async assertCheckout(owned: OwnedWorkspace): Promise<void> {
    if (owned.gitPending)
      throw new Error(
        "A worker Git operation is unresolved; its checkout was preserved.",
      );
    await this.assertIdentity(owned.worktree);
    if (!owned.gitDirectory)
      throw new Error("Worker Git directory ownership is missing.");
    await this.assertIdentity(owned.gitDirectory);
    if (
      owned.gitConfigHash &&
      (await this.configHash(owned)) !== owned.gitConfigHash
    )
      throw new Error(
        "Worker Git configuration or origin changed; its checkout was preserved.",
      );
  }

  private async assertQuiescent(owned: OwnedWorkspace): Promise<void> {
    if (owned.launchPending)
      throw new Error(
        "A worker launch is unresolved; its checkout was preserved.",
      );
    const directory = path.join(
      this.dependencies.dataDir,
      "forge-workers",
      "tabs",
    );
    if (
      !(await requireSafeDirectory(this.dependencies.dataDir, directory, {
        create: false,
        label: "Forge tab ownership directory",
      }))
    )
      return;
    for (const name of await fs.readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const tab = await this.tabManifest(name.slice(0, -5)).read<OwnedTab>();
      if (tab?.workerId === owned.id && !tab.closed && !tab.quiescent)
        throw new Error(
          "Stop the worker process before publishing or removing its checkout.",
        );
    }
  }

  private tabManifest(tabId: string): JsonStateFile {
    return new JsonStateFile(
      this.dependencies.dataDir,
      `forge-workers/tabs/${safeId(tabId)}.json`,
      "Forge tab ownership",
    );
  }

  private async recordQuiescence(tabId: string): Promise<void> {
    const owned =
      this.ownedTabs.get(tabId) ??
      (await this.tabManifest(tabId).read<OwnedTab>());
    if (!owned) throw new Error("Worker tab ownership record is missing.");
    owned.quiescent = true;
    await this.tabManifest(tabId).write(owned);
  }

  private async captureTab(tab: WorkspaceTab, owned: OwnedTab): Promise<void> {
    const contextPath = tab.contextPath
      ? path.resolve(tab.contextPath)
      : undefined;
    const context = contextPath ? this.dependencies.sessions.getContextDirectory(tab.id) : undefined;
    if (
      contextPath &&
      (!context || path.dirname(contextPath) !== context.path)
    )
      throw new Error(
        "Worker tab context is outside its owned context directory.",
      );
    const launchPath = path.join(
      path.resolve(this.dependencies.dataDir),
      "codex-launches",
      safeId(tab.id),
    );
    if (context) {
      if (!(await this.assertContextIdentity(context))) throw new Error("Worker context directory disappeared.");
      owned.context = { ...context };
    }
    if (
      await requireSafeDirectory(
        this.dependencies.dataDir,
        path.dirname(launchPath),
        { create: false, label: "Codex launch directory" },
      )
    )
      owned.launch = await optionalIdentity(launchPath);
    await this.tabManifest(tab.id).write(owned);
  }

  private async removeContext(expected: DirectoryIdentity): Promise<void> {
    const context = await this.openContext(expected);
    if (!context) return;
    try { await context.remove(); } finally { await context.close(); }
  }

  private async assertContextIdentity(expected: DirectoryIdentity): Promise<boolean> {
    const context = await this.openContext(expected);
    if (!context) return false;
    await context.close();
    return true;
  }

  private async openContext(expected: DirectoryIdentity) {
    const contextDirectory = path.join(
      path.resolve(this.dependencies.dataDir),
      "context",
    );
    if (
      !isIdentity(expected) ||
      path.dirname(expected.path) !== contextDirectory
    )
      throw new Error("Worker context ownership record is invalid.");
    await requireSafeDirectory(this.dependencies.dataDir, contextDirectory, {
      create: false,
      label: "Worker context directory",
    });
    return openOwnedDirectoryNoFollow(contextDirectory, expected.path, "Worker context", expected).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  }

  private async removeLaunch(
    expected: DirectoryIdentity,
    tabId: string,
  ): Promise<void> {
    const launchPath = path.join(
      path.resolve(this.dependencies.dataDir),
      "codex-launches",
      safeId(tabId),
    );
    if (!isIdentity(expected) || expected.path !== launchPath)
      throw new Error("Worker launch ownership record is invalid.");
    await requireSafeDirectory(
      this.dependencies.dataDir,
      path.dirname(launchPath),
      { create: false, label: "Codex launch directory" },
    );
    const current = await optionalIdentity(launchPath);
    if (!current) return;
    if (current.dev !== expected.dev || current.ino !== expected.ino)
      throw new Error(
        "Worker launch ownership changed; the replacement was preserved.",
      );
    await fs.rm(launchPath, { recursive: true });
  }

  private async directory(candidate: string): Promise<DirectoryIdentity> {
    if (
      !(await requireSafeDirectory(this.dependencies.dataDir, candidate, {
        create: false,
        label: "Forge owned directory",
      }))
    )
      throw new Error("Worker directory disappeared.");
    return identity(candidate);
  }

  private async assertIdentity(expected: DirectoryIdentity): Promise<void> {
    const current = await this.directory(expected.path);
    if (
      current.path !== expected.path ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    )
      throw new Error(
        "Worker directory ownership changed; the replacement was preserved.",
      );
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = this.manifest(id).filePath;
    const run = (ForgeRuntime.operations.get(key) ?? Promise.resolve()).then(
      operation,
    );
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    ForgeRuntime.operations.set(key, settled);
    void settled.then(() => {
      if (ForgeRuntime.operations.get(key) === settled)
        ForgeRuntime.operations.delete(key);
    });
    return run;
  }
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(id))
    throw new Error("Invalid Forge worker id.");
  return id;
}

export function assertForgeOrigin(
  origin: string,
  repository: ForgeRepository,
): void {
  const api = validateRepository(repository);
  const hostname =
    repository.provider === "github" && api.hostname === "api.github.com"
      ? "github.com"
      : api.hostname;
  let remote: URL;
  try {
    remote = new URL(origin);
  } catch {
    throw new Error(
      "Origin must be the configured forge repository's HTTPS clone URL.",
    );
  }
  if (
    remote.protocol !== "https:" ||
    remote.search ||
    remote.hash ||
    remote.username ||
    remote.password ||
    remote.port !== api.port
  )
    throw new Error("Origin must use HTTPS without embedded secrets.");
  const remoteHost = remote.hostname;
  let remotePath = remote.pathname.replace(/^\//u, "");
  remotePath = remotePath.replace(/\.git$/u, "");
  const expectedPath = repository.projectPath;
  const matchesPath =
    repository.provider === "github"
      ? remotePath.toLowerCase() === expectedPath.toLowerCase()
      : remotePath === expectedPath;
  if (
    remoteHost.toLowerCase() !== hostname.toLowerCase() ||
    !matchesPath ||
    /[\r\n]/u.test(origin)
  )
    throw new Error("Origin does not match the configured forge repository.");
}

function isIdentity(value: unknown): value is DirectoryIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.path === "string" &&
    typeof item.dev === "string" &&
    typeof item.ino === "string"
  );
}

async function identity(directory: string): Promise<DirectoryIdentity> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Worker directory must be a real directory.");
  return {
    path: directory,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
  };
}

async function optionalIdentity(
  directory: string,
): Promise<DirectoryIdentity | undefined> {
  try {
    return await identity(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  signal?.throwIfAborted();
  const env: NodeJS.ProcessEnv = {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_ASKPASS: "/bin/false",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const key of [
    "PATH",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "SystemRoot",
    "TEMP",
    "TMP",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-c",
      "credential.interactive=false",
      "-c",
      "http.followRedirects=false",
      "-c",
      "http.sslVerify=true",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      ...args,
    ],
    {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output: Buffer[] = [];
  let bytes = 0;
  let failure: unknown;
  const stop = (reason: unknown): void => {
    if (failure) return;
    failure = reason ?? new Error("Git command was cancelled.");
    if (child.pid) {
      try {
        process.kill(
          process.platform === "win32" ? child.pid : -child.pid,
          "SIGKILL",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error;
      }
    }
  };
  const collect = (chunk: Buffer, retain: boolean): void => {
    bytes += chunk.length;
    if (bytes > 2_000_000)
      stop(new Error("Git command exceeded its output limit."));
    else if (retain) output.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
  const abort = (): void => stop(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () => stop(new Error("Git command exceeded its five minute deadline.")),
    300_000,
  );
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", resolve);
    });
    if (failure) throw failure;
    if (code !== 0)
      throw new Error(`Git ${args[0]} failed with exit code ${code}.`);
    return Buffer.concat(output).toString("utf8");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

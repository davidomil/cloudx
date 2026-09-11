import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeIssueDetail, ForgeRepository, ForgeWorker } from "@cloudx/shared";
import { ConfigService } from "../configService.js";
import { ForgeSettingsService } from "../forge/ForgeSettingsService.js";
import { ForgeWorkflowService, type ForgeWorkflowDependencies } from "../forge/ForgeWorkflowService.js";
import { HookRegistry } from "../hooks/HookRegistry.js";
import { ForgePlugin } from "./ForgePlugin.js";

const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "org/repo" };
const placement = { windowId: "window", paneId: "pane" };
const headSha = "a".repeat(40);
const actions = [
  { hook: "forge.issues.list", input: { filter: "is:open" } },
  { hook: "forge.changes.list", input: { filter: "is:open" } },
  { hook: "forge.issue.get", input: { number: 7 } },
  { hook: "forge.change.get", input: { number: 7 } },
  { hook: "forge.issue.start", input: { number: 7, ...placement } },
  { hook: "forge.review.start", input: { number: 7, autoPost: true, ...placement } },
  { hook: "forge.change.review", input: { number: 7, headSha, event: "approve" } },
  { hook: "forge.change.review", input: { number: 7, headSha, event: "request_changes" } },
];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(selectedRepository: ForgeRepository) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-repository-binding-"));
  roots.push(root);
  let settings: ForgeSettingsService;
  let workflow: ForgeWorkflowService;
  const plugin = new ForgePlugin(() => ({ settings, workflow }));
  const config = new ConfigService(root, () => [plugin.descriptor()]);
  settings = new ForgeSettingsService(config, {
    credential: () => ({ kind: "token", token: "fixture-secret" }),
    workerAuthors: () => [],
  });
  const selectRepository = async (selected: ForgeRepository) => {
    await config.update({ plugins: { forge: { ...selected, workerTemplateId: "worker", reviewTemplateId: "review" } } });
  };
  await selectRepository(selectedRepository);
  const issue: ForgeIssueDetail = {
    number: 7, title: "Repository-bound item", body: "", url: "https://github.com/org/repo/issues/7",
    state: "open", author: "author", labels: [], updatedAt: "", comments: [],
  };
  const change: ForgeChangeRequest = {
    ...issue, draft: false, headSha, headBranch: "feature", baseBranch: "main", baseSha: "b".repeat(40), targetHeadSha: "b".repeat(40),
    merged: false, mergeable: true, requiresBaseUpdate: false, reviewReady: true,
    approved: false, unresolvedDiscussions: 0, linkedIssues: [],
  };
  const requests: { method: string; repository: ForgeRepository }[] = [];
  const boundProvider = settings.provider.bind(settings);
  vi.spyOn(settings, "provider").mockImplementation((selected, role, signal) => {
    const remote = boundProvider(selected, role, signal);
    const record = (method: string) => requests.push({ method, repository: selected });
    vi.spyOn(remote, "listIssues").mockImplementation(async () => { record("listIssues"); return { items: [issue] }; });
    vi.spyOn(remote, "listChangeRequests").mockImplementation(async () => { record("listChangeRequests"); return { items: [change] }; });
    vi.spyOn(remote, "getIssue").mockImplementation(async () => { record("getIssue"); return issue; });
    vi.spyOn(remote, "getChangeRequest").mockImplementation(async () => { record("getChangeRequest"); return change; });
    vi.spyOn(remote, "postReview").mockImplementation(async () => { record("postReview"); return { commentIds: [] }; });
    return remote;
  });
  const runtime = {
    isActive: vi.fn(() => true),
    recover: vi.fn(async () => ({ tabIds: [] })),
    prepareWorkspace: vi.fn(async () => ({ repositoryPath: root, worktreePath: root, branch: "feature" })),
    refreshReviewWorkspace: vi.fn(async () => {}),
    launch: vi.fn(async () => "worker-tab"),
    pause: vi.fn(async () => {}), close: vi.fn(async () => {}), cleanup: vi.fn(async () => {}),
    verifyPublishedWorkspace: vi.fn(async () => {}), syncPublishedBranch: vi.fn(async () => {}), updateIssueBranch: vi.fn(async () => headSha), publishBranch: vi.fn(async () => headSha),
    prepareIssueRebase: vi.fn(async () => ({ targetHeadSha: headSha, originalHeadSha: headSha })),
    completeIssueRebase: vi.fn(async () => headSha),
  } satisfies ForgeWorkflowDependencies["runtime"];
  const deps: ForgeWorkflowDependencies = {
    settings: () => settings.settings(), provider: (selected, role, signal) => settings.provider(selected, role, signal), runtime,
    store: { read: vi.fn(async (): Promise<ForgeWorker[]> => []), write: vi.fn(async () => {}) },
    reports: { prepare: vi.fn(async () => ({ reportPath: path.join(root, "report.json"), contextPath: path.join(root, "context.json") })), read: vi.fn(), remove: vi.fn(async () => {}) },
    notify: vi.fn(),
  };
  workflow = new ForgeWorkflowService(deps);
  const hooks = new HookRegistry();
  plugin.hooks.forEach(hook => hooks.register(hook));
  const call = (hook: string, input: Record<string, unknown>) => hooks.call(hook, input, { caller: { kind: "ui" } });
  return { call, selectRepository, workflow, runtime, requests, deps, settings, change };
}

describe.each([
  { repository },
  { repository: { provider: "gitlab", apiUrl: "https://gitlab.com/api/v4", projectPath: "org/subgroup/repo" } as ForgeRepository },
])("Displayed $repository.provider repository", ({ repository }) => {
  it.each(actions)("keeps reads and mutations on the displayed repository: $hook $input.event", async ({ hook, input }) => {
    const f = await fixture(repository);
    await f.call(hook, { ...input, repository });
    expect(f.requests.length).toBeGreaterThan(0);
    for (const request of f.requests) expect(request.repository).toEqual(repository);
  });

  it.each(actions)("rejects a stale repository before any provider or checkout operation: $hook $input.event", async ({ hook, input }) => {
    const f = await fixture(repository);
    await f.selectRepository({ ...repository, projectPath: "org/fork" });
    await expect(f.call(hook, { ...input, repository })).rejects.toThrow(/repository changed|different repository/);
    expect(f.requests).toEqual([]);
    expect(f.runtime.prepareWorkspace).not.toHaveBeenCalled();
    expect(f.runtime.launch).not.toHaveBeenCalled();
    expect((await f.workflow.dashboard()).workers).toEqual([]);
  });

  it.each(["provider", "apiUrl", "projectPath"] as const)("rejects a different displayed %s even when the item number and SHA match", async key => {
    const f = await fixture(repository);
    const stale = { ...repository, [key]: key === "provider" ? repository.provider === "github" ? "gitlab" : "github" : "other" };
    await expect(f.call("forge.change.review", { repository: stale, number: 7, headSha, event: "approve" })).rejects.toThrow(/repository changed|different repository/);
    expect(f.requests).toEqual([]);
  });

  it.each(actions)("requires a valid repository at the hook boundary: $hook", async ({ hook, input }) => {
    const f = await fixture(repository);
    for (const invalid of [undefined, null, {}, { ...repository, provider: "other" }, { ...repository, apiUrl: "" }, { ...repository, projectPath: "" }, { ...repository, repositoryPath: "/unexpected" }]) {
      await expect(f.call(hook, { ...input, ...(invalid === undefined ? {} : { repository: invalid }) })).rejects.toThrow(/invalid input/);
    }
    expect(f.requests).toEqual([]);
  });

  it.each(actions.filter(({ hook }) => hook.endsWith("start") || hook.endsWith("review")))("rechecks the repository after waiting for the workflow queue: $hook $input.event", async ({ hook, input }) => {
    const f = await fixture(repository);
    let finishLoading!: (workers: ForgeWorker[]) => void;
    const loading = new Promise<ForgeWorker[]>(resolve => { finishLoading = resolve; });
    vi.mocked(f.deps.store.read).mockReturnValueOnce(loading);
    const pending = f.call(hook, { ...input, repository });
    const rejected = expect(pending).rejects.toThrow(/repository changed|different repository/);
    await vi.waitFor(() => expect(f.deps.store.read).toHaveBeenCalled());
    await f.selectRepository({ ...repository, projectPath: "org/fork" });
    finishLoading([]);
    await rejected;
    expect(f.requests).toEqual([]);
    expect(f.runtime.prepareWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the decision response on the same repository if settings change while posting", async () => {
    const f = await fixture(repository);
    const createProvider = vi.mocked(f.settings.provider).getMockImplementation()!;
    vi.spyOn(f.settings, "provider").mockImplementation((selected, role, signal) => {
      const remote = createProvider(selected, role, signal);
      if (role === "reviewer") vi.mocked(remote.postReview).mockImplementation(async () => {
        f.requests.push({ method: "postReview", repository: selected });
        await f.selectRepository({ ...repository, projectPath: "org/fork" });
        return { commentIds: [] };
      });
      return remote;
    });
    await expect(f.call("forge.change.review", { repository, number: 7, headSha, event: "approve" })).resolves.toEqual({ change: f.change });
    expect(f.requests.map(request => request.repository)).toEqual([repository, repository, repository]);
  });
});

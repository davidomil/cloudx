import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import { MAX_FORGE_REVIEW_DRAFT_BODY_LENGTH } from "@cloudx/shared";
import type { ForgeCredential } from "../forge/providers/ForgeCredentials.js";
import { ForgePlugin } from "./ForgePlugin.js";
import { HookRegistry } from "../hooks/HookRegistry.js";
import { ConfigService } from "../configService.js";
import { ForgeSettingsService } from "../forge/ForgeSettingsService.js";
import type { ForgeWorkflowService } from "../forge/ForgeWorkflowService.js";
const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "org/repo" };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-plugin-"));
  roots.push(root);
  const workflow = {
    previewOwnership: vi.fn(async () => ({ fingerprint: "a".repeat(64), directories: [] })),
    reconcileOwnership: vi.fn(async () => ({ id: "worker" })),
    startIssue: vi.fn(async () => ({ id: "worker" })),
    setAutoReview: vi.fn(async () => ({ id: "worker" })),
    syncAndReview: vi.fn(async () => ({ id: "worker" })),
    rebaseAndResolve: vi.fn(async () => ({ id: "worker" })),
    continueWorker: vi.fn(async () => ({ id: "worker" })),
    omitDiscussionReply: vi.fn(async () => ({ id: "worker" })),
    dashboard: vi.fn(async () => ({ workers: [] })),
    workerHistory: vi.fn(async () => undefined as import("@cloudx/shared").ForgeWorkerHistory | undefined),
    markReview: vi.fn(async () => {}),
    saveReview: vi.fn(async () => ({ id: "worker" })),
    submitReview: vi.fn(async () => ({ id: "worker" })),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  let settings: ForgeSettingsService;
  const plugin = new ForgePlugin(() => ({
    settings,
    workflow: workflow as unknown as ForgeWorkflowService,
  }), logger);
  const config = new ConfigService(root, () => [plugin.descriptor()]);
  const connections = {
    workerAuthors: vi.fn(() => ["app/cloudx-worker", "app/cloudx-reviewer"]),
    credential: vi.fn(
      (
        _repository: ForgeRepository,
        role: ForgeCredentialRole,
      ): ForgeCredential => {
        throw new Error(`Connect the ${role} application in Forge settings.`);
      },
    ),
  };
  settings = new ForgeSettingsService(config, connections);
  const hooks = new HookRegistry();
  plugin.hooks.forEach((h) => hooks.register(h));
  return { plugin, config, settings, hooks, workflow, connections, logger };
}
describe("Forge plugin boundary", () => {
  it("requires a complete ownership preview and explicit attestation at the hook boundary", async () => {
    const { hooks, workflow } = await fixture();
    const input = { id: "worker", fingerprint: "a".repeat(64), attestations: [{ device: "64521", filesystemId: "original-ext4", filesystemType: "ext4" }] };
    await expect(hooks.call("forge.worker.previewOwnership", { id: "worker" }, { caller: { kind: "ui" } })).resolves.toMatchObject({ preview: { fingerprint: input.fingerprint } });
    await hooks.call("forge.worker.reconcileOwnership", input, { caller: { kind: "ui" } });
    expect(workflow.reconcileOwnership).toHaveBeenCalledExactlyOnceWith("worker", { fingerprint: input.fingerprint, attestations: input.attestations });
    for (const invalid of [{ ...input, attestations: [] }, { ...input, fingerprint: "stale" }, { ...input, path: "/other" }, { ...input, attestations: [{ device: "64521" }] }]) {
      await expect(hooks.call("forge.worker.reconcileOwnership", invalid, { caller: { kind: "ui" } })).rejects.toThrow(/invalid input/);
    }
    await expect(hooks.call("forge.worker.reconcileOwnership", input, { caller: { kind: "automation" } })).rejects.toThrow(/exposed/);
    expect(workflow.reconcileOwnership).toHaveBeenCalledTimes(1);
  });

  it.each(["ui", "http"] as const)("reads retained history through %s without starting a worker", async kind => {
    const { hooks, workflow, logger } = await fixture();
    const history = { tabId: "tab-1", capturedAt: "2026-09-21T12:00:00.000Z", screen: { data: "Private terminal history", cols: 100, rows: 30 } };
    workflow.workerHistory.mockResolvedValue(history);
    await expect(hooks.call("forge.worker.history", { id: "worker" }, { caller: { kind } })).resolves.toEqual({ history });
    expect(workflow.workerHistory).toHaveBeenCalledExactlyOnceWith("worker");
    expect(workflow.startIssue).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.values(logger).flatMap(log => log.mock.calls))).not.toContain(history.screen.data);
  });

  it.each([{ id: undefined }, { id: "" }, { id: 7 }, { id: "w".repeat(129) }, { id: "worker", path: "/private" }])("rejects malformed history input before dispatch %#", async input => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.history", input, { caller: { kind: "ui" } })).rejects.toThrow(/invalid input/);
    expect(workflow.workerHistory).not.toHaveBeenCalled();
  });

  it("reports missing history explicitly and keeps the read hook unavailable to automation", async () => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.history", { id: "worker" }, { caller: { kind: "ui" } })).resolves.toEqual({ history: undefined });
    workflow.workerHistory.mockClear();
    await expect(hooks.call("forge.worker.history", { id: "worker" }, { caller: { kind: "automation" } })).rejects.toThrow(/exposed/);
    expect(workflow.workerHistory).not.toHaveBeenCalled();
  });

  it.each([{ kind: "ui", length: 40 }, { kind: "http", length: 40 }, { kind: "ui", length: 64 }, { kind: "http", length: 64 }] as const)("omits only the displayed reply through $kind at its $length-character head", async ({ kind, length }) => {
    const { hooks, workflow } = await fixture();
    const input = { id: "worker", discussionId: "discussion-1", headSha: "a".repeat(length), body: "Fixed the timeout.\nThe reproduction passes." };
    await expect(hooks.call("forge.worker.omitDiscussionReply", input, { caller: { kind } })).resolves.toEqual({ worker: { id: "worker" } });
    expect(workflow.omitDiscussionReply).toHaveBeenCalledExactlyOnceWith(input.id, input.discussionId, input.headSha, input.body);
  });

  it.each([
    { id: undefined }, { id: "" }, { id: 7 }, { id: "w".repeat(129) },
    { discussionId: undefined }, { discussionId: "" }, { discussionId: " \n" }, { discussionId: 7 }, { discussionId: "d".repeat(257) },
    { headSha: undefined }, { headSha: "" }, { headSha: 7 }, { headSha: "a".repeat(39) }, { headSha: "a".repeat(41) },
    { headSha: "a".repeat(63) }, { headSha: "a".repeat(65) }, { headSha: "g".repeat(40) }, { headSha: `${"a".repeat(40)}\n` },
    { body: undefined }, { body: "" }, { body: " \n" }, { body: 7 }, { body: "b".repeat(20_001) },
    { resolved: true }, { repositoryPath: "/untrusted" },
  ])("rejects invalid uncertain reply recovery input before dispatch %#", async invalid => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.omitDiscussionReply", { id: "worker", discussionId: "discussion-1", headSha: "a".repeat(40), body: "Fixed the timeout.", ...invalid }, { caller: { kind: "ui" } })).rejects.toThrow(/invalid input/);
    expect(workflow.omitDiscussionReply).not.toHaveBeenCalled();
  });

  it("keeps uncertain reply omission unavailable to automation", async () => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.omitDiscussionReply", { id: "worker", discussionId: "discussion-1", headSha: "a".repeat(40), body: "Fixed the timeout." }, { caller: { kind: "automation" } })).rejects.toThrow(/exposed/);
    expect(workflow.omitDiscussionReply).not.toHaveBeenCalled();
  });

  it("returns stale-checkpoint rejection to the UI", async () => {
    const { hooks, workflow } = await fixture();
    workflow.omitDiscussionReply.mockRejectedValue(new Error("The uncertain discussion reply changed. Refresh Forge."));
    await expect(hooks.call("forge.worker.omitDiscussionReply", { id: "worker", discussionId: "discussion-1", headSha: "a".repeat(40), body: "Fixed the timeout." }, { caller: { kind: "ui" } })).rejects.toThrow("The uncertain discussion reply changed. Refresh Forge.");
  });

  it.each(["ui", "http"] as const)("continues the selected worker with its message through %s", async kind => {
    const { hooks, workflow, logger } = await fixture();
    const message = "The setup is fixed.\nContinue with the failing test.";
    await expect(hooks.call("forge.worker.continue", { id: "worker", message, windowId: "window", paneId: "pane" }, { caller: { kind } })).resolves.toEqual({ worker: { id: "worker" } });
    expect(workflow.continueWorker).toHaveBeenCalledExactlyOnceWith("worker", message, { windowId: "window", paneId: "pane" });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "hook_completed", hookId: "forge.worker.continue", elapsedMs: expect.any(Number) }), expect.any(String));
    const logs = JSON.stringify(Object.values(logger).flatMap(log => log.mock.calls));
    expect(logs).not.toContain("The setup is fixed.");
    expect(logs).not.toContain("Continue with the failing test.");
  });

  it.each([
    { message: undefined }, { message: null }, { message: 7 }, { message: "" }, { message: " \n\t" }, { message: "x".repeat(20_001) },
    { id: undefined }, { id: "" }, { id: 7 }, { id: "x".repeat(129) },
    { windowId: undefined }, { windowId: "" }, { paneId: undefined }, { paneId: "" },
    { repositoryPath: "/untrusted" }, { headSha: "a".repeat(40) },
  ])("rejects invalid continuation input before dispatch %#", async invalid => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.continue", { id: "worker", message: "Continue", windowId: "window", paneId: "pane", ...invalid }, { caller: { kind: "ui" } })).rejects.toThrow(/invalid input/);
    expect(workflow.continueWorker).not.toHaveBeenCalled();
  });

  it("keeps manual continuation unavailable to automation", async () => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.continue", { id: "worker", message: "Continue", windowId: "window", paneId: "pane" }, { caller: { kind: "automation" } })).rejects.toThrow(/exposed/);
    expect(workflow.continueWorker).not.toHaveBeenCalled();
  });

  it.each(["ui", "http"] as const)("starts conflict recovery through %s using the selected worker and pane", async kind => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.rebaseAndResolve", { id: "worker", windowId: "window", paneId: "pane" }, { caller: { kind } })).resolves.toEqual({ worker: { id: "worker" } });
    expect(workflow.rebaseAndResolve).toHaveBeenCalledExactlyOnceWith("worker", { windowId: "window", paneId: "pane" });
  });

  it.each([
    { id: undefined }, { id: "" }, { id: 7 }, { id: "w".repeat(129) },
    { windowId: undefined }, { windowId: "" }, { paneId: undefined }, { paneId: "" },
    { repositoryPath: "/untrusted" }, { headSha: "a".repeat(40) }, { targetHeadSha: "b".repeat(40) },
  ])("rejects invalid conflict recovery arguments before touching the worker %#", async invalid => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.rebaseAndResolve", { id: "worker", windowId: "window", paneId: "pane", ...invalid }, { caller: { kind: "ui" } })).rejects.toThrow(/invalid input/);
    expect(workflow.rebaseAndResolve).not.toHaveBeenCalled();
  });

  it("does not expose conflict recovery to automation hooks", async () => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.rebaseAndResolve", { id: "worker", windowId: "window", paneId: "pane" }, { caller: { kind: "automation" } })).rejects.toThrow(/exposed/);
    expect(workflow.rebaseAndResolve).not.toHaveBeenCalled();
  });

  it("syncs the selected worker using the current pane placement", async () => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.syncAndReview", { id: "worker", windowId: "window", paneId: "pane" }, { caller: { kind: "ui" } })).resolves.toEqual({ worker: { id: "worker" } });
    expect(workflow.syncAndReview).toHaveBeenCalledExactlyOnceWith("worker", { windowId: "window", paneId: "pane" });
  });

  it.each([
    { id: undefined }, { id: "" }, { id: 7 }, { id: "w".repeat(129) },
    { windowId: undefined }, { windowId: "" }, { paneId: undefined }, { paneId: "" },
    { repositoryPath: "/untrusted" }, { headSha: "a".repeat(40) },
  ])("rejects invalid sync arguments before touching the worker %#", async invalid => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.syncAndReview", { id: "worker", windowId: "window", paneId: "pane", ...invalid }, { caller: { kind: "ui" } })).rejects.toThrow(/invalid input/);
    expect(workflow.syncAndReview).not.toHaveBeenCalled();
  });

  it("does not expose branch sync and re-review to automation", async () => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.worker.syncAndReview", { id: "worker", windowId: "window", paneId: "pane" }, { caller: { kind: "automation" } })).rejects.toThrow(/exposed/);
    expect(workflow.syncAndReview).not.toHaveBeenCalled();
  });

  it("binds saving and submitting a review to the displayed draft", async () => {
    const { hooks, workflow } = await fixture();
    const draftId = "33333333-3333-4333-8333-333333333333";
    const edit = { body: "Review this revision.", event: "comment", comments: [] };
    await hooks.call("forge.review.save", { id: "worker", draftId, ...edit }, { caller: { kind: "ui" } });
    await hooks.call("forge.review.submit", { id: "worker", draftId }, { caller: { kind: "ui" } });
    expect(workflow.saveReview).toHaveBeenCalledExactlyOnceWith("worker", draftId, edit);
    expect(workflow.submitReview).toHaveBeenCalledExactlyOnceWith("worker", draftId);
  });

  it.each(["ui", "http"] as const)("saves the full draft body limit through %s and rejects longer edits before dispatch", async kind => {
    const { hooks, workflow } = await fixture();
    const draftId = "33333333-3333-4333-8333-333333333333";
    const edit = { body: "x".repeat(MAX_FORGE_REVIEW_DRAFT_BODY_LENGTH), event: "comment", comments: [] };
    await hooks.call("forge.review.save", { id: "worker", draftId, ...edit }, { caller: { kind } });
    expect(workflow.saveReview).toHaveBeenCalledExactlyOnceWith("worker", draftId, edit);

    await expect(hooks.call("forge.review.save", { id: "worker", draftId, ...edit, body: `${edit.body}x` }, { caller: { kind } })).rejects.toThrow(/invalid input.*body/);
    expect(workflow.saveReview).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 7, "", " ", "review", "33333333-3333-4333-8333-33333333333", "33333333-3333-4333-8333-333333333333\n"])("rejects a missing or invalid draft identity before either mutation: %j", async draftId => {
    const { hooks, workflow } = await fixture();
    for (const hook of ["forge.review.save", "forge.review.submit"]) {
      const edit = hook === "forge.review.save" ? { body: "Finding.", event: "comment", comments: [] } : {};
      await expect(hooks.call(hook, { id: "worker", ...edit, ...(draftId === undefined ? {} : { draftId }) }, { caller: { kind: "ui" } })).rejects.toThrow(/invalid input.*draftId/);
    }
    expect(workflow.saveReview).not.toHaveBeenCalled();
    expect(workflow.submitReview).not.toHaveBeenCalled();
  });

  it("rejects client changes to the server-owned review timestamp", async () => {
    const { hooks, workflow } = await fixture();
    await expect(hooks.call("forge.review.save", { id: "worker", draftId: "33333333-3333-4333-8333-333333333333", startedAt: "2026-09-07T12:00:00.000Z", body: "Finding.", comments: [], event: "comment" }, { caller: { kind: "ui" } })).rejects.toThrow(/invalid input/);
    expect(workflow.saveReview).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "github", event: "approve", headSha: "a".repeat(40) },
    { provider: "github", event: "request_changes", headSha: "b".repeat(64) },
    { provider: "gitlab", event: "approve", headSha: "a".repeat(40) },
    { provider: "gitlab", event: "request_changes", headSha: "b".repeat(64) },
  ] as const)("dispatches the displayed $provider head for $event", async ({ provider, event, headSha }) => {
    const { config, settings, connections, hooks, workflow } = await fixture();
    await config.update({ plugins: { forge: { provider, apiUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4", projectPath: "org/repo", workerTemplateId: "worker", reviewTemplateId: "review" } } });
    connections.credential.mockImplementation(() => ({ kind: "token", token: "private" }));
    const remote = settings.provider(settings.repository(), "worker");
    const change = { number: 7, headSha } as ForgeChangeRequest;
    vi.spyOn(remote, "getChangeRequest").mockResolvedValue(change);
    vi.spyOn(settings, "provider").mockReturnValue(remote);
    const body = "Decision on the displayed revision.";

    await expect(hooks.call("forge.change.review", { repository: settings.repository(), number: 7, headSha, event, body }, { caller: { kind: "ui" } })).resolves.toEqual({ change });

    expect(workflow.markReview).toHaveBeenCalledExactlyOnceWith(settings.repository(), 7, headSha, event, body);
  });

  it.each([undefined, null, 42, "", "a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), "g".repeat(40), `${"a".repeat(40)}\n`])("rejects a missing or invalid direct decision head before dispatch: %j", async headSha => {
    const { hooks, workflow } = await fixture();
    const input = { repository, number: 7, event: "approve", ...(headSha === undefined ? {} : { headSha }) };
    await expect(hooks.call("forge.change.review", input, { caller: { kind: "ui" } })).rejects.toThrow(/invalid input.*headSha/);
    expect(workflow.markReview).not.toHaveBeenCalled();
  });

  it.each(["forge.issues.list", "forge.changes.list"])("validates and dispatches quick scopes through %s", async hook => {
    const { config, settings, connections, hooks } = await fixture();
    await config.update({ plugins: { forge: { projectPath: "org/repo", workerTemplateId: "worker", reviewTemplateId: "review" } } });
    connections.credential.mockImplementation(() => ({ kind: "token", token: "private" }));
    const provider = settings.provider(settings.repository(), "worker");
    const list = vi.spyOn(provider, hook === "forge.issues.list" ? "listIssues" : "listChangeRequests").mockResolvedValue({ items: [] });
    vi.spyOn(settings, "provider").mockReturnValue(provider);
    for (const scope of ["assigned_to_me", "created_by_me", "created_by_workers"]) {
      const input = { filter: "is:open", scope, page: 2, perPage: 25 };
      await hooks.call(hook, { ...input, repository }, { caller: { kind: "ui" } });
      expect(list).toHaveBeenLastCalledWith(input);
    }
    await expect(hooks.call(hook, { scope: "unknown" }, { caller: { kind: "ui" } })).rejects.toThrow();
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("registers a creatable panel with settings for repository and template selection", async () => {
    const { plugin } = await fixture();
    expect(plugin.descriptor()).toMatchObject({
      id: "forge",
      creatable: true,
      uiContributions: expect.arrayContaining([
        expect.objectContaining({ renderer: "forge.panel" }),
      ]),
    });
    expect(
      plugin.configFields.filter((f) => f.type === "secret").map((f) => f.key),
    ).toEqual([]);
    expect(plugin.configFields.map((field) => field.key)).not.toContain(
      "repositoryPath",
    );
  });
  it("validates worker start arguments before dispatch and blocks automation exposure", async () => {
    const { hooks, workflow } = await fixture();
    await expect(
      hooks.call(
        "forge.issue.start",
        { number: -1, windowId: "w", paneId: "p" },
        { caller: { kind: "ui" } },
      ),
    ).rejects.toThrow();
    await expect(
      hooks.call(
        "forge.issue.start",
        { repository, number: 1, windowId: "w", paneId: "p", repositoryPath: "/elsewhere" },
        { caller: { kind: "http" } },
      ),
    ).rejects.toThrow();
    await expect(
      hooks.call(
        "forge.issue.start",
        { repository, number: 1, windowId: "w", paneId: "p" },
        { caller: { kind: "automation" } },
      ),
    ).rejects.toThrow(/exposed/);
    expect(workflow.startIssue).not.toHaveBeenCalled();
    await hooks.call(
      "forge.issue.start",
      { repository, number: 1, windowId: "w", paneId: "p" },
      { caller: { kind: "ui" } },
    );
    expect(workflow.startIssue).toHaveBeenCalledWith(repository, 1, {
      windowId: "w",
      paneId: "p",
    }, false);
  });
  it("opts into the issue review loop only through validated explicit controls", async () => {
    const { hooks, workflow } = await fixture();
    await hooks.call("forge.issue.start", { repository, number: 1, windowId: "w", paneId: "p", autoReview: true }, { caller: { kind: "ui" } });
    expect(workflow.startIssue).toHaveBeenCalledWith(repository, 1, { windowId: "w", paneId: "p" }, true);
    await hooks.call("forge.worker.autoReview", { id: "worker", enabled: false, windowId: "w", paneId: "p" }, { caller: { kind: "ui" } });
    expect(workflow.setAutoReview).toHaveBeenCalledWith("worker", false, { windowId: "w", paneId: "p" });
    await expect(hooks.call("forge.worker.autoReview", { id: "worker", enabled: "true", windowId: "w", paneId: "p" }, { caller: { kind: "ui" } })).rejects.toThrow();
    await expect(hooks.call("forge.worker.autoReview", { id: "worker", enabled: true, windowId: "w", paneId: "p" }, { caller: { kind: "automation" } })).rejects.toThrow(/exposed/);
  });
  it("requires connected application identities and keeps their credentials out of public config", async () => {
    const { config, settings, connections } = await fixture();
    expect(() => settings.settings()).toThrow(/Configure/);
    await config.update({
      plugins: {
        forge: {
          projectPath: "org/repo",
          workerTemplateId: "worker",
          reviewTemplateId: "review",
        },
      },
    });
    expect(() => settings.settings()).toThrow("Connect the worker application");
    connections.credential.mockImplementation((_repository, role) => ({
      kind: "token",
      token: `private-${role}-secret`,
    }));
    expect(settings.settings().repository.projectPath).toBe("org/repo");
    expect(JSON.stringify(config.getResponse())).not.toContain(
      "private-worker-secret",
    );
    expect(JSON.stringify(config.getResponse())).not.toContain(
      "private-reviewer-secret",
    );
  });
});


describe("Forge hook diagnostics", () => {
  it("times actions and keeps dashboard polling at debug level without logging input or output", async () => {
    const { hooks, workflow, logger } = await fixture();
    workflow.dashboard.mockResolvedValue({ workers: [{ title: "private-result" }] } as never);
    await hooks.call("forge.dashboard", {}, { caller: { kind: "ui" } });
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ event: "hook_completed", hookId: "forge.dashboard", elapsedMs: expect.any(Number) }), expect.any(String));
    expect(logger.info).not.toHaveBeenCalled();
    await hooks.call("forge.review.save", { id: "worker", draftId: "33333333-3333-4333-8333-333333333333", body: "private-review", comments: [], event: "comment" }, { caller: { kind: "ui" } });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "hook_started", hookId: "forge.review.save" }), expect.any(String));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "hook_completed", hookId: "forge.review.save", elapsedMs: expect.any(Number) }), expect.any(String));
    const logs = JSON.stringify(Object.values(logger).flatMap(log => log.mock.calls));
    expect(logs).not.toContain("private-review");
    expect(logs).not.toContain("private-result");
  });

  it("preserves failures and successful actions when logging throws", async () => {
    const { hooks, workflow, logger } = await fixture();
    const failure = new Error("private-error");
    workflow.dashboard.mockRejectedValueOnce(failure);
    await expect(hooks.call("forge.dashboard", {}, { caller: { kind: "ui" } })).rejects.toThrow("private-error");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "hook_failed", hookId: "forge.dashboard", failure: "unknown", elapsedMs: expect.any(Number) }), expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private-error");
    for (const log of Object.values(logger)) log.mockImplementation(() => { throw new Error("logger failed"); });
    await expect(hooks.call("forge.dashboard", {}, { caller: { kind: "ui" } })).resolves.toEqual({ workers: [] });
    workflow.dashboard.mockRejectedValueOnce(failure);
    await expect(hooks.call("forge.dashboard", {}, { caller: { kind: "ui" } })).rejects.toThrow("private-error");
  });
});

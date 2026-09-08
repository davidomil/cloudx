import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
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
    startIssue: vi.fn(async () => ({ id: "worker" })),
    setAutoReview: vi.fn(async () => ({ id: "worker" })),
    dashboard: vi.fn(async () => ({ workers: [] })),
    markReview: vi.fn(async () => {}),
  };
  let settings: ForgeSettingsService;
  const plugin = new ForgePlugin(() => ({
    settings,
    workflow: workflow as unknown as ForgeWorkflowService,
  }));
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
  return { plugin, config, settings, hooks, workflow, connections };
}
describe("Forge plugin boundary", () => {
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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import type { ForgeCredential } from "../forge/providers/ForgeCredentials.js";
import { ForgePlugin } from "./ForgePlugin.js";
import { HookRegistry } from "../hooks/HookRegistry.js";
import { ConfigService } from "../configService.js";
import { ForgeSettingsService } from "../forge/ForgeSettingsService.js";
import type { ForgeWorkflowService } from "../forge/ForgeWorkflowService.js";
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
    dashboard: vi.fn(async () => ({ workers: [] })),
  };
  let settings: ForgeSettingsService;
  const plugin = new ForgePlugin(() => ({
    settings,
    workflow: workflow as unknown as ForgeWorkflowService,
  }));
  const config = new ConfigService(root, () => [plugin.descriptor()]);
  const connections = {
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
        { number: 1, windowId: "w", paneId: "p", repositoryPath: "/elsewhere" },
        { caller: { kind: "http" } },
      ),
    ).rejects.toThrow();
    await expect(
      hooks.call(
        "forge.issue.start",
        { number: 1, windowId: "w", paneId: "p" },
        { caller: { kind: "automation" } },
      ),
    ).rejects.toThrow(/exposed/);
    expect(workflow.startIssue).not.toHaveBeenCalled();
    await hooks.call(
      "forge.issue.start",
      { number: 1, windowId: "w", paneId: "p" },
      { caller: { kind: "ui" } },
    );
    expect(workflow.startIssue).toHaveBeenCalledWith(1, {
      windowId: "w",
      paneId: "p",
    });
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

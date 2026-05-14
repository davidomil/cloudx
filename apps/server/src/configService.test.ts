import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PluginDescriptor } from "@cloudx/shared";

import { ConfigService } from "./configService.js";

describe("ConfigService", () => {
  it("resolves defaults and persists updated global and plugin values", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-"));
    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);

    expect(service.getResponse()).toMatchObject({
      values: {
        global: { aiControlEnabled: true, microphoneEnabled: true, themeId: "cloudx-neon", uiScale: 100 },
        plugins: { "file-browser": { showGitDiff: true, gitAutoRefresh: true, gitAutoRefreshSeconds: 15 } }
      }
    });

    await service.update({
      global: { aiControlEnabled: false, themeId: "minimalist-dark", uiScale: 115 },
      plugins: { "file-browser": { showGitDiff: false, gitAutoRefresh: false, gitAutoRefreshSeconds: 30 } }
    });

    const configPath = path.join(dataDir, "config.json");
    await expect(fs.readFile(configPath, "utf8")).resolves.toContain("gitAutoRefreshSeconds");
    const reloaded = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);
    expect(reloaded.getResponse()).toMatchObject({
      values: {
        global: { aiControlEnabled: false, microphoneEnabled: true, themeId: "minimalist-dark", uiScale: 115 },
        plugins: { "file-browser": { showGitDiff: false, gitAutoRefresh: false, gitAutoRefreshSeconds: 30 } }
      }
    });
  });

  it("rejects unknown or wrongly typed values", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-"));
    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);

    await expect(service.update({ global: { nope: true } })).rejects.toThrow("Unknown config key");
    await expect(service.update({ global: { themeId: "missing" } })).rejects.toThrow("must be one of the configured options");
    await expect(service.update({ global: { uiScale: 50 } })).rejects.toThrow("must be greater than or equal to 75");
    await expect(service.update({ global: { uiScale: 175 } })).rejects.toThrow("must be less than or equal to 150");
    await expect(service.update({ plugins: { "file-browser": { showGitDiff: "no" } } })).rejects.toThrow("must be a boolean");
    await expect(service.update({ plugins: { "file-browser": { gitAutoRefreshSeconds: 0 } } })).rejects.toThrow("must be greater than or equal to 1");
  });
});

function fileBrowserDescriptor(): PluginDescriptor {
  return {
    id: "file-browser",
    acronym: "FB",
    displayName: "Files",
    description: "Files",
    panelKind: "file-browser",
    creatable: true,
    requiresDirectory: true,
    actions: [],
    configFields: [
      {
        key: "showGitDiff",
        label: "Show Git diff",
        type: "boolean",
        defaultValue: true
      },
      {
        key: "gitAutoRefresh",
        label: "Git auto-refresh",
        type: "boolean",
        defaultValue: true
      },
      {
        key: "gitAutoRefreshSeconds",
        label: "Git refresh frequency",
        type: "number",
        defaultValue: 15,
        min: 1,
        step: 1
      }
    ]
  };
}

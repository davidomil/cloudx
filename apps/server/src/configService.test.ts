import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PluginDescriptor } from "@cloudx/shared";
import { DEFAULT_VOICE_MODEL } from "@cloudx/shared";

import { ConfigService } from "./configService.js";

describe("ConfigService", () => {
  it("resolves defaults and persists updated global and plugin values", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-"));
    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);

    expect(service.getResponse()).toMatchObject({
      values: {
        global: { aiControlEnabled: true, voiceCommandsEnabled: true, microphoneEnabled: true, voiceModel: DEFAULT_VOICE_MODEL, themeId: "cloudx-neon", uiScale: 100 },
        plugins: { "file-browser": { showGitDiff: true, gitAutoRefresh: true, gitAutoRefreshSeconds: 15 } }
      }
    });

    await service.update({
      global: { aiControlEnabled: false, voiceCommandsEnabled: false, voiceModel: "gpt-5.4-mini", themeId: "minimalist-dark", uiScale: 115 },
      plugins: { "file-browser": { showGitDiff: false, gitAutoRefresh: false, gitAutoRefreshSeconds: 30 } }
    });

    const configPath = path.join(dataDir, "config.json");
    await expect(fs.readFile(configPath, "utf8")).resolves.toContain("gitAutoRefreshSeconds");
    expect((await fs.readdir(dataDir)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
    const reloaded = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);
    expect(reloaded.getResponse()).toMatchObject({
      values: {
        global: { aiControlEnabled: false, voiceCommandsEnabled: false, microphoneEnabled: true, voiceModel: "gpt-5.4-mini", themeId: "minimalist-dark", uiScale: 115 },
        plugins: { "file-browser": { showGitDiff: false, gitAutoRefresh: false, gitAutoRefreshSeconds: 30 } }
      }
    });
  });

  it("uses the startup voice model as the runtime default and persists overrides", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-voice-model-"));
    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()], { voiceModel: "gpt-5.4" });

    expect(service.getResponse().globalFields.find((field) => field.key === "voiceModel")).toMatchObject({
      type: "select",
      defaultValue: "gpt-5.4",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "gpt-5.4", label: "GPT-5.4" }),
        expect.objectContaining({ value: "gpt-5.4-mini", label: "GPT-5.4-Mini" })
      ])
    });
    expect(service.getVoiceModel()).toBe("gpt-5.4");

    await service.update({ global: { voiceModel: "gpt-5.4-mini" } });

    expect(service.getVoiceModel()).toBe("gpt-5.4-mini");
    expect(new ConfigService(dataDir, () => [fileBrowserDescriptor()], { voiceModel: "gpt-5.4" }).getVoiceModel()).toBe("gpt-5.4-mini");
  });

  it("serializes concurrent updates without losing earlier config patches", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-concurrent-"));
    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);

    await Promise.all([
      service.update({ global: { aiControlEnabled: false } }),
      service.update({ global: { voiceCommandsEnabled: false } }),
      service.update({ global: { microphoneEnabled: false } }),
      service.update({ plugins: { "file-browser": { showGitDiff: false } } }),
      service.update({ plugins: { "file-browser": { gitAutoRefreshSeconds: 45 } } })
    ]);

    const reloaded = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);
    expect(reloaded.getResponse()).toMatchObject({
      values: {
        global: { aiControlEnabled: false, voiceCommandsEnabled: false, microphoneEnabled: false },
        plugins: { "file-browser": { showGitDiff: false, gitAutoRefreshSeconds: 45 } }
      }
    });
    expect((await fs.readdir(dataDir)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("resolves and validates internal plugin config fields", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-internal-"));
    const service = new ConfigService(dataDir, () => [internalConfigDescriptor()]);

    expect(service.getResponse()).toMatchObject({
      plugins: [
        {
          pluginId: "internal-config",
          fields: [
            expect.objectContaining({
              key: "skillIds",
              visibility: "internal",
              defaultValue: "metadata,visuals"
            })
          ]
        }
      ],
      values: {
        plugins: {
          "internal-config": {
            skillIds: "metadata,visuals"
          }
        }
      }
    });

    await service.update({ plugins: { "internal-config": { skillIds: "metadata" } } });

    expect(service.getPluginConfig("internal-config").skillIds).toBe("metadata");
  });

  it("stores secret plugin config values outside config.json and redacts responses", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-secret-"));
    const service = new ConfigService(dataDir, () => [secretConfigDescriptor()]);

    const response = await service.update({ plugins: { jira: { siteUrl: "https://example.atlassian.net", apiToken: "secret-token" } } });

    expect(response.values.plugins.jira.apiToken).toBe("");
    expect(response.plugins[0]?.fields.find((field) => field.key === "apiToken")).toMatchObject({
      type: "secret",
      secretConfigured: true
    });
    await expect(fs.readFile(path.join(dataDir, "config.json"), "utf8")).resolves.not.toContain("secret-token");
    const secretPath = path.join(dataDir, "secrets", "config-secrets.json");
    await expect(fs.readFile(secretPath, "utf8")).resolves.toContain("secret-token");
    if (process.platform !== "win32") {
      expect((await fs.stat(secretPath)).mode & 0o777).toBe(0o600);
    }

    const reloaded = new ConfigService(dataDir, () => [secretConfigDescriptor()]);
    expect(reloaded.getResponse().values.plugins.jira.apiToken).toBe("");
    expect(reloaded.getPluginSecret("jira", "apiToken")).toBe("secret-token");
    await reloaded.update({ plugins: { jira: { siteUrl: "https://other.atlassian.net", apiToken: "" } } });
    expect(reloaded.getPluginSecret("jira", "apiToken")).toBe("secret-token");

    const cleared = await reloaded.clearPluginSecret("jira", "apiToken");
    expect(cleared.plugins[0]?.fields.find((field) => field.key === "apiToken")).toMatchObject({ secretConfigured: false });
    expect(reloaded.getPluginSecret("jira", "apiToken")).toBeUndefined();
    await expect(fs.readFile(secretPath, "utf8")).resolves.not.toContain("secret-token");
  });

  it("merges updates from separate service instances against the latest persisted config", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-cross-instance-"));
    const first = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);
    const second = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);

    await first.update({ global: { aiControlEnabled: false } });
    await second.update({ global: { microphoneEnabled: false } });

    const reloaded = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);
    expect(reloaded.getResponse()).toMatchObject({
      values: {
        global: { aiControlEnabled: false, microphoneEnabled: false }
      }
    });
  });

  it("rejects unknown or wrongly typed values", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-"));
    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);

    await expect(service.update({ global: { nope: true } })).rejects.toThrow("Unknown config key");
    await expect(service.update({ global: { themeId: "missing" } })).rejects.toThrow("must be one of the configured options");
    await expect(service.update({ global: { voiceModel: "" } })).rejects.toThrow("must be one of the configured options");
    await expect(service.update({ global: { voiceModel: "gpt 5.4" } })).rejects.toThrow("must be one of the configured options");
    await expect(service.update({ global: { voiceModel: "x".repeat(129) } })).rejects.toThrow("must be one of the configured options");
    await expect(service.update({ global: { uiScale: 50 } })).rejects.toThrow("must be greater than or equal to 75");
    await expect(service.update({ global: { uiScale: 175 } })).rejects.toThrow("must be less than or equal to 150");
    await expect(service.update({ plugins: { "file-browser": { showGitDiff: "no" } } })).rejects.toThrow("must be a boolean");
    await expect(service.update({ plugins: { "file-browser": { gitAutoRefreshSeconds: 0 } } })).rejects.toThrow("must be greater than or equal to 1");
    await expect(service.update(null as never)).rejects.toThrow("Config patch must be an object.");
    await expect(service.update({ global: null } as never)).rejects.toThrow("global must be an object.");
    await expect(service.update({ plugins: { "file-browser": null } } as never)).rejects.toThrow("plugins.file-browser must be an object.");
  });

  it("falls back to defaults for invalid persisted values", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-"));
    await fs.writeFile(
      path.join(dataDir, "config.json"),
      `${JSON.stringify({
        global: {
          aiControlEnabled: "false",
          voiceCommandsEnabled: "no",
          microphoneEnabled: 1,
          voiceModel: "bad model",
          themeId: "missing",
          uiScale: 999
        },
        plugins: {
          "file-browser": {
            showGitDiff: "no",
            gitAutoRefresh: 0,
            gitAutoRefreshSeconds: 0
          }
        }
      })}\n`,
      "utf8"
    );

    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);

    expect(service.getResponse()).toMatchObject({
      values: {
        global: { aiControlEnabled: true, voiceCommandsEnabled: true, microphoneEnabled: true, voiceModel: DEFAULT_VOICE_MODEL, themeId: "cloudx-neon", uiScale: 100 },
        plugins: { "file-browser": { showGitDiff: true, gitAutoRefresh: true, gitAutoRefreshSeconds: 15 } }
      }
    });
  });

  it("normalizes valid stored config JSON with wrong collection shapes", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-shapes-"));
    await fs.writeFile(
      path.join(dataDir, "config.json"),
      `${JSON.stringify({
        global: "not-an-object",
        plugins: {
          "file-browser": "not-an-object"
        }
      })}\n`,
      "utf8"
    );

    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);

    expect(service.getResponse()).toMatchObject({
      values: {
        global: { aiControlEnabled: true, voiceCommandsEnabled: true, microphoneEnabled: true, themeId: "cloudx-neon", uiScale: 100 },
        plugins: { "file-browser": { showGitDiff: true, gitAutoRefresh: true, gitAutoRefreshSeconds: 15 } }
      }
    });
  });

  it("falls back to defaults when app-owned config JSON is malformed", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-malformed-"));
    await fs.writeFile(path.join(dataDir, "config.json"), "{not-json", "utf8");

    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);

    expect(service.getResponse()).toMatchObject({
      values: {
        global: { aiControlEnabled: true, voiceCommandsEnabled: true, microphoneEnabled: true, themeId: "cloudx-neon", uiScale: 100 },
        plugins: { "file-browser": { showGitDiff: true, gitAutoRefresh: true, gitAutoRefreshSeconds: 15 } }
      }
    });
  });

  it("rejects symlinked config data directories before writes can escape", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-dir-link-"));
    const dataDir = path.join(root, ".cloudx");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-outside-"));
    const service = new ConfigService(dataDir, () => [fileBrowserDescriptor()]);
    await fs.symlink(outside, dataDir, "dir");

    await expect(service.update({ global: { aiControlEnabled: false } })).rejects.toThrow("symbolic link");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("rejects symlinked config files before reading external state", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-file-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-file-outside-"));
    const outsideFile = path.join(outside, "config.json");
    await fs.writeFile(outsideFile, JSON.stringify({ global: { aiControlEnabled: false } }), "utf8");
    await fs.symlink(outsideFile, path.join(dataDir, "config.json"));

    expect(() => new ConfigService(dataDir, () => [fileBrowserDescriptor()])).toThrow("symbolic link");
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

function internalConfigDescriptor(): PluginDescriptor {
  return {
    id: "internal-config",
    acronym: "IC",
    displayName: "Internal Config",
    description: "Internal Config",
    panelKind: "placeholder",
    creatable: false,
    requiresDirectory: false,
    actions: [],
    configFields: [
      {
        key: "skillIds",
        label: "Skill IDs",
        type: "string",
        visibility: "internal",
        defaultValue: "metadata,visuals"
      }
    ]
  };
}

function secretConfigDescriptor(): PluginDescriptor {
  return {
    id: "jira",
    acronym: "JIR",
    displayName: "Jira",
    description: "Jira",
    panelKind: "placeholder",
    creatable: true,
    requiresDirectory: false,
    actions: [],
    configFields: [
      {
        key: "siteUrl",
        label: "Site URL",
        type: "string",
        defaultValue: ""
      },
      {
        key: "apiToken",
        label: "API token",
        type: "secret",
        defaultValue: ""
      }
    ]
  };
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { InstalledPluginService, normalizeGithubRepositoryUrl, type PluginGitClient } from "./InstalledPluginService.js";

describe("InstalledPluginService", () => {
  it("normalizes HTTPS GitHub repository URLs", () => {
    expect(normalizeGithubRepositoryUrl("https://github.com/CloudX/demo-plugin.git")).toMatchObject({
      type: "github",
      url: "https://github.com/CloudX/demo-plugin",
      cloneUrl: "https://github.com/CloudX/demo-plugin.git",
      owner: "CloudX",
      repo: "demo-plugin"
    });
  });

  it("rejects non-GitHub and credential-bearing URLs", () => {
    expect(() => normalizeGithubRepositoryUrl("https://gitlab.com/cloudx/plugin")).toThrow("https://github.com");
    expect(() => normalizeGithubRepositoryUrl("https://token@github.com/cloudx/plugin")).toThrow("must not include embedded credentials");
    expect(() => normalizeGithubRepositoryUrl("git@github.com:cloudx/plugin.git")).toThrow("valid https://github.com");
  });

  it("clones, validates, persists, and exposes a manifest plugin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-installed-plugin-"));
    const fixture = await pluginFixture("github-demo", "GHD");
    const service = new InstalledPluginService(root, { git: fakeGit(fixture, "abc123") });

    const result = await service.installFromGithub("https://github.com/cloudx/github-demo", new Set());

    expect(result.record).toMatchObject({
      id: "github-demo",
      enabled: true,
      commit: "abc123",
      source: { cloneUrl: "https://github.com/cloudx/github-demo.git" },
      manifest: { displayName: "GitHub Demo" }
    });
    expect(result.plugin.descriptor()).toMatchObject({
      id: "github-demo",
      panelKind: "placeholder",
      creatable: false,
      requiresDirectory: false
    });
    expect(new InstalledPluginService(root, { git: fakeGit(fixture) }).pluginsFromCatalog()[0]?.descriptor().id).toBe("github-demo");
  });

  it("rejects invalid manifests before persisting the plugin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-installed-plugin-invalid-"));
    const fixture = await pluginFixture("Bad_ID", "BAD");
    const service = new InstalledPluginService(root, { git: fakeGit(fixture) });

    await expect(service.installFromGithub("https://github.com/cloudx/bad-plugin", new Set())).rejects.toThrow("metadata.id");
    await expect(fs.access(path.join(root, "installed-plugins.json"))).rejects.toThrow();
  });

  it("rejects duplicate installed plugin ids", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-installed-plugin-duplicate-"));
    const fixture = await pluginFixture("github-demo", "GHD");
    const service = new InstalledPluginService(root, { git: fakeGit(fixture) });

    await service.installFromGithub("https://github.com/cloudx/github-demo", new Set());
    await expect(service.installFromGithub("https://github.com/cloudx/github-demo-copy", new Set())).rejects.toThrow("Plugin already registered: github-demo");
  });
});

async function pluginFixture(id: string, acronym: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-fixture-"));
  await fs.mkdir(path.join(root, ".cloudx-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".cloudx-plugin/plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      acronym,
      displayName: "GitHub Demo",
      description: "Demo plugin installed from GitHub metadata."
    }, null, 2),
    "utf8"
  );
  return root;
}

function fakeGit(fixture: string, commit = "deadbeef"): PluginGitClient {
  return {
    async lsRemote() {
      return undefined;
    },
    async clone(_url, directory) {
      await fs.cp(fixture, directory, { recursive: true });
    },
    async revParseHead() {
      return commit;
    }
  };
}

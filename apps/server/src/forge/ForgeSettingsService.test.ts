import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import { ConfigService } from "../configService.js";
import { ForgePlugin } from "../plugins/ForgePlugin.js";
import type { ForgeCredential } from "./providers/ForgeCredentials.js";
import {
  ForgeSettingsService,
  forgeConfigFields,
} from "./ForgeSettingsService.js";

const roots: string[] = [];
const repository: ForgeRepository = {
  provider: "github",
  apiUrl: "https://api.github.com",
  projectPath: "org/repo",
};

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-settings-"));
  roots.push(root);
  const plugin = new ForgePlugin(() => {
    throw new Error("Workflow actions are not part of this settings fixture.");
  });
  const config = new ConfigService(root, () => [plugin.descriptor()]);
  const credentials = new Map<ForgeCredentialRole, ForgeCredential>();
  const connections = {
    credential: vi.fn(
      (
        _repository: ForgeRepository,
        role: ForgeCredentialRole,
      ): ForgeCredential => {
        const credential = credentials.get(role);
        if (!credential)
          throw new Error(`Connect the ${role} application in Forge settings.`);
        return credential;
      },
    ),
  };
  const settings = new ForgeSettingsService(config, connections);
  await config.update({
    plugins: {
      forge: {
        projectPath: repository.projectPath,
        workerTemplateId: "worker",
        reviewTemplateId: "review",
      },
    },
  });
  return { config, connections, credentials, settings };
}

describe("Forge settings field contracts", () => {
  it("uses connected applications instead of local checkout and manual credential fields", async () => {
    const { config } = await fixture();
    const fields = forgeConfigFields();
    expect(fields.some((field) => field.type === "secret")).toBe(false);
    for (const key of [
      "repositoryPath",
      "workerToken",
      "reviewerToken",
      "workerPrivateKey",
      "reviewerPrivateKey",
      "workerAppId",
      "reviewerAppId",
      "workerInstallationId",
      "reviewerInstallationId",
    ]) {
      expect(fields.map((field) => field.key)).not.toContain(key);
      await expect(
        config.update({ plugins: { forge: { [key]: "obsolete-setting" } } }),
      ).rejects.toThrow("Unknown config key");
    }
  });

  it("offers Rules / Skills template choices while persisting string identifiers", () => {
    const fields = forgeConfigFields();
    for (const key of ["workerTemplateId", "reviewTemplateId"]) {
      expect(fields.find((field) => field.key === key)).toMatchObject({
        type: "string",
        defaultValue: "",
        optionSource: "rulesSkills.templates",
      });
    }
  });
});

describe("Forge connected application settings", () => {
  it("persists trust only for the explicitly approved repository and current provider settings", async () => {
    const { config, settings } = await fixture();
    expect(settings.isRepositoryTrusted(repository)).toBe(false);
    const trustedRepository = JSON.stringify([repository.provider, repository.apiUrl, repository.projectPath]);
    await config.update({ plugins: { forge: { trustedRepository } } });
    expect(settings.isRepositoryTrusted(repository)).toBe(true);
    for (const other of [
      { ...repository, provider: "gitlab" as const },
      { ...repository, apiUrl: "https://github.example/api/v3" },
      { ...repository, projectPath: "org/other" },
    ]) expect(settings.isRepositoryTrusted(other)).toBe(false);
    await config.update({ plugins: { forge: { projectPath: "org/other" } } });
    expect(settings.isRepositoryTrusted(repository)).toBe(false);
    await config.update({ plugins: { forge: { projectPath: repository.projectPath } } });
    expect(settings.isRepositoryTrusted(repository)).toBe(true);
    await config.update({ plugins: { forge: { trustedRepository: "" } } });
    expect(settings.isRepositoryTrusted(repository)).toBe(false);
  });

  it("allows repository setup before connecting and requires both identities before starting work", async () => {
    const { settings, connections, credentials } = await fixture();
    expect(settings.repository()).toEqual(repository);
    expect(connections.credential).not.toHaveBeenCalled();
    expect(() => settings.settings()).toThrow("Connect the worker application");
    credentials.set("worker", { kind: "token", token: "worker-private" });
    expect(() => settings.settings()).toThrow(
      "Connect the reviewer application",
    );
    credentials.set("reviewer", { kind: "token", token: "reviewer-private" });
    expect(settings.settings()).toEqual({
      repository,
      baseBranch: "main",
      workerTemplateId: "worker",
      reviewTemplateId: "review",
      maxRunMinutes: 180,
    });
    expect(connections.credential).toHaveBeenCalledWith(repository, "worker");
    expect(connections.credential).toHaveBeenCalledWith(repository, "reviewer");
  });

  it("uses the requested connection for Git access without exposing its credential in public config", async () => {
    const { settings, connections, credentials, config } = await fixture();
    credentials.set("reviewer", { kind: "token", token: "reviewer-private" });
    const access = await settings.gitAccess(repository, "reviewer");
    expect(access).toEqual({
      cloneUrl: "https://github.com/org/repo.git",
      authorization: `Basic ${Buffer.from("x-access-token:reviewer-private").toString("base64")}`,
    });
    expect(connections.credential).toHaveBeenCalledExactlyOnceWith(
      repository,
      "reviewer",
    );
    expect(JSON.stringify(config.getResponse())).not.toContain(
      "reviewer-private",
    );
    expect(JSON.stringify(config.getValues())).not.toContain("repositoryPath");
  });

  it("rejects canceled access and workers from a different repository before reading a credential", async () => {
    const { settings, connections } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("worker canceled"));
    await expect(
      settings.gitAccess(repository, "worker", controller.signal),
    ).rejects.toThrow("worker canceled");
    const other = { ...repository, projectPath: "org/other" };
    expect(() => settings.provider(other, "worker")).toThrow(
      "different repository",
    );
    expect(() => settings.gitAccess(other, "reviewer")).toThrow(
      "different repository",
    );
    expect(connections.credential).not.toHaveBeenCalled();
  });
});

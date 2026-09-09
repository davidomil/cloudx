import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import { ConfigService } from "../configService.js";
import { ForgePlugin } from "../plugins/ForgePlugin.js";
import type { ForgeCredential } from "./providers/ForgeCredentials.js";
import { ForgeProviderUnavailableError } from "./providers/ForgeProvider.js";
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
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const replacementKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const workerApp = { kind: "github-app" as const, appId: "app_1", installationId: "42", privateKey: appKey };

async function applicationFixture() {
  const f = await fixture();
  f.credentials.set("worker", workerApp);
  f.credentials.set("reviewer", { ...workerApp, appId: "app_2", installationId: "43" });
  const exchanges: { url: string; body: unknown }[] = [];
  const authorizations: string[] = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url).endsWith("/access_tokens")) {
      exchanges.push({ url: String(url), body: JSON.parse(String(options?.body)) });
      return Response.json({ token: "installation-" + exchanges.length, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    authorizations.push(new Headers(options?.headers).get("authorization")!);
    return Response.json({ items: [], incomplete_results: false });
  });
  return { ...f, exchanges, authorizations, fetcher };
}

describe("installation tokens across Forge provider acquisitions", () => {
  it("reuses each role's token for fresh providers and Git access", async () => {
    const f = await applicationFixture();
    await f.settings.provider(repository, "worker").listIssues();
    await f.settings.provider(repository, "worker").listChangeRequests();
    expect(await f.settings.gitAccess(repository, "worker")).toMatchObject({ authorization: "Basic " + Buffer.from("x-access-token:installation-1").toString("base64") });
    await f.settings.provider(repository, "reviewer").listIssues();
    await f.settings.provider(repository, "reviewer").listChangeRequests();
    expect(f.exchanges).toEqual([
      { url: "https://api.github.com/app/installations/42/access_tokens", body: { repositories: ["repo"] } },
      { url: "https://api.github.com/app/installations/43/access_tokens", body: { repositories: ["repo"] } },
    ]);
    expect(f.authorizations).toEqual(["Bearer installation-1", "Bearer installation-1", "Bearer installation-2", "Bearer installation-2"]);
    expect(JSON.stringify(f.config.getResponse())).not.toContain("installation-1");
    expect(JSON.stringify(f.config.getResponse())).not.toContain("PRIVATE KEY");
  });

  it.each([
    { name: "application", replacement: { appId: "app_3" } },
    { name: "installation", replacement: { installationId: "44" } },
    { name: "signing key", replacement: { privateKey: replacementKey } },
  ])("invalidates the token when the $name changes", async ({ replacement }) => {
    const f = await applicationFixture();
    await f.settings.provider(repository, "worker").listIssues();
    f.credentials.set("worker", { ...workerApp, ...replacement });
    await f.settings.provider(repository, "worker").listIssues();
    await f.settings.provider(repository, "worker").listIssues();
    expect(f.exchanges).toHaveLength(2);
    expect(f.authorizations).toEqual(["Bearer installation-1", "Bearer installation-2", "Bearer installation-2"]);
  });

  it.each(["disconnect", "static token"])("discards prior application authorization after %s", async change => {
    const f = await applicationFixture();
    await f.settings.provider(repository, "worker").listIssues();
    if (change === "disconnect") {
      f.credentials.delete("worker");
      await expect(f.settings.provider(repository, "worker").listIssues()).rejects.toThrow("Connect the worker");
    } else {
      f.credentials.set("worker", { kind: "token", token: "replacement-static-token" });
      await f.settings.provider(repository, "worker").listIssues();
      expect(f.authorizations.at(-1)).toBe("Bearer replacement-static-token");
    }
    f.credentials.set("worker", workerApp);
    await f.settings.provider(repository, "worker").listIssues();
    expect(f.exchanges).toHaveLength(2);
    expect(f.authorizations.at(-1)).toBe("Bearer installation-2");
  });

  it.each([
    { name: "project", next: { ...repository, projectPath: "org/other" } },
    { name: "API host", next: { ...repository, apiUrl: "https://github.example/api/v3" } },
    { name: "provider", next: { ...repository, provider: "gitlab" as const, apiUrl: "https://gitlab.example/api/v4" } },
  ])("keeps cached authorization within the selected $name identity", async ({ next }) => {
    const f = await applicationFixture();
    await f.settings.provider(repository, "worker").listIssues();
    await f.config.update({ plugins: { forge: next } });
    if (next.provider === "gitlab") f.credentials.set("worker", { kind: "token", token: "gitlab-private" });
    await f.settings.gitAccess(next, "worker");
    await f.config.update({ plugins: { forge: { ...repository } } });
    f.credentials.set("worker", workerApp);
    await f.settings.provider(repository, "worker").listIssues();
    expect(f.exchanges).toHaveLength(next.provider === "gitlab" ? 2 : 3);
    expect(f.authorizations.at(-1)).toBe("Bearer installation-" + f.exchanges.length);
  });

  it("does not share a caller's cancelled token exchange with a different provider acquisition", async () => {
    const f = await fixture();
    f.credentials.set("worker", workerApp);
    const paused = new AbortController();
    let notifyBothStarted!: () => void;
    const bothStarted = new Promise<void>(resolve => { notifyBothStarted = resolve; });
    const exchanges: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      if (!String(url).endsWith("/access_tokens")) return Response.json({ items: [], incomplete_results: false });
      return new Promise<Response>((resolve, reject) => {
        const signal = options!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        exchanges.push({ signal, resolve });
        if (exchanges.length === 2) notifyBothStarted();
        if (exchanges.length > 2) resolve(Response.json({ token: "extra-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
      });
    });
    const first = f.settings.provider(repository, "worker", paused.signal).listIssues().catch(error => error);
    const second = f.settings.provider(repository, "worker").listIssues();
    await bothStarted;
    paused.abort(new Error("private cancellation context"));
    const error = await first;
    exchanges[1].resolve(Response.json({ token: "surviving-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
    await second;
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ failure: "cancelled" });
    expect(error.message).not.toContain("private cancellation context");
    expect(exchanges[1].signal.aborted).toBe(false);
    await f.settings.provider(repository, "worker").listIssues();
    expect(exchanges).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
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
    workerAuthors: vi.fn(() => ["app/cloudx-worker", "app/cloudx-reviewer"]),
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
  it("saves independent coding and review model choices and rejects invalid selections", async () => {
    const { config, settings, credentials } = await fixture();
    credentials.set("worker", { kind: "token", token: "worker-private" });
    credentials.set("reviewer", { kind: "token", token: "reviewer-private" });
    expect(settings.settings()).toMatchObject({ workerModel: "gpt-6-astra", workerReasoningEffort: "xhigh", reviewModel: "gpt-6-astra", reviewReasoningEffort: "max" });
    const selected = { workerModel: "gpt-5.6-sol", workerReasoningEffort: "high", reviewModel: "gpt-5.6-terra", reviewReasoningEffort: "ultra" };
    await config.update({ plugins: { forge: selected } });
    expect(settings.settings()).toMatchObject(selected);
    for (const field of ["workerModel", "reviewModel", "workerReasoningEffort", "reviewReasoningEffort"]) {
      await expect(config.update({ plugins: { forge: { [field]: "unknown" } } })).rejects.toThrow(/configured options/);
      expect(settings.settings()).toMatchObject(selected);
    }
  });

  it("uses the saved human username and registered bot authors in provider searches", async () => {
    const { config, settings, credentials, connections } = await fixture();
    credentials.set("worker", { kind: "token", token: "worker-private" });
    const requests: URL[] = [];
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      requests.push(new URL(String(input)));
      return Response.json({ items: [], incomplete_results: false });
    });
    try {
      const provider = settings.provider(repository, "worker");
      await provider.listIssues();
      expect(connections.workerAuthors).not.toHaveBeenCalled();
      await expect(provider.listIssues({ scope: "created_by_me" })).rejects.toThrow(/username/i);
      await config.update({ plugins: { forge: { username: "alice" } } });
      await provider.listIssues({ scope: "assigned_to_me", filter: "is:open label:bug" });
      expect(requests.at(-1)!.searchParams.get("q")).toContain("assignee:alice");
      expect(requests.at(-1)!.searchParams.get("q")).toContain("is:open label:bug");
      await provider.listChangeRequests({ scope: "created_by_me" });
      expect(requests.at(-1)!.searchParams.get("q")).toContain("author:alice");
      await provider.listChangeRequests({ scope: "created_by_workers" });
      expect(requests.at(-1)!.searchParams.get("q")).toContain("author:app/cloudx-worker OR author:app/cloudx-reviewer");
      expect(connections.workerAuthors).toHaveBeenCalledWith(repository);
      expect(requests.some(url => url.searchParams.get("q")?.includes("@me"))).toBe(false);
    } finally {
      fetcher.mockRestore();
    }
  });

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
      workerModel: "gpt-6-astra",
      workerReasoningEffort: "xhigh",
      reviewModel: "gpt-6-astra",
      reviewReasoningEffort: "max",
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
    ).rejects.toMatchObject({ name: "ForgeProviderUnavailableError", failure: "cancelled" });
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

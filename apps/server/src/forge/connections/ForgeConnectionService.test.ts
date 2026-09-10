import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import { ForgeConnectionService } from "./ForgeConnectionService.js";
import { ForgeConnectionStore, connectionKey } from "./ForgeConnectionStore.js";
import { ForgeRegistrationClient } from "./ForgeRegistrationClient.js";
import { registerForgeConnectionRoutes } from "./ForgeConnectionRoutes.js";
import { ForgeProviderError } from "../providers/ForgeProvider.js";

const github: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "team/project" };
const gitlab: ForgeRepository = { provider: "gitlab", apiUrl: "https://gitlab.com/api/v4", projectPath: "team/project" };
const origin = "http://localhost:5173";
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(repository = github) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-connections-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ForgeConnectionStore(root);
  const clock = { now: Date.parse("2030-01-01"), repository };
  const manifest = new ForgeRegistrationClient();
  const registration = {
    githubManifest: vi.fn(manifest.githubManifest.bind(manifest)),
    githubConvert: vi.fn(async (_repository: ForgeRepository, code: string, _signal?: AbortSignal) =>
      ({ appId: code === "worker" ? "11" : "12", privateKey: "private-" + code, slug: "cloudx-" + code, name: "CloudX " + code })),
    githubInstallation: vi.fn(async (_repository: ForgeRepository, _app: { appId: string; privateKey: string }, id: string, _role: ForgeCredentialRole, _signal?: AbortSignal) => ({ installationId: id })),
    gitlabCheckSetup: vi.fn(async (_repository: ForgeRepository, _token: string, _signal?: AbortSignal) => {}),
    gitlabCreateAccount: vi.fn(async (_repository: ForgeRepository, role: ForgeCredentialRole, _token: string, _signal?: AbortSignal) =>
      ({ id: role === "worker" ? "21" : "22", name: "CloudX " + role, username: "cloudx_" + role })),
    gitlabGrantAccess: vi.fn(async (_repository: ForgeRepository, _role: ForgeCredentialRole, _id: string, _token: string, _signal?: AbortSignal) => {}),
    gitlabCreateToken: vi.fn(async (_repository: ForgeRepository, role: ForgeCredentialRole, id: string, _token: string, _signal?: AbortSignal) =>
      ({ id: role === "worker" ? "31" : "32", userId: id, token: "bot-secret-" + role, expiresAt: role === "worker" ? "2031-01-01" : "2032-01-01" })),
  };
  function service() {
    const instance = new ForgeConnectionService({ repository: () => clock.repository, store, registration, now: () => clock.now });
    cleanup.push(() => instance.dispose());
    return instance;
  }
  const connections = service();
  async function begin(role: ForgeCredentialRole = "worker") {
    const result = await connections.beginGitHub(clock.repository, role, origin);
    const state = new URL(result.action.url).searchParams.get("state")!;
    const cookie = result.cookie.split(";")[0]!.split("=")[1]!;
    return { ...result, state, cookie };
  }
  return { root, store, clock, registration, connections, service, begin };
}

describe("GitHub application connection lifecycle", () => {
  it("validates callback settings before persisting a registration", async () => {
    const f = await fixture();
    await expect(f.connections.beginGitHub(github, "worker", "http://cloudx.example")).rejects.toThrow("HTTPS");
    expect(f.store.read()).toEqual({});
  });

  it("registers and verifies independent applications without exposing issued keys", async () => {
    const f = await fixture();
    expect(f.connections.workerAuthors(github)).toEqual([]);
    for (const role of ["worker", "reviewer"] as const) {
      const start = await f.begin(role);
      expect(start.action.method).toBe("POST");
      expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(start.cookie).not.toBe(start.state);
      expect(JSON.parse(start.action.fields!.manifest!)).toMatchObject({
        redirect_url: origin + "/api/forge/connections/github/manifest",
        setup_url: origin + "/api/forge/connections/github/installation",
        default_permissions: { contents: role === "worker" ? "write" : "read", pull_requests: "write" },
      });
      expect(f.connections.status().roles.find(item => item.role === role)?.state).toBe("registering");
      const installUrl = await f.connections.completeGitHubManifest(start.state, role, start.cookie, [origin]);
      expect(f.connections.workerAuthors(github)).not.toContain(`app/cloudx-${role}`);
      expect(installUrl).toBe("https://github.com/apps/cloudx-" + role + "/installations/new?state=" + start.state);
      expect(() => f.connections.credential(github, role)).toThrow("Connect");
      await f.connections.completeGitHubInstallation(start.state, role === "worker" ? "41" : "42", start.cookie, [origin]);
      expect(f.connections.credential(github, role)).toMatchObject({ kind: "github-app", privateKey: "private-" + role });
      expect(f.store.read()[connectionKey(github, role)]?.attempt).toBeUndefined();
      await expect(f.connections.completeGitHubInstallation(start.state, "41", start.cookie, [origin])).rejects.toThrow("already used");
      await expect(f.connections.beginGitHub(github, role, origin)).rejects.toThrow("already connected");
    }
    expect(f.connections.status().roles.map(item => item.state)).toEqual(["connected", "connected"]);
    expect(f.connections.workerAuthors(github)).toEqual(["app/cloudx-worker", "app/cloudx-reviewer"]);
    for (const other of [gitlab, { ...github, projectPath: "team/other" }, { ...github, apiUrl: "https://github.example/api/v3" }])
      expect(f.connections.workerAuthors(other)).toEqual([]);
    expect(JSON.stringify(f.connections.status())).not.toMatch(/private-|cookieHash|installationId/);
    expect(f.registration.githubConvert).toHaveBeenCalledTimes(2);
    expect(f.registration.githubInstallation).toHaveBeenCalledTimes(2);
  });

  it.each(["cookie", "missing-cookie", "state", "trusted-origin", "expired", "changed-repository", "wrong-phase"])(
    "rejects %s before contacting GitHub", async problem => {
      const f = await fixture();
      const start = await f.begin();
      if (problem === "expired") f.clock.now += 3_600_000;
      if (problem === "changed-repository") f.clock.repository = { ...github, projectPath: "another/project" };
      const state = problem === "state" ? "A".repeat(43) : start.state;
      const cookie = problem === "cookie" ? "different-browser" : problem === "missing-cookie" ? undefined : start.cookie;
      const trusted = problem === "trusted-origin" ? ["https://another.local"] : [origin];
      const callback = problem === "wrong-phase"
        ? f.connections.completeGitHubInstallation(state, "41", cookie, trusted)
        : f.connections.completeGitHubManifest(state, "worker", cookie, trusted);
      await expect(callback).rejects.toThrow();
      expect(f.registration.githubConvert).not.toHaveBeenCalled();
      expect(f.registration.githubInstallation).not.toHaveBeenCalled();
    },
  );

  it("continues after restart using the same app registration and a replacement browser cookie", async () => {
    const f = await fixture();
    const old = await f.begin();
    await f.connections.dispose();
    const restarted = f.service();
    const resumed = await restarted.beginGitHub(github, "worker", origin);
    expect(new URL(resumed.action.url).searchParams.get("state")).toBe(old.state);
    const cookie = resumed.cookie.split(";")[0]!.split("=")[1]!;
    expect(cookie).not.toBe(old.cookie);
    await expect(restarted.completeGitHubManifest(old.state, "worker", old.cookie, [origin])).rejects.toThrow("another browser");
    await restarted.completeGitHubManifest(old.state, "worker", cookie, [origin]);
    await expect(restarted.beginGitHub(github, "worker", "https://cloudx.local")).rejects.toThrow(origin);
    const install = await restarted.beginGitHub(github, "worker", origin);
    expect(install.action).toEqual({ method: "GET", url: "https://github.com/apps/cloudx-worker/installations/new?state=" + old.state });
    expect(f.registration.githubConvert).toHaveBeenCalledTimes(1);
  });

  it("retains the registered app when installation verification fails, then allows explicit continuation", async () => {
    const f = await fixture();
    const start = await f.begin();
    await f.connections.completeGitHubManifest(start.state, "worker", start.cookie, [origin]);
    f.registration.githubInstallation.mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.connections.completeGitHubInstallation(start.state, "41", start.cookie, [origin])).rejects.toThrow("unavailable");
    expect(f.connections.status().roles[0]).toMatchObject({ state: "installing", message: expect.stringContaining("configured repository") });
    const continued = await f.begin();
    await f.connections.completeGitHubInstallation(continued.state, "41", continued.cookie, [origin]);
    expect(f.connections.status().roles[0]).toMatchObject({ state: "connected", message: undefined });
    expect(f.registration.githubConvert).toHaveBeenCalledTimes(1);
  });

  it("persists a mutation before sending it and never repeats an uncertain conversion", async () => {
    const f = await fixture();
    const start = await f.begin();
    f.registration.githubConvert.mockImplementationOnce(async () => {
      expect(f.store.read()[connectionKey(github, "worker")]?.phase).toBe("converting");
      throw new Error("private-response-data");
    });
    await expect(f.connections.completeGitHubManifest(start.state, "worker", start.cookie, [origin])).rejects.toThrow();
    expect(f.connections.status().roles[0]?.state).toBe("failed");
    expect(JSON.stringify(f.connections.status())).not.toContain("private-response-data");
    await expect(f.connections.beginGitHub(github, "worker", origin)).rejects.toThrow("may have created");
    expect(f.registration.githubConvert).toHaveBeenCalledTimes(1);
  });

  it("uses the enterprise installation URL and secure cookies for an HTTPS browser", async () => {
    const repository: ForgeRepository = { ...github, apiUrl: "https://github.example/api/v3" };
    const f = await fixture(repository);
    const start = await f.connections.beginGitHub(repository, "worker", "https://cloudx.local");
    expect(start.cookie).toContain("; Secure");
    const state = new URL(start.action.url).searchParams.get("state")!;
    const cookie = start.cookie.split(";")[0]!.split("=")[1]!;
    expect(await f.connections.completeGitHubManifest(state, "worker", cookie, ["https://cloudx.local"]))
      .toBe("https://github.example/github-apps/cloudx-worker/installations/new?state=" + state);
  });
});

describe("GitLab automatic bot provisioning", () => {
  it("creates, grants and tokens both identities in order, retaining only issued bot credentials", async () => {
    const f = await fixture(gitlab);
    const order: string[] = [];
    f.registration.gitlabCreateAccount.mockImplementation(async (_repository, role, token) => {
      expect(token).toBe("one-time-setup-secret");
      expect(f.store.read()[connectionKey(gitlab, role)]?.phase).toBe("creating_account");
      order.push(role + ":create");
      return { id: role === "worker" ? "21" : "22", username: role, name: role };
    });
    f.registration.gitlabGrantAccess.mockImplementation(async (_repository, role, id) => {
      expect(f.store.read()[connectionKey(gitlab, role)]).toMatchObject({ phase: "granting_access", account: { id } });
      order.push(role + ":grant");
    });
    f.registration.gitlabCreateToken.mockImplementation(async (_repository, role, id) => {
      expect(f.store.read()[connectionKey(gitlab, role)]?.phase).toBe("creating_token");
      order.push(role + ":token");
      return { id: role === "worker" ? "31" : "32", userId: id, token: "issued-" + role, expiresAt: "2031-01-01" };
    });
    const result = await f.connections.provisionGitLab(gitlab, "one-time-setup-secret");
    expect(order).toEqual(["worker:create", "worker:grant", "worker:token", "reviewer:create", "reviewer:grant", "reviewer:token"]);
    expect(result.roles.map(item => item.state)).toEqual(["connected", "connected"]);
    expect(f.connections.workerAuthors(gitlab)).toEqual(["worker", "reviewer"]);
    f.clock.now = Date.parse("2032-01-01");
    expect(f.connections.workerAuthors(gitlab)).toEqual(["worker", "reviewer"]);
    f.clock.now = Date.parse("2030-01-01");
    expect(f.connections.credential(gitlab, "worker")).toEqual({ kind: "token", token: "issued-worker" });
    expect(f.connections.credential(gitlab, "reviewer")).toEqual({ kind: "token", token: "issued-reviewer" });
    expect(JSON.stringify(result)).not.toMatch(/one-time-setup-secret|issued-|tokenId/);
    const saved = await fs.readFile(path.join(f.root, "secrets/config-secrets.json"), "utf8");
    expect(saved).toContain("issued-worker");
    expect(saved).not.toContain("one-time-setup-secret");
    await f.connections.provisionGitLab(gitlab, "another-token");
    expect(f.registration.gitlabCreateAccount).toHaveBeenCalledTimes(2);
  });

  it.each(["", " ", "a b", "a\nb", "x".repeat(4097)])("rejects malformed setup input before storing or provisioning", async token => {
    const f = await fixture(gitlab);
    await expect(f.connections.provisionGitLab(gitlab, token)).rejects.toThrow("setup token");
    expect(f.store.read()).toEqual({});
    expect(f.registration.gitlabCreateAccount).not.toHaveBeenCalled();
  });

  it("lets a rejected setup token be corrected before any bot is created", async () => {
    const f = await fixture(gitlab);
    f.registration.gitlabCheckSetup.mockRejectedValueOnce(new Error("GitLab setup access denied."));
    await expect(f.connections.provisionGitLab(gitlab, "rejected-token")).rejects.toThrow("access denied");
    expect(f.store.read()).toEqual({});
    expect(f.registration.gitlabCreateAccount).not.toHaveBeenCalled();
    expect(f.connections.status().roles.map(role => role.state)).toEqual(["disconnected", "disconnected"]);
    await f.connections.provisionGitLab(gitlab, "corrected-token");
    expect(f.registration.gitlabCheckSetup).toHaveBeenCalledTimes(2);
    expect(f.registration.gitlabCreateAccount).toHaveBeenCalledTimes(2);
  });

  it("keeps the first connected bot and preserves the second account after a partial failure", async () => {
    const f = await fixture(gitlab);
    f.registration.gitlabGrantAccess.mockImplementation(async (_repository, role) => {
      if (role === "reviewer") throw new Error("one-time-setup-secret echoed by transport");
    });
    await expect(f.connections.provisionGitLab(gitlab, "one-time-setup-secret")).rejects.toThrow("account 22");
    expect(f.connections.status().roles.map(item => item.state)).toEqual(["connected", "failed"]);
    expect(f.connections.credential(gitlab, "worker")).toMatchObject({ token: "bot-secret-worker" });
    expect(JSON.stringify(f.store.read())).not.toContain("one-time-setup-secret");
    await expect(f.connections.provisionGitLab(gitlab, "new-setup-secret")).rejects.toThrow("Inspect GitLab");
    expect(f.registration.gitlabCreateAccount).toHaveBeenCalledTimes(2);
    expect(f.registration.gitlabCreateToken).toHaveBeenCalledTimes(1);
  });

  it("rejects a token belonging to a different bot", async () => {
    const f = await fixture(gitlab);
    f.registration.gitlabCreateToken.mockResolvedValueOnce({ id: "31", userId: "999", token: "wrong-bot-secret", expiresAt: "2031-01-01" });
    await expect(f.connections.provisionGitLab(gitlab, "setup")).rejects.toThrow("did not finish");
    expect(JSON.stringify(f.store.read())).not.toContain("wrong-bot-secret");
    expect(() => f.connections.credential(gitlab, "worker")).toThrow("Connect");
  });

  it("renews expired access on the same account without recreating bots or changing an active reviewer", async () => {
    const f = await fixture(gitlab);
    await f.connections.provisionGitLab(gitlab, "setup");
    f.clock.now = Date.parse("2031-02-01");
    expect(f.connections.status().roles.map(item => item.state)).toEqual(["expired", "connected"]);
    expect(() => f.connections.credential(gitlab, "worker")).toThrow("expired");
    f.registration.gitlabCreateToken.mockResolvedValueOnce({ id: "33", userId: "21", token: "renewed-worker", expiresAt: "2032-01-01" });
    const result = await f.connections.provisionGitLab(gitlab, "renew-setup");
    expect(result.roles.map(item => item.state)).toEqual(["connected", "connected"]);
    expect(f.registration.gitlabCreateAccount).toHaveBeenCalledTimes(2);
    expect(f.registration.gitlabGrantAccess).toHaveBeenCalledTimes(2);
    expect(f.registration.gitlabCreateToken).toHaveBeenLastCalledWith(gitlab, "worker", "21", "renew-setup", expect.any(AbortSignal));
    expect(f.connections.credential(gitlab, "reviewer")).toMatchObject({ token: "bot-secret-reviewer" });
    expect(f.connections.credential(gitlab, "worker")).toMatchObject({ token: "renewed-worker" });
  });

  it("aborts pending registration before disposal resolves and rejects queued setup", async () => {
    const f = await fixture(gitlab);
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    f.registration.gitlabCreateAccount.mockImplementation(async (_repository, _role, _token, signal) => {
      started();
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    const setup = f.connections.provisionGitLab(gitlab, "setup").catch(error => error);
    await pending;
    const queued = f.connections.provisionGitLab(gitlab, "queued").catch(error => error);
    await f.connections.dispose();
    expect(await setup).toBeInstanceOf(Error);
    expect((await queued).message).toContain("shutting down");
    expect(f.store.read()[connectionKey(gitlab, "worker")]?.phase).toBe("failed");
    expect(f.registration.gitlabCreateAccount).toHaveBeenCalledTimes(1);
  });
});

describe("Forge connection HTTP routes", () => {
  async function server(repository = github) {
    const f = await fixture(repository);
    const app = Fastify({ logger: false });
    registerForgeConnectionRoutes(app, f.connections, [origin, "http://localhost:3001"]);
    cleanup.push(() => app.close());
    return { ...f, app };
  }

  it("completes a real state/cookie flow through a proxy that rewrites Host", async () => {
    const f = await server();
    const start = await f.app.inject({ method: "POST", url: "/api/forge/connections/github/start", headers: { host: "localhost:3001", origin }, payload: { repository: github, role: "worker" } });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().url).searchParams.get("state")!;
    const cookie = String(start.headers["set-cookie"]).split(";")[0]!;
    expect(start.headers["set-cookie"]).toContain("HttpOnly; SameSite=Lax");
    const converted = await f.app.inject({ url: "/api/forge/connections/github/manifest?state=" + state + "&code=worker", headers: { host: "localhost:3001", cookie } });
    expect(converted.statusCode).toBe(302);
    expect(converted.headers.location).toContain("/apps/cloudx-worker/installations/new");
    const installed = await f.app.inject({ url: "/api/forge/connections/github/installation?state=" + state + "&installation_id=41&setup_action=install", headers: { host: "localhost:3001", cookie } });
    expect(installed.statusCode).toBe(200);
    expect(installed.body).toContain("Application connected");
    expect(installed.headers["set-cookie"]).toContain("Max-Age=0");
    expect(installed.headers["referrer-policy"]).toBe("no-referrer");
    const status = await f.app.inject("/api/forge/connections");
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json().roles[0].state).toBe("connected");
    expect(status.body).not.toMatch(/private-worker|cookieHash/);
  });

  it("shows missing workflow access in browser status and connects the same app after the grant is approved", async () => {
    const f = await server();
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    f.registration.githubConvert.mockResolvedValueOnce({ appId: "11", privateKey, slug: "cloudx-worker", name: "CloudX worker" });
    const permissions: Record<string, string> = { contents: "write", issues: "write", pull_requests: "write" };
    const client = new ForgeRegistrationClient(async () => Response.json({ id: 41, app_id: 11, suspended_at: null, permissions }));
    f.registration.githubInstallation.mockImplementation(client.githubInstallation.bind(client));
    const start = await f.app.inject({ method: "POST", url: "/api/forge/connections/github/start", headers: { origin }, payload: { repository: github, role: "worker" } });
    const state = new URL(start.json().url).searchParams.get("state")!;
    const cookie = String(start.headers["set-cookie"]).split(";")[0]!;
    const converted = await f.app.inject({ url: `/api/forge/connections/github/manifest?state=${state}&code=worker`, headers: { cookie } });
    expect(converted.statusCode).toBe(302);
    const callback = { url: `/api/forge/connections/github/installation?state=${state}&installation_id=41`, headers: { cookie } };

    const rejected = await f.app.inject(callback);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).toContain("Return to CloudX Settings");
    const status = await f.app.inject("/api/forge/connections");
    expect(status.json().roles[0]).toMatchObject({
      state: "installing",
      message: "Grant the worker GitHub App Workflows: write permission, approve the updated permissions for its installation, then continue installation.",
    });
    expect(status.body).not.toMatch(/PRIVATE KEY|cookieHash/);
    expect(f.service().status().roles[0]?.message).toBe(status.json().roles[0].message);

    permissions.workflows = "write";
    expect((await f.app.inject(callback)).statusCode).toBe(200);
    const connected = await f.app.inject("/api/forge/connections");
    expect(connected.json().roles[0].state).toBe("connected");
    expect(connected.json().roles[0].message).toBeUndefined();
    expect(f.registration.githubConvert).toHaveBeenCalledTimes(1);
  });

  it("keeps arbitrary provider failures out of callback HTML and connection status", async () => {
    const f = await server();
    const start = await f.begin();
    const cookie = `cloudx_forge_${start.state}=${start.cookie}`;
    await f.app.inject({ url: `/api/forge/connections/github/manifest?state=${start.state}&code=worker`, headers: { cookie } });
    f.registration.githubInstallation.mockRejectedValueOnce(new ForgeProviderError("private-provider-response", 403));
    const rejected = await f.app.inject({ url: `/api/forge/connections/github/installation?state=${start.state}&installation_id=41`, headers: { cookie } });
    expect(rejected.statusCode).toBe(400);
    const status = await f.app.inject("/api/forge/connections");
    expect(status.json().roles[0]).toMatchObject({ state: "installing", message: "Install this app on the configured repository with its requested permissions, then continue installation." });
    expect(rejected.body + status.body).not.toContain("private-provider-response");
  });

  it.each([undefined, "https://untrusted.example"])("requires a trusted browser origin for setup writes", async untrusted => {
    const f = await server(gitlab);
    const headers = untrusted ? { origin: untrusted } : {};
    const result = await f.app.inject({ method: "POST", url: "/api/forge/connections/gitlab", headers, payload: { repository: gitlab, setupToken: "private-setup" } });
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain("private-setup");
    expect(f.registration.gitlabCreateAccount).not.toHaveBeenCalled();
  });

  it.each(["missing", "duplicate", "incorrect"])("rejects a %s callback cookie without returning callback values", async kind => {
    const f = await server();
    const start = await f.begin();
    const pair = start.cookie ? "cloudx_forge_" + start.state + "=" + start.cookie : "";
    const cookie = kind === "duplicate" ? pair + "; " + pair : kind === "incorrect" ? "cloudx_forge_" + start.state + "=incorrect" : "";
    const result = await f.app.inject({ url: "/api/forge/connections/github/manifest?state=" + start.state + "&code=private-callback-code", headers: { cookie } });
    expect(result.statusCode).toBe(400);
    expect(result.body).not.toContain("private-callback-code");
    expect(result.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(f.registration.githubConvert).not.toHaveBeenCalled();
  });

  it("returns only public bot status after one-time provisioning", async () => {
    const f = await server(gitlab);
    const result = await f.app.inject({ method: "POST", url: "/api/forge/connections/gitlab", headers: { origin }, payload: { repository: gitlab, setupToken: "private-setup" } });
    expect(result.statusCode).toBe(200);
    expect(result.json().roles.map((role: { state: string }) => role.state)).toEqual(["connected", "connected"]);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).not.toMatch(/private-setup|bot-secret|tokenId/);
  });
});

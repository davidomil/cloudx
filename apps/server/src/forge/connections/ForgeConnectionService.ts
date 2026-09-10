import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ForgeConnectionAction, ForgeConnections, ForgeConnectionStatus, ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import type { ForgeCredential } from "../providers/ForgeCredentials.js";
import { validateRepository } from "../providers/ForgeCredentials.js";
import { ForgeProviderError } from "../providers/ForgeProvider.js";
import { connectionKey, type ForgeConnectionRecords, type ForgeConnectionStore, type StoredForgeConnection } from "./ForgeConnectionStore.js";
import { GitHubInstallationPermissionError, type ForgeRegistrationClient } from "./ForgeRegistrationClient.js";

const roles = ["worker", "reviewer"] as const;
const registrationLifetime = 60 * 60_000;

interface Dependencies {
  repository(): ForgeRepository;
  store: Pick<ForgeConnectionStore, "read" | "write">;
  registration: Pick<ForgeRegistrationClient, "githubManifest" | "githubConvert" | "githubInstallation" | "gitlabCheckSetup" | "gitlabCreateAccount" | "gitlabGrantAccess" | "gitlabCreateToken">;
  now?: () => number;
}

export class ForgeConnectionService {
  private queue: Promise<unknown> = Promise.resolve();
  private operationActive = false;
  private disposed = false;
  private controller?: AbortController;
  constructor(private readonly deps: Dependencies) {}

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller?.abort(new Error("CloudX is shutting down."));
    await this.queue.catch(() => undefined);
  }

  status(): ForgeConnections {
    let repository: ForgeRepository;
    try { repository = this.deps.repository(); }
    catch (error) { return { configurationError: errorMessage(error), roles: roles.map(role => ({ role, state: "disconnected" })) }; }
    const records = this.deps.store.read();
    return { repository, roles: roles.map(role => this.publicConnection(role, records[connectionKey(repository, role)])) };
  }

  credential(repository: ForgeRepository, role: ForgeCredentialRole): ForgeCredential {
    const connection = this.deps.store.read()[connectionKey(repository, role)];
    if (connection?.phase !== "connected") throw new Error(`Connect the ${role} application in Forge settings.`);
    if (repository.provider === "github" && connection.app && connection.installationId)
      return { kind: "github-app", appId: connection.app.appId, privateKey: connection.app.privateKey, installationId: connection.installationId };
    if (repository.provider === "gitlab" && connection.token) {
      if (this.tokenExpired(connection)) throw new Error(`The ${role} GitLab bot token has expired. Renew its access in Forge settings before starting work.`);
      return { kind: "token", token: connection.token };
    }
    throw new Error("Forge application credentials are incomplete.");
  }

  workerAuthors(repository: ForgeRepository): string[] {
    const records = this.deps.store.read();
    return roles.flatMap(role => {
      const connection = records[connectionKey(repository, role)];
      if (connection?.phase !== "connected") return [];
      if (repository.provider === "github" && connection.app) return [`app/${connection.app.slug}`];
      if (repository.provider === "gitlab" && connection.account) return [connection.account.username];
      return [];
    });
  }

  beginGitHub(repository: ForgeRepository, role: ForgeCredentialRole, origin: string): Promise<{ action: ForgeConnectionAction; cookie: string }> {
    return this.exclusive(async () => {
      this.assertRepository(repository, "github");
      const records = this.deps.store.read();
      const key = connectionKey(repository, role);
      const connection = records[key] ?? { repository, role, phase: "registering" };
      if (connection.phase === "connected") throw new Error("This application is already connected.");
      if (!["registering", "installing"].includes(connection.phase)) throw new Error(connection.message ?? "A previous registration needs attention. Inspect the provider before registering another application.");
      if (connection.attempt && connection.attempt.origin !== origin) throw new Error(`Continue this application setup from ${connection.attempt.origin}, where its callback was registered.`);
      const cookie = randomBytes(32).toString("base64url");
      connection.attempt = {
        state: connection.attempt?.state ?? randomBytes(32).toString("base64url"),
        cookieHash: digest(cookie), origin,
        expiresAt: new Date(this.now() + registrationLifetime).toISOString(),
      };
      records[key] = connection;
      let action: ForgeConnectionAction;
      if (connection.app) {
        action = { method: "GET", url: this.installationUrl(connection) };
      } else {
        const registration = this.deps.registration.githubManifest(repository, role, { origin, state: connection.attempt.state });
        action = { method: "POST", url: registration.action, fields: { manifest: JSON.stringify(registration.manifest) } };
      }
      await this.deps.store.write(records);
      return { action, cookie: cookieHeader(connection.attempt.state, cookie, origin) };
    });
  }

  completeGitHubManifest(state: string, code: string, cookie: string | undefined, trustedOrigins: readonly string[]): Promise<string> {
    return this.exclusive(async () => {
      const { records, connection } = this.callback(state, cookie, trustedOrigins, "registering");
      connection.phase = "converting";
      await this.deps.store.write(records);
      try {
        connection.app = await this.deps.registration.githubConvert(connection.repository, code, this.controller?.signal);
        connection.name = connection.app.name;
        connection.phase = "installing";
        await this.deps.store.write(records);
        return this.installationUrl(connection);
      } catch (error) {
        await this.fail(records, connection, "Application registration could not finish. The provider may have created the app; inspect it before registering again.");
        throw error;
      }
    });
  }

  completeGitHubInstallation(state: string, installationId: string, cookie: string | undefined, trustedOrigins: readonly string[]): Promise<void> {
    return this.exclusive(async () => {
      const { records, connection } = this.callback(state, cookie, trustedOrigins, "installing");
      if (!connection.app) throw new Error("The application registration is incomplete.");
      connection.phase = "verifying";
      await this.deps.store.write(records);
      try {
        const installation = await this.deps.registration.githubInstallation(connection.repository, connection.app, installationId, connection.role, this.controller?.signal);
        connection.installationId = installation.installationId;
        connection.phase = "connected";
        connection.message = undefined;
        connection.attempt = undefined;
        await this.deps.store.write(records);
      } catch (error) {
        // Verification is read-only: retain the registered app for explicit installation continuation.
        connection.phase = "installing";
        connection.message = error instanceof GitHubInstallationPermissionError
          ? error.message
          : "Install this app on the configured repository with its requested permissions, then continue installation.";
        await this.deps.store.write(records);
        throw error;
      }
    });
  }

  provisionGitLab(repository: ForgeRepository, setupToken: string): Promise<ForgeConnections> {
    return this.exclusive(async () => {
      this.assertRepository(repository, "gitlab");
      if (!/^[\x21-\x7e]{1,4096}$/u.test(setupToken)) throw new Error("Enter a one-time GitLab setup token without whitespace.");
      const records = this.deps.store.read();
      for (const role of roles) {
        const previous = records[connectionKey(repository, role)];
        if (previous && previous.phase !== "connected") throw new Error(previous.message ?? "Previous bot setup was interrupted. Inspect the project service accounts before creating more bots.");
      }
      if (roles.every(role => {
        const connection = records[connectionKey(repository, role)];
        return connection?.phase === "connected" && !this.tokenExpired(connection);
      })) return this.status();
      await this.deps.registration.gitlabCheckSetup(repository, setupToken, this.controller?.signal);
      for (const role of roles) {
        const key = connectionKey(repository, role);
        const previous = records[key];
        if (previous?.phase === "connected" && !this.tokenExpired(previous)) continue;
        const connection: StoredForgeConnection = previous ?? { repository, role, phase: "creating_account" };
        records[key] = connection;
        try {
          if (!previous) {
            await this.deps.store.write(records);
            connection.account = await this.deps.registration.gitlabCreateAccount(repository, role, setupToken, this.controller?.signal);
            connection.name = connection.account.name;
            connection.phase = "granting_access";
            await this.deps.store.write(records);
            await this.deps.registration.gitlabGrantAccess(repository, role, connection.account.id, setupToken, this.controller?.signal);
          }
          if (!connection.account) throw new Error("The GitLab bot account is missing.");
          connection.phase = "creating_token";
          await this.deps.store.write(records);
          const credential = await this.deps.registration.gitlabCreateToken(repository, role, connection.account.id, setupToken, this.controller?.signal);
          if (credential.userId !== connection.account.id) throw new Error("GitLab issued a token for a different bot account.");
          connection.token = credential.token;
          connection.tokenId = credential.id;
          connection.expiresAt = credential.expiresAt;
          connection.phase = "connected";
          connection.message = undefined;
          await this.deps.store.write(records);
        } catch (error) {
          const detail = error instanceof ForgeProviderError ? error.message : "The setup operation failed.";
          await this.fail(records, connection, `${role === "worker" ? "Issue worker" : "Reviewer"} bot setup did not finish. Inspect GitLab project service accounts${connection.account ? ` (account ${connection.account.id})` : ""} before creating another bot. ${detail}`);
          throw new Error(connection.message);
        }
      }
      return this.status();
    });
  }

  private callback(state: string, cookie: string | undefined, trustedOrigins: readonly string[], phase: StoredForgeConnection["phase"]) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(state) || !cookie) throw new Error("Invalid application registration state.");
    const records = this.deps.store.read();
    const connection = Object.values(records).find(record => record.attempt?.state === state);
    const attempt = connection?.attempt;
    if (!connection || !attempt || connection.phase !== phase || !trustedOrigins.includes(attempt.origin) || Date.parse(attempt.expiresAt) <= this.now() || !safeEqual(attempt.cookieHash, digest(cookie)))
      throw new Error("This application registration has expired, was already used, or belongs to another browser.");
    this.assertRepository(connection.repository, "github");
    return { records, connection };
  }

  private installationUrl(connection: StoredForgeConnection): string {
    if (!connection.app || !connection.attempt) throw new Error("The application registration is incomplete.");
    const api = new URL(connection.repository.apiUrl);
    const host = api.hostname === "api.github.com" ? "https://github.com" : api.origin;
    const prefix = api.hostname === "api.github.com" ? "apps" : "github-apps";
    return `${host}/${prefix}/${encodeURIComponent(connection.app.slug)}/installations/new?state=${encodeURIComponent(connection.attempt.state)}`;
  }

  private publicConnection(role: ForgeCredentialRole, connection?: StoredForgeConnection): ForgeConnectionStatus {
    if (!connection) return { role, state: "disconnected" };
    if (connection.phase === "connected" && this.tokenExpired(connection)) return { role, state: "expired", name: connection.name, expiresAt: connection.expiresAt, message: "Use a one-time GitLab setup token to renew this bot's access." };
    const interrupted = ["converting", "verifying", "creating_account", "granting_access", "creating_token"].includes(connection.phase);
    const state = connection.phase === "connected" ? "connected" : connection.phase === "failed" || (interrupted && !this.operationActive) ? "failed" : connection.app ? "installing" : "registering";
    return { role, state, name: connection.name, message: connection.message ?? (interrupted ? "Setup is in progress. If the server restarted, inspect the provider before continuing." : undefined), expiresAt: connection.expiresAt ?? connection.attempt?.expiresAt };
  }

  private assertRepository(repository: ForgeRepository, provider: ForgeRepository["provider"]): void {
    validateRepository(repository);
    const current = this.deps.repository();
    if (repository.provider !== provider || connectionKey(current, "worker") !== connectionKey(repository, "worker")) throw new Error("Repository settings changed. Save and reload the intended repository before connecting.");
  }
  private async fail(records: ForgeConnectionRecords, connection: StoredForgeConnection, message: string) {
    connection.phase = "failed";
    connection.message = message;
    await this.deps.store.write(records);
  }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private tokenExpired(connection: StoredForgeConnection): boolean {
    return connection.repository.provider === "gitlab" && Boolean(connection.expiresAt && Date.parse(connection.expiresAt) <= this.now());
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.disposed) throw new Error("Forge application setup is shutting down.");
      this.operationActive = true;
      this.controller = new AbortController();
      try { return await operation(); } finally { this.operationActive = false; this.controller = undefined; }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export function forgeSetupCookieName(state: string): string { return `cloudx_forge_${state}`; }
function cookieHeader(state: string, cookie: string, origin: string): string {
  return `${forgeSetupCookieName(state)}=${cookie}; HttpOnly; SameSite=Lax; Path=/api/forge/connections; Max-Age=3600${origin.startsWith("https:") ? "; Secure" : ""}`;
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeEqual(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Forge application setup failed."; }

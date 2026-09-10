import { createPrivateKey } from "node:crypto";
import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import {
  forgeWebOrigin,
  githubAppJwt,
  validateRepository,
} from "../providers/ForgeCredentials.js";
import { ForgeProviderError } from "../providers/ForgeProvider.js";
import { readBoundedBody } from "../providers/responseBody.js";
import { integer, list, record, string } from "../providers/validation.js";

export interface GitHubAppManifest {
  name: string;
  url: string;
  public: boolean;
  redirect_url: string;
  setup_url: string;
  default_permissions: Record<string, "read" | "write">;
}

export class GitHubInstallationPermissionError extends ForgeProviderError {
  constructor(role: ForgeCredentialRole, permission: string, access: "read" | "write") {
    super(
      `Grant the ${role} GitHub App ${permission === "workflows" ? "Workflows" : permission}: ${access} permission, approve the updated permissions for its installation, then continue installation.`,
      403,
    );
  }
}

export class ForgeRegistrationClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  githubManifest(
    repository: ForgeRepository,
    role: ForgeCredentialRole,
    options: { origin: string; state: string },
  ): { action: string; manifest: GitHubAppManifest } {
    requireProvider(repository, "github");
    const origin = callbackOrigin(options.origin);
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(options.state))
      throw new ForgeProviderError("Use an unpredictable registration state.");
    const query = new URLSearchParams({ state: options.state });
    return {
      action: `${forgeWebOrigin(repository)}/settings/apps/new?${query}`,
      manifest: {
        name: `CloudX ${role} ${options.state.slice(0, 12)}`,
        url: origin,
        public: true,
        redirect_url: `${origin}/api/forge/connections/github/manifest`,
        setup_url: `${origin}/api/forge/connections/github/installation`,
        default_permissions: githubPermissions(role),
      },
    };
  }

  async githubConvert(
    repository: ForgeRepository,
    code: string,
    signal?: AbortSignal,
  ): Promise<{
    appId: string;
    privateKey: string;
    slug: string;
    name: string;
  }> {
    requireProvider(repository, "github");
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(code))
      throw new ForgeProviderError("The GitHub manifest code is invalid.");
    return this.request(
      repository,
      `/app-manifests/${code}/conversions`,
      {
        method: "POST",
        signal,
      },
      (value) => {
        const body = record(value);
        const appId = positiveId(body.id);
        const privateKey = string(body.pem);
        if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa")
          throw new Error("RSA key required");
        const slug = string(body.slug);
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(slug))
          throw new Error("Invalid app slug");
        return { appId, privateKey, slug, name: nonempty(body.name) };
      },
    );
  }

  async githubInstallation(
    repository: ForgeRepository,
    app: { appId: string; privateKey: string },
    expectedInstallationId: string,
    role: ForgeCredentialRole,
    signal?: AbortSignal,
  ): Promise<{ installationId: string }> {
    requireProvider(repository, "github");
    signal?.throwIfAborted();
    requireId(expectedInstallationId);
    requireId(app.appId);
    const permissions = githubPermissions(role);
    const granted = await this.request(
      repository,
      `/repos/${repository.projectPath}/installation`,
      {
        authorization: { Authorization: `Bearer ${githubAppJwt(app)}` },
        signal,
      },
      (value) => {
        const body = record(value);
        if (
          positiveId(body.id) !== expectedInstallationId ||
          positiveId(body.app_id) !== app.appId ||
          body.suspended_at !== null
        )
          throw new Error("Installation identity mismatch or suspended");
        return record(body.permissions);
      },
    );
    for (const [permission, access] of Object.entries(permissions)) {
      if (granted[permission] !== "write" && granted[permission] !== access)
        throw new GitHubInstallationPermissionError(role, permission, access);
    }
    return { installationId: expectedInstallationId };
  }

  async gitlabCheckSetup(
    repository: ForgeRepository,
    setupToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    requireProvider(repository, "gitlab");
    const options = { authorization: gitlabSetupHeaders(setupToken), signal };
    await this.request(
      repository,
      "/personal_access_tokens/self",
      options,
      (value) => {
        const token = record(value);
        if (
          token.active !== true ||
          token.revoked !== false ||
          !list(token.scopes).map(string).includes("api")
        )
          throw new Error(
            "An active personal access token with api scope is required",
          );
      },
    );
    await this.request(
      repository,
      `${gitlabProject(repository)}/service_accounts?per_page=1`,
      options,
      (value) => {
        const accounts = list(value);
        if (accounts.length > 1)
          throw new Error("Unexpected service-account page size");
        for (const account of accounts) parseGitLabAccount(account);
      },
    );
  }

  async gitlabCreateAccount(
    repository: ForgeRepository,
    role: ForgeCredentialRole,
    setupToken: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; username: string; name: string }> {
    requireProvider(repository, "gitlab");
    requireRole(role);
    return this.request(
      repository,
      `${gitlabProject(repository)}/service_accounts`,
      {
        method: "POST",
        authorization: gitlabSetupHeaders(setupToken),
        body: { name: `CloudX ${role}` },
        signal,
      },
      parseGitLabAccount,
    );
  }

  async gitlabGrantAccess(
    repository: ForgeRepository,
    role: ForgeCredentialRole,
    accountId: string,
    setupToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    requireProvider(repository, "gitlab");
    requireRole(role);
    requireId(accountId);
    const accessLevel = role === "worker" ? 40 : 30;
    return this.request(
      repository,
      `${gitlabProject(repository)}/members`,
      {
        method: "POST",
        authorization: gitlabSetupHeaders(setupToken),
        body: { user_id: Number(accountId), access_level: accessLevel },
        signal,
      },
      (value) => {
        const body = record(value);
        if (
          positiveId(body.id) !== accountId ||
          integer(body.access_level) !== accessLevel ||
          body.state !== "active"
        )
          throw new Error("The requested project membership is not active");
      },
    );
  }

  async gitlabCreateToken(
    repository: ForgeRepository,
    role: ForgeCredentialRole,
    accountId: string,
    setupToken: string,
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    userId: string;
    token: string;
    expiresAt?: string;
  }> {
    requireProvider(repository, "gitlab");
    requireRole(role);
    requireId(accountId);
    const scopes = [
      "api",
      role === "worker" ? "write_repository" : "read_repository",
    ];
    return this.request(
      repository,
      `${gitlabProject(repository)}/service_accounts/${accountId}/personal_access_tokens`,
      {
        method: "POST",
        authorization: gitlabSetupHeaders(setupToken),
        body: { name: `CloudX ${role}`, scopes },
        signal,
      },
      (value) => {
        const body = record(value);
        const granted = list(body.scopes).map(string);
        if (
          positiveId(body.user_id) !== accountId ||
          body.active !== true ||
          body.revoked !== false ||
          scopes.some((scope) => !granted.includes(scope))
        )
          throw new Error("Token identity, state, or scopes do not match");
        const token = nonempty(body.token);
        if (!/^[\x21-\x7e]{1,20000}$/.test(token))
          throw new Error("Invalid access token");
        const expiresAt =
          body.expires_at == null ? undefined : string(body.expires_at);
        if (
          expiresAt !== undefined &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) ||
            !(Date.parse(expiresAt) > Date.now()) ||
            new Date(expiresAt).toISOString().slice(0, 10) !== expiresAt)
        )
          throw new Error("The token is expired or has an invalid expiry date");
        return {
          id: positiveId(body.id),
          userId: accountId,
          token,
          ...(expiresAt ? { expiresAt } : {}),
        };
      },
    );
  }

  private async request<T>(
    repository: ForgeRepository,
    path: string,
    options: {
      method?: "POST" | "PUT";
      authorization?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
    },
    parse: (body: unknown) => T,
  ): Promise<T> {
    options.signal?.throwIfAborted();
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    const failed = () =>
      new ForgeProviderError(
        options.method
          ? "The registration operation's remote result is unknown. Reconcile the existing application or bot before submitting again."
          : repository.provider === "gitlab"
            ? "CloudX could not verify GitLab setup access. Use an active personal access token with the api scope and Maintainer or Owner project access."
            : "CloudX could not verify the application installation. Check repository access and required permissions.",
        options.method ? 409 : 502,
      );
    let response: Response;
    try {
      response = await this.fetcher(
        `${repository.apiUrl.replace(/\/$/, "")}${path}`,
        {
          method: options.method ?? "GET",
          redirect: "error",
          signal,
          headers: {
            ...options.authorization,
            Accept: "application/json",
            ...(repository.provider === "github"
              ? { "X-GitHub-Api-Version": "2026-03-10" }
              : {}),
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        },
      );
    } catch {
      throw failed();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (options.method && (response.status === 408 || response.status >= 500))
        throw failed();
      throw new ForgeProviderError(
        `The ${repository.provider} API rejected registration (HTTP ${response.status}). Check account permissions and instance support.`,
        response.status,
      );
    }
    try {
      const body: unknown = JSON.parse(
        await readBoundedBody(response, 128_000),
      );
      signal.throwIfAborted();
      return parse(body);
    } catch {
      throw failed();
    }
  }
}

function githubPermissions(
  role: ForgeCredentialRole,
): Record<string, "read" | "write"> {
  requireRole(role);
  const access = role === "worker" ? "write" : "read";
  return {
    contents: access,
    issues: access,
    pull_requests: "write",
    ...(role === "worker" ? { workflows: "write" } : {}),
  };
}

function requireRole(role: ForgeCredentialRole): void {
  if (role !== "worker" && role !== "reviewer")
    throw new ForgeProviderError("Choose a worker or reviewer identity.");
}

function gitlabProject(repository: ForgeRepository): string {
  return `/projects/${encodeURIComponent(repository.projectPath)}`;
}

function parseGitLabAccount(value: unknown): {
  id: string;
  username: string;
  name: string;
} {
  const body = record(value);
  return {
    id: positiveId(body.id),
    username: nonempty(body.username),
    name: nonempty(body.name),
  };
}

function gitlabSetupHeaders(token: string): Record<string, string> {
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,20000}$/.test(token))
    throw new ForgeProviderError(
      "Provide a nonempty GitLab setup token without whitespace.",
    );
  return { "PRIVATE-TOKEN": token };
}

function requireProvider(
  repository: ForgeRepository,
  provider: ForgeRepository["provider"],
): void {
  validateRepository(repository);
  if (repository.provider !== provider)
    throw new ForgeProviderError(
      `Choose a ${provider} repository for this registration.`,
    );
}

function callbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ForgeProviderError("Use a valid CloudX callback origin.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ForgeProviderError(
      "Use an HTTPS CloudX origin or a local HTTP origin without a path or credentials.",
    );
  return url.origin;
}

function positiveId(value: unknown): string {
  const id = integer(value);
  if (!id) throw new Error("Positive ID required");
  return String(id);
}

function requireId(value: string): void {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new ForgeProviderError(
      "Use a valid application, installation, or bot ID.",
    );
}

function nonempty(value: unknown): string {
  const text = string(value);
  if (!text.trim()) throw new Error("Nonempty value required");
  return text;
}

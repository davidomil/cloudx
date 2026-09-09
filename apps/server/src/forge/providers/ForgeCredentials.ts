import { createPrivateKey, sign } from "node:crypto";
import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import { ForgeProviderError, ForgeProviderUnavailableError, forgeRequestFailure, throwIfForgeRequestAborted } from "./ForgeProvider.js";
import { record, string } from "./validation.js";
import { readBoundedBody } from "./responseBody.js";

export type ForgeCredential =
  | { kind: "token"; token: string }
  | { kind: "gitlab-oauth"; token: string }
  | {
      kind: "github-app";
      appId: string;
      installationId: string;
      privateKey: string;
    };

export type ReadForgeCredential = (
  role: ForgeCredentialRole,
) => Promise<ForgeCredential | undefined>;

export function validateRepository(repository: ForgeRepository): URL {
  let url: URL;
  try {
    url = new URL(repository.apiUrl);
  } catch {
    throw new ForgeProviderError("Set a valid forge API URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ForgeProviderError(
      "Forge API URLs must use HTTPS and contain no credentials, query, or fragment.",
    );
  }
  if (!["github", "gitlab"].includes(repository.provider))
    throw new ForgeProviderError("Choose GitHub or GitLab.");
  const parts = repository.projectPath.split("/");
  if (
    parts.length < 2 ||
    parts.some(
      (part) =>
        !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..",
    ) ||
    (repository.provider === "github" && parts.length !== 2)
  ) {
    throw new ForgeProviderError(
      "Set the repository path to owner/repository (GitLab may include subgroups).",
    );
  }
  const expectedPath =
    repository.provider === "gitlab"
      ? "/api/v4"
      : url.hostname === "api.github.com"
        ? ""
        : "/api/v3";
  if (url.pathname.replace(/\/$/, "") !== expectedPath) {
    throw new ForgeProviderError(
      `The API URL must end with ${expectedPath || "the api.github.com hostname"}.`,
    );
  }
  return url;
}

export function forgeWebOrigin(repository: ForgeRepository): string {
  const api = validateRepository(repository);
  if (repository.provider === "github" && api.hostname === "api.github.com")
    return "https://github.com";
  return api.origin;
}

export function githubAppJwt(app: {
  appId: string;
  privateKey: string;
}): string {
  if (!/^[A-Za-z0-9_]+$/.test(app.appId))
    throw new ForgeProviderError("Set a valid GitHub App ID or client ID.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: app.appId })}`;
  try {
    const key = createPrivateKey(app.privateKey);
    if (key.asymmetricKeyType !== "rsa") throw new Error("RSA key required");
    return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), key).toString("base64url")}`;
  } catch {
    throw new ForgeProviderError(
      "The GitHub App private key is not a valid RSA signing key.",
    );
  }
}

export class ForgeCredentials {
  private readonly installationTokens = new Map<
    ForgeCredentialRole,
    { credential: string; token: string; expires: number }
  >();

  constructor(
    private readonly repository: ForgeRepository,
    private readonly read: ReadForgeCredential,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    validateRepository(repository);
  }

  async headers(
    role: ForgeCredentialRole,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    throwIfForgeRequestAborted(signal);
    let credential: ForgeCredential | undefined;
    try {
      credential = await this.read(role);
    } catch (error) {
      this.installationTokens.delete(role);
      throw error;
    }
    throwIfForgeRequestAborted(signal);
    if (credential?.kind !== "github-app") this.installationTokens.delete(role);
    if (!credential)
      throw new ForgeProviderError(
        `Configure ${role} application credentials in Forge Workers settings.`,
        401,
      );
    if (credential.kind === "github-app") {
      if (this.repository.provider !== "github")
        throw new ForgeProviderError(
          "GitHub application credentials require a GitHub repository.",
        );
      return {
        Authorization: `Bearer ${await this.installationToken(role, credential, signal)}`,
      };
    }
    if (!credential.token.trim())
      throw new ForgeProviderError(
        `Configure a nonempty ${role} access token.`,
        401,
      );
    if (
      credential.kind === "gitlab-oauth" &&
      this.repository.provider !== "gitlab"
    )
      throw new ForgeProviderError(
        "GitLab OAuth credentials require a GitLab repository.",
      );
    return this.repository.provider === "gitlab" && credential.kind === "token"
      ? { "PRIVATE-TOKEN": credential.token }
      : { Authorization: `Bearer ${credential.token}` };
  }

  async gitAccess(
    role: ForgeCredentialRole,
    signal?: AbortSignal,
  ): Promise<{ cloneUrl: string; authorization: string }> {
    const headers = await this.headers(role, signal);
    const token =
      "PRIVATE-TOKEN" in headers
        ? headers["PRIVATE-TOKEN"]
        : headers.Authorization.slice("Bearer ".length);
    const username =
      this.repository.provider === "github" ? "x-access-token" : "oauth2";
    return {
      cloneUrl: `${forgeWebOrigin(this.repository)}/${this.repository.projectPath}.git`,
      authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
    };
  }

  private async installationToken(
    role: ForgeCredentialRole,
    credential: Extract<ForgeCredential, { kind: "github-app" }>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (
      !/^[A-Za-z0-9_]+$/.test(credential.appId) ||
      !/^\d+$/.test(credential.installationId)
    )
      throw new ForgeProviderError(
        "Set the GitHub App client ID and numeric installation ID.",
      );
    const identity = JSON.stringify(credential);
    const cached = this.installationTokens.get(role);
    if (cached?.credential === identity && cached.expires > Date.now() + 60_000)
      return cached.token;
    this.installationTokens.delete(role);
    const jwt = githubAppJwt(credential);
    let response: Response;
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    throwIfForgeRequestAborted(requestSignal, "authentication");
    try {
      response = await this.fetcher(
        `${this.repository.apiUrl.replace(/\/$/, "")}/app/installations/${credential.installationId}/access_tokens`,
        {
          method: "POST",
          redirect: "error",
          signal: requestSignal,
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repositories: [this.repository.projectPath.split("/")[1]],
          }),
        },
      );
    } catch {
      throw new ForgeProviderUnavailableError(forgeRequestFailure(requestSignal), "authentication");
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } finally {
        throw new ForgeProviderError(
          `GitHub App authentication failed (HTTP ${response.status}).`,
          response.status,
        );
      }
    }
    let value: unknown;
    try {
      value = JSON.parse(await readBoundedBody(response, 100_000));
    } catch {
      throw new ForgeProviderUnavailableError(forgeRequestFailure(requestSignal, true), "authentication");
    }
    throwIfForgeRequestAborted(requestSignal, "authentication");
    let body: Record<string, unknown>;
    try {
      body = record(value);
    } catch {
      throw new ForgeProviderError(
        "GitHub App authentication returned invalid credentials.",
        502,
      );
    }
    const token = string(body.token);
    const expires = Date.parse(string(body.expires_at));
    if (!token || !Number.isFinite(expires) || expires <= Date.now())
      throw new ForgeProviderError(
        "GitHub App returned an expired or invalid installation token.",
        502,
      );
    this.installationTokens.set(role, { credential: identity, token, expires });
    return token;
  }
}

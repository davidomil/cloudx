import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import { ForgeCredentials } from "./ForgeCredentials.js";
import { ForgeHttpClient } from "./ForgeHttpClient.js";
import type { ForgeListIdentity, ForgeProvider } from "./ForgeProvider.js";
import { GitHubProvider } from "./GitHubProvider.js";
import { GitLabProvider } from "./GitLabProvider.js";

export * from "./ForgeCredentials.js";
export * from "./ForgeProvider.js";

export function createForgeProvider(
  repository: ForgeRepository,
  credentials: ForgeCredentials,
  options: {
    fetcher?: typeof fetch;
    role?: ForgeCredentialRole;
    signal?: AbortSignal;
    listIdentity?: () => ForgeListIdentity;
  } = {},
): ForgeProvider {
  const http = new ForgeHttpClient(
    repository,
    credentials,
    options.fetcher,
    options.role,
    options.signal,
  );
  return repository.provider === "github"
    ? new GitHubProvider(http, options.listIdentity)
    : new GitLabProvider(http, options.listIdentity);
}

import type {
  ForgeCredentialRole,
  ForgeListQuery,
  ForgeRepository,
} from "@cloudx/shared";
import { ForgeCredentials, validateRepository } from "./ForgeCredentials.js";
import { ForgeProviderError, ForgeProviderUnavailableError, forgeRequestFailure, throwIfForgeRequestAborted, type ForgeProviderFailure } from "./ForgeProvider.js";
import { list } from "./validation.js";
import { readBoundedBody } from "./responseBody.js";

export class ForgeHttpClient {
  constructor(
    readonly repository: ForgeRepository,
    private readonly credentials: ForgeCredentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly readRole: ForgeCredentialRole = "worker",
    private readonly signal?: AbortSignal,
  ) {
    validateRepository(repository);
  }

  async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      role?: ForgeCredentialRole;
      text?: boolean;
      graphql?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ body: unknown; headers: Headers }> {
    throwIfForgeRequestAborted(this.signal);
    throwIfForgeRequestAborted(options.signal);
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path
        .split("?")[0]
        .split("/")
        .some((part) => part === "." || part === "..")
    )
      throw new ForgeProviderError("Invalid forge API path.");
    const api = new URL(this.repository.apiUrl);
    const base = options.graphql
      ? `${api.origin}${this.repository.provider === "github" && api.hostname === "api.github.com" ? "" : "/api"}`
      : this.repository.apiUrl.replace(/\/$/, "");
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...[this.signal, options.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    ]);
    const headers: Record<string, string> = {
      ...(await this.credentials.headers(
        options.role ?? this.readRole,
        signal,
      )),
      Accept: options.text ? "application/vnd.github.diff" : "application/json",
      ...(this.repository.provider === "github"
        ? { "X-GitHub-Api-Version": "2026-03-10" }
        : {}),
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    };
    throwIfForgeRequestAborted(signal);
    const method = options.method ?? "GET";
    const query = String((options.body as { query?: unknown })?.query);
    const graphqlRead = options.graphql && /^\s*query\b/.test(query) && !/\bmutation\b/.test(query);
    const changesRemoteState =
      !["GET", "HEAD"].includes(method) &&
      !graphqlRead;
    let body: string | undefined;
    try {
      body = options.body === undefined ? undefined : JSON.stringify(options.body);
    } catch {
      throw new ForgeProviderError("The forge request body could not be encoded.");
    }
    let response: Response;
    try {
      response = await this.fetcher(`${base}${path}`, {
        method,
        headers,
        redirect: "error",
        signal,
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw requestFailure(forgeRequestFailure(signal), changesRemoteState);
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } finally {
        throw new ForgeProviderError(
          `The ${this.repository.provider} API rejected the operation (HTTP ${response.status}).`,
          response.status,
        );
      }
    }
    try {
      const text = await readBoundedBody(response);
      throwIfForgeRequestAborted(signal);
      return {
        body: options.text ? text : text ? (JSON.parse(text) as unknown) : null,
        headers: response.headers,
      };
    } catch (error) {
      if (!changesRemoteState && error instanceof ForgeProviderError) throw error;
      throw requestFailure(forgeRequestFailure(signal, true), changesRemoteState);
    }
  }

  async all(path: string): Promise<unknown[]> {
    const values: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = await this.request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const items = list(response.body);
      values.push(...items);
      if (!hasNextPage(response.headers)) return values;
    }
    throw new ForgeProviderError(
      "This request exceeds 2,000 records. Narrow the scope before continuing.",
      422,
    );
  }
}

function requestFailure(failure: ForgeProviderFailure, changesRemoteState: boolean): ForgeProviderError {
  const unavailable = new ForgeProviderUnavailableError(failure);
  return changesRemoteState
    ? new ForgeProviderError(`${unavailable.message} Its remote result is unknown. Refresh provider state before submitting again.`, 409)
    : unavailable;
}

export function pagination(query: ForgeListQuery = {}): {
  page: number;
  perPage: number;
} {
  const page = query.page ?? 1;
  const perPage = query.perPage ?? 50;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000 ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100
  ) {
    throw new ForgeProviderError(
      "Choose page 1–1000 and a page size of 1–100.",
    );
  }
  if (query.filter && query.filter.length > 2000)
    throw new ForgeProviderError("Filters must be at most 2,000 characters.");
  return { page, perPage };
}

export function hasNextPage(headers: Headers): boolean {
  return (
    Boolean(headers.get("x-next-page")) ||
    /rel="next"/.test(headers.get("link") ?? "")
  );
}

import type {
  ForgeCredentialRole,
  ForgeListQuery,
  ForgeRepository,
} from "@cloudx/shared";
import { ForgeCredentials, validateRepository } from "./ForgeCredentials.js";
import { ForgeProviderError } from "./ForgeProvider.js";
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
    this.signal?.throwIfAborted();
    options.signal?.throwIfAborted();
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
    signal.throwIfAborted();
    const method = options.method ?? "GET";
    const changesRemoteState =
      !["GET", "HEAD"].includes(method) &&
      (!options.graphql ||
        /^mutation\b/.test(
          String((options.body as { query?: unknown })?.query),
        ));
    try {
      const response = await this.fetcher(`${base}${path}`, {
        method,
        headers,
        redirect: "error",
        signal,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ForgeProviderError(
          `The ${this.repository.provider} API rejected the operation (HTTP ${response.status}).`,
          response.status,
        );
      }
      const text = await readBoundedBody(response);
      signal.throwIfAborted();
      return {
        body: options.text ? text : text ? (JSON.parse(text) as unknown) : null,
        headers: response.headers,
      };
    } catch (error) {
      if (error instanceof ForgeProviderError) throw error;
      if (signal.aborted)
        throw new ForgeProviderError(
          changesRemoteState
            ? "The forge operation was interrupted; its remote result is unknown. Refresh provider state before submitting again."
            : "The forge request was interrupted.",
          changesRemoteState ? 409 : 499,
        );
      throw new ForgeProviderError(
        "The forge API request failed or returned unreadable data.",
        502,
      );
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

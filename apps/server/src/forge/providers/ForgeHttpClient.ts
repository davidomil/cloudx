import type {
  ForgeCredentialRole,
  ForgeListQuery,
  ForgeRepository,
} from "@cloudx/shared";
import { ForgeCredentials, validateRepository } from "./ForgeCredentials.js";
import { ForgeProviderError, forgeRequestTimeoutMs, type ForgeDiagnosticObserver } from "./ForgeProvider.js";
import { ForgeRequestFailures, httpFailure } from "./ForgeRequestFailures.js";
import { list } from "./validation.js";
import { readBoundedBody } from "./responseBody.js";
import { readCiLog } from "./ciEvidence.js";

interface ForgeRequestOptions {
  method?: string;
  body?: unknown;
  role?: ForgeCredentialRole;
  text?: boolean;
  graphql?: boolean;
  signal?: AbortSignal;
}

export class ForgeHttpClient {
  constructor(
    readonly repository: ForgeRepository,
    private readonly credentials: ForgeCredentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly readRole: ForgeCredentialRole = "worker",
    private readonly signal?: AbortSignal,
    private readonly onFailure?: ForgeDiagnosticObserver,
  ) {
    validateRepository(repository);
  }

  async request(
    path: string,
    options: ForgeRequestOptions = {},
  ): Promise<{ body: unknown; headers: Headers }> {
    return this.performRequest(path, options);
  }

  async ciLog(path: string): Promise<string> {
    const prefix = this.repository.provider === "github"
      ? `/repos/${this.repository.projectPath.split("/").map(encodeURIComponent).join("/")}/actions/jobs/`
      : `/projects/${encodeURIComponent(this.repository.projectPath)}/jobs/`;
    if (!path.startsWith(prefix) || !/^\d+\/(?:logs|trace)$/.test(path.slice(prefix.length)) ||
        !path.endsWith(this.repository.provider === "github" ? "/logs" : "/trace"))
      throw new ForgeProviderError("CI logs require a job in the configured repository.");
    return String((await this.performRequest(path, {}, true)).body);
  }

  private async performRequest(
    path: string,
    options: ForgeRequestOptions,
    ciLog = false,
  ): Promise<{ body: unknown; headers: Headers }> {
    const role = options.role ?? this.readRole;
    const method = (options.method ?? "GET").toUpperCase();
    const failures = new ForgeRequestFailures(this.repository, role, path, method, "request", this.onFailure);
    failures.assertReady(this.signal);
    failures.assertReady(options.signal, this.credentials.requestDelay());
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path
        .split("?")[0]
        .split("/")
        .some((part) => part === "." || part === "..")
    )
      throw failures.prepare("Invalid forge API path.");
    const api = new URL(this.repository.apiUrl);
    const base = options.graphql
      ? `${api.origin}${this.repository.provider === "github" && api.hostname === "api.github.com" ? "" : "/api"}`
      : this.repository.apiUrl.replace(/\/$/, "");
    const signal = AbortSignal.any([
      AbortSignal.timeout(forgeRequestTimeoutMs),
      ...[this.signal, options.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    ]);
    const headers: Record<string, string> = {
      ...(await this.credentials.headers(
        role,
        signal,
        this.onFailure,
      )),
      Accept: ciLog && this.repository.provider === "gitlab" ? "text/plain" : options.text ? "application/vnd.github.diff" : "application/json",
      ...(this.repository.provider === "github"
        ? { "X-GitHub-Api-Version": "2026-03-10" }
        : {}),
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    };
    failures.assertReady(signal, this.credentials.requestDelay());
    const query = String((options.body as { query?: unknown })?.query);
    const graphqlRead = options.graphql && /^\s*query\b/.test(query) && !/\bmutation\b/.test(query);
    const changesRemoteState =
      !["GET", "HEAD"].includes(method) &&
      !graphqlRead;
    let body: string | undefined;
    try {
      body = options.body === undefined ? undefined : JSON.stringify(options.body);
    } catch {
      throw failures.prepare("The forge request body could not be encoded.");
    }
    const url = `${base}${path}`;
    const request: RequestInit = { method, headers, redirect: "manual", signal, ...(body === undefined ? {} : { body }) };
    try {
      new Request(url, request);
    } catch {
      throw failures.prepare();
    }
    failures.assertReady(signal, this.credentials.requestDelay());
    let response: Response;
    try {
      response = await this.fetcher(url, request);
    } catch (error) {
      throw failures.transport(error, signal, changesRemoteState);
    }
    failures.received(response);
    const secrets = ciLog ? Object.entries(headers)
      .filter(([name]) => /authorization|private-token/i.test(name))
      .flatMap(([, value]) => {
        const token = value.replace(/^Bearer /, "");
        return [value, token, encodeURIComponent(token), Buffer.from(token).toString("base64")];
      }) : [];
    if (ciLog && this.repository.provider === "github" && response.status === 302) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      let download: URL;
      try { download = new URL(location ?? ""); } catch { throw failures.prepare("GitHub did not supply a safe job-log download URL."); }
      const configured = new URL(this.repository.apiUrl);
      const allowed = download.hostname === "results-receiver.actions.githubusercontent.com" ||
        /^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(download.hostname) ||
        configured.hostname !== "api.github.com" && download.origin === configured.origin;
      if (!allowed || download.protocol !== "https:" || download.username || download.password ||
          download.hash || download.port && download.port !== "443")
        throw failures.prepare("GitHub supplied an unsafe job-log download URL.");
      try {
        response = await this.fetcher(download.href, { method: "GET", redirect: "manual", signal, credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "text/plain" } });
      } catch (error) { throw failures.transport(error, signal, false); }
      failures.received(response);
    }
    if (!response.ok) {
      const failure = httpFailure(response, this.repository.provider);
      this.credentials.deferRequests(failure.retryAfterMs);
      try {
        await response.body?.cancel();
      } finally {
        throw failures.http(failure, changesRemoteState);
      }
    }
    try {
      if (ciLog) {
        const text = await readCiLog(response, secrets);
        if (signal.aborted) throw signal.reason;
        return { body: text, headers: response.headers };
      }
      const text = await readBoundedBody(response);
      if (signal.aborted) throw signal.reason;
      return {
        body: options.text ? text : text ? (JSON.parse(text) as unknown) : null,
        headers: response.headers,
      };
    } catch (error) {
      throw failures.transport(error, signal, changesRemoteState, true);
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

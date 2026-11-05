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
import { readCiLog, type CiLogEvidence } from "./ciEvidence.js";

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
  ): Promise<{ body: unknown; headers: Headers; status: number }> {
    return this.performRequest(path, options);
  }

  async ciLog(path: string): Promise<string> {
    return (await this.ciLogEvidence(path)).log;
  }

  async ciLogEvidence(path: string): Promise<CiLogEvidence> {
    const prefix = this.repository.provider === "github"
      ? `/repos/${this.repository.projectPath.split("/").map(encodeURIComponent).join("/")}/actions/jobs/`
      : `/projects/${encodeURIComponent(this.repository.projectPath)}/jobs/`;
    const logPath = this.repository.provider === "github" ? /^\d+\/(?:steps\/[1-9]\d*\/)?logs$/ : /^\d+\/trace$/;
    if (!path.startsWith(prefix) || !logPath.test(path.slice(prefix.length)))
      throw new ForgeProviderError("CI logs require a job in the configured repository.");
    return (await this.performRequest(path, {}, true)).body as CiLogEvidence;
  }

  private async performRequest(
    path: string,
    options: ForgeRequestOptions,
    ciLog = false,
  ): Promise<{ body: unknown; headers: Headers; status: number }> {
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
    let authorization: Record<string, string>;
    try {
      authorization = await this.credentials.headers(role, signal, this.onFailure);
    } catch (error) {
      if (error instanceof ForgeProviderError && error.diagnostic) throw error;
      failures.assertReady(signal);
      throw failures.beforeDispatch(error);
    }
    const headers: Record<string, string> = {
      ...authorization,
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
        const text = await readCiLog(response, secrets, this.repository.projectPath);
        if (signal.aborted) throw signal.reason;
        return { body: text, headers: response.headers, status: response.status };
      }
      const text = await readBoundedBody(response);
      if (signal.aborted) throw signal.reason;
      return {
        body: options.text ? text : text ? (JSON.parse(text) as unknown) : null,
        headers: response.headers,
        status: response.status,
      };
    } catch (error) {
      throw failures.transport(error, signal, changesRemoteState, true);
    }
  }

  async all(path: string, options: { requireCompletePages?: boolean } = {}): Promise<unknown[]> {
    const values: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = await this.request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const items = list(response.body);
      values.push(...items);
      const next = options.requireCompletePages
        ? hasCompleteNextPage(response.headers, this.repository.apiUrl, page)
        : hasNextPage(response.headers);
      if (!next) return values;
    }
    throw new ForgeProviderError(
      "This request exceeds 2,000 records. Narrow the scope before continuing.",
      422,
    );
  }
}

function hasCompleteNextPage(headers: Headers, apiUrl: string, page: number): boolean {
  const invalidPagination = (): never => {
    throw new ForgeProviderError("The provider returned incomplete or inconsistent pagination. Reconcile the request before continuing.", 502);
  };
  const expectedNext = String(page + 1);
  const nextHeader = headers.get("x-next-page");
  if (nextHeader !== null && nextHeader !== "" && nextHeader !== expectedNext) return invalidPagination();
  if (headers.has("x-page") && headers.get("x-page") !== String(page)) return invalidPagination();
  if (headers.has("x-per-page") && headers.get("x-per-page") !== "100") return invalidPagination();
  const totalPages = headers.get("x-total-pages");
  if (totalPages !== null && (!/^\d{1,9}$/.test(totalPages) || Number(totalPages) < page && !(page === 1 && totalPages === "0")))
    return invalidPagination();
  const link = headers.get("link");
  let nextLink = false;
  if (link !== null) {
    if (!link || link.length > 32_768) return invalidPagination();
    const relations = new Set<string>();
    for (const part of link.split(/,\s*(?=<)/)) {
      const match = part.trim().match(/^<([^<>]+)>;\s*rel="(next|prev|first|last)"$/);
      if (!match || relations.has(match[2])) return invalidPagination();
      relations.add(match[2]);
      let url: URL;
      try { url = new URL(match[1]); } catch { return invalidPagination(); }
      if (url.origin !== new URL(apiUrl).origin || url.username || url.password || url.hash) return invalidPagination();
      if (match[2] === "next") {
        if (url.searchParams.getAll("page").length !== 1 || url.searchParams.get("page") !== expectedNext) return invalidPagination();
        nextLink = true;
      }
    }
  }
  if (nextHeader !== null && link !== null && Boolean(nextHeader) !== nextLink) return invalidPagination();
  const next = Boolean(nextHeader) || nextLink;
  if (totalPages !== null && next !== (Number(totalPages) > page)) return invalidPagination();
  return next;
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

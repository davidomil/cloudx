import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import {
  ForgeProviderError,
  ForgeProviderUnavailableError,
  forgeRequestFailure,
  type ForgeDiagnosticObserver,
  type ForgeProviderFailure,
  type ForgeRequestDiagnostic,
} from "./ForgeProvider.js";

interface FailureDetails {
  failure: ForgeProviderFailure;
  retryable: boolean;
  causeCodes?: readonly string[];
  httpStatus?: number;
  retryAfterMs?: number;
}

const timeoutCodes = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const connectionCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_SOCKET"]);
const tlsCodes = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const allowedCodes = new Set([...timeoutCodes, ...connectionCodes, ...tlsCodes, "ENOTFOUND", "ABORT_ERR"]);

export class ForgeRequestFailures {
  private readonly context: Pick<ForgeRequestDiagnostic, "provider" | "role" | "operation" | "method" | "path">;

  constructor(
    repository: ForgeRepository,
    role: ForgeCredentialRole,
    path: string,
    method: string,
    operation: "request" | "authentication",
    private readonly onFailure?: ForgeDiagnosticObserver,
  ) {
    this.context = {
      provider: repository.provider, role, operation,
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER",
      path: diagnosticPath(repository.provider, path),
    };
  }

  prepare(message = "The forge request could not be prepared; check its configuration."): ForgeProviderError {
    this.report("prepare", { failure: "invalid_request", retryable: false });
    return new ForgeProviderError(message);
  }

  assertReady(signal?: AbortSignal, retryAfterMs?: number): void {
    if (signal?.aborted) {
      const failure = forgeRequestFailure(signal);
      throw this.unavailable("prepare", { failure, retryable: failure === "timeout" });
    }
    if (retryAfterMs !== undefined)
      throw this.unavailable("prepare", { failure: "rate_limited", retryable: true, retryAfterMs });
  }

  transport(error: unknown, signal: AbortSignal, changesRemoteState: boolean, responseReceived = false): ForgeProviderError {
    const phase = responseReceived ? "response" : "fetch";
    if (error instanceof ForgeProviderError && !changesRemoteState) {
      this.report(phase, { failure: "unreadable_response", retryable: false });
      return error;
    }
    const details = transportFailure(error, signal, responseReceived);
    return this.unavailable(phase, { ...details, retryable: details.retryable && !changesRemoteState }, changesRemoteState);
  }

  http(details: FailureDetails, changesRemoteState: boolean): ForgeProviderError {
    const failure = { ...details, retryable: details.retryable && !changesRemoteState };
    if (details.failure === "redirect" || (changesRemoteState && details.httpStatus! >= 500))
      return this.unavailable("response", failure, changesRemoteState);
    if (failure.retryable) return this.unavailable("response", failure);
    this.report("response", failure);
    const message = this.context.operation === "authentication"
      ? `GitHub App authentication failed (HTTP ${details.httpStatus}).`
      : `The ${this.context.provider} API rejected the operation (HTTP ${details.httpStatus}).`;
    return new ForgeProviderError(message, details.httpStatus);
  }

  private unavailable(phase: ForgeRequestDiagnostic["phase"], details: FailureDetails, changesRemoteState = false): ForgeProviderError {
    this.report(phase, details);
    const unavailable = new ForgeProviderUnavailableError(details.failure, this.context.operation, details);
    return changesRemoteState
      ? new ForgeProviderError(`${unavailable.message} Its remote result is unknown. Refresh provider state before submitting again.`, 409)
      : unavailable;
  }

  private report(phase: ForgeRequestDiagnostic["phase"], details: FailureDetails): void {
    const diagnostic = Object.freeze({ ...this.context, phase, ...details, causeCodes: Object.freeze([...(details.causeCodes ?? [])]) });
    try {
      this.onFailure?.(diagnostic);
    } catch {
      // Diagnostic delivery must not change the request outcome.
    }
  }
}

export function httpFailure(response: Response, provider: ForgeRepository["provider"]): FailureDetails {
  const status = response.status;
  const now = Date.now();
  const retryAfter = retryAfterDelay(response.headers.get("retry-after"), now);
  const prefix = provider === "github" ? "x-ratelimit" : "ratelimit";
  const exhausted = response.headers.get(`${prefix}-remaining`)?.trim() === "0";
  const rateLimited = status === 429 || (status === 403 && (exhausted || retryAfter !== undefined));
  const reset = rateLimited && exhausted ? resetDelay(response.headers.get(`${prefix}-reset`), now) : undefined;
  const hints = [retryAfter, reset].filter((value): value is number => value !== undefined);
  const retryAfterMs = hints.length ? Math.max(...hints) : rateLimited && provider === "github" ? 60_000 : undefined;
  const failure = status >= 300 && status < 400 ? "redirect"
    : rateLimited ? "rate_limited"
      : [502, 503, 504].includes(status) ? "service_unavailable" : "rejected";
  return {
    failure, retryable: failure === "rate_limited" || failure === "service_unavailable", httpStatus: status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function retryAfterDelay(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const delay = Number(text) * 1000;
    return Number.isSafeInteger(now + delay) ? delay : undefined;
  }
  // Accept the three HTTP-date forms, not Date.parse's permissive numeric formats.
  if (!/^(?:[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function resetDelay(value: string | null, now: number): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const deadline = Number(value) * 1000;
  return Number.isSafeInteger(deadline) ? Math.max(0, deadline - now) : undefined;
}

function transportFailure(error: unknown, signal: AbortSignal, responseReceived: boolean): FailureDetails {
  const { codes, complete } = causeCodes(error);
  if (signal.aborted) {
    const failure = forgeRequestFailure(signal);
    return { failure, retryable: failure === "timeout", causeCodes: codes };
  }
  const retryable = complete && codes.length > 0 && codes.every(code => timeoutCodes.has(code) || connectionCodes.has(code));
  const failure = codes.some(code => tlsCodes.has(code)) ? "tls"
    : codes.includes("ABORT_ERR") ? "cancelled"
      : codes.some(code => timeoutCodes.has(code)) ? "timeout"
        : codes.some(code => connectionCodes.has(code) || code === "ENOTFOUND") ? "connection"
          : responseReceived ? "unreadable_response" : "unknown";
  return { failure, retryable, causeCodes: codes };
}

function causeCodes(error: unknown): { codes: string[]; complete: boolean } {
  const codes = new Set<string>();
  const pending = [error];
  const seen = new Set<object>();
  let complete = true;
  while (pending.length && seen.size < 32) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) { complete = false; continue; }
    seen.add(value);
    const code: unknown = Object.getOwnPropertyDescriptor(value, "code")?.value;
    const cause: unknown = Object.getOwnPropertyDescriptor(value, "cause")?.value;
    const errors: unknown = Object.getOwnPropertyDescriptor(value, "errors")?.value;
    if (typeof code === "string" && allowedCodes.has(code)) codes.add(code);
    else if (code !== undefined) complete = false;
    if (cause !== undefined) pending.push(cause);
    if (Array.isArray(errors)) {
      pending.push(...errors.slice(0, 32));
      if (errors.length > 32) complete = false;
    }
    if (code === undefined && cause === undefined && !(Array.isArray(errors) && errors.length)) complete = false;
  }
  return { codes: [...codes], complete: complete && pending.length === 0 };
}

function diagnosticPath(provider: ForgeRepository["provider"], path: string): string {
  const route = path.split(/[?#]/)[0];
  if (["/graphql", "/search/issues", "/user"].includes(route)) return route;
  if (/^\/app\/installations\/\d+\/access_tokens$/.test(route)) return "/app/installations/{installation}/access_tokens";
  const base = provider === "github" ? /^\/repos\/[^/]+\/[^/]+/ : /^\/projects\/[^/]+/;
  const match = route.match(base);
  if (!match) return "/<unrecognized>";
  const suffix = route.slice(match[0].length);
  const prefix = provider === "github" ? "/repos/{owner}/{repo}" : "/projects/{project}";
  if (suffix === "") return prefix;
  const routes: Array<[RegExp, string]> = [
    [/^\/(issues|pulls|merge_requests)$/, "/$1"],
    [/^\/(issues|pulls|merge_requests)\/\d+$/, "/$1/{number}"],
    [/^\/(issues|pulls|merge_requests)\/\d+\/(comments|reviews|notes|approvals|approve|discussions|versions|merge|closes_issues)$/, "/$1/{number}/$2"],
    [/^\/merge_requests\/\d+\/discussions\/[^/]+$/, "/merge_requests/{number}/discussions/{discussion}"],
    [/^\/merge_requests\/\d+\/discussions\/[^/]+\/notes$/, "/merge_requests/{number}/discussions/{discussion}/notes"],
    [/^\/rules\/branches\/[^/]+$/, "/rules/branches/{branch}"],
    [/^\/rulesets\/\d+$/, "/rulesets/{ruleset}"],
  ];
  for (const [pattern, replacement] of routes)
    if (pattern.test(suffix)) return prefix + suffix.replace(pattern, replacement);
  return "/<unrecognized>";
}

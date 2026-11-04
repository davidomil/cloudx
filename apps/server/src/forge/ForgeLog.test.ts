import { describe, expect, it } from "vitest";
import { forgeErrorFields } from "./ForgeLog.js";
import { ForgeRequestFailures } from "./providers/ForgeRequestFailures.js";
import { ForgeMutationUncertainError, ForgeMergeNotStartedError, ForgeProviderError, ForgeProviderUnavailableError } from "./providers/ForgeProvider.js";

describe("Forge log error fields", () => {
  it("distinguishes CloudX status codes from remote HTTP status and unwraps unstarted merges", () => {
    const failure = new ForgeProviderUnavailableError("rate_limited", "request", { retryable: true, retryAfterMs: 120_000 });
    for (const error of [failure, new ForgeMergeNotStartedError(failure)]) {
      expect(forgeErrorFields(error)).toEqual({ failure: "rate_limited", statusCode: 502, retryable: true, retryAfterMs: 120_000 });
      expect(forgeErrorFields(error)).not.toHaveProperty("httpStatus");
    }
  });

  it("labels a local uncertain write separately from provider rejection", () => {
    const error = new ForgeMutationUncertainError(new ForgeProviderUnavailableError("connection"));
    expect(forgeErrorFields(error)).toEqual({ failure: "mutation_uncertain", statusCode: 409, dispatch: "unknown" });
    expect(forgeErrorFields(error)).not.toHaveProperty("httpStatus");
  });

  it("keeps preflight failures and transport causes separate from provider rejection", () => {
    const failures = new ForgeRequestFailures({ provider: "github", apiUrl: "https://api.github.com", projectPath: "a/b" }, "worker", "/repos/a/b/pulls", "POST", "request");
    expect(forgeErrorFields(failures.prepare())).toMatchObject({ failure: "request_not_started", dispatch: "not_started", phase: "prepare" });
    const error = failures.transport(Object.assign(new Error("private"), { code: "EAI_AGAIN" }), new AbortController().signal, true);
    expect(forgeErrorFields(error)).toEqual({ failure: "mutation_uncertain", statusCode: 409, dispatch: "unknown", phase: "fetch", providerFailure: "connection", causeCodes: ["EAI_AGAIN"] });
  });

  it("excludes raw messages, causes and arbitrary error properties", () => {
    expect(forgeErrorFields(new ForgeProviderError("private-provider-error", 403)))
      .toEqual({ failure: "provider_rejected", statusCode: 403 });
    for (const error of [new Error("private-error"), { name: "private-name", code: "private-code" }, "private-token", null])
      expect(forgeErrorFields(error)).toEqual({ failure: "unknown" });
  });
});

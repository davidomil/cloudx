import { describe, expect, it } from "vitest";
import { forgeErrorFields } from "./ForgeLog.js";
import { ForgeMergeNotStartedError, ForgeProviderError, ForgeProviderUnavailableError } from "./providers/ForgeProvider.js";

describe("Forge log error fields", () => {
  it("distinguishes CloudX status codes from remote HTTP status and unwraps unstarted merges", () => {
    const failure = new ForgeProviderUnavailableError("rate_limited", "request", { retryable: true, retryAfterMs: 120_000 });
    for (const error of [failure, new ForgeMergeNotStartedError(failure)]) {
      expect(forgeErrorFields(error)).toEqual({ failure: "rate_limited", statusCode: 502, retryable: true, retryAfterMs: 120_000 });
      expect(forgeErrorFields(error)).not.toHaveProperty("httpStatus");
    }
  });

  it("excludes raw messages, causes and arbitrary error properties", () => {
    expect(forgeErrorFields(new ForgeProviderError("private-provider-error", 403)))
      .toEqual({ failure: "provider_rejected", statusCode: 403 });
    for (const error of [new Error("private-error"), { name: "private-name", code: "private-code" }, "private-token", null])
      expect(forgeErrorFields(error)).toEqual({ failure: "unknown" });
  });
});

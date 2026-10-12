import { describe, expect, it, vi } from "vitest";
import type { ForgeRepository } from "@cloudx/shared";
import { ForgeCredentials } from "./ForgeCredentials.js";
import { ForgeHttpClient } from "./ForgeHttpClient.js";
import { classifyCiLog, maxCiLogBytes, maxCiLogScanBytes, readCiLog } from "./ciEvidence.js";

const source = "a".repeat(40);
const moved = "b".repeat(40);
const checkout = (sha = source, repository = "owner/repo") =>
  `Syncing repository: ${repository}\n[command]/usr/bin/git log -1 --format='%H'\n'${sha}'\n`;
const browserFailure = "TimeoutError: locator.selectOption: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByLabel('Plugin')\n";
const noise = "successful build output\n".repeat(5_000);

async function scan(log: string) {
  return readCiLog(new Response(log), ["worker-private-token"], "owner/repo");
}

describe("complete CI log evidence with bounded excerpts", () => {
  it("retains a late Playwright failure and early checkout after scanning beyond the excerpt", async () => {
    const evidence = await scan(checkout() + noise + browserFailure);
    expect(evidence.checkout).toEqual({ shas: [source], invalid: false });
    expect(evidence.classification).toBe("code");
    expect(evidence.log).toContain(source);
    expect(evidence.log).toContain(browserFailure.trim());
    expect(evidence.log).toContain("full stream scanned");
    expect(evidence.log.length).toBeLessThanOrEqual(32_000);
  });

  it("does not hide conflicting checkouts in the omitted middle", async () => {
    const evidence = await scan(checkout() + noise + checkout(moved) + noise + browserFailure);
    expect(evidence.checkout).toEqual({ shas: [source, moved], invalid: false });
    expect(evidence.log).toContain(moved);
  });

  it("only binds checkouts of the configured repository", async () => {
    const evidence = await scan(checkout(source, "other/repo") + checkout(moved) + browserFailure);
    expect(evidence.checkout).toEqual({ shas: [moved], invalid: false });
  });

  it.each(["not-a-sha\n", ""])("rejects missing or malformed checkout revisions: %s", async revision => {
    const evidence = await scan(`Syncing repository: owner/repo\n[command]/usr/bin/git log -1 --format=%H\n${revision}`);
    expect(evidence.checkout).toEqual({ shas: [], invalid: true });
  });

  it.each([
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
    ["infrastructure", "Runner lost communication with the server"],
  ])("preserves %s blockers from an omitted middle segment", async (classification, blocker) => {
    const evidence = await scan(checkout() + noise + blocker + "\n" + noise + browserFailure);
    expect(evidence.classification).toBe(classification);
    expect(evidence.log).toContain(blocker);
  });

  it("preserves blocker precedence throughout the full stream", async () => {
    const evidence = await scan("Runner offline\n" + noise + "approval required\n" + noise + "HTTP 401 unauthorized\n" + browserFailure);
    expect(evidence.classification).toBe("credentials");
    expect(evidence.log).toContain("HTTP 401 unauthorized");
  });

  it("redacts streamed secrets across chunk and excerpt boundaries", async () => {
    const text = checkout() + "API_TOKEN=first-secret\n" + noise + "-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----\n" + noise + "worker-private-token\nPASSWORD=last-secret\n" + browserFailure;
    const encoded = new TextEncoder().encode(text);
    let offset = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (offset >= encoded.length) return controller.close();
        controller.enqueue(encoded.subarray(offset, offset + 17));
        offset += 17;
      },
    }));
    const evidence = await readCiLog(response, ["worker-private-token"], "owner/repo");
    for (const secret of ["first-secret", "last-secret", "private-key-body", "worker-private-token"])
      expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(evidence.log).toContain("REDACTED");
    expect(evidence.classification).toBe("code");
  });

  it("preserves small redacted logs exactly", async () => {
    const log = checkout() + browserFailure;
    expect((await scan(log)).log).toBe(log);
    expect((await scan("API_TOKEN=private\n")).log).toBe("API_TOKEN=[REDACTED]\n");
  });

  it.each([
    '{\n  "token":\n    "opaque-value"\n}\n',
    "{\n  'password':\n    'opaque-value'\n}\n",
    'TOKEN="first-line\\"\nopaque-value\nlast-line"\n',
    "SECRET=\nopaque-value\n",
    '2026-10-12T03:00:00.000Z "token":\n2026-10-12T03:00:00.001Z "first-line\n2026-10-12T03:00:00.002Z opaque-value\n2026-10-12T03:00:00.003Z last-line"\n',
  ])("redacts unknown multiline credentials without retaining continuation values", async log => {
    const evidence = await scan(log + browserFailure);
    expect(evidence.log).not.toContain("opaque-value");
    expect(evidence.log).not.toContain("first-line");
    expect(evidence.log).not.toContain("last-line");
    expect(evidence.log).toContain("REDACTED");
    expect(evidence.log).toContain(browserFailure.trim());
  });

  it("fails clearly and cancels when the complete scan exceeds the byte budget", async () => {
    const cancel = vi.fn();
    let bytes = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        const chunk = new TextEncoder().encode(`${"ok ".repeat(1_000)}\n`.repeat(10));
        bytes += chunk.length;
        controller.enqueue(chunk);
      }, cancel,
    }));
    await expect(readCiLog(response, [], "owner/repo")).rejects.toThrow("full-scan byte limit");
    expect(bytes).toBeGreaterThan(maxCiLogScanBytes);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("fails clearly on an oversized line before retaining it", async () => {
    await expect(scan("x".repeat(maxCiLogBytes + 1))).rejects.toThrow("line beyond");
  });

  it("exposes the scanned checkout and classification through the HTTP client", async () => {
    const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "owner/repo" };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(checkout() + noise + browserFailure));
    const http = new ForgeHttpClient(repository, new ForgeCredentials(repository, async () => ({ kind: "token", token: "worker-private-token" })), fetcher);
    expect(await http.ciLogEvidence("/repos/owner/repo/actions/jobs/501/logs")).toMatchObject({
      classification: "code", checkout: { shas: [source], invalid: false },
    });
  });
});

describe("Playwright failure classification", () => {
  it.each([
    browserFailure,
    "Error: expect(locator).toBeVisible() failed\nLocator: getByRole('button')\nExpected: visible\nReceived: hidden\n",
    "Error: expect(locator).toHaveText(expected)\nExpected string: \"ready\"\nReceived string: \"waiting\"\nAssertion failed",
  ])("recognizes browser action and assertion failures", log => {
    expect(classifyCiLog(log)).toBe("code");
  });

  it("keeps operational blockers ahead of browser failures", () => {
    expect(classifyCiLog(browserFailure + "fatal: authentication failed")).toBe("credentials");
    expect(classifyCiLog(browserFailure + "approval required")).toBe("policy");
    expect(classifyCiLog(browserFailure + "network is unreachable")).toBe("infrastructure");
  });

  it("keeps expected HTTP errors in assertions classified as code", () => {
    expect(classifyCiLog("AssertionError: expected HTTP 403 to equal received HTTP 401")).toBe("code");
  });
});

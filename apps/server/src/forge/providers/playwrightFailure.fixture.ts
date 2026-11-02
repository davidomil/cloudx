import { createRequire } from "node:module";
import { expect as playwrightExpect } from "@playwright/test";

// Use the locked runner's formatter so these examples track actual reporter output.
const { base } = createRequire(import.meta.url)("playwright/lib/runner") as {
  base: { nonTerminalScreen: object; formatFailure(screen: object, config: object, test: object, index: number): string };
};

export const playwrightAssertions = [
  { name: ".toBe", fail: () => playwrightExpect("three").toBe("NEXT") },
  { name: ".not.toBe", fail: () => playwrightExpect("NEXT").not.toBe("NEXT") },
  { name: ".resolves.toBe", fail: () => playwrightExpect(Promise.resolve("three")).resolves.toBe("NEXT") },
  { name: ".rejects.toBe", fail: () => playwrightExpect(Promise.reject("three")).rejects.toBe("NEXT") },
  { name: ".resolves.not.toBe", fail: () => playwrightExpect(Promise.resolve("NEXT")).resolves.not.toBe("NEXT") },
  { name: ".rejects.not.toBe", fail: () => playwrightExpect(Promise.reject("NEXT")).rejects.not.toBe("NEXT") },
];

export async function playwrightFailureReport(assertion: typeof playwrightAssertions[number]): Promise<string> {
  let failure: Error | undefined;
  try { await assertion.fail(); } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure = error;
  }
  if (!failure) throw new Error(`The ${assertion.name} fixture must fail its Playwright assertion.`);
  const attachment = JSON.stringify({ level: 50, err: { type: "DocumentationServiceUnavailableError",
    message: `Documentation service unavailable at http://127.0.0.1:9/enrichment/pending: ${"fetch failed ".repeat(40)}` } });
  const test = {
    titlePath: () => ["", "chromium", "tests/browser/promise.spec.ts", "preserves promise assertion evidence"],
    location: { file: "/fixture/tests/browser/promise.spec.ts", line: 10, column: 3 },
    tags: [], expectedStatus: "passed",
    results: [{ status: "failed", retry: 0, errors: [{ message: failure.message, stack: failure.stack }], steps: [],
      attachments: [{ name: "server.log", contentType: "text/plain", body: Buffer.from(attachment) }] }],
  };
  return ["Running 1 test using 1 worker", base.formatFailure(base.nonTerminalScreen, { rootDir: "/fixture", tags: [] }, test, 1), "1 failed", ""].join("\n");
}

import { describe, expect, it, vi } from "vitest";
import type { ForgeCiDiagnostic, ForgeRepository } from "@cloudx/shared";
import { ForgeCredentials } from "./ForgeCredentials.js";
import { ForgeHttpClient } from "./ForgeHttpClient.js";
import { classifyCiLog, classifyDiagnostic, maxCiLogBytes, maxCiLogScanBytes, readCiLog } from "./ciEvidence.js";

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

  it.each([
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
    ["infrastructure", "Runner lost communication with the server"],
  ])("retains redacted context around a %s blocker deep in an omitted line", async (classification, blocker) => {
    const middle = `${"x".repeat(1_500)} "token":"opaque-context-secret", worker-private-token ${blocker} ${"y".repeat(1_500)}\n`;
    const evidence = await scan(checkout() + noise + middle + noise + browserFailure);
    expect(evidence.classification).toBe(classification);
    expect(evidence.log).toContain(blocker);
    expect(evidence.log).toContain("REDACTED");
    expect(evidence.log).not.toContain("opaque-context-secret");
    expect(evidence.log).not.toContain("worker-private-token");
    expect(evidence.log).not.toContain("x".repeat(1_000));
    expect(evidence.log).not.toContain("y".repeat(1_000));
    expect(evidence.log.length).toBeLessThanOrEqual(32_000);
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

const testRun = " RUN  v4.1.11 /work/repository\n";
const failingTest = "apps/server/src/documentation/DocumentationClient.test.ts > DocumentationClient > keeps streaming ingest URL requests alive while progress arrives";
const failedTests = `⎯⎯⎯ Failed Tests 1 ⎯⎯⎯\n FAIL  ${failingTest}\nError: Documentation progress stream was quiet for 30 ms.\n ❯ DocumentationClient.requestProgress apps/server/src/documentation/DocumentationClient.ts:537:15\n`;
const testSummary = " Test Files  1 failed | 23 passed (24)\n      Tests  1 failed | 874 passed | 1 skipped (876)\n   Duration  459.71s\n";
const fixtureMessage = "Documentation service unavailable at http://127.0.0.1:1/enrichment/pending: fetch failed: bad port";
const fixtureRequest = JSON.stringify({ level: 50, req: { method: "POST", url: "/api/hooks/documentation.documents.list" }, res: { statusCode: 503 }, err: { type: "DocumentationServiceUnavailableError", message: fixtureMessage, stack: `Error: ${fixtureMessage}\n    at DocumentationClient.fetchService` }, msg: fixtureMessage }) + "\n";
const fixtureOutput = `··${JSON.stringify({ level: 50, time: 1792116115439, pid: 270, err: { type: "DocumentationServiceUnavailableError", message: fixtureMessage, stack: `Error: ${fixtureMessage}\n    at DocumentationClient.fetchService` }, msg: "Documentation background enrichment failed." })}\n`;

async function diagnoseStream(log: string, chunkSize = 17) {
  const bytes = new TextEncoder().encode(log);
  let offset = 0;
  const evidence = await readCiLog(new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset = Math.min(offset + chunkSize, bytes.length);
    },
  })), [], "owner/repo");
  const diagnostic: ForgeCiDiagnostic = {
    repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "owner/repo" },
    changeNumber: 7, sourceHeadSha: source, targetHeadSha: moved, failureKey: "", state: "blocked",
    jobs: [{ runId: "100", runAttempt: 1, jobId: "501", name: "Isolated verifier (coverage-1)", conclusion: "failure",
      url: "https://github.com/owner/repo/actions/runs/100/job/501", testedSha: source, log: evidence.log, classification: evidence.classification }],
  };
  classifyDiagnostic(diagnostic);
  expect(classifyCiLog(log)).toBe(evidence.classification);
  return { evidence, diagnostic };
}

describe("failure-scoped CI evidence", () => {
  it.each(["early", "middle", "late"])("keeps %s passing-fixture output from blocking the failed streaming test", async position => {
    const fixture = fixtureOutput + fixtureRequest;
    const execution = [position === "early" ? fixture : "", noise, position === "middle" ? fixture : "", noise, position === "late" ? fixture : ""].join("");
    const log = checkout() + testRun + execution + failedTests + testSummary;
    const { evidence, diagnostic } = await diagnoseStream(log);
    expect(evidence.classification).toBe("code");
    expect(diagnostic.state).toBe("actionable");
    expect(evidence.log).toContain("full stream scanned");
    expect(evidence.log).toContain("Documentation progress stream was quiet");
    expect(evidence.log).not.toContain("[Operational blocker evidence]");
    expect(evidence.log.length).toBeLessThanOrEqual(32_000);
  });

  it.each([1, 7, 1024])("recognizes timestamped ANSI output across %i-byte chunks", async chunkSize => {
    const log = (checkout() + testRun + fixtureOutput + failedTests + testSummary).split("\n")
      .map(line => `2026-10-16T02:01:55.4500139Z \x1b[31m${line}\x1b[39m`).join("\r\n");
    expect((await diagnoseStream(log, chunkSize)).diagnostic.state).toBe("actionable");
  });

  it.each(["stdout", "stderr"])("associates %s operational output with its named test", async stream => {
    const file = failingTest.split(" > ")[0];
    const passing = `${file} > DocumentationClient > handles an unavailable documentation fixture`;
    const output = (name: string) => `${stream} | ${name}\nservice unavailable\n\n`;
    expect((await diagnoseStream(checkout() + testRun + output(passing) + failedTests + testSummary)).diagnostic.state).toBe("actionable");
    const { evidence, diagnostic } = await diagnoseStream(checkout() + testRun + output(failingTest) + failedTests + testSummary);
    expect(evidence.classification).toBe("infrastructure");
    expect(diagnostic.state).toBe("blocked");
    expect((await diagnoseStream(checkout() + testRun + output(file) + failedTests + testSummary)).diagnostic.state).toBe("blocked");
  });

  it.each(["stdout", "stderr"])("recognizes dot-prefixed %s headers with ANSI and timestamps", async stream => {
    const log = checkout() + testRun + `2026-10-16T02:01:55.4500139Z ···\x1b[90m${stream}\x1b[39m | apps/server/src/server.test.ts > handles fixture failure\n` +
      "2026-10-16T02:01:55.4500140Z service unavailable\n\n" + failedTests + testSummary;
    expect((await diagnoseStream(log)).diagnostic.state).toBe("actionable");
  });

  it.each(["x", "-", "*", "·x-*✓×↓"])("recognizes mixed reporter statuses %s before fixture records and console headers", async prefix => {
    const output = prefix + fixtureOutput.slice(2) + `${prefix}stderr | apps/server/src/server.test.ts > passing fixture\nservice unavailable\n\n`;
    const log = (checkout() + testRun + noise + output + noise + failedTests + testSummary).split("\n")
      .map(line => `2026-10-16T02:01:55.4500139Z \x1b[31m${line}\x1b[39m`).join("\r\n");
    const { evidence, diagnostic } = await diagnoseStream(log, 7);
    expect(evidence.classification).toBe("code");
    expect(diagnostic.state).toBe("actionable");
    expect(evidence.log).toContain("full stream scanned");
  });

  it.each([
    { output: failingTest, failure: `|unit| ${failingTest}`, classification: "infrastructure" },
    { output: failingTest.split(" > ")[0], failure: `|unit| ${failingTest}`, classification: "infrastructure" },
    { output: failingTest.split(" > ").slice(0, 2).join(" > "), failure: `|unit| ${failingTest}`, classification: "infrastructure" },
    { output: `|unit| ${failingTest}`, failure: `|unit| ${failingTest}`, classification: "infrastructure" },
    { output: `|unit| ${failingTest}`, failure: failingTest, classification: "infrastructure" },
    { output: `|browser| ${failingTest}`, failure: `|unit| ${failingTest}`, classification: "code" },
    { output: `${failingTest} with a passing fixture`, failure: `|unit| ${failingTest}`, classification: "code" },
  ])("matches named-project console output conservatively: $output / $failure", async ({ output, failure, classification }) => {
    const log = checkout() + testRun + `stderr | ${output}\nservice unavailable\n\n` + failedTests.replace(failingTest, failure) + testSummary;
    const { evidence, diagnostic } = await diagnoseStream(log, 1);
    expect(evidence.classification).toBe(classification);
    expect(diagnostic.state).toBe(classification === "code" ? "actionable" : "blocked");
  });

  it.each([true, false])("counts identical failures in different projects separately with ambiguous console output: %s", async failedOutput => {
    const output = failedOutput ? failingTest : `${failingTest} with a passing fixture`;
    const failures = failedTests.replace(failingTest, `|unit| ${failingTest}`) + failedTests.replace(failingTest, `|browser| ${failingTest}`);
    const log = checkout() + testRun + fixtureOutput + `stderr | ${output}\nservice unavailable\n\n` +
      failures + testSummary.replaceAll("1 failed", "2 failed");
    const { evidence, diagnostic } = await diagnoseStream(log);
    expect(evidence.classification).toBe(failedOutput ? "infrastructure" : "code");
    expect(diagnostic.state).toBe(failedOutput ? "blocked" : "actionable");
  });

  const projectBadge = (name: string) => `\x1b[30m\x1b[42m ${name} \x1b[49m\x1b[39m`;
  // Captured from a Vitest 4.1.11 named-project timeout with FORCE_COLOR=1.
  const coloredFailure = (project: string, task = failingTest) =>
    `\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m ${projectBadge(project)} ${task}\nError: Test timed out in 25ms.\n`;

  it.each(["test", "suite", "file"])("associates %s console output with a genuine colored-project failure", async scope => {
    const task = scope === "file" ? failingTest.split(" > ")[0] : scope === "suite" ? failingTest.split(" > ").slice(0, 2).join(" > ") : failingTest;
    const output = `\x1b[90mstderr\x1b[2m | ${task}\n\x1b[22m\x1b[39mservice unavailable\n\n`;
    const log = (checkout() + testRun + output + coloredFailure("unit") + testSummary).split("\n")
      .map(line => `2026-10-16T02:01:55.4500139Z ${line}`).join("\r\n");
    const { evidence, diagnostic } = await diagnoseStream(log, 1);
    expect(evidence.classification).toBe("infrastructure");
    expect(diagnostic.state).toBe("blocked");
  });

  it.each([
    { project: "unit", output: failingTest, classification: "infrastructure" },
    { project: "unit integration", output: failingTest, classification: "infrastructure" },
    { project: "unit", output: `|browser| ${failingTest}`, classification: "code" },
    { project: "unit", output: `${projectBadge("browser")} ${failingTest}`, classification: "code" },
    { project: "unit", output: `${projectBadge("unit")} ${failingTest}`, classification: "infrastructure" },
    { project: "unit", output: `${failingTest} with a passing fixture`, classification: "code" },
  ])("keeps colored project identities separate: $project / $output", async ({ project, output, classification }) => {
    const log = checkout() + testRun + noise + `x-*stderr | ${output}\nservice unavailable\n\n` + noise + coloredFailure(project) + testSummary;
    const { evidence, diagnostic } = await diagnoseStream(log, 7);
    expect(evidence.classification).toBe(classification);
    expect(diagnostic.state).toBe(classification === "code" ? "actionable" : "blocked");
    expect(evidence.log).toContain("full stream scanned");
  });

  it("counts identical failures in different colored projects separately", async () => {
    const log = checkout() + testRun + fixtureOutput + coloredFailure("unit") + coloredFailure("browser") +
      testSummary.replaceAll("1 failed", "2 failed");
    const { evidence, diagnostic } = await diagnoseStream(log);
    expect(evidence.classification).toBe("code");
    expect(diagnostic.state).toBe("actionable");
  });

  it("preserves double spaces in an unlabelled task path", async () => {
    const task = "directory  with spaces/named.test.ts > test";
    const log = checkout() + testRun + `stderr | ${task}\nservice unavailable\n\n` +
      failedTests.replace(failingTest, task) + testSummary;
    expect((await diagnoseStream(log)).diagnostic.state).toBe("blocked");
  });

  it("preserves colored values inside task names", async () => {
    const task = `${failingTest} with ${projectBadge("unit")} output`;
    const log = checkout() + testRun + `stderr | ${task}\nservice unavailable\n\n` + coloredFailure("browser", task) + testSummary;
    expect((await diagnoseStream(log)).diagnostic.state).toBe("blocked");
  });

  it.each(["HTTP 403", "approval required", "runner offline"])("keeps serialized assertion comparisons containing %s actionable", async actual => {
    let assertion: Error | undefined;
    try { expect(actual).toBe("expected fixture value"); }
    catch (error) { if (error instanceof Error) assertion = error; else throw error; }
    expect(assertion?.name).toBe("AssertionError");
    const err = { type: assertion!.name, message: assertion!.message, stack: assertion!.stack };
    for (const msg of ["Caught assertion fixture.", err.message, `${err.type}: ${err.message}`, `Caught assertion fixture: ${err.message} (comparison)`]) {
      const output = JSON.stringify({ level: 50, msg, err }) + "\n";
      for (const header of ["", "x-*stdout | passing.test.ts > catches a comparison\n"]) {
        const log = checkout() + testRun + noise + header + output + "\n" + noise + failedTests + testSummary;
        const { evidence, diagnostic } = await diagnoseStream(log, 7);
        expect(evidence.classification, msg + header).toBe("code");
        expect(diagnostic.state).toBe("actionable");
        expect(evidence.log).not.toContain("[Operational blocker evidence]");
      }
    }
  });

  it.each([
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
    ["infrastructure", "Runner lost communication with the server"],
    ["infrastructure", "no space left on device"],
  ])("preserves independent %s controls alongside a serialized assertion", async (classification, blocker) => {
    const assertion = { type: "AssertionError", message: "expected 'runner offline' to be 'runner online' // Object.is equality",
      stack: "AssertionError: expected 'runner offline' to be 'runner online' // Object.is equality\n    at fixture" };
    for (const controls of [
      [{ level: 50, msg: blocker, err: assertion }],
      [{ level: 50, msg: `${blocker}: ${assertion.message}`, err: assertion }],
      [{ level: 50, msg: "Caught assertion fixture.", err: assertion },
        { level: 50, msg: "CI execution failed while reporting AssertionError.", err: { type: "Error", message: blocker, stack: `Error: ${blocker}` } }],
      [{ level: 50, msg: "CI execution failed.", err: { type: "Error", message: `${blocker} while reporting AssertionError.`, stack: `Error: ${blocker}` } }],
    ]) {
      const log = checkout() + testRun + controls.map(record => JSON.stringify(record) + "\n").join("") + failedTests + testSummary;
      const { evidence, diagnostic } = await diagnoseStream(log, 1);
      expect(evidence.classification).toBe(classification);
      expect(diagnostic.state).toBe("blocked");
    }
  });

  it.each([
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
    ["infrastructure", "Runner lost communication with the server"],
    ["infrastructure", "service unavailable"],
  ])("preserves genuine %s failures alongside fixture and assertion output", async (classification, blocker) => {
    for (const phase of ["before", "during", "after"]) {
      const log = checkout() + (phase === "before" ? blocker + "\n" : "") + testRun + fixtureOutput + noise +
        (phase === "during" ? blocker + "\n" : "") + noise + failedTests + testSummary + (phase === "after" ? blocker + "\n" : "");
      const { evidence, diagnostic } = await diagnoseStream(log, 1024);
      expect(evidence.classification, phase).toBe(classification);
      expect(diagnostic.state, phase).toBe("blocked");
      expect(evidence.log, phase).toContain(blocker);
    }
  });

  it.each([
    ["infrastructure", "Runner lost communication with the server"],
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
  ])("keeps %s annotations outside an open test console block", async (classification, blocker) => {
    const log = checkout() + testRun + "stderr | apps/server/src/server.test.ts > passing fixture\n" +
      fixtureOutput + `##[error]${blocker}\n` + failedTests + testSummary;
    const { evidence, diagnostic } = await diagnoseStream(log);
    expect(evidence.classification).toBe(classification);
    expect(diagnostic.state).toBe("blocked");
  });

  it.each([
    ["infrastructure", "Runner lost communication with the server"],
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
  ])("keeps structured %s job controls authoritative", async (classification, blocker) => {
    const control = JSON.stringify({ level: 50, msg: blocker, err: { type: "Error", message: blocker, stack: `Error: ${blocker}\n    at runner` } }) + "\n";
    const { evidence, diagnostic } = await diagnoseStream(checkout() + testRun + fixtureOutput + control + failedTests + testSummary);
    expect(evidence.classification).toBe(classification);
    expect(diagnostic.state).toBe("blocked");
  });

  it.each([
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
    ["infrastructure", "Runner lost communication with the server"],
    ["infrastructure", "no space left on device"],
  ])("preserves %s causes inside generic structured errors", async (classification, blocker) => {
    for (const field of ["type", "message", "stack"]) {
      const control = JSON.stringify({ level: 50, msg: "CI execution failed.",
        err: { type: "Error", message: "CI execution failed.", stack: "Error: CI execution failed.", [field]: blocker } }) + "\n";
      for (const consoleHeader of ["", "stderr | apps/server/src/server.test.ts > passing fixture\n"]) {
        const log = checkout() + testRun + noise + fixtureOutput + consoleHeader + control + "\n" + noise + failedTests + testSummary;
        const { evidence, diagnostic } = await diagnoseStream(log, 1024);
        expect(evidence.classification, field + consoleHeader).toBe(classification);
        expect(diagnostic.state, field + consoleHeader).toBe("blocked");
        expect(evidence.log).toContain(blocker);
        expect(evidence.log).toContain("[Operational blocker evidence]");
      }
    }
  });

  it("keeps ordinary Vitest runner stack frames from making fixture output authoritative", async () => {
    const output = fixtureOutput.replace("at DocumentationClient.fetchService", "at /work/node_modules/@vitest/runner/dist/index.js:123:1");
    const { evidence, diagnostic } = await diagnoseStream(checkout() + testRun + output + failedTests + testSummary);
    expect(evidence.classification).toBe("code");
    expect(diagnostic.state).toBe("actionable");
  });

  it.each([
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
    ["infrastructure", "Runner lost communication with the server"],
    ["infrastructure", "failed to prepare environment"],
    ["infrastructure", "system failure"],
    ["infrastructure", "no space left on device"],
  ])("keeps structured %s causes authoritative despite assertion wording in the wrapper", async (classification, blocker) => {
    const control = JSON.stringify({ level: 50, msg: "CI execution failed while reporting AssertionError.",
      err: { type: "Error", message: blocker, stack: `Error: ${blocker}` } }) + "\n";
    const { evidence, diagnostic } = await diagnoseStream(checkout() + testRun + control + failedTests + testSummary);
    expect(evidence.classification).toBe(classification);
    expect(diagnostic.state).toBe("blocked");
  });

  it("does not treat a failing test's title as an operational error", async () => {
    const name = failingTest + " when service unavailable";
    const log = checkout() + testRun + `stderr | ${name}\nfixture output\n\n` +
      failedTests.replace(failingTest, name) + testSummary;
    expect((await diagnoseStream(log)).diagnostic.state).toBe("actionable");
  });

  it("blocks when the failed test reports a real service outage", async () => {
    const failure = failedTests.replace("Error: Documentation progress stream was quiet for 30 ms.", "Error: service unavailable at https://dependency.example");
    const { evidence, diagnostic } = await diagnoseStream(checkout() + testRun + fixtureOutput + failure + testSummary);
    expect(evidence.classification).toBe("infrastructure");
    expect(diagnostic.state).toBe("blocked");
  });

  it.each([
    testRun + fixtureOutput,
    testRun + fixtureOutput + failedTests,
    testRun + fixtureOutput + failedTests + "Tests  2 failed | 874 passed\n",
    testRun + fixtureOutput + "Tests  874 passed\n" + browserFailure,
    testRun + fixtureOutput + "Tests  0 failed | 874 passed\n" + browserFailure,
    fixtureOutput + failedTests + testSummary,
    testRun + fixtureOutput + "##[group]Build\n" + failedTests + testSummary,
    testRun + fixtureOutput + "##[endgroup]\n" + failedTests + testSummary,
    testRun + fixtureOutput + "section_end:1792116116:test\n" + failedTests + testSummary,
    testRun + fixtureOutput + testRun + failedTests + testSummary,
  ])("retains uncertain operational evidence when the emitting run lacks a complete failed-test report", async log => {
    const { evidence, diagnostic } = await diagnoseStream(checkout() + log);
    expect(evidence.classification).toBe("infrastructure");
    expect(diagnostic.state).toBe("blocked");
  });

  it.each([
    '··{"level":50,"msg":"service unavailable"',
    '{"msg":"service unavailable"}\n',
    '{"level":50,"message":"service unavailable"}\n',
    '{"level":50,"msg":"service unavailable"}\n',
    '{"level":50,"msg":"application event","other":"service unavailable"}\n',
  ])("keeps unrecognized structured output conservative", async output => {
    const { diagnostic } = await diagnoseStream(checkout() + testRun + output + "\n" + failedTests + testSummary);
    expect(diagnostic.state).toBe("blocked");
  });

  it("retains redacted provisional evidence from an incomplete run", async () => {
    const output = fixtureOutput.replace("bad port", "bad port worker-private-token");
    const evidence = await scan(checkout() + testRun + noise + output + noise);
    expect(evidence.classification).toBe("infrastructure");
    expect(evidence.log).toContain("[Operational blocker evidence]");
    expect(evidence.log).toContain("[REDACTED]");
    expect(evidence.log).not.toContain("worker-private-token");
  });

  it("keeps a later job phase's application logs blocking", async () => {
    const { evidence, diagnostic } = await diagnoseStream(checkout() + testRun + fixtureOutput + failedTests + testSummary + "##[group]Deploy\n" + fixtureOutput);
    expect(evidence.classification).toBe("infrastructure");
    expect(diagnostic.state).toBe("blocked");
  });
});

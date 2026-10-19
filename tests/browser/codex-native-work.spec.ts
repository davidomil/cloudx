import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type {
  CodexNativeWork,
  WorkspaceTab,
} from "../../packages/shared/src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let server: ViteDevServer;
let httpServer: Server;
let baseUrl: string;

test.beforeAll(async () => {
  httpServer = createHttpServer();
  server = await createServer({
    configFile: false,
    root: repoRoot,
    plugins: [react()],
    resolve: {
      alias: {
        "@cloudx/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      },
    },
    server: { middlewareMode: { server: httpServer }, ws: false },
    optimizeDeps: { entries: ["tests/browser/fixtures/native-work.html"] },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/native-work.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function openFixture(page: Page) {
  const sockets: Record<string, WebSocketRoute[]> = {
    affected: [],
    sibling: [],
  };
  const input: Record<string, string[]> = { affected: [], sibling: [] };
  await page.route("**/api/tabs/*/command-details", (route) => {
    const tabId = route.request().url().split("/").at(-2)!;
    return route.fulfill({
      json: {
        version: 1,
        tabId,
        executionId: "",
        status: "unavailable",
        commands: [],
        reason: "Native protocol fixture.",
      },
    });
  });
  await page.routeWebSocket("**/ws/terminal/*", (socket) => {
    const tabId = socket.url().split("/").at(-1)!;
    sockets[tabId].push(socket);
    socket.send(
      JSON.stringify({ type: "data", data: `Codex ${tabId} prompt > ` }),
    );
    socket.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === "input") {
        input[tabId].push(event.data);
        socket.send(JSON.stringify({ type: "data", data: event.data }));
      }
    });
  });
  await page.goto(baseUrl);
  await expect(
    page.getByRole("heading", { name: "Native turn failed · Goal blocked" }),
  ).toBeVisible();
  return { sockets, input };
}

function restoredTab(): WorkspaceTab {
  const updatedAt = "2026-10-12T21:00:00Z";
  return {
    id: "affected",
    pluginId: "codex-terminal",
    title: "Affected Codex",
    cwd: "/workspace/affected",
    status: "running",
    createdAt: updatedAt,
    updatedAt,
    indicator: { color: "green", label: "Running", updatedAt },
    nativeWork: {
      version: 1,
      tabId: "affected",
      executionId: "restarted-execution",
      threadId: "exact-conversation",
      updatedAt,
      turnStatus: "failed",
      goalStatus: "blocked",
      recoveryStatus: "awaiting_goal_resume",
    },
  };
}

async function observe(page: Page, work: Partial<CodexNativeWork>) {
  await page.evaluate(
    (work) =>
      (
        window as unknown as {
          observeNativeWork(work: Partial<CodexNativeWork>): void;
        }
      ).observeNativeWork(work),
    work,
  );
}

test("keeps failure diagnostics and input live, binds restart through tab switching, and waits for native completion", async ({
  page,
}, testInfo) => {
  const requests: Array<{ path: string; body: unknown }> = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tabs/*/recover", async (route) => {
    requests.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    await released;
    await route.fulfill({ json: restoredTab() });
  });
  const { sockets, input } = await openFixture(page);
  const panel = page.getByRole("region", {
    name: "Native work for Affected Codex",
  });
  await expect(panel).toContainText("request-after-http-200");
  await expect(panel).toContainText("HTTP status: 200");
  await expect(panel).toContainText("Native turn: Failed");
  await expect(panel).toContainText("Terminal process: Running");
  await expect(panel).toContainText("does not establish native completion");
  const terminal = page.locator('[data-tab="affected"] .terminal-panel');
  await expect(terminal).toBeVisible();
  const bounds = await terminal.boundingBox();
  expect(bounds!.height).toBeGreaterThan(120);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("inspect blocked goal");
  await expect.poll(() => input.affected.join("")).toBe("inspect blocked goal");
  await expect(terminal.locator(".xterm-rows")).toContainText(
    "inspect blocked goal",
  );
  const evidenceDirectory = path.join(repoRoot, "test-results/issue209");
  await mkdir(evidenceDirectory, { recursive: true });
  const screenshot = path.join(
    evidenceDirectory,
    testInfo.project.name.startsWith("desktop")
      ? "native-recovery.png"
      : "native-recovery-mobile.png",
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach("native-work-failure", {
    path: screenshot,
    contentType: "image/png",
  });

  await sockets.affected[0].close({ code: 1001 });
  await expect.poll(() => sockets.affected.length).toBe(2);
  await expect(panel).toContainText("request-after-http-200");
  await panel
    .getByRole("button", { name: "Restart this Codex client" })
    .click();
  await expect.poll(() => requests.length).toBe(1);
  await page
    .getByRole("button", { name: "Working Codex", exact: true })
    .click();
  await page.locator('[data-tab="sibling"] .xterm-helper-textarea').focus();
  await page.keyboard.type("parallel turn remains live");
  await expect
    .poll(() => input.sibling.join(""))
    .toBe("parallel turn remains live");
  release();
  await expect.poll(() => sockets.affected.length).toBe(3);
  expect(sockets.sibling).toHaveLength(1);
  expect(requests).toEqual([
    {
      path: "/api/tabs/affected/recover",
      body: {
        action: "restart-native",
        executionId: "affected-execution",
        sessionId: "exact-conversation",
      },
    },
  ]);
  await page
    .getByRole("button", { name: "Affected Codex", exact: true })
    .click();
  await expect(panel).toContainText("Waiting for explicit goal resume");
  await expect(
    panel.getByRole("button", { name: "Restart this Codex client" }),
  ).toHaveCount(0);
  await expect(panel).not.toContainText("Recovery succeeded");
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("/goal resume");
  await page.keyboard.press("Enter");
  await expect.poll(() => input.affected.join("")).toContain("/goal resume\r");
  await observe(page, {
    turnStatus: "running",
    goalStatus: "active",
    recoveryStatus: "running",
  });
  await expect(panel).toContainText("Waiting for native completion");
  await expect(panel).not.toContainText("Recovery succeeded");
  await observe(page, { turnStatus: "completed", recoveryStatus: "succeeded" });
  await expect(panel).toContainText(
    "Recovery succeeded: a subsequent native turn completed",
  );
  expect(requests).toHaveLength(1);
});

test("leaves repeated native failure blocked with diagnostics and a deliberate recovery choice", async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route("**/api/tabs/*/recover", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: restoredTab() });
  });
  const { input } = await openFixture(page);
  const panel = page.getByRole("region", {
    name: "Native work for Affected Codex",
  });
  await panel
    .getByRole("button", { name: "Restart this Codex client" })
    .click();
  await expect(panel).toContainText("Waiting for explicit goal resume");
  await observe(page, {
    turnStatus: "running",
    goalStatus: "active",
    recoveryStatus: "running",
  });
  await observe(page, {
    turnStatus: "failed",
    goalStatus: "blocked",
    recoveryStatus: "failed",
    lastError: {
      kind: "terminal",
      message: "The provider failed again.",
      code: "repeated_failure",
      requestId: "second-request",
    },
  });
  await expect(panel).toContainText("Recovery failed");
  await expect(panel).toContainText("Goal blocked");
  await expect(panel).toContainText("second-request");
  await expect(
    panel.getByRole("button", { name: "Restart this Codex client" }),
  ).toBeEnabled();
  await expect(panel).not.toContainText("Recovery succeeded");
  await page.locator('[data-tab="affected"] .xterm-helper-textarea').focus();
  await page.keyboard.type("inspect repeated failure");
  await expect
    .poll(() => input.affected.join(""))
    .toBe("inspect repeated failure");
  expect(requests).toHaveLength(1);
});

test("collapses blocked-goal details across refresh, reconnect and tabs while input stays live; new failures reopen", async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route("**/api/tabs/*/recover", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: restoredTab() });
  });
  const { sockets, input } = await openFixture(page);
  await observe(page, { turnStatus: "running" });
  const panel = page.getByRole("region", {
    name: "Native work for Affected Codex",
  });
  await expect(panel.getByRole("heading")).toHaveText(
    "Native turn running · Goal blocked",
  );
  await expect(panel).not.toContainText("native work stopped");
  await expect(
    panel.getByRole("button", { name: "Restart this Codex client" }),
  ).toBeDisabled();
  await expect(panel).toContainText(
    "After the running turn finishes, enter /goal resume",
  );
  await panel.getByRole("button", { name: "Hide native work details" }).click();
  await expect(
    panel.getByRole("button", { name: "Show native work details" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    panel.getByText("request-after-http-200", { exact: false }),
  ).toBeHidden();
  await observe(page, { updatedAt: "2026-10-15T23:00:00Z" });
  await sockets.affected[0].close({ code: 1001 });
  await expect.poll(() => sockets.affected.length).toBe(2);
  await expect(
    panel.getByRole("button", { name: "Show native work details" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Working Codex", exact: true })
    .click();
  const sibling = page.getByRole("region", {
    name: "Native work for Working Codex",
  });
  await expect(
    sibling.getByRole("button", { name: "Hide native work details" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Affected Codex", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Show native work details" }),
  ).toBeVisible();
  await page.locator('[data-tab="affected"] .xterm-helper-textarea').focus();
  await page.keyboard.type("continue ordinary work");
  await expect
    .poll(() => input.affected.join(""))
    .toBe("continue ordinary work");
  expect(requests).toHaveLength(0);

  // Starting an ordinary turn keeps the dismissed failure compact.
  await observe(page, { turnStatus: "failed" });
  await panel.getByRole("button", { name: "Hide native work details" }).click();
  await observe(page, { turnStatus: "running" });
  await expect(
    panel.getByRole("button", { name: "Show native work details" }),
  ).toBeVisible();
  await expect(panel.getByRole("heading")).toHaveText(
    "Native turn running · Goal blocked",
  );
  // The fixture starts failed on reload; dismiss that exact failure first.
  await observe(page, { turnStatus: "failed" });
  await panel.getByRole("button", { name: "Hide native work details" }).click();
  await page.reload();
  await expect(
    panel.getByRole("button", { name: "Show native work details" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Show native work details" }).click();
  await expect(
    panel.getByText("request-after-http-200", { exact: false }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Hide native work details" }).click();
  await observe(page, {
    turnId: "new-failed-turn",
    lastError: {
      kind: "terminal",
      message: "A new failure after dismissal.",
      requestId: "new-failure",
    },
  });
  await expect(
    panel.getByRole("button", { name: "Hide native work details" }),
  ).toBeVisible();
  await expect(panel).toContainText("A new failure after dismissal");
  await expect(
    panel.getByRole("button", { name: "Restart this Codex client" }),
  ).toBeEnabled();
  await observe(page, {
    executionId: "new-execution",
    turnStatus: "completed",
    goalStatus: "active",
    recoveryStatus: "succeeded",
  });
  await expect(panel).toContainText(
    "Recovery succeeded: a subsequent native turn completed",
  );
  await expect(
    panel.getByRole("button", { name: "Restart this Codex client" }),
  ).toHaveCount(0);
  expect(requests).toHaveLength(0);
});

test("shows rejected recovery outside collapsed details and distinguishes identical rejected-start incidents", async ({
  page,
}) => {
  const requests: Array<{ path: string; body: unknown }> = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tabs/*/recover", async (route) => {
    requests.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    await released;
    await route.fulfill({
      status: 409,
      json: { message: "The exact conversation binding became stale." },
    });
  });
  const { input } = await openFixture(page);
  const panel = page.getByRole("region", {
    name: "Native work for Affected Codex",
  });
  await panel
    .getByRole("button", { name: "Restart this Codex client" })
    .click();
  await expect.poll(() => requests.length).toBe(1);
  await panel.getByRole("button", { name: "Hide native work details" }).click();
  release();
  await expect(panel.getByRole("alert")).toHaveText(
    "The exact conversation binding became stale.",
  );
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Show native work details" }),
  ).toBeVisible();
  expect(requests).toEqual([
    {
      path: "/api/tabs/affected/recover",
      body: {
        action: "restart-native",
        executionId: "affected-execution",
        sessionId: "exact-conversation",
      },
    },
  ]);
  await page.locator('[data-tab="affected"] .xterm-helper-textarea').focus();
  await page.keyboard.type("inspect rejected recovery");
  await expect
    .poll(() => input.affected.join(""))
    .toBe("inspect rejected recovery");

  const sameError = {
    kind: "terminal" as const,
    code: "badRequest",
    message: "The provider rejected the request.",
  };
  await observe(page, {
    lastError: { ...sameError, incidentId: "first-rejected-start" },
  });
  await expect(
    panel.getByText(sameError.message, { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Hide native work details" }).click();
  await observe(page, { updatedAt: "2026-10-16T00:20:00Z" });
  await expect(
    panel.getByRole("button", { name: "Show native work details" }),
  ).toBeVisible();
  await observe(page, {
    lastError: { ...sameError, incidentId: "second-rejected-start" },
  });
  await expect(
    panel.getByRole("button", { name: "Hide native work details" }),
  ).toBeVisible();
  await expect(
    panel.getByText(sameError.message, { exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
});

test("clears resolved recovery guidance automatically while preserving history and new-failure attention", async ({
  page,
}, testInfo) => {
  const { sockets, input } = await openFixture(page);
  const panel = page.getByRole("region", {
    name: "Native work for Affected Codex",
  });
  await observe(page, {
    recoveryStatus: "failed",
    goalStatus: "active",
    turnId: "failed-recovery",
  });
  await expect(
    panel.getByText("Recovery failed:", { exact: false }),
  ).toBeVisible();
  await observe(page, { turnId: "later-turn", turnStatus: "running" });
  await expect(
    panel.getByRole("button", { name: "Restart this Codex client" }),
  ).toBeDisabled();
  await observe(page, {
    turnStatus: "completed",
    incidentResolvedByTurnId: "later-turn",
  });
  await expect(panel.getByRole("heading")).toHaveText("Codex native work");
  await expect(
    panel.getByRole("button", { name: "Show native work details" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    panel.getByRole("button", { name: "Restart this Codex client" }),
  ).toHaveCount(0);
  await expect(
    panel.getByText("Restart only this client", { exact: false }),
  ).toHaveCount(0);
  await sockets.affected[0].close({ code: 1001 });
  await expect.poll(() => sockets.affected.length).toBe(2);
  await expect(panel.getByRole("heading")).toHaveText("Codex native work");
  const evidenceDirectory = path.join(repoRoot, "test-results/issue230");
  await mkdir(evidenceDirectory, { recursive: true });
  const screenshot = path.join(
    evidenceDirectory,
    `${testInfo.project.name}-resolved.png`,
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach("resolved-native-incident", {
    path: screenshot,
    contentType: "image/png",
  });
  await panel.getByRole("button", { name: "Show native work details" }).click();
  await expect(
    panel.getByText("Previous recovery attempt failed.", { exact: false }),
  ).toBeVisible();
  await panel
    .getByText("Resolved provider incident diagnostics", { exact: true })
    .click();
  await expect(
    panel.getByText("request-after-http-200", { exact: false }),
  ).toBeVisible();
  await page.locator('[data-tab="affected"] .xterm-helper-textarea').focus();
  await page.keyboard.type("continue after successful turn");
  await expect
    .poll(() => input.affected.join(""))
    .toBe("continue after successful turn");
  await panel.getByRole("button", { name: "Hide native work details" }).click();
  await observe(page, {
    turnId: "new-failure",
    turnStatus: "failed",
    incidentResolvedByTurnId: undefined,
  });
  await expect(panel.getByRole("heading")).toHaveText("Native turn failed");
  await expect(
    panel.getByRole("button", { name: "Hide native work details" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Restart this Codex client" }),
  ).toBeEnabled();
});

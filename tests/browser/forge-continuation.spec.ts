import { expect, test, type Page, type Route } from "@playwright/test";
import type { ForgeWorker, ForgeWorkerHistory } from "@cloudx/shared";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { TerminalScreen } from "../../apps/server/src/terminal/TerminalScreen.js";

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
    optimizeDeps: { entries: ["tests/browser/fixtures/forge-panel.html"] },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing browser fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/forge-panel.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function workers(
  page: Page,
  options: {
    holdFirstContinuation?: boolean;
    historyScreen?: ForgeWorkerHistory["screen"];
  } = {},
) {
  const repository = {
    provider: "github" as const,
    apiUrl: "https://api.github.com",
    projectPath: "cloudx/example",
  };
  const common = {
    repository,
    repositoryPath: "/fixture/repository",
    baseBranch: "main",
    templateId: "worker-template",
    autoPost: false,
    startedAt: "2026-09-15",
    updatedAt: "2026-09-15",
  };
  const entries: ForgeWorker[] = [
    {
      ...common,
      id: "issue-worker",
      kind: "issue",
      number: 7,
      title: "Repair deployment",
      status: "failed",
      error: "The dependency is unavailable.",
    },
    {
      ...common,
      id: "review-worker",
      kind: "review",
      number: 12,
      title: "Review deployment changes",
      status: "completed",
    },
  ];
  const continuations: Array<{
    input: Record<string, unknown>;
    tabId: string;
  }> = [];
  const historyRequests: string[] = [];
  let held!: Route;
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    requested = resolve;
  });

  await page.route("**/fixture-hooks/**", async (route) => {
    const hook = new URL(route.request().url()).pathname.split("/").pop();
    const body = route.request().postDataJSON();
    switch (hook) {
      case "forge.dashboard":
        return route.fulfill({
          json: { configured: true, repository, workers: entries },
        });
      case "forge.issues.list":
        return route.fulfill({ json: { items: [] } });
      case "forge.worker.history":
        historyRequests.push(body.input.id);
        return route.fulfill({
          json: {
            history: {
              tabId: `${body.input.id}-terminal`,
              capturedAt: "2026-09-21T12:00:00.000Z",
              screen: options.historyScreen ?? {
                cols: 100,
                rows: 30,
                data: `Starting deployment check\r\n${Array.from({ length: 80 }, (_, index) => `Checking dependency ${index + 1}`).join("\r\n")}\r\n\x1b[31mDeployment check failed: missing dependency.\x1b[0m\x1b[?1003h`,
              },
            },
          },
        });
      case "forge.worker.continue": {
        continuations.push(body);
        if (options.holdFirstContinuation && continuations.length === 1) {
          held = route;
          requested();
          return;
        }
        const worker = entries.find((entry) => entry.id === body.input.id);
        if (!worker) throw new Error(`Unknown worker ${body.input.id}`);
        worker.status = "running";
        delete worker.error;
        return route.fulfill({ json: { worker } });
      }
      default:
        throw new Error(`Unexpected hook ${hook}`);
    }
  });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Workers (2)", exact: true }).click();
  return {
    continuations,
    historyRequests,
    pending,
    fail: () =>
      held.fulfill({
        status: 409,
        json: { error: "The checkout needs attention." },
      }),
  };
}

for (const worker of [
  { kind: "issue", number: 7, status: "failed" },
  { kind: "review", number: 12, status: "completed" },
]) {
  test(`views the ${worker.status} ${worker.kind} worker history without restarting it`, async ({
    page,
  }, testInfo) => {
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    const fixture = await workers(page);
    const tab = page.getByRole("tab", {
      name: new RegExp(`${worker.kind} #${worker.number}`, "i"),
    });
    await tab.click();
    await page
      .getByRole("button", { name: "View worker", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Latest saved terminal · read only");
    const output = dialog.getByRole("region", {
      name: "Saved worker terminal output",
    });
    await expect(output.locator(".xterm-accessibility-tree")).toContainText(
      "Deployment check failed: missing dependency.",
    );
    await expect(output).toBeInViewport({ ratio: 1 });
    const bounds = (await output.boundingBox())!;
    expect(bounds.width).toBeGreaterThan(250);
    expect(bounds.height).toBeGreaterThan(200);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    const screenshot = testInfo.outputPath("saved-worker-history.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("saved-worker-history", {
      path: screenshot,
      contentType: "image/png",
    });

    await output.hover();
    const beforeScrolling = await output
      .locator(".xterm-accessibility-tree")
      .textContent();
    await page.mouse.wheel(0, -10_000);
    await expect(output.locator(".xterm-accessibility-tree")).not.toHaveText(
      beforeScrolling!,
    );
    if (testInfo.project.name === "mobile-chromium") {
      const rail = (await output
        .locator(".terminal-mobile-scroll-rail")
        .boundingBox())!;
      await page.touchscreen.tap(rail.x + rail.width / 2, rail.y + 1);
    } else {
      await output.locator("textarea").focus();
      for (let index = 0; index < 4; index++)
        await page.keyboard.press("Shift+PageUp");
    }
    await expect(output.locator(".xterm-accessibility-tree")).toContainText(
      "Starting deployment check",
    );
    await dialog.getByRole("button", { name: "Close worker terminal" }).click();
    await expect(dialog).toHaveCount(0);
    await page
      .getByRole("button", { name: "View worker", exact: true })
      .click();
    await expect(output.locator(".xterm-accessibility-tree")).toContainText(
      "Deployment check failed: missing dependency.",
    );
    await output.locator("textarea").focus();
    await page.keyboard.type("do not run this");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(fixture.historyRequests).toEqual([
      `${worker.kind}-worker`,
      `${worker.kind}-worker`,
    ]);
    expect(fixture.continuations).toEqual([]);
    expect(sockets).toEqual([]);
    await expect(tab).toContainText(worker.status);
  });

  test(`continues the selected ${worker.status} ${worker.kind} worker with a multiline message`, async ({
    page,
  }, testInfo) => {
    const fixture = await workers(page);
    const tab = page.getByRole("tab", {
      name: new RegExp(`${worker.kind} #${worker.number}`, "i"),
    });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Continue with message" }).click();

    const form = page.getByRole("form", {
      name: "Continue worker with a message",
    });
    const input = form.getByRole("textbox", { name: "Message to worker" });
    const submit = form.getByRole("button", { name: "Send and continue" });
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("maxlength", "20000");
    await expect(submit).toBeDisabled();
    await input.fill(" \n\t");
    await expect(submit).toBeDisabled();
    const message =
      "The dependency is installed.\nRun the deployment check again.";
    await input.fill(message);
    await expect(submit).toBeEnabled();
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(submit).toBeInViewport({ ratio: 1 });
    const bounds = (await input.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(220);
    expect(bounds.height).toBeGreaterThanOrEqual(60);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    const screenshot = testInfo.outputPath("continuation-form.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("continuation-form", {
      path: screenshot,
      contentType: "image/png",
    });

    await submit.click();
    await expect(form).toHaveCount(0);
    expect(fixture.continuations).toEqual([
      {
        input: {
          id: `${worker.kind}-worker`,
          message,
          windowId: "window-1",
          paneId: "pane-2",
        },
        tabId: "forge-tab",
      },
    ]);
    await expect(tab).toContainText("running");
  });
}

async function scrollWorkerHistoryTo(
  page: Page,
  edge: "first" | "last",
  touch: boolean,
) {
  const output = page.getByRole("region", {
    name: "Saved worker terminal output",
  });
  const rail = output.locator(".terminal-mobile-scroll-rail");
  if (touch && (await rail.isVisible())) {
    const browserInput = await page.context().newCDPSession(page);
    const track = (await rail.boundingBox())!;
    const x = track.x + track.width / 2;
    await browserInput.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: track.y + track.height / 2 }],
    });
    await browserInput.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x, y: edge === "first" ? track.y - 1 : track.y + track.height + 1 },
      ],
    });
    await browserInput.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await browserInput.detach();
  } else {
    await output.hover();
    const scrollbar = output.locator(".xterm .scrollbar.vertical");
    const track = (await scrollbar.boundingBox())!;
    const thumb = await scrollbar.locator(".slider").boundingBox();
    if (!thumb) return;
    await page.mouse.move(
      thumb.x + thumb.width / 2,
      thumb.y + thumb.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      track.x + track.width / 2,
      edge === "first" ? track.y : track.y + track.height,
    );
    await page.mouse.up();
  }
}

for (const scenario of [
  { name: "after shortening", height: 960, cursor: "\x1b[H" },
  { name: "on initial short display", height: 540, cursor: "\x1b[H" },
  {
    name: "with saved origin mode and scroll margins",
    height: 540,
    cursor: "\x1b[2;10r\x1b[?6h\x1b[H",
  },
]) {
  test(`preserves worker history below the saved cursor ${scenario.name}`, async ({
    page,
  }, testInfo) => {
    const diagnostics = Array.from(
      { length: 30 },
      (_, index) => `line-${String(index).padStart(4, "0")}: diagnostic`,
    );
    const screen = new TerminalScreen(100, 30);
    let historyScreen: ForgeWorkerHistory["screen"];
    try {
      screen.write(diagnostics.join("\r\n") + scenario.cursor);
      historyScreen = await screen.snapshot();
    } finally {
      await screen.dispose();
    }
    await page.setViewportSize({
      width: scenario.height === 960 ? 1440 : 390,
      height: scenario.height,
    });
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    const fixture = await workers(page, { historyScreen });
    await page
      .getByRole("button", { name: "View worker", exact: true })
      .click();
    const output = page.getByRole("region", {
      name: "Saved worker terminal output",
    });
    const visibleLines = output.locator(".xterm-accessibility-tree");
    await expect(visibleLines).toContainText(diagnostics.at(-1)!);

    for (const viewport of [
      { width: 390, height: 540 },
      { width: 1440, height: 960 },
      { width: 320, height: 540 },
      { width: 1440, height: 960 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(output).toBeInViewport({ ratio: 1 });
      if (viewport.height === 540) {
        await expect
          .poll(() => visibleLines.locator("[role='listitem']").count())
          .toBeLessThan(30);
      }
      for (const edge of ["first", "last"] as const) {
        await scrollWorkerHistoryTo(
          page,
          edge,
          testInfo.project.name === "mobile-chromium",
        );
        await expect(visibleLines).toContainText(
          edge === "first" ? diagnostics[0] : diagnostics.at(-1)!,
        );
      }
      if (viewport.width === 390) {
        const screenshot = testInfo.outputPath("short-worker-diagnostics.png");
        await page.screenshot({ path: screenshot });
        await testInfo.attach("short-worker-diagnostics", {
          path: screenshot,
          contentType: "image/png",
        });
      }
    }
    await expect(visibleLines).toContainText(diagnostics.join(""));
    const screenshot = testInfo.outputPath("restored-worker-diagnostics.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("restored-worker-diagnostics", {
      path: screenshot,
      contentType: "image/png",
    });
    expect(fixture.historyRequests).toEqual(["issue-worker"]);
    expect(fixture.continuations).toEqual([]);
    expect(sockets).toEqual([]);
  });
}

test("preserves near-limit worker history through mobile fitting and repeated resizing", async ({
  page,
}, testInfo) => {
  const firstDiagnostic = "line-0000: earliest failure diagnostic";
  const lastDiagnostic = "line-0999: final failure diagnostic";
  const lastDiagnosticEnd = "END-0999";
  const lines = Array.from(
    { length: 1000 },
    (_, index) => `line-${String(index).padStart(4, "0")}: dependency check`,
  );
  lines[0] = firstDiagnostic;
  lines[lines.length - 1] =
    lastDiagnostic.padEnd(100 - lastDiagnosticEnd.length, ".") +
    lastDiagnosticEnd;
  const fixture = await workers(page, {
    historyScreen: {
      cols: 100,
      rows: 30,
      data: lines.map((line) => line.padEnd(100, ".")).join("\r\n"),
    },
  });
  await page.getByRole("button", { name: "View worker", exact: true }).click();
  const output = page.getByRole("region", {
    name: "Saved worker terminal output",
  });
  const visibleLines = output.locator(".xterm-accessibility-tree");
  await expect(visibleLines).toContainText(lastDiagnostic);

  for (const [stage, viewport] of [
    page.viewportSize()!,
    { width: 390, height: 844 },
    { width: 1440, height: 960 },
    { width: 320, height: 700 },
    { width: 1440, height: 960 },
  ].entries()) {
    await page.setViewportSize(viewport);
    await expect(output).toBeInViewport({ ratio: 1 });
    for (const edge of ["first", "last"] as const) {
      await scrollWorkerHistoryTo(
        page,
        edge,
        testInfo.project.name === "mobile-chromium",
      );
      await expect(visibleLines).toContainText(
        edge === "first" ? firstDiagnostic : lastDiagnostic,
      );
      if (edge === "last")
        await expect(visibleLines).toContainText(lastDiagnosticEnd);
      if (edge === "first" && (stage === 1 || stage === 4)) {
        const name = `earliest-worker-history-${viewport.width}px`;
        const screenshot = testInfo.outputPath(`${name}.png`);
        await page.screenshot({ path: screenshot });
        await testInfo.attach(name, {
          path: screenshot,
          contentType: "image/png",
        });
      }
    }
  }
  expect(fixture.historyRequests).toEqual(["issue-worker"]);
  expect(fixture.continuations).toEqual([]);
});

test("retains a failed message and allows an explicit retry", async ({
  page,
}) => {
  const fixture = await workers(page, { holdFirstContinuation: true });
  await page.getByRole("button", { name: "Continue with message" }).click();
  const form = page.getByRole("form", {
    name: "Continue worker with a message",
  });
  const input = form.getByRole("textbox", { name: "Message to worker" });
  const message = "The dependency is installed.\nContinue the existing work.";
  await input.fill(message);
  await form.getByRole("button", { name: "Send and continue" }).click();
  await fixture.pending;
  await expect(input).toBeDisabled();
  await expect(
    form.getByRole("button", { name: "Continuing…" }),
  ).toBeDisabled();
  await expect(form.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(fixture.continuations).toHaveLength(1);

  await fixture.fail();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The checkout needs attention." }),
  ).toBeVisible();
  await expect(input).toHaveValue(message);
  await expect(input).toBeEnabled();
  await form.getByRole("button", { name: "Send and continue" }).click();
  await expect(form).toHaveCount(0);
  expect(fixture.continuations).toHaveLength(2);
  expect(fixture.continuations[1]).toEqual(fixture.continuations[0]);
});

test("cancels without sending and clears the abandoned message", async ({
  page,
}) => {
  const fixture = await workers(page);
  const open = page.getByRole("button", { name: "Continue with message" });
  await open.click();
  const form = page.getByRole("form", {
    name: "Continue worker with a message",
  });
  await form
    .getByRole("textbox", { name: "Message to worker" })
    .fill("Discard this draft.");
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
  expect(fixture.continuations).toEqual([]);
  await open.click();
  await expect(
    form.getByRole("textbox", { name: "Message to worker" }),
  ).toHaveValue("");
  await expect(
    form.getByRole("button", { name: "Send and continue" }),
  ).toBeDisabled();
});

test("omits the displayed uncertain reply before explicitly retrying publication", async ({
  page,
}, testInfo) => {
  const repository = {
    provider: "github" as const,
    apiUrl: "https://api.github.com",
    projectPath: "cloudx/example",
  };
  const reply = {
    discussionId: "PRRT_uncertain_reply",
    body: "Fixed the timeout.\nThe reproduction passes.",
  };
  const headSha = "a".repeat(40);
  const worker: ForgeWorker = {
    id: "issue-worker",
    kind: "issue",
    number: 7,
    title: "Repair deployment",
    status: "failed",
    repository,
    repositoryPath: "/fixture/repository",
    baseBranch: "main",
    templateId: "worker-template",
    autoPost: false,
    startedAt: "2026-09-15",
    updatedAt: "2026-09-15",
    changeNumber: 12,
    headSha,
    changeUrl: "https://github.com/cloudx/example/pull/12",
    error: "The discussion reply outcome is uncertain.",
    pendingPublication: {
      headSha,
      confirmed: true,
      repliedDiscussionIds: [],
      replyingToDiscussionId: reply.discussionId,
      report: {
        kind: "issue",
        title: "Repair deployment",
        body: "The reproduction passes.",
        discussionReplies: [reply],
        resolvedDiscussionIds: [reply.discussionId],
      },
    },
  };
  const actions: Array<{
    hook: string;
    input: Record<string, unknown>;
    tabId: string;
  }> = [];
  await page.route("**/fixture-hooks/**", async (route) => {
    const hook = new URL(route.request().url()).pathname.split("/").pop()!;
    const body = route.request().postDataJSON();
    switch (hook) {
      case "forge.dashboard":
        return route.fulfill({
          json: { configured: true, repository, workers: [worker] },
        });
      case "forge.issues.list":
        return route.fulfill({ json: { items: [] } });
      case "forge.worker.omitDiscussionReply":
        actions.push({ hook, ...body });
        worker.pendingPublication!.report.discussionReplies = [];
        worker.pendingPublication!.report.resolvedDiscussionIds = [];
        delete worker.pendingPublication!.replyingToDiscussionId;
        return route.fulfill({ json: { worker } });
      case "forge.worker.resume":
        actions.push({ hook, ...body });
        delete worker.pendingPublication;
        delete worker.error;
        worker.status = "awaiting_review";
        return route.fulfill({ json: { worker } });
      default:
        throw new Error(`Unexpected hook ${hook}`);
    }
  });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Workers (1)", exact: true }).click();
  const recovery = page.getByRole("region", {
    name: "Uncertain discussion reply",
  });
  await expect(recovery).toContainText(reply.discussionId);
  await expect(recovery).toContainText(
    "without posting it again or resolving this thread",
  );
  const preview = recovery.getByRole("textbox", {
    name: "Uncertain reply body",
  });
  await expect(preview).toHaveValue(reply.body);
  await expect(preview).toHaveAttribute("readonly", "");
  const omit = recovery.getByRole("button", {
    name: "Omit reply",
    exact: true,
  });
  await expect(omit).toBeInViewport({ ratio: 1 });
  const bounds = (await preview.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(220);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  const screenshot = testInfo.outputPath("uncertain-reply-recovery.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("uncertain-reply-recovery", {
    path: screenshot,
    contentType: "image/png",
  });

  await omit.click();
  await expect(recovery).toHaveCount(0);
  expect(actions).toEqual([
    {
      hook: "forge.worker.omitDiscussionReply",
      input: { id: worker.id, ...reply, headSha },
      tabId: "forge-tab",
    },
  ]);
  await expect(page.getByRole("tab", { name: /Issue #7/ })).toContainText(
    "failed",
  );
  await page
    .getByRole("button", { name: "Retry publication", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: /Issue #7/ })).toContainText(
    "awaiting review",
  );
  expect(actions).toEqual([
    {
      hook: "forge.worker.omitDiscussionReply",
      input: { id: worker.id, ...reply, headSha },
      tabId: "forge-tab",
    },
    {
      hook: "forge.worker.resume",
      input: { id: worker.id, windowId: "window-1", paneId: "pane-2" },
      tabId: "forge-tab",
    },
  ]);
});

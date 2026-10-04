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
    issueWorker?: Partial<ForgeWorker>;
    secondWorker?: Partial<ForgeWorker>;
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
      ...options.issueWorker,
    },
    {
      ...common,
      id: "review-worker",
      kind: "review",
      number: 12,
      title: "Review deployment changes",
      status: "completed",
      ...options.secondWorker,
    },
  ];
  const continuations: Array<{
    input: Record<string, unknown>;
    tabId: string;
  }> = [];
  const historyRequests: string[] = [];
  const resumes: Array<{ input: Record<string, unknown>; tabId: string }> = [];
  let held!: Route;
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    requested = resolve;
  });

  await page.route("**/fixture-hooks/**", async (route) => {
    const hook = new URL(route.request().url()).pathname.split("/").pop();
    const body = route.request().postDataJSON();
    switch (hook) {
      case "forge.worker.ownershipAvailability":
        return route.fulfill({
          json: { availability: { status: "not_needed" } },
        });
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
      case "forge.worker.resume": {
        resumes.push(body);
        const worker = entries.find((entry) => entry.id === body.input.id);
        return route.fulfill({ json: { worker } });
      }
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
    entries,
    resumes,
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

test("shows retained checkout files without offering another worker attempt", async ({
  page,
}, testInfo) => {
  const retainedWorkspace = {
    worktreePath:
      "/home/developer/cloudx/.cloudx/forge-workers/checkouts/5691781c-745a-4876-a8a4-9b7d3ab128c5",
    retainedPaths: [
      "debug_tooling/issue114/publication-diagnostics.bin",
      "apps/server/src/forge/unfinished-research-notes.md",
    ],
  };
  const fixture = await workers(page, {
    issueWorker: { status: "completed", error: undefined, retainedWorkspace },
  });
  const worker = page.getByRole("article", { name: "issue worker #7" });
  const recovery = worker.getByRole("region", {
    name: "Retained working files",
  });
  await expect(recovery).toContainText(retainedWorkspace.worktreePath);
  await expect(recovery).toContainText(
    "Its Git index remains intact, including staged edits",
  );
  await recovery.getByText("Retained paths (2)", { exact: true }).click();
  await expect(recovery.getByRole("listitem")).toHaveText(
    retainedWorkspace.retainedPaths,
  );
  for (const text of [
    retainedWorkspace.worktreePath,
    ...retainedWorkspace.retainedPaths,
  ]) {
    const entry = recovery.getByText(text, { exact: true });
    await expect(entry).toBeInViewport({ ratio: 1 });
    const bounds = (await entry.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  }
  await expect(
    worker.getByRole("button", { name: "Resume", exact: true }),
  ).toHaveCount(0);
  await expect(
    worker.getByRole("button", { name: "Continue with message", exact: true }),
  ).toHaveCount(0);
  expect(fixture.continuations).toEqual([]);
  const screenshot = testInfo.outputPath("retained-working-files.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("retained-working-files", {
    path: screenshot,
    contentType: "image/png",
  });
});

test("reviews legacy environment evidence and requires confirmation before discarding", async ({
  page,
}, testInfo) => {
  const resource = {
    id: "evidence-resource",
    name: "completed-regression-env",
    kind: "container",
    engineId: "fixture-engine",
    owner: { workerId: "issue-worker", attemptId: "earlier-attempt" },
    consumers: [{ workerId: "issue-worker", attemptId: "earlier-attempt" }],
    state: "blocked",
    reason:
      "The completed environment is stopped. Select the useful evidence before release.",
    retentionReason: "Preserve the regression log for the validated commit.",
    allocatedBytes: 8192,
    reclaimedBytes: 0,
    updatedAt: "2026-10-04",
  };
  const decisions: unknown[] = [];
  await page.route("**/api/forge/resources", (route) =>
    route.fulfill({ json: { resources: [resource] } }),
  );
  await page.route(
    "**/api/forge/resources/evidence-resource/evidence-decision",
    (route) => {
      decisions.push(route.request().postDataJSON());
      resource.state = "deleted";
      resource.reclaimedBytes = 8192;
      return route.fulfill({ json: resource });
    },
  );
  await workers(page);
  await page.getByRole("button", { name: "Environments", exact: true }).click();
  const environment = page.getByRole("article", {
    name: "Environment completed-regression-env",
    exact: true,
  });
  await expect(environment).toContainText(resource.retentionReason);
  const discard = environment.getByRole("button", {
    name: "Discard evidence and release",
    exact: true,
  });
  await expect(discard).toBeDisabled();
  await environment
    .getByRole("textbox", {
      name: "Evidence paths for completed-regression-env",
    })
    .fill("/work/evidence/test.log");
  await expect(
    environment.getByRole("button", { name: "Export evidence and release" }),
  ).toBeEnabled();
  await environment
    .getByRole("checkbox", {
      name: "Discard this container’s evidence permanently",
    })
    .check();
  const screenshot = testInfo.outputPath("environment-evidence-decision.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("environment-evidence-decision", {
    path: screenshot,
    contentType: "image/png",
  });
  await discard.click();
  await expect(environment).toContainText("8,192 writable bytes reclaimed");
  await expect(environment.locator("fieldset")).toHaveCount(0);
  expect(decisions).toEqual([
    { action: "discard", confirmation: "Discard evidence" },
  ]);
});

test("continues an unfinished handoff with the exact message to its issue worker", async ({
  page,
}, testInfo) => {
  const reason =
    "The handoff reports unfinished deployment edits. The checkout and its files were preserved.";
  const fixture = await workers(page, {
    issueWorker: {
      error: reason,
      completion: {
        attemptId: "unfinished-attempt",
        deadlineAt: "2026-09-23T12:00:00.000Z",
        continuationRequired: reason,
      },
    },
  });
  const worker = page.getByRole("article", { name: "issue worker #7" });
  await expect(worker.getByRole("status")).toContainText(reason);
  await expect(worker.getByRole("status")).toContainText(
    "Use Continue with message",
  );
  await expect(
    worker.getByRole("button", { name: "Resume", exact: true }),
  ).toHaveCount(0);
  await worker
    .getByRole("button", { name: "Continue with message", exact: true })
    .click();
  const form = worker.getByRole("form", {
    name: "Continue worker with a message",
  });
  const message =
    "Finish and validate the deployment changes.\nCommit the implementation and retain the diagnostic files in the new handoff.";
  const input = form.getByRole("textbox", { name: "Message to worker" });
  await input.fill(message);
  const submit = form.getByRole("button", { name: "Send and continue" });
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(submit).toBeInViewport({ ratio: 1 });
  const screenshot = testInfo.outputPath("unfinished-handoff-continuation.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("unfinished-handoff-continuation", {
    path: screenshot,
    contentType: "image/png",
  });
  await submit.click();
  await expect(form).toHaveCount(0);
  expect(fixture.continuations).toEqual([
    {
      input: {
        id: "issue-worker",
        message,
        windowId: "window-1",
        paneId: "pane-2",
      },
      tabId: "forge-tab",
    },
  ]);
  await expect(page.getByRole("tab", { name: /Issue #7/ })).toContainText(
    "running",
  );
});

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
      await output
        .getByRole("textbox", { name: "Terminal input", exact: true })
        .focus();
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
    await output
      .getByRole("textbox", { name: "Terminal input", exact: true })
      .focus();
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
    // xterm retains old thumb bounds after the viewport stops overflowing.
    if (
      await scrollbar.evaluate(
        (element) => getComputedStyle(element).pointerEvents === "none",
      )
    )
      return;
    await scrollbar.locator(".slider").hover();
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
        await expect(output.getByLabel("Selected terminal text")).toBeHidden();
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

test("keeps a CI-paused worker responsive while another worker waits for terminal context", async ({
  page,
}, testInfo) => {
  const fixture = await workers(page, {
    holdFirstContinuation: true,
    issueWorker: { status: "paused", title: "Finish noisy terminal" },
    secondWorker: {
      kind: "issue",
      number: 9,
      status: "paused",
      title: "Repair failed CI",
      error: "Required CI failed.",
    },
  });
  const noisy = page.getByRole("article", { name: "issue worker #7" });
  await noisy.getByRole("button", { name: "Continue with message" }).click();
  await noisy
    .getByRole("textbox", { name: "Message to worker" })
    .fill("Continue the noisy worker.");
  await noisy.getByRole("button", { name: "Send and continue" }).click();
  await fixture.pending;
  await expect(
    noisy.getByRole("button", { name: "Resume", exact: true }),
  ).toBeDisabled();
  await expect(
    noisy.getByRole("button", { name: "Continuing…" }),
  ).toBeDisabled();
  fixture.entries[0].activity = {
    phase: "Closing terminal and saving context",
    since: "2026-09-28T02:00:00.000Z",
    elapsedMs: 566_000,
    queueDelayMs: 2400,
  };
  await page
    .getByRole("button", { name: "Refresh Forge", exact: true })
    .click();
  await expect(noisy).toContainText(
    "Closing terminal and saving context · 9m 26s elapsed · Queue delay 3s",
  );
  await page.getByRole("tab", { name: /Issue #9/i }).click();
  const recovery = page.getByRole("article", { name: "issue worker #9" });
  await expect(recovery).toContainText("Required CI failed.");
  await expect(
    recovery.getByRole("button", { name: "Resume", exact: true }),
  ).toBeEnabled();
  await recovery.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(() => fixture.resumes.length).toBe(1);
  expect(fixture.resumes[0].input.id).toBe("review-worker");
  await recovery.getByRole("button", { name: "Continue with message" }).click();
  await expect(recovery).toContainText(
    "This starts implementation work; Resume rechecks the existing loop.",
  );
  await recovery
    .getByRole("textbox", { name: "Message to worker" })
    .fill("Repair the failing CI check.");
  const submit = recovery.getByRole("button", { name: "Send and continue" });
  await expect(submit).toBeEnabled();
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport({ ratio: 1 });
  const screenshot = testInfo.outputPath("independent-worker-controls.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("independent-worker-controls", {
    path: screenshot,
    contentType: "image/png",
  });
  await submit.click();
  await expect(recovery.getByRole("form")).toHaveCount(0);
  expect(fixture.continuations.map((request) => request.input.id)).toEqual([
    "issue-worker",
    "review-worker",
  ]);
  expect(fixture.continuations[1].input.message).toBe(
    "Repair the failing CI check.",
  );
  await page.getByRole("tab", { name: /Issue #7/i }).click();
  await expect(
    noisy.getByRole("button", { name: "Resume", exact: true }),
  ).toBeDisabled();
  await expect(
    noisy.getByRole("textbox", { name: "Message to worker" }),
  ).toHaveValue("Continue the noisy worker.");
  await fixture.fail();
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
      case "forge.worker.ownershipAvailability":
        return route.fulfill({
          json: { availability: { status: "not_needed" } },
        });
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

test("saves a batch across reload, edits members and associates every issue with one worker", async ({
  page,
}, testInfo) => {
  const repository = {
    provider: "github" as const,
    apiUrl: "https://api.github.com",
    projectPath: "cloudx/example",
  };
  const issues = [7, 9, 11].map((number) => ({
    number,
    title: `Repair CI ${number}`,
    body: `Reproduce CI failure ${number}.`,
    url: `https://github.com/cloudx/example/issues/${number}`,
    state: "open" as const,
    author: "ari",
    labels: [],
    updatedAt: "2026-09-27",
    comments: [],
  }));
  let worker: ForgeWorker | undefined;
  const starts: Record<string, unknown>[] = [];
  await page.route("**/fixture-hooks/**", async (route) => {
    const hook = new URL(route.request().url()).pathname.split("/").pop();
    const { input } = route.request().postDataJSON();
    switch (hook) {
      case "forge.worker.ownershipAvailability":
        return route.fulfill({
          json: { availability: { status: "not_needed" } },
        });
      case "forge.dashboard":
        return route.fulfill({
          json: {
            configured: true,
            repository,
            workers: worker ? [worker] : [],
          },
        });
      case "forge.issues.list":
        return route.fulfill({
          json:
            input.page === 2
              ? { items: issues.slice(1) }
              : { items: [issues[0]], nextPage: 2 },
        });
      case "forge.issue.get":
        return route.fulfill({
          json: {
            issue: issues.find((issue) => issue.number === input.number),
          },
        });
      case "forge.batch.save": {
        worker = {
          id: "ci-batch",
          kind: "issue",
          number: input.numbers[0],
          title: input.name,
          repository,
          repositoryPath: "/fixture/repository",
          baseBranch: "main",
          templateId: "worker-template",
          status: "draft",
          autoPost: false,
          startedAt: "2026-09-27",
          updatedAt: "2026-09-27",
          batch: {
            issues: issues.filter((issue) =>
              input.numbers.includes(issue.number),
            ),
          },
        };
        return route.fulfill({ json: { worker } });
      }
      case "forge.batch.start": {
        starts.push(input);
        worker = {
          ...worker!,
          status: "running",
          changeNumber: 42,
          changeUrl: "https://github.com/cloudx/example/pull/42",
          batch: {
            ...worker!.batch!,
            results: [
              {
                number: 7,
                status: "completed",
                changes: "CI repaired",
                validation: "CI reproduction passes",
              },
              {
                number: 9,
                status: "blocked",
                changes: "CI analyzed",
                validation: "CI still fails",
                blocker: "Runner unavailable",
              },
              {
                number: 11,
                status: "unfinished",
                changes: "Waiting for the runner repair",
                validation: "Dependent CI check has not run",
                blocker: "Depends on issue #9",
              },
            ],
          },
        };
        return route.fulfill({ json: { worker } });
      }
      default:
        throw new Error(`Unexpected hook ${hook}`);
    }
  });
  await page.goto(baseUrl);
  await page
    .getByRole("checkbox", { name: "Select issue #7 for batch" })
    .check();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select issue #9 for batch" })
    .check();
  const create = page.getByRole("form", { name: "Create issue batch" });
  await expect(create.getByRole("link")).toHaveText([
    "#7 Repair CI 7",
    "#9 Repair CI 9",
  ]);
  await create.getByRole("textbox", { name: "Batch name" }).fill("Reliable CI");
  await create.getByRole("button", { name: "Save batch", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Batch · #7, #9/ })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Workers (1)", exact: true }).click();
  const edit = page.getByRole("form", { name: "Edit issue batch" });
  await expect(edit.getByRole("textbox", { name: "Batch name" })).toHaveValue(
    "Reliable CI",
  );
  await edit
    .getByRole("textbox", { name: "Batch name" })
    .fill("Reliable builds");
  await edit.getByRole("textbox", { name: "Issue numbers" }).fill("7, 9, 11");
  await expect(
    page.getByRole("button", { name: "Start batch" }),
  ).toBeDisabled();
  await edit.getByRole("button", { name: "Save batch changes" }).click();
  await expect(
    page.getByRole("region", { name: "Batch issues" }).getByRole("link"),
  ).toHaveText(["#7 Repair CI 7", "#9 Repair CI 9", "#11 Repair CI 11"]);
  await page
    .getByRole("checkbox", { name: "Auto review", exact: true })
    .check();
  const start = page.getByRole("button", { name: "Start batch", exact: true });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeInViewport({ ratio: 1 });
  const screenshot = testInfo.outputPath("batch-draft.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("batch-draft", {
    path: screenshot,
    contentType: "image/png",
  });
  await start.click();
  await expect(
    page.getByRole("article", { name: "Batch worker Reliable builds" }),
  ).toBeVisible();
  await expect(edit).toHaveCount(0);
  expect(starts).toEqual([
    {
      id: "ci-batch",
      autoReview: true,
      windowId: "window-1",
      paneId: "pane-2",
    },
  ]);
  await page.getByRole("button", { name: "Issues", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  for (const number of [9, 11]) {
    await page
      .getByRole("button", {
        name: new RegExp(`^#${number} Repair CI ${number}`),
      })
      .click();
    const card = page.getByRole("article", {
      name: "Batch worker Reliable builds",
    });
    await expect(
      card.getByRole("link", { name: "Open PR/MR" }),
    ).toHaveAttribute("href", "https://github.com/cloudx/example/pull/42");
    await expect(card).toContainText("Issue open · Last report: completed");
    await expect(card).toContainText("CI reproduction passes");
    await expect(card).toContainText("Runner unavailable");
    await expect(
      page.getByRole("button", { name: "Start work", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("checkbox", { name: `Select issue #${number} for batch` }),
    ).toHaveCount(0);
  }
});

test("groups overlapping persisted batches through start, edit and reconnect with keyboard selection", async ({
  page,
}, testInfo) => {
  const repository = {
    provider: "github" as const,
    apiUrl: "https://api.github.com",
    projectPath: "cloudx/example",
  };
  const issues = [7, 9, 11, 13].map((number) => ({
    number,
    title: `Repair ${number}: keep retained workspace diagnostics and source changes through recovery`,
    url: `https://github.com/cloudx/example/issues/${number}`,
    body: "Reproduction and validation",
    state: "open" as const,
    author: "ari",
    labels: [],
    updatedAt: "2026-09-28",
    comments: [],
  }));
  const common = {
    repository,
    repositoryPath: "/fixture/repository",
    baseBranch: "main",
    templateId: "worker-template",
    autoPost: false,
    startedAt: "2026-09-28",
    updatedAt: "2026-09-28",
    kind: "issue" as const,
    status: "draft" as const,
  };
  let entries: ForgeWorker[] = [
    {
      ...common,
      id: "batch-a",
      number: 7,
      title: "Reliable builds with preserved investigation files",
      batch: { issues: issues.slice(0, 2) },
    },
    {
      ...common,
      id: "batch-b",
      number: 11,
      title: "Workspace cleanup",
      batch: { issues: issues.slice(1, 3) },
    },
  ];
  entries.push({ ...entries[0], id: "same-members", title: "Same members" });
  await page.route("**/fixture-hooks/**", async (route) => {
    const hook = new URL(route.request().url()).pathname.split("/").pop();
    const { input } = route.request().postDataJSON();
    if (hook === "forge.dashboard")
      return route.fulfill({
        json: { configured: true, repository, workers: entries },
      });
    if (hook === "forge.issues.list")
      return route.fulfill({ json: { items: issues.slice(1) } });
    if (hook === "forge.issue.get")
      return route.fulfill({
        json: { issue: issues.find((issue) => issue.number === input.number) },
      });
    throw new Error(`Unexpected hook ${hook}`);
  });
  await page.goto(baseUrl);
  const first = page.getByRole("group", { name: entries[0].title });
  await expect(first).toContainText("1 of 2 issues shown");
  await expect(
    page.getByRole("group", { name: "Workspace cleanup", exact: true }),
  ).toContainText("2 of 2 issues shown");
  const duplicate = page.getByRole("group", {
    name: "Same members",
    exact: true,
  });
  await expect(duplicate).toContainText("1 of 2 issues shown");
  entries[0].status = "running";
  await page.getByRole("button", { name: "Refresh Forge" }).click();
  await expect(first).toContainText(`#9 ${issues[1].title}`);
  await expect(duplicate).toContainText(`#9 ${issues[1].title}`);
  await page.reload();
  await expect(first).toContainText("1 of 2 issues shown");
  await expect(duplicate).toContainText("1 of 2 issues shown");
  for (const number of [9, 11])
    await expect(
      page.getByRole("checkbox", { name: `Select issue #${number} for batch` }),
    ).toHaveCount(0);
  const details = first.getByRole("button");
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: `#9 ${issues[1].title}`, exact: true }),
  ).toBeVisible();
  const selection = page.getByRole("checkbox", {
    name: "Select issue #13 for batch",
  });
  await selection.focus();
  await page.keyboard.press("Space");
  await expect(selection).toBeChecked();
  await expect(
    page.getByRole("form", { name: "Create issue batch" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove issue #13 from selection" })
    .click();
  await page.locator(".forge-list").evaluate((element) => {
    element.scrollTop = 0;
  });
  const screenshot = testInfo.outputPath("grouped-batches.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("grouped-batches", {
    path: screenshot,
    contentType: "image/png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  entries = [{ ...entries[1], batch: { issues: [issues[2]] } }];
  await page.getByRole("button", { name: "Refresh Forge" }).click();
  await expect(first).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Select issue #9 for batch" }),
  ).toBeEnabled();
});

test("ownership inspection is contextual and disappears after an empty stale preview", async ({
  page,
}, testInfo) => {
  await workers(page);
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Workers (2)", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Inspect directory ownership" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Continue with message" }),
  ).toBeEnabled();
  let needed = true;
  await page.route(
    "**/fixture-hooks/forge.worker.ownershipAvailability",
    (route) =>
      route.fulfill({
        json: {
          availability: needed
            ? {
                status: "available",
                reason: "A saved directory device changed.",
              }
            : { status: "not_needed" },
        },
      }),
  );
  await page.route(
    "**/fixture-hooks/forge.worker.previewOwnership",
    (route) => {
      needed = false;
      return route.fulfill({
        json: { preview: { fingerprint: "a".repeat(64), directories: [] } },
      });
    },
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("button", { name: "Inspect directory ownership" })
    .click();
  await expect(
    page.getByText(
      "No directory ownership repair is needed. Resume when ready.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Directory ownership recovery" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeEnabled();
  const screenshot = testInfo.outputPath("contextual-ownership.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("contextual-ownership", {
    path: screenshot,
    contentType: "image/png",
  });
});

test("shows queue order and the active candidate while recovery controls stay usable", async ({
  page,
}, testInfo) => {
  await workers(page, {
    issueWorker: {
      status: "awaiting_merge",
      error: undefined,
      changeNumber: 42,
      changeUrl: "https://github.com/cloudx/example/pull/42",
      mergeQueue: {
        sequence: 2,
        enteredAt: "2026-09-28",
        phase: "queued",
        active: false,
        position: 2,
        activeWorkerId: "review-worker",
        reason: "Waiting for the current merge turn.",
      },
    },
    secondWorker: {
      kind: "issue",
      title: "Prepare deployment dependencies",
      status: "awaiting_merge",
      changeNumber: 43,
      changeUrl: "https://github.com/cloudx/example/pull/43",
      mergeQueue: {
        sequence: 1,
        enteredAt: "2026-09-28",
        phase: "waiting_ci",
        active: true,
        position: 1,
        activeWorkerId: "review-worker",
      },
    },
  });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Workers (2)", exact: true }).click();
  const queue = page.getByRole("region", { name: "Merge queue", exact: true });
  await expect(queue).toContainText("Queued · Position 2 · main");
  await expect(queue).toContainText("Active: Prepare deployment dependencies");
  await expect(
    page.getByRole("region", { name: "Merge queues", exact: true }),
  ).toContainText("Waiting for CI");
  await expect(queue.getByRole("link", { name: "PR #42" })).toHaveAttribute(
    "href",
    "https://github.com/cloudx/example/pull/42",
  );
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Continue with message" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message to worker" }),
  ).toBeEnabled();
  const screenshot = testInfo.outputPath("merge-queue.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("merge-queue", {
    path: screenshot,
    contentType: "image/png",
  });
});

test("Codex recovery keeps conversation controls and offers ownership repair only when applicable", async ({
  page,
}, testInfo) => {
  let needed = false;
  let repairs = 0;
  const resumes: unknown[] = [];
  await page.route("**/api/tabs/codex-recovery/ownership", (route) =>
    route.fulfill({
      json: needed
        ? { status: "available", reason: "A saved directory device changed." }
        : { status: "not_needed" },
    }),
  );
  await page.route("**/api/tabs/codex-recovery/ownership/preview", (route) =>
    route.fulfill({
      json: {
        fingerprint: "a".repeat(64),
        directories: [
          {
            path: "/home/user/.codex",
            device: "1",
            currentDevice: "2",
            filesystemId: "aaaa",
            filesystemType: "ef53",
          },
        ],
      },
    }),
  );
  await page.route(
    "**/api/tabs/codex-recovery/ownership/reconcile",
    (route) => {
      repairs++;
      needed = false;
      return route.fulfill({ json: {} });
    },
  );
  await page.route("**/fixture-recover", (route) => {
    resumes.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.goto(`${baseUrl}?codex-recovery`);
  await expect(
    page.getByRole("button", { name: "Inspect directory ownership" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Resume conversation", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "Conversation session ID" }),
  ).toBeEnabled();
  needed = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("button", { name: "Inspect directory ownership" })
    .click();
  await expect(
    page.getByRole("button", { name: "Reconcile verified ownership" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Reconcile verified ownership" })
    .click();
  await expect(
    page.getByRole("region", { name: "Directory ownership recovery" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Directory ownership reconciled. Resume when ready."),
  ).toBeVisible();
  expect(repairs).toBe(1);
  expect(resumes).toEqual([]);
  await page
    .getByRole("textbox", { name: "Conversation session ID" })
    .fill("selected-conversation");
  await page
    .getByRole("button", { name: "Resume selected conversation" })
    .click();
  expect(resumes).toEqual([
    { action: "resume-conversation", sessionId: "selected-conversation" },
  ]);
  const screenshot = testInfo.outputPath("codex-recovery.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("codex-recovery", {
    path: screenshot,
    contentType: "image/png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

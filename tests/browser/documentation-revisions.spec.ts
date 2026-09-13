import { expect, test, type Page, type Route } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";

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
    optimizeDeps: {
      entries: ["tests/browser/fixtures/documentation-panel.html"],
    },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing browser fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/documentation-panel.html`;
});
test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function source(
  page: Page,
  count: number,
  delayDetail = false,
  pendingCleanup = false,
) {
  let searches = 0;
  const calls: Array<{ hook: string; input: Record<string, unknown> }> = [];
  let held: Route | undefined;
  let detailRequested!: () => void;
  const pendingDetail = new Promise<void>((resolve) => {
    detailRequested = resolve;
  });
  const detail = (id: string) => ({
    document: {
      documentId: id,
      title:
        id === "current"
          ? "Archived hardware guide"
          : id === "second"
            ? "Second search source"
            : "Refreshed guide",
      sourceType: "pdf",
      state: "active",
      uri: "file:///archive/hardware-guide.pdf",
      chunks: [
        {
          chunkId: 1,
          locator: "page 1",
          text: "Original archived source text.",
        },
      ],
    },
  });
  await page.route("**/fixture-hooks/**", async (route) => {
    const hook = new URL(route.request().url()).pathname.split("/").pop()!;
    const input = route.request().postDataJSON() ?? {};
    calls.push({ hook, input });
    switch (hook) {
      case "documentation.summary":
        return route.fulfill({
          json: { activeDocumentCount: 1, activeChunkCount: 1 },
        });
      case "documentation.ingest.queue":
        return route.fulfill({ json: { jobs: [] } });
      case "documentation.answer": {
        searches++;
        const second = searches > 1;
        return route.fulfill({
          json: {
            answer: second
              ? "New answer survives unrelated work."
              : "Original answer.",
            answerHtml: second
              ? "<p>New answer survives unrelated work.</p>"
              : "<p>Original answer.</p>",
            citations: [],
            warnings: [],
            results: [
              {
                documentId: second ? "second" : "current",
                title: second
                  ? "Second search source"
                  : "Archived hardware guide",
                chunkId: second ? 2 : 1,
                sourceType: "pdf",
                state: "active",
                locator: "page 1",
                snippet: second
                  ? "Second search source evidence."
                  : "Original archived source text.",
              },
            ],
          },
        });
      }
      case "documentation.documents.get":
        if (input.documentId === "new" && delayDetail) {
          held = route;
          detailRequested();
          return;
        }
        return route.fulfill({ json: detail(String(input.documentId)) });
      case "documentation.documents.revisions":
        return route.fulfill({
          json: {
            sourceKey: "source:guide",
            revisions: Array.from({ length: count }, (_, i) => ({
              document_id: i ? `old-${i}` : "current",
              title: "Board",
              state: i ? "superseded" : "active",
              created_at: "2026-09-11",
              content_sha256: i.toString(16).padStart(64, "a"),
            })),
            pendingCleanup: pendingCleanup
              ? [
                  {
                    documentId: "purged-old",
                    purgeId: 1,
                    error:
                      "Retained file cleanup needs an explicit retry after a disk permission failure.",
                  },
                ]
              : [],
          },
        });
      case "documentation.documents.purge":
        return route.fulfill({
          json: {
            purged: true,
            cleanupPending: false,
            retainedDocument: false,
          },
        });
      case "documentation.documents.checkRevision":
        return route.fulfill({ json: { status: "new-revision" } });
      case "documentation.documents.refresh":
        return route.fulfill({
          json: { status: "refreshed", documentId: "new" },
        });
      default:
        throw new Error(`Unexpected hook ${hook}`);
    }
  });
  await page.goto(baseUrl);
  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("First source");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "View Source", exact: true }).click();
  await expect(page.locator(".documentation-chunk")).toContainText(
    "Original archived source text.",
  );
  return {
    calls,
    pendingDetail,
    release: () => held!.fulfill({ json: detail("new") }),
    fail: () =>
      held!.fulfill({
        status: 503,
        json: { error: "Older revision details unavailable" },
      }),
  };
}

for (const viewport of [
  { width: 393, height: 851 },
  { width: 320, height: 568 },
  { width: 851, height: 393 },
]) {
  test(`expanded history preserves source and actions at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await source(page, 12, false, true);
    await page
      .getByRole("button", { name: "Source revisions", exact: true })
      .click();
    await expect(page.locator(".documentation-revisions li")).toHaveCount(13);
    const chunks = page.locator(".documentation-chunk-list");
    expect((await chunks.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await testInfo.attach("source-history-bounds", {
      body: JSON.stringify(
        await page.evaluate(() => {
          const bounds = (selector: string) => {
            const element = document.querySelector(selector)!;
            const rect = element.getBoundingClientRect();
            return {
              height: rect.height,
              scrollHeight: element.scrollHeight,
              overflowY: getComputedStyle(element).overflowY,
            };
          };
          return {
            viewport: { width: innerWidth, height: innerHeight },
            source: bounds(".documentation-chunk-list"),
            history: bounds(".documentation-revisions"),
          };
        }),
      ),
      contentType: "application/json",
    });
    await chunks.scrollIntoViewIfNeeded();
    await expect(chunks).toBeInViewport({ ratio: 0.9 });
    const lastDelete = page
      .getByRole("button", { name: "Delete old revision", exact: true })
      .last();
    await lastDelete.click();
    await page
      .getByRole("button", { name: "Cancel deletion", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Retry file cleanup", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Old revision permanently deleted.",
    );
    expect((await chunks.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await testInfo.attach("expanded-history", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}

test("short history leaves source space and current refresh switches to the new revision", async ({
  page,
}) => {
  const fixture = await source(page, 2, true);
  await beginRefresh(page, fixture);
  await fixture.release();
  await expect(page.locator(".documentation-source-header")).toContainText(
    "Refreshed guide",
  );
  expect(
    (await page.locator(".documentation-chunk-list").boundingBox())!.height,
  ).toBeGreaterThan(100);
});

for (const nextView of [
  "closed",
  "same source reopened",
  "new search",
  "different source",
  "new search with source open",
]) {
  test(`late revision details preserve ${nextView}`, async ({ page }) => {
    const fixture = await source(page, 2, true);
    await beginRefresh(page, fixture);
    if (nextView !== "new search with source open")
      await page.getByRole("button", { name: "Close", exact: true }).click();
    if (nextView === "same source reopened")
      await page
        .getByRole("button", { name: "View Source", exact: true })
        .click();
    if (
      [
        "new search",
        "different source",
        "new search with source open",
      ].includes(nextView)
    ) {
      await page
        .getByRole("textbox", { name: "Question", exact: true })
        .fill("Second query");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Search", exact: true }),
      ).toBeEnabled();
      if (nextView === "different source")
        await page
          .getByRole("button", { name: "View Source", exact: true })
          .click();
      if (nextView === "new search")
        await expect(page.locator(".documentation-result")).toContainText(
          "Second search source",
        );
    }
    const summaries = fixture.calls.filter(
      ({ hook }) => hook === "documentation.summary",
    ).length;
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("documentation.documents.get") &&
        response.request().postDataJSON().documentId === "new",
    );
    await fixture.release();
    await response;
    // Drain the fetch response and React render without an arbitrary timer.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      fixture.calls.filter(({ hook }) => hook === "documentation.summary"),
    ).toHaveLength(summaries);
    if (
      [
        "same source reopened",
        "different source",
        "new search with source open",
      ].includes(nextView)
    ) {
      await expect(page.locator(".documentation-source-header")).toContainText(
        nextView === "different source"
          ? "Second search source"
          : "Archived hardware guide",
      );
      await page.getByRole("button", { name: "Close", exact: true }).click();
    }
    await expect(page.locator(".documentation-source-viewer")).toHaveCount(0);
    await expect(page.locator(".documentation-result")).toContainText(
      ["closed", "same source reopened"].includes(nextView)
        ? "Archived hardware guide"
        : "Second search source",
    );
    await expect(page.locator(".documentation-answer-body")).toContainText(
      ["closed", "same source reopened"].includes(nextView)
        ? "Original answer."
        : "New answer survives unrelated work.",
    );
  });
}

async function beginRefresh(
  page: Page,
  fixture: Awaited<ReturnType<typeof source>>,
) {
  await page
    .getByRole("button", { name: "Source revisions", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check for a new revision", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import latest revision", exact: true })
    .click();
  await fixture.pendingDetail;
}

test("a late detail failure does not add an error to the newer search view", async ({
  page,
}) => {
  const fixture = await source(page, 2, true);
  await beginRefresh(page, fixture);
  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("Second query");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Search", exact: true }),
  ).toBeEnabled();
  await fixture.fail();
  await expect(
    page.getByRole("button", { name: "Hide revisions", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".documentation-revisions")).not.toContainText(
    "Older revision details unavailable",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".documentation-answer-body")).toContainText(
    "New answer survives unrelated work.",
  );
});

test("a current detail failure remains visible without replacing the source", async ({
  page,
}) => {
  const fixture = await source(page, 2, true);
  await beginRefresh(page, fixture);
  await fixture.fail();
  await expect(page.locator(".documentation-revisions")).toContainText(
    "Older revision details unavailable",
  );
  await expect(page.locator(".documentation-source-header")).toContainText(
    "Archived hardware guide",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".documentation-answer-body")).toContainText(
    "Original answer.",
  );
});

test("a newer search also supersedes refresh before detail loading begins", async ({
  page,
}) => {
  const fixture = await source(page, 2);
  let held!: Route;
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(
    "**/fixture-hooks/documentation.documents.refresh",
    (route) => {
      held = route;
      requested();
    },
  );
  await page
    .getByRole("button", { name: "Source revisions", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check for a new revision", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import latest revision", exact: true })
    .click();
  await pending;
  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("Second query");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Search", exact: true }),
  ).toBeEnabled();
  await held.fulfill({ json: { status: "refreshed", documentId: "new" } });
  await expect(
    page.getByRole("button", { name: "Hide revisions", exact: true }),
  ).toBeEnabled();
  expect(
    fixture.calls.some(
      ({ hook, input }) =>
        hook === "documentation.documents.get" && input.documentId === "new",
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".documentation-result")).toContainText(
    "Second search source",
  );
  await expect(page.locator(".documentation-answer-body")).toContainText(
    "New answer survives unrelated work.",
  );
});

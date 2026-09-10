import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const documentId = "doc_browser_reprocessing";
const title = "Archived hardware guide";
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
    throw new Error("Could not allocate browser fixture port.");
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function openSource(page: Page) {
  let sourceText = "Original archived source text.";
  await page.route("**/fixture-hooks/**", async (route) => {
    const hookId = new URL(route.request().url()).pathname.split("/").pop();
    switch (hookId) {
      case "documentation.summary":
        return route.fulfill({
          json: { activeDocumentCount: 1, activeChunkCount: 1 },
        });
      case "documentation.ingest.queue":
        return route.fulfill({ json: { jobs: [] } });
      case "documentation.answer":
        return route.fulfill({
          json: {
            results: [
              {
                documentId,
                title,
                chunkId: 1,
                sourceType: "pdf",
                state: "active",
                locator: "page 1",
                snippet: sourceText,
              },
            ],
          },
        });
      case "documentation.documents.get":
        return route.fulfill({
          json: {
            document: {
              documentId,
              title,
              sourceType: "pdf",
              state: "active",
              uri: "file:///archive/hardware-guide.pdf",
              chunks: [{ chunkId: 1, locator: "page 1", text: sourceText }],
            },
          },
        });
      default:
        throw new Error(`Unexpected fixture hook: ${hookId}`);
    }
  });
  await page.goto(`${baseUrl}tests/browser/fixtures/documentation-panel.html`);
  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "View Source", exact: true }).click();
  await expect(page.locator(".documentation-chunk")).toContainText(sourceText);
  return (text: string) => {
    sourceText = text;
  };
}

async function expectSourceActionsFit(page: Page) {
  const viewer = page.locator(".documentation-source-viewer");
  await expect(viewer).toBeVisible();
  for (const name of ["Reanalyze and enrich", "Re-enrich", "Remove", "Close"]) {
    const button = viewer.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
  }
  expect(
    await viewer.locator(".documentation-chunk p").evaluate((element) => {
      const text = document.createRange();
      text.selectNodeContents(element);
      const bounds = text.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
    }),
  ).toBe(true);
  expect(
    await viewer.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".documentation-panel")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
}

test("source actions and text remain visible in a narrow pane", async ({
  page,
}, testInfo) => {
  await openSource(page);
  await page.locator("#root").evaluate((element) => {
    element.style.width = "360px";
  });
  await expectSourceActionsFit(page);
  await page.screenshot({ path: testInfo.outputPath("narrow-pane.png") });
});

for (const operation of [
  {
    hook: "reanalyze",
    button: "Reanalyze and enrich",
    completion: "Reanalysis",
  },
  { hook: "reenrich", button: "Re-enrich", completion: "Re-enrichment" },
]) {
  test(`${operation.completion} keeps actions reachable and refreshes the source after a mocked completion`, async ({
    page,
  }, testInfo) => {
    const updateSource = await openSource(page);
    await expectSourceActionsFit(page);
    const response = Promise.withResolvers<void>();
    const request = Promise.withResolvers<Record<string, unknown>>();
    await page.route(
      `**/fixture-hooks/documentation.documents.${operation.hook}`,
      async (route) => {
        request.resolve(route.request().postDataJSON());
        await response.promise;
        await route.fulfill({ json: {} });
      },
    );
    await page
      .getByRole("button", { name: operation.button, exact: true })
      .click();
    expect(await request.promise).toEqual({ documentId });
    try {
      for (const name of ["Reanalyze and enrich", "Re-enrich", "Remove"]) {
        await expect(
          page.getByRole("button", { name, exact: true }),
        ).toBeDisabled();
      }
      await expect(page.getByRole("status")).toContainText(
        `Processing ${title}`,
      );
      await page.screenshot({ path: testInfo.outputPath("pending.png") });
      updateSource(`Source refreshed after ${operation.completion}.`);
    } finally {
      response.resolve();
    }
    await expect(page.getByRole("alert")).toHaveText(
      `${title}: ${operation.completion} complete.`,
    );
    await expect(page.locator(".documentation-chunk")).toContainText(
      `Source refreshed after ${operation.completion}.`,
    );
    await expect(
      page.getByRole("button", { name: operation.button, exact: true }),
    ).toBeEnabled();
    await expectSourceActionsFit(page);
    await page.screenshot({ path: testInfo.outputPath("complete.png") });
  });
}

test("a mocked reprocessing error stays visible and restores the source actions", async ({
  page,
}, testInfo) => {
  await openSource(page);
  await page.route(
    "**/fixture-hooks/documentation.documents.reenrich",
    (route) =>
      route.fulfill({
        status: 503,
        json: { message: "Enrichment service unavailable." },
      }),
  );
  await page.getByRole("button", { name: "Re-enrich", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Enrichment service unavailable.",
  );
  await expect(
    page.getByRole("button", { name: "Re-enrich", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".documentation-chunk")).toContainText(
    "Original archived source text.",
  );
  await expectSourceActionsFit(page);
  await page.screenshot({ path: testInfo.outputPath("error.png") });
});

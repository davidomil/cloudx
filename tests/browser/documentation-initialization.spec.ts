import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const initializing =
  "Documentation archive is initializing. Large archives may take several minutes. Refresh when initialization finishes.";
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

for (const listState of ["unopened", "opened"]) {
  test(`Refresh recovers from initialization with the active document list ${listState}`, async ({
    page,
  }, testInfo) => {
    let ready = false;
    let listRequests = 0;
    await page.route("**/fixture-hooks/**", async (route) => {
      const hookId = new URL(route.request().url()).pathname.split("/").pop();
      if (hookId === "documentation.ingest.queue")
        return route.fulfill({ json: { jobs: [] } });
      if (hookId === "documentation.documents.list") listRequests += 1;
      if (!ready)
        return route.fulfill({ status: 503, json: { message: initializing } });
      switch (hookId) {
        case "documentation.summary":
          return route.fulfill({
            json: { activeDocumentCount: 1, activeChunkCount: 3 },
          });
        case "documentation.documents.list":
          return route.fulfill({
            json: {
              documents: [
                {
                  documentId: "ready-doc",
                  title: "Initialized archive guide",
                  state: "active",
                },
              ],
            },
          });
        default:
          throw new Error(`Unexpected fixture hook: ${hookId}`);
      }
    });
    await page.goto(
      `${baseUrl}tests/browser/fixtures/documentation-panel.html`,
    );
    await expect(page.getByRole("alert")).toHaveText(initializing);
    expect(listRequests).toBe(0);
    if (listState === "opened") {
      await page.getByRole("button", { name: "Show active documents" }).click();
      await expect.poll(() => listRequests).toBe(1);
      await expect(page.getByRole("alert")).toHaveText(initializing);
    }
    await page.screenshot({ path: testInfo.outputPath("initializing.png") });

    ready = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByText("1 active documents, 3 active chunks"),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh", exact: true }),
    ).toBeEnabled();
    expect(listRequests).toBe(listState === "opened" ? 2 : 0);
    if (listState === "unopened")
      await page.getByRole("button", { name: "Show active documents" }).click();
    if (testInfo.project.name === "mobile-chromium")
      await page
        .getByRole("button", { name: "Active documents", exact: true })
        .click();
    await expect(page.locator(".documentation-document-row")).toContainText(
      "Initialized archive guide",
    );
    await expect(page.locator(".documentation-document-row")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("ready.png") });
  });
}

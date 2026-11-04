import { expect, test, type Frame, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import type { HTTPMethods } from "fastify";
import { createServer as createHttpServer, type Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { loadConfig } from "../../apps/server/src/config.js";
import { TabContextService } from "../../apps/server/src/context/TabContextService.js";
import { PathPolicy } from "../../apps/server/src/pathPolicy.js";
import { PluginRegistry } from "../../apps/server/src/pluginRegistry.js";
import { LocalWebPlugin } from "../../apps/server/src/plugins/LocalWebPlugin.js";
import { buildServer, type AppServices } from "../../apps/server/src/server.js";
import { SessionStore } from "../../apps/server/src/sessionStore.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let vite: ViteDevServer;
let httpServer: Server;
let localServer: Server;
let api: Awaited<ReturnType<typeof buildServer>>;
let workspace: string;
let cloudxOrigin: string;
let targetUrl: string;
let tabId: string;
const apiRequests: Array<{ origin?: string; status: number }> = [];

test.beforeAll(async () => {
  localServer = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><meta charset="utf-8">
      <title>Local Web storage reproducer</title>
      <h1 id="app">Loading dashboard...</h1>
      <a href="${cloudxOrigin}/api/local-web/${tabId}/proxy/" target="_blank">Open proxy popup</a>
      <script>
        const saved = localStorage.getItem('local-web-demo');
        localStorage.setItem('local-web-demo', 'dashboard preference');
        document.querySelector('#app').textContent = 'Dashboard ready';
      </script>`);
  });
  await listen(localServer);
  targetUrl = `${origin(localServer)}/dashboard?token=demo#comparison`;

  httpServer = createHttpServer();
  await listen(httpServer);
  cloudxOrigin = origin(httpServer);
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-local-web-browser-"),
  );
  const plugins = new PluginRegistry();
  plugins.register(new LocalWebPlugin());
  const pathPolicy = new PathPolicy([workspace]);
  const sessions = new SessionStore(
    plugins,
    pathPolicy,
    new TabContextService(path.join(workspace, ".cloudx")),
  );
  const config = {
    ...loadConfig({
      CLOUDX_DATA_DIR: path.join(workspace, ".cloudx"),
      CLOUDX_ALLOWED_ROOTS: workspace,
      CLOUDX_WEB_DIST_DIR: path.join(workspace, "missing-web-dist"),
      CLOUDX_APP_SERVER_ENABLED: "false",
      CLOUDX_AUTOMATION_START_DISABLED: "true",
      CLOUDX_LOG_LEVEL: "silent",
    }),
    trustedOrigins: [cloudxOrigin],
  };
  api = await buildServer(config, {
    plugins,
    sessions,
    pathPolicy,
    voice: {},
    asr: {},
  } as unknown as AppServices);
  const tab = await sessions.createTab({
    pluginId: "local-web",
    cwd: workspace,
    initialInput: { url: targetUrl },
  });
  tabId = tab.id;
  vite = await createServer({
    configFile: false,
    root: repoRoot,
    plugins: [react()],
    resolve: {
      alias: {
        "@cloudx/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      },
    },
    server: { middlewareMode: { server: httpServer }, ws: false },
    optimizeDeps: { entries: ["tests/browser/fixtures/local-web.html"] },
  });
  httpServer.on("request", async (request, response) => {
    if (!request.url?.startsWith("/api/")) {
      vite.middlewares(request, response);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await api.inject({
      method: request.method as HTTPMethods,
      url: request.url,
      headers: request.headers,
      ...(chunks.length ? { payload: Buffer.concat(chunks) } : {}),
    });
    if (request.url === "/api/health")
      apiRequests.push({
        origin: request.headers.origin,
        status: result.statusCode,
      });
    response
      .writeHead(result.statusCode, result.headers)
      .end(result.rawPayload);
  });
}, 60_000);

test.afterAll(async () => {
  await vite?.close();
  for (const server of [httpServer, localServer])
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  await api?.close();
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

test("explains blocked dashboard storage and opens the original site with isolated storage", async ({
  page,
  context,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${cloudxOrigin}/tests/browser/fixtures/local-web.html?tabId=${tabId}`,
  );
  await page.evaluate(() =>
    localStorage.setItem("cloudx-private-test", "CloudX only"),
  );
  const notice = page.getByRole("complementary", {
    name: "Restricted preview",
  });
  await expect(notice).toContainText("localStorage and sessionStorage");
  await expect(notice).toContainText("localhost refers to this device");
  const iframe = page.locator("iframe");
  await expect(iframe).not.toHaveAttribute("sandbox", /allow-same-origin/);
  await expect(page.frameLocator("iframe").locator("#app")).toHaveText(
    "Loading dashboard...",
  );
  await expect
    .poll(() => errors.some((error) => error.includes("localStorage")))
    .toBe(true);
  const frame = (await (await iframe.elementHandle())!.contentFrame())!;
  await expectCloudxIsolation(frame, "null");
  const frameBounds = await iframe.boundingBox();
  const noticeBounds = await notice.boundingBox();
  expect(frameBounds!.height).toBeGreaterThan(100);
  expect(noticeBounds!.y + noticeBounds!.height).toBeLessThanOrEqual(
    frameBounds!.y,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const screenshot = testInfo.outputPath("restricted-preview.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("restricted-preview", {
    path: screenshot,
    contentType: "image/png",
  });

  const popupPromise = context.waitForEvent("page");
  await notice
    .getByRole("link", { name: "Open original site in a new tab" })
    .click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(targetUrl);
  await expect(popup.locator("#app")).toHaveText("Dashboard ready");
  expect(
    await popup.evaluate(() => ({
      saved: localStorage.getItem("local-web-demo"),
      cloudx: localStorage.getItem("cloudx-private-test"),
      opener: window.opener,
    })),
  ).toEqual({ saved: "dashboard preference", cloudx: null, opener: null });
  await expectCloudxApiBlocked(popup, new URL(targetUrl).origin);
  expect(
    await page.evaluate(() => localStorage.getItem("local-web-demo")),
  ).toBeNull();
  expect(
    await page.evaluate(() => localStorage.getItem("cloudx-private-test")),
  ).toBe("CloudX only");
});

test("keeps top-level proxy pages and escaped proxy popups sandboxed", async ({
  page,
  context,
}) => {
  await page.goto(
    `${cloudxOrigin}/tests/browser/fixtures/local-web.html?tabId=${tabId}`,
  );
  const proxyPopupPromise = context.waitForEvent("page");
  await page
    .frameLocator("iframe")
    .getByRole("link", { name: "Open proxy popup" })
    .click();
  const proxyPopup = await proxyPopupPromise;
  await expect(proxyPopup.locator("#app")).toHaveText("Loading dashboard...");
  await expectCloudxIsolation(proxyPopup, "null");
  const response = await page.goto(
    `${cloudxOrigin}/api/local-web/${tabId}/proxy/`,
  );
  expect(response!.headers()["content-security-policy"]).toContain(
    "sandbox allow-",
  );
  await expect(page.locator("#app")).toHaveText("Loading dashboard...");
  await expectCloudxIsolation(page, "null");
});

async function expectCloudxIsolation(
  page: Page | Frame,
  requestOrigin: string,
) {
  expect(
    await page.evaluate(() => {
      return [
        () => localStorage,
        () => sessionStorage,
        () => parent.localStorage,
      ].map((readStorage) => {
        try {
          readStorage().getItem("cloudx-private-test");
          return "accessible";
        } catch (error) {
          return (error as DOMException).name;
        }
      });
    }),
  ).toEqual(["SecurityError", "SecurityError", "SecurityError"]);
  await expectCloudxApiBlocked(page, requestOrigin);
}

async function expectCloudxApiBlocked(
  page: Page | Frame,
  requestOrigin: string,
) {
  for (const method of ["GET", "POST"]) {
    const previousRequests = apiRequests.length;
    expect(
      await page.evaluate(
        async ({ url, method }) => {
          try {
            await fetch(url, { method });
            return "accessible";
          } catch {
            return "blocked";
          }
        },
        { url: `${cloudxOrigin}/api/health`, method },
      ),
    ).toBe("blocked");
    expect(apiRequests.slice(previousRequests)).toEqual([
      { origin: requestOrigin, status: 403 },
    ]);
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function origin(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}`;
}

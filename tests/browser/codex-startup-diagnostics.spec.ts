import { expect, test } from "@playwright/test";
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
    optimizeDeps: { entries: ["tests/browser/fixtures/terminal-startup.html"] },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing browser fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/terminal-startup.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

for (const initiallyFailed of [false, true]) {
  test(`keeps the bridge error readable when startup exits ${initiallyFailed ? "before" : "after"} the panel opens`, async ({
    page,
  }, testInfo) => {
    const input: string[] = [];
    let connections = 0;
    const error = "CloudX native worker bridge: startup failed.";
    await page.routeWebSocket("**/ws/terminal/startup-tab", (socket) => {
      connections++;
      socket.onMessage((message) => {
        const event = JSON.parse(String(message));
        if (event.type === "input") input.push(event.data);
      });
      socket.send(JSON.stringify({ type: "data", data: `${error}\r\n` }));
    });
    await page.goto(initiallyFailed ? `${baseUrl}?failed` : baseUrl);
    await expect(page.locator(".xterm-rows")).toContainText(error);
    if (!initiallyFailed)
      await page.getByRole("button", { name: "Report startup exit" }).click();

    await expect(
      page.getByRole("heading", { name: "Codex startup failed" }),
    ).toBeVisible();
    const output = page.getByRole("region", { name: "Codex terminal output" });
    await expect(output).toBeVisible();
    await expect(output.locator(".xterm-rows")).toContainText(error);
    const bounds = await output.boundingBox();
    expect(bounds!.height).toBeGreaterThan(120);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height + 1,
    );
    await expect(
      page.getByRole("textbox", { name: "Conversation session ID" }),
    ).toHaveCount(0);
    await output.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("must not resume");
    expect(input).toEqual([]);
    expect(connections).toBe(1);
    const screenshot = testInfo.outputPath("startup-diagnostics.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("startup-diagnostics.png", {
      path: screenshot,
      contentType: "image/png",
    });
  });
}

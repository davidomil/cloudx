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
    optimizeDeps: {
      entries: ["tests/browser/fixtures/claude-launch-mode.html"],
    },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing launch-mode fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/claude-launch-mode.html`;
});
test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

test("discloses the managed source tradeoff, saves future choice and preserves explicit interactive selection", async ({
  page,
}, testInfo) => {
  await page.goto(baseUrl);
  const mode = page.getByLabel("Claude launch mode", { exact: true });
  await expect(mode).toHaveValue("");
  const sourceDisclosure = page
    .getByText(
      "Shared project settings, project CLAUDE.md and project rules are omitted",
      { exact: false },
    )
    .first();
  await mode.scrollIntoViewIfNeeded();
  await expect(sourceDisclosure).toBeVisible();
  expect((await sourceDisclosure.boundingBox())!.y).toBeLessThan(
    (await mode.boundingBox())!.y,
  );
  await expect(
    page
      .getByText("local settings and CLAUDE.local.md", { exact: false })
      .first(),
  ).toBeVisible();
  await mode.selectOption("cloudx-managed");
  await page
    .getByRole("button", { name: "Save Claude settings", exact: true })
    .click();
  await expect(
    page.getByText("Saved choice: CloudX-managed", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Allow notes")).toBeChecked();
  await page
    .getByRole("button", { name: "Open new Claude tab", exact: true })
    .click();
  const dialog = page.locator(".dialog");
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  await expect(dialog.getByLabel("Claude launch mode")).toHaveValue("");
  await expect(
    dialog.getByRole("option", { name: "Inherit saved · CloudX-managed" }),
  ).toHaveCount(1);
  await dialog.getByLabel("Claude launch mode").selectOption("native-project");
  await page.screenshot({
    path: testInfo.outputPath("claude-launch-mode.png"),
  });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByLabel("Submitted launch")).toHaveText(
    JSON.stringify({
      agent: { providerId: "claude", accountId: "selected" },
      claudeLaunchMode: "native-project",
    }),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("offers only new and exact-ID Claude sessions and submits the selected UUID", async ({
  page,
}) => {
  await page.goto(baseUrl);
  await page
    .getByRole("button", { name: "Open new Claude tab", exact: true })
    .click();
  const dialog = page.locator(".dialog");
  const session = dialog.getByLabel("Session", { exact: true });
  await expect(session.locator("option")).toHaveText([
    "New session",
    "Resume ID",
  ]);
  await expect(
    dialog.getByText("Resume picker and Resume last cannot verify", {
      exact: false,
    }),
  ).toBeVisible();
  await session.selectOption("session");
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Session ID", { exact: true })
    .fill("b16b3294-9703-4c3c-a35c-de2c86d7e717");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByLabel("Submitted launch")).toHaveText(
    JSON.stringify({
      resume: {
        mode: "session",
        sessionId: "b16b3294-9703-4c3c-a35c-de2c86d7e717",
      },
      agent: { providerId: "claude", accountId: "selected" },
    }),
  );
});

test("keeps the longer mode disclosure and launch controls reachable in a short desktop window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 640 });
  await page.goto(baseUrl);
  await page
    .getByRole("button", { name: "Open new Claude tab", exact: true })
    .click();
  const dialog = page.locator(".dialog");
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(641);
  await dialog.getByLabel("Claude launch mode").selectOption("cloudx-managed");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByLabel("Submitted launch")).toContainText(
    '"claudeLaunchMode":"cloudx-managed"',
  );
});

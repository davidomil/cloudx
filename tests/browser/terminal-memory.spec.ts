import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type { TerminalMemoryStatus } from "@cloudx/shared";

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
    optimizeDeps: { entries: ["tests/browser/fixtures/terminal-memory.html"] },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing terminal memory fixture port.");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/terminal-memory.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

const status: TerminalMemoryStatus = {
  service: "cloudx-terminal.service",
  manageable: true,
  limits: {
    memoryHigh: String(24 * 1024 ** 3),
    memoryMax: String(32 * 1024 ** 3),
  },
  effective: {
    memoryHigh: String(24 * 1024 ** 3),
    memoryMax: String(32 * 1024 ** 3),
  },
  usageBytes: 31 * 1024 ** 3,
  pressure: { someAvg10: 96.22, fullAvg10: 95.73 },
  events: { high: 2260, oom: 0, oomKill: 0 },
  fragmentPath: "/home/operator/.config/systemd/user/cloudx-terminal.service",
  dropInPaths: [
    "/run/user/1000/systemd/user.control/cloudx-terminal.service.d/50-MemoryHigh.conf",
  ],
  controlGroup:
    "/user.slice/user-1000.slice/user@1000.service/app.slice/cloudx-terminal.service",
  activeState: "active",
};

test("applies explicit units live, shows inherited readback and keeps controls reachable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(
    testInfo.project.name.startsWith("mobile")
      ? { width: 360, height: 800 }
      : { width: 1440, height: 960 },
  );
  let current = status;
  const updates: unknown[] = [];
  await page.route("**/api/terminal-memory", (route) => {
    if (route.request().method() === "PUT") {
      const limits = route.request().postDataJSON();
      updates.push(limits);
      current = {
        ...status,
        limits,
        effective: {
          memoryHigh: String(40 * 1024 ** 3),
          memoryMax: "98530299904",
        },
      };
    }
    return route.fulfill({ json: current });
  });
  await page.goto(baseUrl);
  await page.getByLabel("Search settings").fill("MemoryHigh");
  const panel = page.getByRole("region", { name: "Terminal service memory" });
  await expect(panel.getByRole("table")).toContainText("24 GiB");
  await expect(panel.getByText("96.22%", { exact: true })).toBeVisible();
  await panel
    .getByRole("table")
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({
    path: testInfo.outputPath("terminal-memory-observed.png"),
  });
  await panel
    .getByText("Systemd configuration and existing overrides", { exact: true })
    .click();
  await expect(
    panel.getByText(status.dropInPaths[0]!, { exact: true }),
  ).toBeVisible();
  await panel.getByLabel("MemoryHigh amount", { exact: true }).fill("55");
  const apply = panel.getByRole("button", {
    name: "Apply terminal memory",
    exact: true,
  });
  await expect(apply).toBeDisabled();
  await expect(panel.getByRole("alert")).toContainText(
    "MemoryHigh must not exceed MemoryMax",
  );
  await panel.getByLabel("MemoryMax amount", { exact: true }).fill("128");
  await apply.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("terminal-memory-controls.png"),
  });
  await apply.click();
  expect(updates).toEqual([
    { memoryHigh: String(55 * 1024 ** 3), memoryMax: String(128 * 1024 ** 3) },
  ]);
  await expect(panel.getByRole("status")).toContainText(
    "applied and persisted",
  );
  await expect(panel.getByRole("table")).toContainText("40 GiB");
  await expect(panel.getByRole("table")).toContainText("91.76 GiB");
  await panel
    .getByRole("table")
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({
    path: testInfo.outputPath("terminal-memory-readback.png"),
  });
  await expect(panel.locator('[title="98530299904 B"]')).toHaveText(
    "91.76 GiB",
  );
  await panel
    .getByRole("button", { name: "Refresh memory", exact: true })
    .click();
  await expect(panel.getByRole("table")).toContainText("91.76 GiB");
  expect(
    await page
      .locator(".settings-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("shows unavailable readings and an actionable apply error without success", async ({
  page,
}) => {
  let unavailable = false;
  await page.route("**/api/terminal-memory", (route) => {
    if (route.request().method() === "PUT")
      return route.fulfill({
        status: 403,
        json: {
          message:
            "Cannot persist memory policy. Check write permission on the user systemd directory.",
        },
      });
    return route.fulfill({
      json: unavailable
        ? {
            ...status,
            manageable: false,
            reason: "The user systemd manager is unavailable.",
            limits: { memoryHigh: null, memoryMax: "infinity" },
            effective: { memoryHigh: null, memoryMax: null },
          }
        : status,
    });
  });
  await page.goto(baseUrl);
  await page.getByLabel("Search settings").fill("MemoryHigh");
  const panel = page.getByRole("region", { name: "Terminal service memory" });
  await panel
    .getByLabel("MemoryHigh unit", { exact: true })
    .selectOption("infinity");
  await panel
    .getByLabel("MemoryMax unit", { exact: true })
    .selectOption("infinity");
  await panel
    .getByRole("button", { name: "Apply terminal memory", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText(
    "Check write permission",
  );
  await expect(panel.getByRole("status")).toHaveCount(0);
  unavailable = true;
  await panel
    .getByRole("button", { name: "Refresh memory", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "user systemd manager is unavailable",
  );
  await expect(panel.getByRole("table")).toContainText("Unknown");
  await expect(panel.getByRole("table")).toContainText("Unlimited");
  await expect(
    panel.getByLabel("MemoryHigh amount", { exact: true }),
  ).toBeDisabled();
});

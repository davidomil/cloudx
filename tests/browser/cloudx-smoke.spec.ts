import { expect, test } from "@playwright/test";
import type { CreateTabResponse, TabLayoutNode } from "@cloudx/shared";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

let baseUrl: string;
let server: ChildProcessWithoutNullStreams;
let testRoot: string;
let serverLogs = "";

test.describe("CloudX shipped shell", () => {
  test.beforeAll(async () => {
    testRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-browser-smoke-"),
    );
    const workspace = path.join(testRoot, "workspace");
    const data = path.join(testRoot, "data");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "README.md"),
      "# Browser smoke workspace\n",
    );

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["apps/server/dist/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLOUDX_ALLOWED_ROOTS: workspace,
        CLOUDX_APP_SERVER_ENABLED: "false",
        CLOUDX_ASR_URL: "http://127.0.0.1:9",
        CLOUDX_AUTOMATION_START_DISABLED: "true",
        CLOUDX_DATA_DIR: data,
        CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
        CLOUDX_HOST: "127.0.0.1",
        CLOUDX_LOG_LEVEL: "warn",
        CLOUDX_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => (serverLogs += chunk.toString()));
    server.stderr.on("data", (chunk) => (serverLogs += chunk.toString()));
    await waitForHealth();
  });

  test.afterAll(async () => {
    server?.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => server?.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  test("renders a connected, non-overflowing workspace", async ({
    page,
  }, testInfo) => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(page.locator(".workspace-pane").first()).toBeVisible();
    await expect(page.locator('[aria-label^="connected:"]')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);

    const screenshot = await page.screenshot({
      path: testInfo.outputPath("workspace.png"),
    });
    await testInfo.attach("workspace", {
      body: screenshot,
      contentType: "image/png",
    });
  });

  test("creates a tab from the committed window without duplicate layout persistence", async ({
    page,
  }, testInfo) => {
    const workspaceRequests: Array<{
      method: "PATCH" | "POST";
      pathname: string;
      body: unknown;
    }> = [];
    page.on("request", (request) => {
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      if (
        (method === "PATCH" && /^\/api\/windows\/[^/]+$/.test(pathname)) ||
        (method === "POST" && pathname === "/api/tabs")
      ) {
        workspaceRequests.push({
          method,
          pathname,
          body: request.postDataJSON(),
        });
      }
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".workspace-pane")).toHaveCount(1);

    const visibleSplitButton = page.locator('button[title^="Split"]:visible');
    if ((await visibleSplitButton.count()) === 0) {
      await page.getByRole("button", { name: "Workspace actions" }).click();
    }
    await visibleSplitButton.first().click();
    await expect(page.locator(".workspace-pane")).toHaveCount(2);

    const targetPane = page.locator(".workspace-pane.active");
    const paneId = await targetPane.getAttribute("data-pane-id");
    expect(paneId).toBeTruthy();
    await targetPane.getByTitle("Add tab to this pane").click();

    await page.getByLabel("Plugin").selectOption("local-web");
    await page.getByLabel("Title").fill("Browser placement");
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/tabs",
    );
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);

    const committed = (await createResponse.json()) as CreateTabResponse;
    const createRequest = workspaceRequests.find(
      (request) => request.method === "POST",
    );
    expect(workspaceRequests.map((request) => request.method)).toEqual([
      "PATCH",
      "POST",
    ]);
    expect(createRequest?.body).toMatchObject({
      pluginId: "local-web",
      windowId: committed.window.id,
      paneId,
    });
    const committedPane = findPane(committed.window.layout.root, paneId!);
    expect(committedPane?.tabIds).toContain(committed.tab.id);
    expect(committedPane?.activeTabId).toBe(committed.tab.id);
    await expect(
      targetPane.getByText("Browser placement", { exact: true }),
    ).toBeVisible();

    await page.waitForTimeout(500);
    expect(
      workspaceRequests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(1);

    const screenshot = await page.screenshot({
      path: testInfo.outputPath("tab-placement.png"),
    });
    await testInfo.attach("tab placement", {
      body: screenshot,
      contentType: "image/png",
    });
  });
});

function findPane(root: TabLayoutNode, paneId: string) {
  if (root.type === "pane") {
    return root.pane.id === paneId ? root.pane : undefined;
  }
  return (
    findPane(root.children[0], paneId) ?? findPane(root.children[1], paneId)
  );
}

async function freePort() {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string")
    throw new Error("Browser smoke probe did not bind a TCP port.");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(
        `CloudX browser smoke server exited early.\n${serverLogs}`,
      );
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The server has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `CloudX browser smoke server did not become healthy.\n${serverLogs}`,
  );
}

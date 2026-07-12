import { expect, test } from "@playwright/test";
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
});

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

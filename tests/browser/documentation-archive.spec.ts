import { expect, test, type Page } from "@playwright/test";
import type { WorkspaceStateResponse } from "@cloudx/shared";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const serverEntry = "tests/browser/fixtures/catalog-server.mjs";
let testRoot: string;
let baseUrl: string;
let server: ChildProcess;
let serverLogs = "";

test.beforeEach(async () => {
  serverLogs = "";
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-documentation-archive-browser-"),
  );
  const data = path.join(testRoot, "data");
  const codexHome = path.join(testRoot, "codex-home");
  const imagegen = path.join(codexHome, "skills", ".system", "imagegen");
  await fs.mkdir(imagegen, { recursive: true });
  await fs.writeFile(
    path.join(imagegen, "SKILL.md"),
    "---\nname: imagegen\ndescription: Browser fixture only.\n---\nFixture data only.\n",
  );
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate browser test port.");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  baseUrl = `http://127.0.0.1:${address.port}`;
  server = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLOUDX_ALLOWED_ROOTS: testRoot,
      CLOUDX_APP_SERVER_ENABLED: "false",
      CLOUDX_ASR_URL: "http://127.0.0.1:9",
      CLOUDX_AUTOMATION_START_DISABLED: "true",
      CLOUDX_DATA_DIR: data,
      CLOUDX_WEB_DIST_DIR: path.join(repoRoot, "apps/web/dist"),
      CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
      CLOUDX_HOST: "127.0.0.1",
      CLOUDX_HTTPS_KEY_PATH: "",
      CLOUDX_HTTPS_CERT_PATH: "",
      CLOUDX_LOG_LEVEL: "warn",
      CLOUDX_PORT: String(address.port),
      CODEX_HOME: codexHome,
      CODEX_SQLITE_HOME: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (chunk) => {
    serverLogs += chunk.toString();
  });
  server.stderr!.on("data", (chunk) => {
    serverLogs += chunk.toString();
  });
  await expect
    .poll(
      async () => {
        if (server.exitCode !== null)
          throw new Error(`Browser test server exited.\n${serverLogs}`);
        try {
          return (await fetch(`${baseUrl}/api/health`)).ok;
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});

test.afterEach(async ({}, testInfo) => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise<void>((resolve) =>
      server.once("exit", () => resolve()),
    );
    server.kill("SIGTERM");
    const forceStop = setTimeout(() => server.kill("SIGKILL"), 2_000);
    try {
      await exited;
    } finally {
      clearTimeout(forceStop);
    }
  }
  const logPath = testInfo.outputPath("server.log");
  await fs.writeFile(logPath, serverLogs);
  await testInfo.attach("server.log", {
    path: logPath,
    contentType: "text/plain",
  });
  if (testRoot) await fs.rm(testRoot, { recursive: true, force: true });
});

async function openDocumentationTabs(page: Page) {
  const workspace = (await (
    await page.request.get(`${baseUrl}/api/workspace`)
  ).json()) as WorkspaceStateResponse;
  const activeWindow = workspace.windows.find(
    (window) => window.id === workspace.activeWindowId,
  )!;
  for (const [pluginId, title] of [
    ["rules-skills", "Other work"],
    ["documentation", "Archive work"],
  ]) {
    const created = await page.request.post(`${baseUrl}/api/tabs`, {
      data: {
        pluginId,
        title,
        windowId: activeWindow.id,
        paneId: activeWindow.layout.activePaneId,
      },
    });
    expect(created.status()).toBe(201);
  }
  await page.route("**/api/hooks/documentation.ingest.queue", (route) =>
    route.fulfill({ json: { result: { jobs: [] } } }),
  );
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".documentation-panel")).toBeVisible();
}

async function showArchiveControls(page: Page) {
  const panel = page.locator(".documentation-panel");
  const exportButton = panel.getByRole("button", {
    name: "Export",
    exact: true,
  });
  if (!(await exportButton.isVisible()))
    await panel.getByRole("button", { name: "Archive", exact: true }).click();
  return panel;
}

test("exports with pending counts, keeps preparation across tabs, and downloads directly", async ({
  page,
}, testInfo) => {
  const releaseSummary = Promise.withResolvers<void>();
  let complete = false;
  let starts = 0;
  const job = () => ({
    id: "browser-export",
    status: complete ? "complete" : "running",
    stage: complete ? "Archive ready." : "Packaging archive files.",
    progress: complete ? 100 : 42,
    filename: "cloudx-browser-archive.zip",
  });
  await page.route("**/api/hooks/documentation.summary", async (route) => {
    await releaseSummary.promise;
    await route.fulfill({
      json: { result: { activeDocumentCount: 1500, activeChunkCount: 300000 } },
    });
  });
  await page.route("**/api/documentation/archive/exports", (route) => {
    starts += 1;
    return route.fulfill({ json: job() });
  });
  await page.route(
    "**/api/documentation/archive/exports/browser-export",
    (route) => route.fulfill({ json: job() }),
  );
  await page.route(
    "**/api/documentation/archive/exports/browser-export/download",
    (route) =>
      route.fulfill({
        contentType: "application/zip",
        headers: {
          "content-disposition":
            'attachment; filename="cloudx-browser-archive.zip"',
        },
        body: "browser archive fixture",
      }),
  );
  try {
    await openDocumentationTabs(page);
    const panel = await showArchiveControls(page);
    await expect(panel).toContainText("Loading archive counts.");
    await panel.getByRole("button", { name: "Export", exact: true }).click();
    await expect(
      panel.getByRole("progressbar", { name: "Archive export progress" }),
    ).toHaveAttribute("value", "42");
    await page.locator(".tab-button").filter({ hasText: "Other work" }).click();
    await expect(panel).toHaveCount(0);
    complete = true;
    await page
      .locator(".tab-button")
      .filter({ hasText: "Archive work" })
      .click();
    await showArchiveControls(page);
    const downloadLink = panel.getByRole("link", {
      name: "Download archive",
      exact: true,
    });
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute(
      "href",
      "/api/documentation/archive/exports/browser-export/download",
    );
    const downloading = page.waitForEvent("download");
    await downloadLink.click();
    expect((await downloading).suggestedFilename()).toBe(
      "cloudx-browser-archive.zip",
    );
    expect(starts).toBe(1);
    await testInfo.attach("archive-ready", {
      body: await page.screenshot({
        path: testInfo.outputPath("archive-ready.png"),
      }),
      contentType: "image/png",
    });
  } finally {
    releaseSummary.resolve();
  }
});

test("retains pending import and completion across workspace tabs", async ({
  page,
}) => {
  const finishImport = Promise.withResolvers<void>();
  let uploads = 0;
  await page.route("**/api/hooks/documentation.summary", (route) =>
    route.fulfill({
      json: { result: { activeDocumentCount: 1500, activeChunkCount: 300000 } },
    }),
  );
  await page.route(
    "**/api/documentation/archive/import/merge?*",
    async (route) => {
      uploads += 1;
      await finishImport.promise;
      await route.fulfill({ json: { import: { mode: "merge" } } });
    },
  );
  try {
    await openDocumentationTabs(page);
    const panel = await showArchiveControls(page);
    await panel.getByLabel("Archive ZIP", { exact: true }).setInputFiles({
      name: "archive.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("archive upload fixture"),
    });
    await panel.getByRole("button", { name: "Import", exact: true }).click();
    await expect(panel).toContainText("Uploading archive.");
    await expect(
      panel.getByRole("progressbar", { name: "Archive import progress" }),
    ).toHaveAttribute("value", "0");
    await page.locator(".tab-button").filter({ hasText: "Other work" }).click();
    await expect(panel).toHaveCount(0);
    finishImport.resolve();
    await page
      .locator(".tab-button")
      .filter({ hasText: "Archive work" })
      .click();
    await showArchiveControls(page);
    await expect(panel).toContainText("Archive merge import complete.");
    await expect(
      panel.getByRole("progressbar", { name: "Archive import progress" }),
    ).toHaveAttribute("value", "100");
    expect(uploads).toBe(1);
  } finally {
    finishImport.resolve();
  }
});

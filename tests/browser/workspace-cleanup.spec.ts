import { expect, test } from "@playwright/test";
import type {
  WorkspaceCleanupJob,
  WorkspaceCleanupPreview,
  WorkspaceCleanupRequest,
} from "@cloudx/shared";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
const repoRoot = path.resolve(import.meta.dirname, "../..");
let testRoot: string;
let baseUrl: string;
let server: ChildProcess;
let serverLogs = "";
test.beforeEach(async ({ page }) => {
  serverLogs = "";
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-workspace-cleanup-"),
  );
  const codexHome = path.join(testRoot, "codex-home");
  const imagegen = path.join(codexHome, "skills", ".system", "imagegen");
  await fs.mkdir(imagegen, { recursive: true });
  await fs.writeFile(
    path.join(imagegen, "SKILL.md"),
    "---\nname: imagegen\ndescription: Browser fixture only.\n---\nSynthetic fixture data.\n",
  );
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate Settings browser test port.");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  baseUrl = `http://127.0.0.1:${address.port}`;
  server = spawn(
    process.execPath,
    ["tests/browser/fixtures/catalog-server.mjs"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLOUDX_ALLOWED_ROOTS: testRoot,
        CLOUDX_APP_SERVER_ENABLED: "false",
        CLOUDX_ASR_URL: "http://127.0.0.1:9",
        CLOUDX_AUTOMATION_START_DISABLED: "true",
        CLOUDX_DATA_DIR: path.join(testRoot, "data"),
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
    },
  );
  server.stdout!.on("data", (chunk) => (serverLogs += chunk.toString()));
  server.stderr!.on("data", (chunk) => (serverLogs += chunk.toString()));
  await expect
    .poll(
      async () => {
        if (server.exitCode !== null)
          throw new Error(`Settings browser server exited.\n${serverLogs}`);
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

test("Settings previews, confirms and reports permanent workspace cleanup at every viewport", async ({
  page,
  isMobile,
}, testInfo) => {
  const firstId = "11111111-1111-1111-1111-111111111111";
  const retainedId = "22222222-2222-2222-2222-222222222222";
  const longPath =
    "/home/developer/projects/cloudx/.cloudx/forge-workers/checkouts/retained-batch-with-an-extremely-long-directory-name";
  const preview: WorkspaceCleanupPreview = {
    id: "33333333-3333-3333-3333-333333333333",
    createdAt: new Date().toISOString(),
    reclaimableBytes: 4 * 1024 ** 3,
    reclaimGroups: [
      { bytes: 4 * 1024 ** 3, candidateIds: [firstId] },
      { bytes: 1024 ** 3, candidateIds: [retainedId] },
    ],
    availableBytes: 1024 ** 3,
    warnings: [],
    candidates: [
      {
        id: firstId,
        path: "/work/merged-checkout",
        repository: "team/completed-project",
        kind: "forge",
        state: "completed",
        lastActivity: "2026-09-27T00:00:00Z",
        allocatedBytes: 4 * 1024 ** 3,
        eligible: true,
        reason: "Completed and inactive. Ignored dependencies can be deleted.",
        sourceChanges: [],
        unpublishedCommits: 0,
        requiresDiscard: false,
      },
      {
        id: retainedId,
        path: longPath,
        repository: "team/project-with-a-long-name-for-layout-review",
        kind: "forge",
        state: "completed",
        lastActivity: "2026-09-27T00:00:00Z",
        allocatedBytes: 1024 ** 3,
        eligible: true,
        reason: "Preserved by default.",
        sourceChanges: ["source/unfinished.ts", "debug_tooling/notes.md"],
        unpublishedCommits: 1,
        requiresDiscard: true,
      },
      {
        id: "44444444-4444-4444-4444-444444444444",
        path: "/work/active-batch",
        repository: "team/active-project",
        kind: "forge",
        state: "paused",
        lastActivity: "2026-09-28T00:00:00Z",
        allocatedBytes: 1024 ** 3,
        eligible: false,
        reason: "An unfinished worker or reviewer still needs this checkout.",
        sourceChanges: [],
        unpublishedCommits: 0,
        requiresDiscard: false,
      },
    ],
  };
  let request: WorkspaceCleanupRequest | undefined;
  let status: WorkspaceCleanupJob | null = null;
  let finish = false;
  await page.route("**/api/system/workspace-cleanup/preview", (route) =>
    route.fulfill({ json: preview }),
  );
  await page.route("**/api/system/workspace-cleanup", async (route) => {
    if (route.request().method() === "POST") {
      request = route.request().postDataJSON();
      status = {
        id: "55555555-5555-5555-5555-555555555555",
        state: "running",
        startedAt: new Date().toISOString(),
        availableBytesBefore: preview.availableBytes,
        results: [
          {
            id: firstId,
            path: preview.candidates[0]!.path,
            status: "deleting",
            reason: "Revalidating ownership, working files and activity.",
          },
        ],
      };
      await route.fulfill({ status: 202, json: status });
    } else {
      if (finish && status)
        status = {
          ...status,
          state: "completed",
          availableBytesAfter: 5 * 1024 ** 3,
          results: status.results.map((item) => ({
            ...item,
            status: "deleted",
            reason: "Permanently deleted; workspace metadata reconciled.",
          })),
        };
      await route.fulfill({ json: status });
    }
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".workspace-pane").first()).toBeVisible();
  if (isMobile) {
    await page
      .getByRole("button", { name: "Workspace actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  } else
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog
    .getByRole("searchbox", { name: "Search settings" })
    .fill("old workspaces");
  const cleanup = dialog.getByRole("region", { name: "Workspace cleanup" });
  await cleanup
    .getByRole("button", { name: "Delete all old workspaces" })
    .click();
  await expect(
    cleanup.getByRole("checkbox", {
      name: `Select ${preview.candidates[0]!.path}`,
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    cleanup.getByRole("checkbox", { name: `Select ${longPath}`, exact: true }),
  ).not.toBeChecked();
  await expect(
    cleanup.getByRole("checkbox", {
      name: "Select /work/active-batch",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  const retainedCheckbox = cleanup.getByRole("checkbox", {
    name: `Select ${longPath}`,
    exact: true,
  });
  await retainedCheckbox.scrollIntoViewIfNeeded();
  expect((await retainedCheckbox.boundingBox())!.width).toBeLessThan(24);
  expect(
    await cleanup
      .locator(".workspace-cleanup-choice strong")
      .first()
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBeGreaterThan(80);
  await page.screenshot({
    path: testInfo.outputPath("workspace-cleanup-preview.png"),
    fullPage: true,
  });
  const review = cleanup.getByRole("button", {
    name: "Review deletion of 1 workspace",
    exact: true,
  });
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(
    cleanup.getByRole("group", { name: "Confirm permanent deletion" }),
  ).toContainText("cannot be recovered");
  await cleanup
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(
    cleanup.getByRole("progressbar", { name: "Workspace cleanup progress" }),
  ).toBeVisible();
  expect(request?.candidateIds).toEqual([firstId]);
  expect(request?.discardCandidateIds).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("workspace-cleanup-progress.png"),
    fullPage: true,
  });
  finish = true;
  await expect(
    cleanup.getByRole("heading", { name: "Cleanup results" }),
  ).toBeVisible();
  await expect(cleanup).toContainText("5.0 GiB available after cleanup");
  await expect(cleanup).toContainText("deleted");
  await page.screenshot({
    path: testInfo.outputPath("workspace-cleanup-results.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

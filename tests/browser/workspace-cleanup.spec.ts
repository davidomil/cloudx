import { expect, test, type Page } from "@playwright/test";
import type {
  CloudxUpdateBackup,
  CloudxUpdateBackupCleanup,
  CloudxUpdateBackupPreview,
  CloudxUpdatePreview,
  CloudxUpdateStatus,
} from "@cloudx/shared";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const timestamp = "2026-10-03T22:35:00Z";
const savedTarget = "c".repeat(40);
const savedRunId = "11111111-1111-4111-8111-111111111111";
const savedUpdateRequest = {
  channel: "main",
  targetCommit: savedTarget,
  resumeRunId: savedRunId,
};
const preview: CloudxUpdatePreview = {
  channel: "main",
  currentCommit: "a".repeat(40),
  runtime: {
    verification: "verified",
    commit: "a".repeat(40),
    builtAt: timestamp,
    sourceDirty: false,
  },
  checkedAt: timestamp,
  state: "available",
  target: {
    commit: "b".repeat(40),
    name: "main",
    url: `https://github.com/davidomil/cloudx/commit/${"b".repeat(40)}`,
  },
  changelog: [],
  changelogComplete: true,
};
const backup: CloudxUpdateBackup = {
  id: "22222222-2222-4222-8222-222222222222:snapshot",
  runId: "22222222-2222-4222-8222-222222222222",
  kind: "snapshot",
  sourceCommit: "a".repeat(40),
  targetCommit: "b".repeat(40),
  createdAt: timestamp,
  outcome: "succeeded",
  path: "/recovery/updates/retained-snapshot-with-a-long-directory-name",
  logicalBytes: 16 * 1024 ** 3,
  allocatedBytes: 16 * 1024 ** 3,
  reclaimableBytes: 16 * 1024 ** 3,
};
const backupPreview: CloudxUpdateBackupPreview = {
  id: "33333333-3333-4333-8333-333333333333",
  createdAt: timestamp,
  backups: [backup],
  reclaimableBytes: backup.reclaimableBytes!,
  estimateNote:
    "Shared files are counted once. Actual reclaimed space may differ.",
};
let testRoot: string;
let baseUrl: string;
let server: ChildProcess;
let serverLogs = "";
let apiRequests: Array<{ method: string; path: string; body: unknown }>;
let pageErrors: string[];

test.beforeEach(async ({ page }) => {
  serverLogs = "";
  apiRequests = [];
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/"))
      apiRequests.push({
        method: request.method(),
        path: pathname,
        body: request.postDataJSON(),
      });
  });
  await page.route(/\/api\/system\/workspace-cleanup(?:[/?]|$)/, (route) =>
    route.fulfill({
      status: 410,
      json: { message: "Manual cleanup was removed." },
    }),
  );
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
  const repository = {
    provider: "github",
    apiUrl: "https://api.github.com",
    projectPath: "cloudx/cleanup-fixture",
  };
  await page.route("**/api/hooks/forge.dashboard", (route) =>
    route.fulfill({
      json: { result: { configured: true, repository, workers: [] } },
    }),
  );
  for (const hook of ["forge.issues.list", "forge.changes.list"])
    await page.route(`**/api/hooks/${hook}`, (route) =>
      route.fulfill({ json: { result: { items: [] } } }),
    );
  await page.route("**/api/forge/resources", (route) =>
    route.fulfill({ json: { resources: [] } }),
  );
  await page.route("**/api/forge/checkout-evidence", (route) =>
    route.fulfill({ json: { archives: [] } }),
  );
  await page.route("**/api/forge/git-history", (route) =>
    route.fulfill({ json: { archives: [] } }),
  );
  await page.route("**/api/system/update", (route) =>
    route.fulfill({ json: { available: true } }),
  );
  await page.route("**/api/system/update/preview", (route) =>
    route.fulfill({ json: preview }),
  );
  await page.route("**/api/system/update/backups", (route) =>
    route.fulfill({ json: { backups: [backup] } }),
  );
  await page.route("**/api/system/update/backups/preview", (route) =>
    route.fulfill({ json: backupPreview }),
  );
  await page.route("**/api/system/update/backups/cleanup", (route) =>
    route.fulfill({ json: null }),
  );
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
  expect(
    apiRequests.filter((request) =>
      /workspace-cleanup|evidence-decision/.test(request.path),
    ),
  ).toEqual([]);
  expect(pageErrors).toEqual([]);
});

async function openSettings(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page
      .getByRole("button", { name: "Workspace actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  } else
    await page
      .locator(".topbar")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectManualCleanupAbsent(page: Page) {
  for (const name of [
    "Open workspace management",
    "Manage Forge environments",
    "Scan workspaces and environments",
    "Environments",
  ])
    await expect(
      page.getByRole("button", { name, exact: true, includeHidden: true }),
    ).toHaveCount(0);
  await expect(
    page.getByRole("tab", {
      name: "Workspaces",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", {
      name: "Workspace cleanup",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
}

async function openUpdates(page: Page, isMobile: boolean) {
  const dialog = await openSettings(page, isMobile);
  await dialog
    .getByRole("searchbox", { name: "Search settings" })
    .fill("update");
  await dialog.getByRole("tab", { name: "Updates", exact: true }).click();
  const updates = dialog.getByRole("region", { name: "CloudX updates" });
  const backups = updates.getByRole("region", {
    name: "Retained update backups",
  });
  await expect(updates).toBeVisible();
  await expectManualCleanupAbsent(page);
  return { dialog, updates, backups };
}

function postedBodies(requestPath: string) {
  return apiRequests
    .filter(
      (request) => request.path === requestPath && request.method === "POST",
    )
    .map((request) => request.body);
}

async function failedUpdate(page: Page) {
  const requiredBytes = 40859257735;
  let availableBytes = 27225911296;
  let resumed = false;
  const updateStatus = (): CloudxUpdateStatus => ({
    available: true,
    run: {
      id: savedRunId,
      state: resumed ? "running" : "failed",
      targetCommit: savedTarget,
      resumable: !resumed,
      message: resumed
        ? "Resuming original saved target"
        : "Update stopped; the previous installation is retained.",
      startedAt: timestamp,
      component: "capacity",
      capacity: resumed
        ? undefined
        : {
            stage: "build-staging",
            checkedAt: timestamp,
            filesystems: [
              {
                device: "1",
                mount: "/recovery",
                destination: "/recovery/update",
                requiredBytes,
                availableBytes,
                shortfallBytes: Math.max(0, requiredBytes - availableBytes),
                headroomBytes: 3714477976,
                requiredInodes: 2048,
                availableInodes: 10000,
                shortfallInodes: 0,
                reservations: [
                  {
                    destination: "/recovery/update",
                    purpose: "snapshot and failed-start recovery",
                    bytes: 1024 ** 3,
                    inodes: 100,
                  },
                  {
                    destination: "/recovery/update",
                    purpose: "release checkout and build staging estimate",
                    bytes: 2 * 1024 ** 3,
                    inodes: 100,
                  },
                ],
              },
            ],
          },
    },
  });
  await page.route("**/api/system/update/capacity", (route) =>
    route.fulfill({ json: updateStatus() }),
  );
  await page.route("**/api/system/update", (route) => {
    if (route.request().method() === "POST") resumed = true;
    return route.fulfill({ status: resumed ? 202 : 200, json: updateStatus() });
  });
  return () => {
    availableBytes = 50 * 1024 ** 3;
  };
}

test("Settings removes workspace management while retained backup review and Forge evidence remain usable", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".workspace-pane").first()).toBeVisible();
  const dialog = await openSettings(page, isMobile);
  await expectManualCleanupAbsent(page);
  await dialog
    .getByRole("searchbox", { name: "Search settings" })
    .fill("old workspaces");
  await expect(
    dialog.getByRole("status").filter({ hasText: "matching settings" }),
  ).toHaveText("0 matching settings across all tabs");
  await expect(
    dialog.getByRole("heading", { name: "No matching settings", exact: true }),
  ).toBeVisible();
  await expectManualCleanupAbsent(page);
  await dialog
    .getByRole("searchbox", { name: "Search settings" })
    .fill("update");
  await dialog.getByRole("tab", { name: "Updates", exact: true }).click();
  const updates = dialog.getByRole("region", { name: "CloudX updates" });
  const backups = updates.getByRole("region", {
    name: "Retained update backups",
  });
  const updateButton = updates.getByRole("button", {
    name: "Update CloudX and dependencies",
    exact: true,
  });
  await expect(updateButton).toBeEnabled();
  await backups
    .getByRole("button", { name: "Clean all update backups", exact: true })
    .click();
  const review = backups.getByRole("group", {
    name: "Review permanent update backup deletion",
  });
  await expect(review).toContainText(
    "1 eligible backup · 16.00 GiB estimated reclaimable",
  );
  await expect(
    review.getByRole("button", {
      name: "Delete all eligible backups permanently",
    }),
  ).toBeDisabled();
  await expect(updateButton).toBeDisabled();
  await review.getByRole("checkbox").check();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(postedBodies("/api/system/update/backups/cleanup")).toEqual([]);
  expect(postedBodies("/api/system/update/backups/preview")).toEqual([{}]);
  await expect(updateButton).toBeEnabled();
  await expect(backups).toContainText(backup.path);
  await expectManualCleanupAbsent(page);
  await dialog
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page
    .locator(".workspace-pane")
    .first()
    .getByTitle("Add tab to this pane")
    .click();
  await page
    .getByRole("combobox", { name: "Plugin", exact: true })
    .selectOption("forge");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const forge = page.getByRole("region", { name: "Forge", exact: true });
  await forge.getByRole("button", { name: "Evidence", exact: true }).click();
  const evidence = forge.getByRole("region", {
    name: "Saved evidence",
    exact: true,
  });
  await expect(evidence).toContainText(
    "Finished Forge workspaces clean automatically.",
  );
  await expect(
    evidence.getByText("Loading saved evidence…", { exact: true }),
  ).toHaveCount(0);
  await expect(
    evidence.locator("button, input, textarea, select, fieldset"),
  ).toHaveCount(0);
  await expectManualCleanupAbsent(page);
  await forge.getByRole("button", { name: "Issues", exact: true }).click();
  await expect(evidence).toHaveCount(0);
  await forge.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(evidence).toContainText(
    "Finished Forge workspaces clean automatically.",
  );
  await expectManualCleanupAbsent(page);
  await page.screenshot({
    path: testInfo.outputPath("automatic-workspace-cleanup.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("Update capacity rechecks reclaimed space and resumes the saved target without manual Forge cleanup", async ({
  page,
  isMobile,
}, testInfo) => {
  const recoverCapacity = await failedUpdate(page);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".workspace-pane").first()).toBeVisible();
  const { updates, backups } = await openUpdates(page, isMobile);
  await expect(updates).toContainText(
    "38.05 GiB required, 25.36 GiB available, 12.70 GiB more needed",
  );
  await expect(updates).toContainText(
    "3.46 GiB safety margin included. Recovery copies and build staging remain reserved.",
  );
  await expect(updates).toContainText(
    "snapshot and failed-start recovery: 1.00 GiB",
  );
  await expect(updates).toContainText(
    "release checkout and build staging estimate: 2.00 GiB",
  );
  await expect(updates).toContainText(
    `Resume target: ${savedTarget.slice(0, 12)}`,
  );
  await expect(
    backups.getByRole("button", {
      name: "Clean all update backups",
      exact: true,
    }),
  ).toBeEnabled();
  expect(postedBodies("/api/system/update/capacity")).toEqual([]);
  expect(postedBodies("/api/system/update")).toEqual([]);
  recoverCapacity();
  await updates
    .getByRole("button", { name: "Recheck update capacity", exact: true })
    .click();
  await expect(updates).toContainText(
    "38.05 GiB required, 50.00 GiB available, 0 B more needed",
  );
  expect(postedBodies("/api/system/update/capacity")).toEqual([
    savedUpdateRequest,
  ]);
  expect(postedBodies("/api/system/update/backups/cleanup")).toEqual([]);
  await expectManualCleanupAbsent(page);
  const resume = updates.getByRole("button", {
    name: "Resume update",
    exact: true,
  });
  await expect(resume).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("update-capacity-recovered.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(updates).toContainText("Resuming original saved target");
  expect(postedBodies("/api/system/update")).toEqual([savedUpdateRequest]);
  await expectManualCleanupAbsent(page);
});

test("Retained backup cleanup reconnects before capacity recheck and saved-target resume across Settings navigation", async ({
  page,
  isMobile,
}, testInfo) => {
  const recoverCapacity = await failedUpdate(page);
  let cleanup: CloudxUpdateBackupCleanup | null = null;
  let statusDisconnected = false;
  let finished = false;
  await page.route("**/api/system/update/backups", (route) =>
    route.fulfill({ json: { backups: finished ? [] : [backup] } }),
  );
  await page.route("**/api/system/update/backups/cleanup", (route) => {
    if (route.request().method() === "POST") {
      cleanup = {
        id: "44444444-4444-4444-8444-444444444444",
        state: "running",
        startedAt: timestamp,
        results: [
          {
            id: backup.id,
            runId: backup.runId,
            path: backup.path,
            status: "deleting",
            deletedLogicalBytes: 0,
          },
        ],
        freeSpace: [
          {
            path: "/recovery",
            availableBytesBefore: 27225911296,
            availableBytesAfter: null,
          },
        ],
      };
      return route.fulfill({ status: 202, json: cleanup });
    }
    if (cleanup && !statusDisconnected) {
      statusDisconnected = true;
      return route.fulfill({
        status: 503,
        json: { message: "Backup cleanup status connection lost." },
      });
    }
    if (cleanup && finished) {
      recoverCapacity();
      cleanup = {
        ...cleanup,
        state: "completed",
        finishedAt: timestamp,
        results: cleanup.results.map((item) => ({
          ...item,
          status: "deleted",
          deletedLogicalBytes: backup.logicalBytes!,
        })),
        freeSpace: [
          {
            path: "/recovery",
            availableBytesBefore: 27225911296,
            availableBytesAfter: 50 * 1024 ** 3,
          },
        ],
      };
    }
    return route.fulfill({ json: cleanup });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".workspace-pane").first()).toBeVisible();
  let { dialog, updates, backups } = await openUpdates(page, isMobile);
  await backups
    .getByRole("button", { name: "Clean all update backups", exact: true })
    .click();
  const review = backups.getByRole("group", {
    name: "Review permanent update backup deletion",
  });
  await expect(review).toContainText(
    "Recovery or downgrade using these saved data snapshots will become unavailable.",
  );
  const remove = review.getByRole("button", {
    name: "Delete all eligible backups permanently",
  });
  await expect(remove).toBeDisabled();
  await expect(
    updates.getByRole("button", { name: "Resume update", exact: true }),
  ).toBeDisabled();
  await expect(
    updates.getByRole("button", {
      name: "Recheck update capacity",
      exact: true,
    }),
  ).toBeDisabled();
  await review.getByRole("checkbox").check();
  await remove.click();
  await expect(
    backups.getByRole("progressbar", {
      name: "Update backup cleanup progress",
    }),
  ).toBeVisible();
  await expect(backups.getByRole("alert")).toContainText(
    "Could not monitor cleanup: Backup cleanup status connection lost.",
  );
  await expect(
    updates.getByRole("button", { name: "Resume update", exact: true }),
  ).toBeDisabled();
  await expect(
    updates.getByRole("button", {
      name: "Recheck update capacity",
      exact: true,
    }),
  ).toBeDisabled();
  expect(postedBodies("/api/system/update/capacity")).toEqual([]);
  expect(postedBodies("/api/system/update")).toEqual([]);
  await expectManualCleanupAbsent(page);
  finished = true;
  await backups
    .getByRole("button", { name: "Check cleanup status", exact: true })
    .click();
  await expect(backups.getByRole("alert")).toHaveCount(0);
  await expect(backups).toContainText(
    "1 deleted; 0 protected; 0 skipped; 0 failed",
  );
  await expect(backups).toContainText("50.00 GiB measured available afterward");
  await expect(backups).toContainText("No retained update backups found.");
  await dialog
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  ({ dialog, updates, backups } = await openUpdates(page, isMobile));
  await expect(backups).toContainText(
    "1 deleted; 0 protected; 0 skipped; 0 failed",
  );
  await expect(
    backups.getByRole("button", { name: "Check cleanup status", exact: true }),
  ).toBeEnabled();
  await updates
    .getByRole("button", { name: "Recheck update capacity", exact: true })
    .click();
  await expect(updates).toContainText("0 B more needed");
  expect(postedBodies("/api/system/update/capacity")).toEqual([
    savedUpdateRequest,
  ]);
  expect(postedBodies("/api/system/update/backups/cleanup")).toEqual([
    { previewId: backupPreview.id, confirmPermanentDeletion: true },
  ]);
  await page.screenshot({
    path: testInfo.outputPath("retained-backup-cleanup-reconnected.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await updates
    .getByRole("button", { name: "Resume update", exact: true })
    .click();
  await expect(updates).toContainText("Resuming original saved target");
  expect(postedBodies("/api/system/update")).toEqual([savedUpdateRequest]);
  await expectManualCleanupAbsent(page);
});

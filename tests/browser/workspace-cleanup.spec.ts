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
  await page.route("**/api/system/update/backups", (route) =>
    route.fulfill({ json: { backups: [] } }),
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
});

test("Settings opens canonical Environments cleanup and retains its deletion job across Forge sections at every viewport", async ({
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
  await expect(
    dialog.getByRole("region", { name: "Workspace cleanup" }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Open workspace management", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const forge = page.getByRole("region", { name: "Forge", exact: true });
  const cleanup = forge.getByRole("region", {
    name: "Workspace cleanup",
    exact: true,
  });
  await expect(
    cleanup.getByRole("combobox", { name: "Workspace filter" }),
  ).toHaveValue("all");
  await cleanup
    .getByRole("button", { name: "Scan workspaces and environments" })
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
  await forge.getByRole("button", { name: "Issues", exact: true }).click();
  await expect(cleanup).toHaveCount(0);
  await forge
    .getByRole("button", { name: "Environments", exact: true })
    .click();
  await expect(
    cleanup.getByRole("progressbar", { name: "Workspace cleanup progress" }),
  ).toBeVisible();
  finish = true;
  await expect(
    cleanup.getByRole("heading", { name: "Cleanup results" }),
  ).toBeVisible();
  await expect(cleanup).toContainText("5.00 GiB available after cleanup");
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

test("Update capacity recovery reviews Forge trash and resumes the same saved target", async ({
  page,
  isMobile,
}, testInfo) => {
  const target = "c".repeat(40);
  const runId = "11111111-1111-4111-8111-111111111111";
  const candidateId = "22222222-2222-4222-8222-222222222222";
  const timestamp = "2026-10-03T22:35:00Z";
  const requiredBytes = 40859257735;
  let availableBytes = 27225911296;
  let cleanup: WorkspaceCleanupJob | null = null;
  let finishCleanup = false;
  let capacityChecks = 0;
  let resume: Record<string, unknown> | undefined;
  const updateStatus = () => ({
    available: true,
    run: {
      id: runId,
      state: "failed",
      targetCommit: target,
      resumable: true,
      message: "Update stopped; the previous installation is retained.",
      startedAt: timestamp,
      component: "capacity",
      capacity: {
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
  await page.route("**/api/system/update/preview", (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );
  await page.route("**/api/system/update/capacity", (route) => {
    capacityChecks++;
    expect(route.request().postDataJSON()).toEqual({
      channel: "main",
      targetCommit: target,
      resumeRunId: runId,
    });
    return route.fulfill({ json: updateStatus() });
  });
  await page.route("**/api/system/update", (route) => {
    if (route.request().method() === "POST") {
      resume = route.request().postDataJSON();
      return route.fulfill({
        status: 202,
        json: {
          available: true,
          run: {
            ...updateStatus().run,
            state: "running",
            resumable: false,
            capacity: undefined,
            message: "Resuming original saved target",
          },
        },
      });
    }
    return route.fulfill({ json: updateStatus() });
  });
  await page.route("**/api/system/workspace-cleanup/preview", (route) =>
    route.fulfill({
      json: {
        id: "33333333-3333-4333-8333-333333333333",
        createdAt: timestamp,
        availableBytes,
        warnings: [],
        reclaimableBytes: 16 * 1024 ** 3,
        reclaimGroups: [{ bytes: 16 * 1024 ** 3, candidateIds: [candidateId] }],
        candidates: [
          {
            id: candidateId,
            path: "/work/completed-forge",
            repository: "team/project",
            kind: "forge",
            state: "completed",
            lastActivity: timestamp,
            allocatedBytes: 16 * 1024 ** 3,
            eligible: true,
            reason: "Completed and inactive",
            sourceChanges: [],
            unpublishedCommits: 0,
            requiresDiscard: false,
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            path: "/work/active-forge",
            repository: "team/project",
            kind: "forge",
            state: "running",
            lastActivity: timestamp,
            allocatedBytes: 1024 ** 3,
            eligible: false,
            reason: "An unfinished worker still needs this checkout",
            sourceChanges: [],
            unpublishedCommits: 0,
            requiresDiscard: false,
          },
          {
            id: "66666666-6666-4666-8666-666666666666",
            path: "/work/unpublished",
            repository: "team/project",
            kind: "forge",
            state: "completed",
            lastActivity: timestamp,
            allocatedBytes: 1024 ** 3,
            eligible: true,
            reason: "Source changes must be preserved",
            sourceChanges: ["source.ts"],
            unpublishedCommits: 1,
            requiresDiscard: true,
          },
        ],
      },
    }),
  );
  await page.route("**/api/system/workspace-cleanup", (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toMatchObject({
        candidateIds: [candidateId],
        discardCandidateIds: [],
        confirmation: "Delete permanently",
      });
      cleanup = {
        id: "55555555-5555-4555-8555-555555555555",
        state: "running",
        startedAt: timestamp,
        availableBytesBefore: availableBytes,
        results: [
          {
            id: candidateId,
            path: "/work/completed-forge",
            status: "deleting",
            reason: "Revalidating ownership and activity",
          },
        ],
      };
      return route.fulfill({ status: 202, json: cleanup });
    }
    if (finishCleanup && cleanup) {
      availableBytes = 50 * 1024 ** 3;
      cleanup = {
        ...cleanup,
        state: "completed",
        availableBytesAfter: availableBytes,
        results: cleanup.results.map((item) => ({
          ...item,
          status: "deleted",
          reason: "Permanently deleted",
        })),
      };
    }
    return route.fulfill({ json: cleanup });
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
    .fill("update");
  await dialog.getByRole("tab", { name: "Updates", exact: true }).click();
  const updates = dialog.getByRole("region", { name: "CloudX updates" });
  await expect(updates).toContainText(
    "38.05 GiB required, 25.36 GiB available, 12.70 GiB more needed",
  );
  await expect(updates).toContainText("3.46 GiB safety margin");
  await updates
    .getByRole("button", { name: "Manage Forge environments", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const forge = page.getByRole("region", { name: "Forge", exact: true });
  const environments = forge.getByRole("region", {
    name: "Workspace cleanup",
    exact: true,
  });
  await expect(
    environments.getByRole("combobox", { name: "Workspace filter" }),
  ).toHaveValue("forge");
  await environments
    .getByRole("button", {
      name: "Scan workspaces and environments",
      exact: true,
    })
    .click();
  await expect(
    environments.getByRole("checkbox", {
      name: "Select /work/active-forge",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    environments.getByRole("checkbox", {
      name: "Select /work/unpublished",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(environments).toContainText("16.00 GiB");
  await environments
    .getByRole("button", {
      name: "Review deletion of 1 workspace",
      exact: true,
    })
    .click();

  await forge.getByRole("button", { name: "Settings", exact: true }).click();
  await dialog.getByRole("tab", { name: "Updates", exact: true }).click();
  await expect(
    updates.getByRole("button", { name: "Resume update", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("region", { name: "Workspace cleanup" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await environments
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(cleanup).toBeNull();
  await environments
    .getByRole("button", {
      name: "Review deletion of 1 workspace",
      exact: true,
    })
    .click();
  await environments
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(
    environments.getByRole("progressbar", {
      name: "Workspace cleanup progress",
    }),
  ).toBeVisible();
  finishCleanup = true;
  await expect(environments).toContainText("50.00 GiB available after cleanup");
  await expect.poll(() => capacityChecks).toBeGreaterThan(0);

  await forge.getByRole("button", { name: "Settings", exact: true }).click();
  await dialog.getByRole("tab", { name: "Updates", exact: true }).click();
  await expect(updates).toContainText("0 B more needed");
  await expect(
    updates.getByRole("button", { name: "Resume update", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("update-capacity-recovered.png"),
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
  await expect
    .poll(() => resume)
    .toEqual({
      channel: "main",
      targetCommit: target,
      resumeRunId: runId,
    });
});

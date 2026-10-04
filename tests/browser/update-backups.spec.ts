import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type {
  CloudxUpdateBackup,
  CloudxUpdateBackupCleanup,
  CloudxUpdateBackupPreview,
} from "@cloudx/shared";

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
    optimizeDeps: { entries: ["tests/browser/fixtures/update-backups.html"] },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing update backup browser fixture port.");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/update-backups.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

const createdAt = "2026-10-04T03:02:05Z";
const firstRunId = "11111111-1111-4111-8111-111111111111";
const secondRunId = "22222222-2222-4222-8222-222222222222";
const first: CloudxUpdateBackup = {
  id: `${firstRunId}:snapshot`,
  runId: firstRunId,
  kind: "snapshot",
  sourceCommit: "a".repeat(40),
  targetCommit: "b".repeat(40),
  createdAt,
  outcome: "succeeded",
  path: `/home/developer/.local/state/cloudx/settings-update/${firstRunId}/snapshot/retained-recovery-version-with-a-long-directory-name`,
  logicalBytes: 8 * 1024 ** 3,
  allocatedBytes: 7 * 1024 ** 3,
  reclaimableBytes: 6 * 1024 ** 3,
};
const protectedRelease: CloudxUpdateBackup = {
  ...first,
  id: `${firstRunId}:release`,
  kind: "release",
  path: `/updates/${firstRunId}/release`,
  reclaimableBytes: 0,
  protectionReason:
    "A surviving terminal broker and Codex session still reference this exact release.",
};
const backups: CloudxUpdateBackup[] = [
  first,
  {
    ...first,
    id: `${secondRunId}:snapshot`,
    runId: secondRunId,
    path: `/updates/${secondRunId}/snapshot`,
  },
  protectedRelease,
];
const preview: CloudxUpdateBackupPreview = {
  id: "33333333-3333-4333-8333-333333333333",
  createdAt,
  backups,
  reclaimableBytes: 10 * 1024 ** 3,
  estimateNote:
    "Shared files are counted once. Links outside the reviewed backups are excluded. Actual reclaimed space may differ.",
};

test("reviews every eligible backup, cancels without deletion and confirms truthful cleanup outcomes", async ({
  page,
}, testInfo) => {
  let inventory = [...backups];
  let current: CloudxUpdateBackupCleanup | null = null;
  const requests: unknown[] = [];
  let finished = false;
  await page.route("**/api/system/update/backups", (route) =>
    route.fulfill({ json: { backups: inventory } }),
  );
  await page.route("**/api/system/update/backups/preview", (route) =>
    route.fulfill({ json: preview }),
  );
  await page.route("**/api/system/update/backups/cleanup", (route) => {
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON());
      current = {
        id: "44444444-4444-4444-8444-444444444444",
        state: "running",
        startedAt: createdAt,
        results: backups.map((item) => ({
          id: item.id,
          runId: item.runId,
          path: item.path,
          status: "pending",
          deletedLogicalBytes: 0,
        })),
        freeSpace: [
          {
            path: "/updates",
            availableBytesBefore: 2 * 1024 ** 3,
            availableBytesAfter: null,
          },
        ],
      };
    } else if (current && finished) {
      current = {
        ...current,
        state: "completed",
        finishedAt: createdAt,
        results: backups.map((item) => ({
          id: item.id,
          runId: item.runId,
          path: item.path,
          status: item.protectionReason ? "protected" : "deleted",
          reason: item.protectionReason,
          deletedLogicalBytes: item.protectionReason ? 0 : item.logicalBytes!,
        })),
        freeSpace: [
          {
            path: "/updates",
            availableBytesBefore: 2 * 1024 ** 3,
            availableBytesAfter: 5 * 1024 ** 3,
          },
        ],
      };
      inventory = [protectedRelease];
    }
    return route.fulfill({ json: current });
  });
  await page.goto(baseUrl);
  const panel = page.getByRole("region", { name: "Retained update backups" });
  await expect(
    panel.getByRole("button", {
      name: "Clean all update backups",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(panel.locator(".workspace-cleanup-list > li")).toHaveCount(3);
  await expect(panel).toContainText(protectedRelease.protectionReason!);
  await panel
    .getByRole("button", { name: "Clean all update backups", exact: true })
    .click();
  const review = panel.getByRole("group", {
    name: "Review permanent update backup deletion",
  });
  await expect(review).toContainText(
    "2 eligible backups · 10.00 GiB estimated reclaimable",
  );
  await expect(review.locator("li")).toHaveCount(3);
  await expect(
    review.getByRole("button", {
      name: "Delete all eligible backups permanently",
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Update CloudX and dependencies" }),
  ).toBeDisabled();
  await review.getByRole("checkbox").check();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(requests).toEqual([]);
  await expect(panel.locator(".workspace-cleanup-list > li")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Update CloudX and dependencies" }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Clean all update backups", exact: true })
    .click();
  await expect(review.getByRole("checkbox")).not.toBeChecked();
  await review.getByRole("checkbox").check();
  await expect(review).toContainText(
    "Recovery or downgrade using these saved data snapshots will become unavailable.",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("reviewed-update-backups.png"),
    fullPage: true,
  });
  await review
    .getByRole("button", { name: "Delete all eligible backups permanently" })
    .click();
  expect(requests).toEqual([
    { previewId: preview.id, confirmPermanentDeletion: true },
  ]);
  await expect(
    panel.getByRole("progressbar", { name: "Update backup cleanup progress" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Update CloudX and dependencies" }),
  ).toBeDisabled();
  finished = true;
  await expect(panel).toContainText(
    "2 deleted; 1 protected; 0 skipped; 0 failed",
  );
  await expect(panel).toContainText(
    "5.00 GiB measured available afterward (3.00 GiB measured increase)",
  );
  await expect(panel.locator(".workspace-cleanup-list > li")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Update CloudX and dependencies" }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("update-backup-cleanup-results.png"),
    fullPage: true,
  });
});

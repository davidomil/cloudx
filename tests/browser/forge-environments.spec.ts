import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  DisposableResource,
  ForgeGitHistoryManifest,
} from "@cloudx/shared";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let server: ViteDevServer;
let httpServer: Server;
let baseUrl: string;
test.use({ hasTouch: true });

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
    server: {
      middlewareMode: { server: httpServer },
      ws: { server: httpServer },
    },
    optimizeDeps: {
      entries: ["tests/browser/fixtures/forge-environments.html"],
    },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/forge-environments.html`;
});
test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function savedEvidence(
  page: Page,
  count = 18,
  history: ForgeGitHistoryManifest[] = [],
) {
  const repository = {
    provider: "github",
    apiUrl: "https://api.github.com",
    projectPath: "cloudx/example",
  };
  const owner = {
    workerId: "completed-worker",
    attemptId: "validation-attempt",
  };
  const resources: DisposableResource[] = Array.from(
    { length: count },
    (_, index) => ({
      id: `resource-${index}`,
      kind: "container",
      engineId: `engine-${index}`,
      name: `validation-${index}`,
      owner,
      consumers: [],
      state: "deleted",
      reason: "Cleaned automatically after completion",
      reclaimedBytes: 8192,
      updatedAt: "2026-10-06",
      evidence: {
        state: "verified",
        paths: ["/evidence"],
        commitSha: "a".repeat(40),
        bytes: 28 * 1024,
        files: Array.from(
          { length: index === count - 1 ? 28 : 1 },
          (_, report) => ({
            path: `evidence/report-${report}.json`,
            bytes: 1024,
            sha256: "b".repeat(64),
          }),
        ),
      },
    }),
  );
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/"))
      requests.push(new URL(request.url()).pathname);
  });
  await page.route("**/fixture-hooks/**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("forge.dashboard")
        ? { configured: true, repository, workers: [] }
        : { items: [] },
    }),
  );
  await page.route("**/api/forge/resources", (route) =>
    route.fulfill({ json: { resources } }),
  );
  await page.route("**/api/forge/checkout-evidence", (route) =>
    route.fulfill({ json: { archives: [] } }),
  );
  await page.route("**/api/forge/git-history", (route) =>
    route.fulfill({ json: { archives: history } }),
  );
  await page.route("**/api/forge/resources/*/evidence-file?*", (route) =>
    route.fulfill({
      body: "saved validation report",
      contentType: "text/plain",
      headers: { "content-disposition": "attachment" },
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  const body = page.getByRole("region", { name: "Saved evidence" });
  await expect(body).toContainText(
    "Finished Forge workspaces clean automatically.",
  );
  await expect(
    body.locator("button, input, textarea, select, fieldset"),
  ).toHaveCount(0);
  return { body, requests, errors };
}

async function insideScrollRegion(body: Locator, target: Locator) {
  await expect
    .poll(async () => {
      const region = await body.boundingBox();
      const link = await target.boundingBox();
      return Boolean(
        region &&
        link &&
        link.y >= region.y &&
        link.y + link.height <= region.y + region.height,
      );
    })
    .toBe(true);
}

for (const width of [900, 420]) {
  test(`saved reports stay read-only and scroll with wheel, touch and keyboard in a ${width}×480 pane`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 480 });
    const { body, requests, errors } = await savedEvidence(page);
    const finalCard = page.getByRole("article", {
      name: "Saved evidence for validation-17",
      exact: true,
    });
    const finalReport = finalCard.getByRole("link", {
      name: "evidence/report-27.json",
      exact: true,
    });
    const scrollGeometry = await body.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(scrollGeometry.clientHeight).toBeLessThan(480);
    expect(scrollGeometry.scrollHeight).toBeGreaterThan(
      scrollGeometry.clientHeight,
    );
    expect(scrollGeometry.scrollTop).toBe(0);
    const header = await page.locator(".forge-header").boundingBox();
    const navigation = await page
      .getByRole("navigation", { name: "Forge sections" })
      .boundingBox();
    const overview = testInfo.outputPath("saved-evidence-overview.png");
    await page.screenshot({ path: overview });
    await testInfo.attach("saved-evidence-overview", {
      path: overview,
      contentType: "image/png",
    });
    const box = (await body.boundingBox())!;
    await page.mouse.move(box.x + box.width - 24, box.y + box.height / 2);
    await page.mouse.wheel(0, 100_000);
    await insideScrollRegion(body, finalReport);
    expect(await page.locator(".forge-header").boundingBox()).toEqual(header);
    expect(
      await page
        .getByRole("navigation", { name: "Forge sections" })
        .boundingBox(),
    ).toEqual(navigation);
    const screenshot = testInfo.outputPath("saved-evidence.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("saved-evidence", {
      path: screenshot,
      contentType: "image/png",
    });

    await body.evaluate((element) => {
      element.scrollTop = 0;
    });
    const cdp = await page.context().newCDPSession(page);
    const touchX = box.x + box.width - 30;
    const startY = box.y + box.height - 25;
    const swipe = async () => {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: touchX, y: startY }],
      });
      for (let step = 1; step <= 8; step++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: touchX, y: startY - step * 25 }],
        });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    await swipe();
    await expect
      .poll(() => body.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    for (let index = 0; index < 100; index++) {
      if (
        await body.evaluate(
          (element) =>
            element.scrollTop >=
            element.scrollHeight - element.clientHeight - 1,
        )
      )
        break;
      await swipe();
    }
    await insideScrollRegion(body, finalReport);
    await cdp.detach();

    await body.evaluate((element) => {
      element.scrollTop = 0;
    });
    await body.focus();
    for (let index = 0; index < 100; index++) {
      if (
        await finalReport.evaluate(
          (element) => document.activeElement === element,
        )
      )
        break;
      await page.keyboard.press("Tab");
    }
    await expect(finalReport).toBeFocused();
    await insideScrollRegion(body, finalReport);
    const download = page.waitForEvent("download");
    await finalReport.click();
    expect((await download).suggestedFilename()).toBe("report-27.json");

    for (const name of ["Issues", "Pull requests", "Workers (0)"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(body).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Evidence", exact: true }).click();
    await expect(body.locator("article")).toHaveCount(18);
    expect(
      requests.some((request) =>
        /workspace-cleanup|evidence-decision/.test(request),
      ),
    ).toBe(false);
    expect(errors).toEqual([]);
  });
}

test("empty evidence replaces filesystem management with one short automatic-cleanup message", async ({
  page,
}, testInfo) => {
  const { body, requests, errors } = await savedEvidence(page, 0);
  await expect(body.locator('[role="status"]')).toHaveCount(0);
  await expect(body.locator("p")).toHaveCount(1);
  const screenshot = testInfo.outputPath("automatic-workspace-cleanup.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("automatic-workspace-cleanup", {
    path: screenshot,
    contentType: "image/png",
  });
  await expect(body.locator("article, a, button, input, select")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Environments", exact: true }),
  ).toHaveCount(0);
  expect(
    requests.some((request) =>
      /workspace-cleanup|evidence-decision/.test(request),
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
});

test("saved Git snapshots remain downloadable without retaining a completed worker", async ({
  page,
}) => {
  const archive: ForgeGitHistoryManifest = {
    archiveId: "history-1",
    workerId: "retired-worker",
    attemptId: "attempt-1",
    commitSha: "a".repeat(40),
    checkoutIdentity: { dev: "1", ino: "2" },
    refs: [
      {
        name: "refs/cloudx/before-rebase/snapshot-1",
        commitSha: "b".repeat(40),
      },
    ],
    exportedAt: "2026-10-06T00:00:00.000Z",
    bytes: 2048,
    files: [{ path: "history.bundle", bytes: 2048, sha256: "c".repeat(64) }],
  };
  await page.route("**/api/forge/git-history/history-1/file", (route) =>
    route.fulfill({
      body: "verified Git bundle",
      contentType: "application/octet-stream",
      headers: { "content-disposition": "attachment" },
    }),
  );
  const { body, requests, errors } = await savedEvidence(page, 0, [archive]);
  const history = body.getByRole("article", {
    name: "Saved Git history for worker retired-worker",
  });
  await expect(history).toContainText("2.00 KiB saved");
  await expect(
    history.getByRole("link", { name: "Download manifest" }),
  ).toHaveAttribute("href", "/api/forge/git-history/history-1");
  await history.getByText("Preserved snapshots (1)", { exact: true }).click();
  await expect(history).toContainText(archive.refs[0]!.name);
  await expect(history).toContainText(archive.refs[0]!.commitSha);
  const bundle = history.getByRole("link", {
    name: "history.bundle",
    exact: true,
  });
  await expect(bundle).toHaveAttribute(
    "href",
    "/api/forge/git-history/history-1/file",
  );
  const download = page.waitForEvent("download");
  await bundle.click();
  expect((await download).suggestedFilename()).toBe("history.bundle");
  expect(
    requests.some((request) =>
      /workspace-cleanup|evidence-decision/.test(request),
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
});

import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  DisposableResource,
  WorkspaceCleanupCandidate,
} from "@cloudx/shared";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { writeFile } from "node:fs/promises";
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

async function inventory(page: Page) {
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
    { length: 18 },
    (_, index) => ({
      id: `resource-${index}`,
      kind: "container",
      engineId: `engine-${index}`,
      name: `validation-${index}`,
      owner,
      consumers:
        index === 17
          ? Array.from({ length: 24 }, (_, n) => ({
              workerId: `worker-${n}`,
              attemptId: `attempt-${n}`,
            }))
          : [owner],
      state: index < 12 ? "deleted" : "blocked",
      reason:
        index === 17
          ? "A report is retained. ".repeat(80)
          : "Completed validation environment.",
      retentionReason: "Preserve the selected validation logs",
      allocatedBytes: 8192,
      reclaimedBytes: index < 12 ? 8192 : 0,
      updatedAt: "2026-10-05",
      evidence: {
        state: index < 12 ? "verified" : "pending",
        paths: ["/evidence/test.log"],
        files:
          index === 17
            ? Array.from({ length: 28 }, (_, n) => ({
                path: `evidence/report-${n}.json`,
                bytes: 1024,
                sha256: "b".repeat(64),
              }))
            : [],
      },
    }),
  );
  const candidates: WorkspaceCleanupCandidate[] = [
    "checkout",
    "worktree",
    "forge",
    "trash",
    "resource",
  ].map((kind, index) => ({
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    kind: kind as WorkspaceCleanupCandidate["kind"],
    path: `/work/${kind}`,
    repository: "cloudx/example",
    state: "completed",
    allocatedBytes: 4096,
    lastActivity: "2026-10-05",
    eligible: true,
    reason: "Completed inactive workspace",
    sourceChanges: [],
    unpublishedCommits: 0,
    requiresDiscard: false,
  }));
  await page.route("**/fixture-hooks/**", (route) => {
    const hook = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({
      json:
        hook === "forge.dashboard"
          ? { configured: true, repository, workers: [] }
          : { items: [] },
    });
  });
  await page.route("**/api/system/workspace-cleanup", (route) =>
    route.fulfill({ json: null }),
  );
  await page.route("**/api/system/workspace-cleanup/preview", (route) =>
    route.fulfill({
      json: {
        id: "11111111-1111-4111-8111-111111111111",
        createdAt: "2026-10-05",
        candidates,
        warnings: [],
        availableBytes: 8192,
        reclaimableBytes: 20480,
        reclaimGroups: candidates.map((item) => ({
          bytes: 4096,
          candidateIds: [item.id],
        })),
      },
    }),
  );
  await page.route("**/api/forge/checkout-evidence", (route) =>
    route.fulfill({ json: { archives: [] } }),
  );
  await page.route("**/api/forge/resources", (route) =>
    route.fulfill({ json: { resources } }),
  );
  await page.route("**/api/forge/resources/*/evidence-decision", (route) =>
    route.fulfill({
      status: 409,
      json: {
        message:
          "Evidence export remains protected until all consumers complete. ".repeat(
            100,
          ),
      },
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Environments", exact: true }).click();
  await page
    .getByRole("button", { name: "Scan workspaces and environments" })
    .click();
  const finalCard = page.getByRole("article", {
    name: "Environment validation-17",
    exact: true,
  });
  await expect(finalCard).toContainText("report-27.json");
  await finalCard.locator("details").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  return { body: page.locator(".forge-environments"), finalCard, errors };
}

async function rectangles(body: Locator, target: Locator) {
  const region = await body.boundingBox();
  const action = await target.boundingBox();
  if (!region || !action)
    throw new Error("Missing scroll region or target rectangle");
  return { region, action };
}
async function insideScrollRegion(body: Locator, target: Locator) {
  await expect
    .poll(async () => {
      const { region, action } = await rectangles(body, target);
      return (
        action.y >= region.y &&
        action.y + action.height <= region.y + region.height
      );
    })
    .toBe(true);
}
async function wheelToEnd(page: Page, body: Locator) {
  const box = await body.boundingBox();
  if (!box) throw new Error("Missing scroll body");
  await page.mouse.move(box.x + box.width - 24, box.y + box.height / 2);
  await page.mouse.wheel(0, 100_000);
}

for (const width of [900, 420]) {
  test(`wheel, touch and keyboard reach evidence actions in a ${width}×480 pane`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 480 });
    const { body, finalCard, errors } = await inventory(page);
    const finalDiscard = finalCard.getByRole("button", {
      name: "Discard evidence and release",
    });
    const initial = await rectangles(body, finalDiscard);
    expect(initial.action.y).toBeGreaterThan(
      initial.region.y + initial.region.height,
    );
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
    await wheelToEnd(page, body);
    await expect
      .poll(() => body.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await insideScrollRegion(body, finalDiscard);
    const afterWheel = await rectangles(body, finalDiscard);
    const screenshot = testInfo.outputPath("environment-evidence-scroll.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("environment-evidence-scroll", {
      path: screenshot,
      contentType: "image/png",
    });
    expect(await page.locator(".forge-header").boundingBox()).toEqual(header);
    expect(
      await page
        .getByRole("navigation", { name: "Forge sections" })
        .boundingBox(),
    ).toEqual(navigation);

    const beforeTouch = await body.evaluate((element) => {
      element.scrollTop = 0;
      return element.scrollTop;
    });
    const cdp = await page.context().newCDPSession(page);
    const box = (await body.boundingBox())!;
    const x = box.x + box.width - 30;
    const startY = box.y + box.height - 25;
    const swipe = async () => {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y: startY }],
      });
      for (let step = 1; step <= 8; step++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: startY - step * 25 }],
        });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    await swipe();
    await expect
      .poll(() => body.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(beforeTouch);
    for (let swipeIndex = 0; swipeIndex < 100; swipeIndex++) {
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
    await insideScrollRegion(body, finalDiscard);
    const afterTouch = await rectangles(body, finalDiscard);
    await cdp.detach();

    await body.evaluate((element) => {
      element.scrollTop = 0;
    });
    await body.focus();
    const checkbox = finalCard.getByRole("checkbox", {
      name: "Discard this container’s evidence permanently",
    });
    for (let index = 0; index < 200; index++) {
      if (
        await checkbox.evaluate((element) => document.activeElement === element)
      )
        break;
      await page.keyboard.press("Tab");
    }
    await expect(checkbox).toBeFocused();
    await insideScrollRegion(body, checkbox);
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await expect(finalDiscard).toBeFocused();
    await insideScrollRegion(body, finalDiscard);
    const afterKeyboard = await rectangles(body, finalDiscard);

    await finalCard
      .getByRole("button", { name: "Export evidence and release" })
      .click();
    await expect(finalCard.getByRole("alert")).toContainText(
      "Evidence export remains protected",
    );
    await wheelToEnd(page, body);
    await expect
      .poll(async () => {
        const { region, action } = await rectangles(
          body,
          finalCard.getByRole("alert"),
        );
        return action.y + action.height <= region.y + region.height;
      })
      .toBe(true);
    const { region: errorRegion, action: actionAboveError } = await rectangles(
      body,
      finalDiscard,
    );
    await page.mouse.wheel(
      0,
      actionAboveError.y - (errorRegion.y + errorRegion.height / 2),
    );
    await insideScrollRegion(body, finalDiscard);

    for (const name of ["Issues", "Pull requests", "Workers (0)"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(body).toHaveCount(0);
      await expect(page.locator(".forge-panel")).toBeVisible();
    }
    await page
      .getByRole("button", { name: "Environments", exact: true })
      .click();
    await expect(
      page.getByRole("checkbox", {
        name: "Select /work/checkout",
        exact: true,
      }),
    ).toBeChecked();
    expect(errors).toEqual([]);
    const geometryPath = testInfo.outputPath(
      "bounded-environments-geometry.json",
    );
    await writeFile(
      geometryPath,
      JSON.stringify(
        {
          width,
          initial,
          afterWheel,
          afterTouch,
          afterKeyboard,
          scrollGeometry,
          header,
          navigation,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("bounded-environments-geometry", {
      path: geometryPath,
      contentType: "application/json",
    });
  });
}

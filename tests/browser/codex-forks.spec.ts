import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { listTabLayoutPanes } from "../../packages/shared/src/index.js";
import { CodexForkWorkspace } from "./fixtures/codex-forks.server.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;
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
    optimizeDeps: { entries: ["tests/browser/fixtures/codex-forks.html"] },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/codex-forks.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function submit(page: Page, text: string) {
  await page
    .locator(".pane-tab-panel:not([hidden]) .xterm-helper-textarea")
    .focus();
  await page.keyboard.insertText(text);
  await expectTerminalText(page, text);
  await page.keyboard.press("Enter");
}

async function expectTerminalText(page: Page, text: string) {
  await expect
    .poll(async () =>
      (
        (await page
          .locator(".pane-tab-panel:not([hidden]) .xterm-rows")
          .textContent()) ?? ""
      ).replace(/\s/gu, ""),
    )
    .toContain(text.replace(/\s/gu, ""));
}

async function ready(fixture: CodexForkWorkspace, tabId: string) {
  await fixture.store.executePluginAction(tabId, "wait_until_ready", {
    timeoutMs: 15_000,
  });
}

async function activate(
  page: Page,
  fixture: CodexForkWorkspace,
  tabId: string,
) {
  const snapshot = await fixture.store.snapshot();
  const pane = snapshot
    .windows!.flatMap((window) => listTabLayoutPanes(window.layout.root))
    .find((pane) => pane.tabIds.includes(tabId))!;
  await page
    .locator(`[data-pane-id="${pane.id}"] .tab-activation`)
    .nth(pane.tabIds.indexOf(tabId))
    .click();
}

async function completeTurn(
  page: Page,
  fixture: CodexForkWorkspace,
  tabId: string,
  text: string,
) {
  await ready(fixture, tabId);
  const count = fixture.requests.length;
  await submit(page, text);
  await expect
    .poll(() => fixture.requests.length, { timeout: 15_000 })
    .toBe(count + 1);
  await expect.poll(() => fixture.transcript(tabId)).toContain(text);
  await ready(fixture, tabId);
}

// Opt in with an installed Codex CLI; model traffic stays on an isolated local Responses provider.
test.describe("native Codex forks in the production workspace", () => {
  test.skip(!codex, "Set CLOUDX_NATIVE_CODEX to an absolute Codex executable.");
  test.setTimeout(120_000);
  test.use({ actionTimeout: 10_000 });

  test("opens each native fork once in its source pane, keeps both branches live, and restores separate ownership", async ({
    page,
  }, testInfo) => {
    const fixture = await CodexForkWorkspace.create(codex!);
    try {
      await fixture.connect(page);
      await page.goto(baseUrl);
      await expect(
        page
          .locator(".tab-activation")
          .filter({ hasText: "Original conversation" }),
      ).toBeVisible();
      const source = fixture.sourceTabId;
      await completeTurn(
        page,
        fixture,
        source,
        "Shared history before the fork.",
      );
      const parentId = fixture.identity(source)!.sessionId;
      const before = await fixture.store.snapshot();
      const sourceWindow = before.windows!.find((window) =>
        listTabLayoutPanes(window.layout.root).some((pane) =>
          pane.tabIds.includes(source),
        ),
      )!;
      const sourcePane = listTabLayoutPanes(sourceWindow.layout.root).find(
        (pane) => pane.tabIds.includes(source),
      )!;
      await submit(page, "/permissions");
      await expectTerminalText(page, "Ask for approval");
      await page.keyboard.press("1");
      await ready(fixture, source);
      const requestsBeforeFork = fixture.requests.length;
      await submit(page, "/fork");
      await expect
        .poll(() => fixture.store.listTabs().length, { timeout: 20_000 })
        .toBe(2);
      const child = fixture.store.listTabs().find((tab) => tab.id !== source)!;
      await expect(page.locator(".tab-button.selected .tab-title")).toHaveText(
        child.title,
      );
      await expect
        .poll(() => fixture.identity(child.id)?.sessionId)
        .not.toBeUndefined();
      const childId = fixture.identity(child.id)!.sessionId;
      expect(childId).not.toBe(parentId);
      expect(child.cwd).toBe(fixture.root);
      expect(fixture.identity(child.id)!.cwd).toBe(fixture.root);
      expect(fixture.identity(source)!.sessionId).toBe(parentId);
      expect(fixture.requests.length).toBe(requestsBeforeFork);
      await expectTerminalText(page, "Shared history before the fork.");
      const after = await fixture.store.snapshot();
      expect(after.activeWindowId).toBe(sourceWindow.id);
      expect(
        listTabLayoutPanes(
          after.windows!.find((window) => window.id === sourceWindow.id)!.layout
            .root,
        ).find((pane) => pane.id === sourcePane.id),
      ).toMatchObject({ tabIds: [source, child.id], activeTabId: child.id });
      await completeTurn(
        page,
        fixture,
        child.id,
        "Only the child continues here.",
      );
      expect(JSON.stringify(fixture.requests.at(-1))).toContain(
        "Shared history before the fork.",
      );
      const childTranscript = await fixture.transcript(child.id);
      expect(childTranscript).toContain('"approval_policy":"on-request"');
      expect(childTranscript).toContain('"type":"workspace-write"');
      await activate(page, fixture, source);
      await completeTurn(
        page,
        fixture,
        source,
        "Only the original continues here.",
      );
      expect(await fixture.transcript(source)).not.toContain(
        "Only the child continues here.",
      );
      expect(await fixture.transcript(child.id)).not.toContain(
        "Only the original continues here.",
      );
      await submit(page, "/fork");
      await expect
        .poll(() => fixture.store.listTabs().length, { timeout: 20_000 })
        .toBe(3);
      const second = fixture.store
        .listTabs()
        .find((tab) => tab.id !== source && tab.id !== child.id)!;
      await expect(page.locator(".tab-button.selected .tab-title")).toHaveText(
        second.title,
      );
      await expect
        .poll(() => fixture.identity(second.id)?.sessionId)
        .not.toBeUndefined();
      expect(
        new Set([parentId, childId, fixture.identity(second.id)!.sessionId])
          .size,
      ).toBe(3);
      const ids = fixture.store
        .listTabs()
        .map((tab) => [tab.id, fixture.identity(tab.id)!.sessionId]);
      await page.screenshot({
        path: testInfo.outputPath("native-fork-tabs.png"),
      });
      await page.goto("about:blank");
      await fixture.reconnectServer();
      await page.goto(baseUrl);
      await expect(page.locator(".tab-button")).toHaveCount(3);
      expect(
        fixture.store
          .listTabs()
          .map((tab) => [tab.id, fixture.identity(tab.id)!.sessionId]),
      ).toEqual(ids);
      for (const tab of [fixture.store.getTab(source), child]) {
        await activate(page, fixture, tab.id);
        await completeTurn(
          page,
          fixture,
          tab.id,
          `Resumed ${tab.id} independently.`,
        );
      }
      expect(fixture.store.listTabs()).toHaveLength(3);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test("cancelled input and a native fork error keep the original tab and never replay a fork", async ({
    page,
  }) => {
    const fixture = await CodexForkWorkspace.create(codex!);
    try {
      await fixture.connect(page);
      await page.goto(baseUrl);
      const source = fixture.sourceTabId;
      await completeTurn(
        page,
        fixture,
        source,
        "Keep the parent after rejected forks.",
      );
      const parentId = fixture.identity(source)!.sessionId;
      const requests = fixture.requests.length;
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("/fork");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+u");
      expect(fixture.store.listTabs()).toHaveLength(1);
      expect(fixture.identity(source)!.sessionId).toBe(parentId);
      await fixture.rejectNextFork();
      await submit(page, "/fork");
      await expectTerminalText(page, "Deliberate native fork rejection");
      expect(fixture.store.listTabs()).toHaveLength(1);
      expect(fixture.identity(source)!.sessionId).toBe(parentId);
      expect(fixture.requests).toHaveLength(requests);
      await page.reload();
      await expect(page.locator(".tab-button")).toHaveCount(1);
      await completeTurn(
        page,
        fixture,
        source,
        "The same parent still accepts a new turn.",
      );
      expect(fixture.identity(source)!.sessionId).toBe(parentId);
      expect(fixture.store.listTabs()).toHaveLength(1);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});

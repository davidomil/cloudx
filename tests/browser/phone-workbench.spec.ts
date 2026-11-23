import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type {
  PluginDescriptor,
  TabLayoutState,
  WorkspaceStateResponse,
  WorkspaceTab,
} from "../../packages/shared/src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const evidenceDirectory = path.join(
  repoRoot,
  process.env.CLOUDX_PHONE_EVIDENCE_DIR ?? "test-results/phone-refresh",
);
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
    optimizeDeps: { entries: ["tests/browser/fixtures/phone-workbench.html"] },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing phone fixture port.");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/phone-workbench.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function openWorkbench(
  page: Page,
  pluginId = "codex-terminal",
  options: { multiplePanes?: boolean; voice?: boolean } = {},
) {
  const updatedAt = "2026-11-23T09:00:00Z";
  const tabs: WorkspaceTab[] = Array.from({ length: 8 }, (_, index) => ({
    id: `phone-${index + 1}`,
    pluginId,
    title: `${pluginId === "codex-terminal" ? "Codex" : "TTY"} ${index + 1}`,
    cwd: "/workspace/phone",
    status: "running",
    createdAt: updatedAt,
    updatedAt,
    indicator: { color: "green", label: "Running", updatedAt },
  }));
  const layout: TabLayoutState = {
    root: {
      type: "pane" as const,
      pane: {
        id: "phone-pane",
        tabIds: tabs.map((tab) => tab.id),
        activeTabId: tabs[0].id,
      },
    },
    activePaneId: "phone-pane",
  };
  if (options.multiplePanes) {
    layout.root = {
      type: "split",
      id: "phone-split",
      direction: "row",
      sizes: [50, 50],
      children: [
        {
          type: "pane",
          pane: {
            id: "phone-pane",
            tabIds: tabs.slice(0, 4).map((tab) => tab.id),
            activeTabId: tabs[0].id,
          },
        },
        {
          type: "pane",
          pane: {
            id: "second-pane",
            tabIds: tabs.slice(4).map((tab) => tab.id),
            activeTabId: tabs[4].id,
          },
        },
      ],
    };
  }
  const workspace: WorkspaceStateResponse = {
    tabs,
    activeTabId: tabs[0].id,
    activeWindowId: "phone-window",
    templates: [],
    windows: [
      {
        id: "phone-window",
        name: "Phone work",
        defaultCwd: "/workspace/phone",
        layout,
        createdAt: updatedAt,
        updatedAt,
      },
    ],
    persistence: [
      {
        name: "Workspace layout",
        state: "available",
        path: "/fixture/workspace.json",
      },
    ],
  };
  const plugins: PluginDescriptor[] = [
    "codex-terminal",
    "standard-terminal",
    "agent-usage",
  ].map((id) => ({
    id,
    acronym: id === "codex-terminal" ? "AI" : "TTY",
    displayName:
      id === "codex-terminal"
        ? "Codex"
        : id === "standard-terminal"
          ? "Terminal"
          : "Usage",
    description: "Phone browser fixture",
    panelKind: "terminal",
    creatable: id !== "agent-usage",
    requiresDirectory: false,
    actions: [],
    configFields: [],
  }));
  if (options.voice)
    plugins.push({
      id: "audio-ai",
      acronym: "AI",
      displayName: "Audio AI",
      description: "Voice controls",
      panelKind: "placeholder",
      creatable: false,
      requiresDirectory: false,
      actions: [],
      configFields: [],
      uiContributions: [
        {
          id: "audio-ai.footer.voiceConsole",
          owner: { kind: "plugin", pluginId: "audio-ai" },
          slot: "app.footer.actions",
          renderer: "audio-ai.voice-console",
          title: "Voice command console",
          order: 0,
        },
      ],
    });
  const summary = {
    costUsd: 2.48,
    costBasis: "api-equivalent",
    totals: {
      input: 1000,
      cachedInput: 100,
      cacheWrite: 0,
      output: 200,
      reasoning: 100,
      webSearches: 0,
      requests: 2,
    },
    byModel: [],
    unpricedModels: [],
  };
  const usage = {
    total: summary,
    tabs: Object.fromEntries(tabs.map((tab) => [tab.id, summary])),
    windows: { "phone-window": summary },
    forgeWorkers: {},
  };
  const inputs: Array<{ tabId: string; data: string }> = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/plugins")
      return route.fulfill({ json: { plugins } });
    if (pathname === "/api/workspace")
      return route.fulfill({ json: workspace });
    if (pathname === "/api/config")
      return route.fulfill({
        json: {
          globalFields: [],
          plugins: [],
          values: {
            global: {
              uiScale: 100,
              aiControlEnabled: options.voice === true,
              voiceCommandsEnabled: options.voice === true,
              microphoneEnabled: false,
            },
            plugins: {},
          },
        },
      });
    if (pathname === "/api/automation/groups")
      return route.fulfill({ json: { groups: [] } });
    if (pathname === "/api/automation/catalog")
      return route.fulfill({ json: { nodes: [] } });
    if (pathname === "/api/notifications")
      return route.fulfill({ json: { notifications: [] } });
    if (pathname === "/api/health")
      return route.fulfill({ json: { status: "ok" } });
    if (pathname === "/api/hooks/agent-usage.read")
      return route.fulfill({ json: { result: { usage } } });
    if (pathname.endsWith("/terminal-capabilities"))
      return route.fulfill({
        json: {
          tabId: pathname.split("/").at(-2),
          providerId: "codex",
          executionId: "phone-execution",
          commandCapture: false,
        },
      });
    if (/\/api\/tabs\/[^/]+\/active$/.test(pathname)) {
      workspace.activeTabId = pathname.split("/").at(-2);
      return route.fulfill({ json: {} });
    }
    if (pathname === "/api/windows/phone-window") {
      const change = route.request().postDataJSON();
      if (change?.layout) workspace.windows[0].layout = change.layout;
      return route.fulfill({ json: workspace });
    }
    return route.fulfill({
      status: 404,
      json: { message: `Unexpected fixture request: ${pathname}` },
    });
  });
  let workspaceSocket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/ws/workspace*", (socket) => {
    workspaceSocket = socket;
  });
  const terminalSockets = new Map<string, WebSocketRoute>();
  await page.routeWebSocket("**/ws/terminal/*", (socket) => {
    const tabId = new URL(socket.url()).pathname.split("/").at(-1)!;
    terminalSockets.set(tabId, socket);
    socket.send(
      JSON.stringify({
        type: "data",
        data: "Phone workbench simulation\r\nReady for terminal input > ",
      }),
    );
    socket.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === "input") inputs.push({ tabId, data: event.data });
    });
  });
  await page.goto(baseUrl);
  await expect(page.locator(".workspace-pane").first()).toBeVisible();
  await expect(
    page.locator(".terminal-panel:visible .xterm-screen").first(),
  ).toBeVisible();
  return {
    inputs,
    workspace,
    updateWorkspace: () =>
      workspaceSocket!.send(
        JSON.stringify({ type: "workspace", ...workspace }),
      ),
    output: (tabId: string, data: string) =>
      terminalSockets.get(tabId)!.send(JSON.stringify({ type: "data", data })),
  };
}

async function swipeTabs(page: Page) {
  const strip = (await page.locator(".tab-strip").boundingBox())!;
  const input = await page.context().newCDPSession(page);
  const start = strip.x + strip.width - 12;
  const end = strip.x + 12;
  const y = strip.y + strip.height / 2;
  await input.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: start, y }],
  });
  for (let step = 1; step <= 8; step++) {
    await input.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: start + ((end - start) * step) / 8, y }],
    });
  }
  await input.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await input.detach();
}

async function recordLayout(page: Page, name: string) {
  const measurements = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect
        ? {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            scrollWidth: element!.scrollWidth,
            clientWidth: element!.clientWidth,
          }
        : null;
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      visualViewportHeight: visualViewport?.height,
      topbar: bounds(".topbar"),
      pane: bounds(".workspace-pane"),
      strip: bounds(".tab-strip"),
      terminal: bounds(".terminal-panel"),
      tooltip: bounds(".usage-card"),
    };
  });
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, `${name}.json`),
    JSON.stringify(measurements, null, 2),
  );
  await page.screenshot({ path: path.join(evidenceDirectory, `${name}.png`) });
  await test.info().attach(name, {
    path: path.join(evidenceDirectory, `${name}.png`),
    contentType: "image/png",
  });
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 390, height: 440 },
  { width: 844, height: 390 },
]) {
  for (const pluginId of ["codex-terminal", "standard-terminal"]) {
    test(`${pluginId} fills ${viewport.width}×${viewport.height} phone space with reachable controls`, async ({
      page,
      isMobile,
    }) => {
      test.skip(!isMobile, "Phone layout and touch simulation.");
      await page.setViewportSize(viewport);
      await openWorkbench(page, pluginId);
      expect(
        await page
          .locator(".topbar")
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeLessThanOrEqual(64);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width + 1);
      await expect
        .poll(() =>
          page
            .locator(".terminal-panel:visible")
            .evaluate((element) => element.getBoundingClientRect().bottom),
        )
        .toBeLessThanOrEqual(viewport.height + 1);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { phoneTerminals: Array<{ rows: number }> })
              .phoneTerminals[0].rows,
        ),
      ).toBeGreaterThanOrEqual(8);
      await expect(
        page.getByRole("button", { name: "Add tab to this pane", exact: true }),
      ).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "Send Escape", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".voice-console")).toBeHidden();
      await recordLayout(
        page,
        `after-${pluginId}-${viewport.width}x${viewport.height}`,
      );
    });
  }
}

test("touch swipes reach the last Codex tab while pane actions stay pinned and usage stays dismissed", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Requires Chromium touch emulation.");
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);
  await page.getByRole("button", { name: "Codex 1", exact: true }).tap();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const add = page.getByRole("button", {
    name: "Add tab to this pane",
    exact: true,
  });
  const initialAddPosition = (await add.boundingBox())!;
  const strip = page.locator(".tab-strip");
  expect(
    await strip.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await swipeTabs(page);
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(40);
  for (let swipe = 0; swipe < 5; swipe++) await swipeTabs(page);
  const last = page.getByRole("button", { name: "Codex 8", exact: true });
  await expect(last).toBeInViewport();
  await last.tap();
  await expect(last).toHaveAttribute("aria-pressed", "true");
  expect((await add.boundingBox())!.x).toBe(initialAddPosition.x);
  await expect(add).toBeInViewport();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.locator(".agent-switch-menu")).toHaveCount(0);
});

test("phone usage opens explicitly and closes without covering continued terminal input", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Touch usage interaction.");
  await page.setViewportSize({ width: 320, height: 568 });
  const { inputs } = await openWorkbench(page);
  await page.getByRole("button", { name: "Codex 1", exact: true }).tap();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Usage for Codex 1", exact: true })
    .tap();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("$2.48");
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(320);
  await recordLayout(page, "after-usage-open");
  await page.getByRole("button", { name: "Close usage", exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await page.locator(".terminal-panel:visible .xterm-helper-textarea").focus();
  await page.keyboard.type("continued from phone");
  await expect
    .poll(() => inputs.map((input) => input.data).join(""))
    .toBe("continued from phone");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

for (const pluginId of ["codex-terminal", "standard-terminal"]) {
  test(`${pluginId} phone keys use live xterm input and preserve terminal focus`, async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "Touch terminal keyboard.");
    await page.setViewportSize({ width: 390, height: 440 });
    const { inputs } = await openWorkbench(page, pluginId);
    const keys = page.getByRole("group", {
      name: "Terminal keyboard shortcuts",
    });
    const sequence = [
      ["Send Escape", "\x1b"],
      ["Send Tab", "\t"],
      ["Send Ctrl+C to interrupt", "\x03"],
      ["Send left arrow", "\x1b[D"],
      ["Send down arrow", "\x1b[B"],
      ["Send up arrow", "\x1b[A"],
      ["Send right arrow", "\x1b[C"],
      ["Send Enter", "\r"],
    ];
    for (const [label, bytes] of sequence) {
      const previous = inputs.length;
      await keys.getByRole("button", { name: label, exact: true }).tap();
      await expect
        .poll(() =>
          inputs
            .slice(previous)
            .map((input) => input.data)
            .join(""),
        )
        .toBe(bytes);
      await expect(
        page.locator(".terminal-panel:visible .xterm-helper-textarea"),
      ).toBeFocused();
    }
    expect(inputs.every((input) => input.tabId === "phone-1")).toBe(true);
  });
}

test("keyboard visual viewport inset keeps the terminal and phone keys above the occluded area", async ({
  page,
  isMobile,
}) => {
  test.skip(
    !isMobile,
    "Synthetic visual viewport, not an operating system keyboard.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
    });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    Object.assign(window, {
      setPhoneKeyboardHeight: (height: number) => {
        Object.assign(viewport, { height });
        viewport.dispatchEvent(new Event("resize"));
      },
    });
  });
  await openWorkbench(page);
  await page.evaluate(() =>
    (
      window as unknown as { setPhoneKeyboardHeight(height: number): void }
    ).setPhoneKeyboardHeight(440),
  );
  await expect
    .poll(() =>
      page
        .locator(".terminal-panel:visible")
        .evaluate((element) => element.getBoundingClientRect().bottom),
    )
    .toBeLessThanOrEqual(441);
  await expect
    .poll(() =>
      page
        .getByRole("group", { name: "Terminal keyboard shortcuts" })
        .evaluate((element) => element.getBoundingClientRect().bottom),
    )
    .toBeLessThanOrEqual(441);
  await recordLayout(page, "after-visual-viewport-keyboard");
  await page.locator(".terminal-input-help summary").tap();
  await expect
    .poll(() =>
      page
        .locator(".terminal-panel")
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(64);
  await expect(
    page.getByRole("button", { name: "Send Escape", exact: true }),
  ).toBeInViewport();
  await recordLayout(page, "after-keyboard-expanded-shortcut-help");
  await page.locator(".terminal-input-help summary").tap();
  await page.evaluate(() =>
    (
      window as unknown as { setPhoneKeyboardHeight(height: number): void }
    ).setPhoneKeyboardHeight(844),
  );
  await expect
    .poll(() =>
      page
        .locator(".terminal-panel:visible")
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(500);
});

test("desktop retains hover usage and tab dragging", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop pointer and keyboard behavior.");
  await openWorkbench(page);
  const first = page.getByRole("button", { name: "Codex 1", exact: true });
  await first.hover();
  await expect(page.getByRole("tooltip")).toContainText("$2.48");
  await page.mouse.move(1200, 800);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const tab = page.locator(".tab-button").first();
  expect(
    await tab.evaluate((element) => (element as HTMLElement).draggable),
  ).toBe(true);
  await page.locator(".tab-button").nth(2).dragTo(tab);
  await expect(page.locator(".tab-strip .tab-title").first()).toHaveText(
    "Codex 3",
  );
  await recordLayout(page, "after-desktop");
});

test("remote selection reveals an offscreen tab while unchanged workspace updates preserve a user's swipe", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Touch workspace navigation.");
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await openWorkbench(page);
  const strip = page.locator(".tab-strip");
  await swipeTabs(page);
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(40);
  const swiped = await strip.evaluate((element) => element.scrollLeft);
  fixture.workspace.tabs[0].title = "Codex 1 refreshed";
  fixture.updateWorkspace();
  await expect(
    page.getByRole("button", { name: "Codex 1 refreshed", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await strip.evaluate((element) => element.scrollLeft),
  ).toBeGreaterThanOrEqual(swiped);
  const root = fixture.workspace.windows[0].layout.root;
  if (root.type !== "pane") throw new Error("Expected single pane fixture.");
  root.pane.activeTabId = "phone-8";
  fixture.workspace.activeTabId = "phone-8";
  fixture.updateWorkspace();
  const last = page.getByRole("button", { name: "Codex 8", exact: true });
  await expect(last).toHaveAttribute("aria-pressed", "true");
  await expect(last).toBeInViewport();
});

test("phone terminal scroll moves real xterm history and releases the pane scroll lock", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Chromium touch scroll simulation.");
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await openWorkbench(page);
  fixture.output(
    "phone-1",
    Array.from(
      { length: 100 },
      (_, line) => `Terminal history line ${line + 1}\r\n`,
    ).join(""),
  );
  const position = () =>
    page.evaluate(() => {
      const terminal = (
        window as unknown as {
          phoneTerminals: Array<{
            buffer: { active: { viewportY: number; baseY: number } };
          }>;
        }
      ).phoneTerminals[0];
      return {
        viewportY: terminal.buffer.active.viewportY,
        baseY: terminal.buffer.active.baseY,
      };
    });
  await expect.poll(async () => (await position()).baseY).toBeGreaterThan(40);
  const before = await position();
  const terminal = (await page
    .locator(".terminal-panel:visible")
    .boundingBox())!;
  const input = await page.context().newCDPSession(page);
  const x = terminal.x + terminal.width / 2;
  const y = terminal.y + terminal.height / 3;
  await input.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await expect(page.locator(".pane-root")).toHaveClass(
    /terminal-touch-scroll-lock/,
  );
  for (let step = 1; step <= 8; step++)
    await input.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + step * 12 }],
    });
  await input.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await input.detach();
  await expect
    .poll(async () => (await position()).viewportY)
    .toBeLessThan(before.viewportY);
  await expect(page.locator(".pane-root")).not.toHaveClass(
    /terminal-touch-scroll-lock/,
  );
  await swipeTabs(page);
  await expect
    .poll(() =>
      page.locator(".tab-strip").evaluate((element) => element.scrollLeft),
    )
    .toBeGreaterThan(40);
});

test("phone split panes remain scrollable and a maximized pane fits the short viewport", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Mobile pane stacking.");
  await page.setViewportSize({ width: 390, height: 440 });
  await openWorkbench(page, "codex-terminal", { multiplePanes: true });
  const root = page.locator(".pane-root");
  expect(
    await root.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  const first = page.locator('[data-pane-id="phone-pane"]');
  await first.getByRole("button", { name: "Maximize pane", exact: true }).tap();
  await expect(page.locator('[data-pane-id="second-pane"]')).toBeHidden();
  await expect
    .poll(() =>
      first.evaluate((element) => element.getBoundingClientRect().bottom),
    )
    .toBeLessThanOrEqual(441);
  await expect(
    first.getByRole("button", { name: "Send Escape", exact: true }),
  ).toBeInViewport();
  await first.getByRole("button", { name: "Restore pane", exact: true }).tap();
  await expect(page.locator('[data-pane-id="second-pane"]')).toBeVisible();
  expect(
    await root.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
});

test("enabled voice input uses phone space only when explicitly opened", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Mobile voice layout.");
  await page.setViewportSize({ width: 320, height: 568 });
  await openWorkbench(page, "codex-terminal", { voice: true });
  const toggle = page.getByRole("button", { name: "Voice input", exact: true });
  await expect(toggle).toBeInViewport();
  await expect(page.locator(".voice-console")).toBeHidden();
  await toggle.tap();
  await expect(page.locator(".voice-console")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      page
        .locator(".terminal-panel:visible")
        .evaluate((element) => element.getBoundingClientRect().bottom),
    )
    .toBeLessThanOrEqual(569);
  await recordLayout(page, "after-voice-open");
  await toggle.tap();
  await expect(page.locator(".voice-console")).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("expanded phone shortcut help keeps terminal controls reachable", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Phone help layout.");
  await page.setViewportSize({ width: 390, height: 440 });
  await openWorkbench(page);
  await page.locator(".terminal-input-help summary").click();
  await recordLayout(page, "after-expanded-shortcut-help");
  await expect
    .poll(() =>
      page
        .locator(".terminal-panel")
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(64);
  await expect(
    page.getByRole("button", { name: "Send Escape", exact: true }),
  ).toBeInViewport();
  await page.locator(".terminal-input-help summary").click();
  await page
    .getByRole("button", { name: "Select visible terminal text", exact: true })
    .tap();
  const selection = page.getByRole("complementary", {
    name: "Terminal text selection mode",
  });
  await expect(selection).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Visible terminal text", exact: true }),
  ).toHaveValue(/Phone workbench simulation/);
  await page
    .getByRole("button", { name: "Close text selection", exact: true })
    .tap();
  await expect(selection).toHaveCount(0);
});

test("selected phone tab remains visible when the viewport becomes narrower", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Phone rotation and viewport resize.");
  await page.setViewportSize({ width: 844, height: 390 });
  const fixture = await openWorkbench(page);
  const root = fixture.workspace.windows[0].layout.root;
  if (root.type !== "pane") throw new Error("Expected single pane fixture.");
  root.pane.activeTabId = "phone-8";
  fixture.workspace.activeTabId = "phone-8";
  fixture.updateWorkspace();
  const last = page.getByRole("button", { name: "Codex 8", exact: true });
  await expect(last).toHaveAttribute("aria-pressed", "true");
  await expect(last).toBeInViewport();
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(last).toBeInViewport();
});

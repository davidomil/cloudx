import {
  expect,
  test,
  type Locator,
  type Page,
  type WebSocket,
} from "@playwright/test";
import type {
  CloudxConfigResponse,
  CreateTabResponse,
  PluginDescriptor,
  TabLayoutNode,
  WorkspaceStateResponse,
} from "@cloudx/shared";
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
    const codexHome = path.join(testRoot, "codex-home");
    const imagegen = path.join(codexHome, "skills", ".system", "imagegen");
    await fs.mkdir(imagegen, { recursive: true });
    await fs.writeFile(
      path.join(imagegen, "SKILL.md"),
      "---\nname: imagegen\ndescription: Browser fixture only.\n---\nFixture data only.\n",
    );
    for (let index = 0; index < 184; index += 1) {
      const retained = path.join(
        data,
        "codex-homes",
        `retained-${String(index).padStart(3, "0")}`,
      );
      await fs.mkdir(retained, { recursive: true });
      await fs.writeFile(
        path.join(retained, "AGENTS.override.md"),
        `# CloudX Codex Session Instructions\n\n## CloudX Template: ${index < 2 ? "Duplicate Review" : "Long template label ".repeat(12).trim()}\n\nSynthetic fixture only.\n`,
      );
      await fs.writeFile(
        path.join(retained, "source-marker.txt"),
        `owner-${index}`,
      );
    }
    const assistant = await writeTerminalFixture(testRoot);

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["apps/server/dist/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLOUDX_ALLOWED_ROOTS: workspace,
        CLOUDX_APP_SERVER_ENABLED: "false",
        CLOUDX_ASSISTANT_BIN: assistant,
        CLOUDX_ASR_URL: "http://127.0.0.1:9",
        CLOUDX_AUTOMATION_START_DISABLED: "true",
        CLOUDX_DATA_DIR: data,
        CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
        CLOUDX_HOST: "127.0.0.1",
        CLOUDX_LOG_LEVEL: "warn",
        CLOUDX_PORT: String(port),
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: "",
        SHELL: "/bin/bash",
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

  test("restores the same running Codex terminal across two full page reloads", async ({
    page,
  }, testInfo) => {
    const sockets: Array<{
      socket: WebSocket;
      frames: Array<{ bytes: number; data: string }>;
      errors: string[];
      closes: number;
    }> = [];
    const tabPosts: unknown[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/tabs"
      ) {
        tabPosts.push(request.postDataJSON());
      }
    });
    page.on("websocket", (socket) => {
      if (!new URL(socket.url()).pathname.startsWith("/ws/terminal/")) return;
      const observed = {
        socket,
        frames: [] as Array<{ bytes: number; data: string }>,
        errors: [] as string[],
        closes: 0,
      };
      sockets.push(observed);
      socket.on("framereceived", ({ payload }) => {
        const text =
          typeof payload === "string" ? payload : payload.toString("utf8");
        const message = JSON.parse(text) as { type: string; data: string };
        if (message.type === "data")
          observed.frames.push({
            bytes: Buffer.byteLength(text),
            data: message.data,
          });
      });
      socket.on("socketerror", (error) => observed.errors.push(error));
      socket.on("close", () => {
        observed.closes += 1;
      });
    });

    let tabId: string | undefined;
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page
        .locator(".workspace-pane.active")
        .getByTitle("Add tab to this pane")
        .click();
      await page.getByLabel("Plugin").selectOption("codex-terminal");
      await page.getByLabel("Title").fill("Reload fixture");
      const creation = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/tabs",
      );
      await page.getByRole("button", { name: "Create", exact: true }).click();
      const created = await creation;
      expect(created.status()).toBe(201);
      const committed = (await created.json()) as CreateTabResponse;
      tabId = committed.tab.id;
      expect(tabPosts).toHaveLength(1);
      expect(tabPosts[0]).toMatchObject({
        pluginId: "codex-terminal",
        windowId: committed.window.id,
        paneId: committed.window.layout.activePaneId,
      });
      await expect.poll(() => sockets.length).toBe(1);
      await expect
        .poll(() =>
          sockets[0]!.frames.some((frame) => frame.data.includes("READY")),
        )
        .toBe(true);
      const startsPath = path.join(testRoot, "fixture-starts.jsonl");
      const initialStarts = await fs.readFile(startsPath, "utf8");
      const starts = initialStarts
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { pid: number; start: number });
      expect(starts).toHaveLength(1);
      const identity = starts[0]!;
      const pidMarker = "PID:" + identity.pid;
      const startMarker = "START:" + identity.start;
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("fill");
      await page.keyboard.press("Enter");
      await expect
        .poll(() =>
          sockets[0]!.frames.some((frame) => frame.data.includes("FILLED")),
        )
        .toBe(true);
      await expect(page.locator(".xterm-rows")).toContainText(pidMarker);

      for (const reload of [1, 2]) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(() => sockets.length).toBe(reload + 1);
        await expect.poll(() => sockets[reload - 1]!.closes).toBe(1);
        const current = sockets[reload]!;
        expect(new URL(current.socket.url()).pathname).toBe(
          "/ws/terminal/" + tabId,
        );
        await expect
          .poll(() =>
            current.frames.some(
              (frame) =>
                frame.bytes > 1_048_576 && frame.data.includes(pidMarker),
            ),
          )
          .toBe(true);
        const replay = current.frames.find((frame) => frame.bytes > 1_048_576)!;
        expect(Buffer.byteLength(replay.data)).toBe(1_048_576);
        expect(replay.data).toContain(startMarker);
        expect(replay.data).toContain("FILLED");
        if (reload === 2) expect(replay.data).toContain("ECHO:after-reload-1");
        await expect(page.locator(".xterm-rows")).toContainText(pidMarker);
        expect(current.socket.isClosed()).toBe(false);
        expect(current.closes).toBe(0);
        expect(current.errors).toEqual([]);
        const input = "after-reload-" + reload;
        await page.locator(".xterm-helper-textarea").focus();
        await page.keyboard.type(input);
        await page.keyboard.press("Enter");
        await expect
          .poll(() =>
            current.frames.some((frame) =>
              frame.data.includes("ECHO:" + input),
            ),
          )
          .toBe(true);
        await expect(page.locator(".xterm-rows")).toContainText(
          "ECHO:" + input,
        );
        await expect(page.locator(".xterm-rows")).toContainText(pidMarker);
        expect(current.socket.isClosed()).toBe(false);
        const workspace = (await (
          await page.request.get(baseUrl + "/api/workspace")
        ).json()) as WorkspaceStateResponse;
        expect(
          workspace.tabs
            .filter((tab) => tab.pluginId === "codex-terminal")
            .map((tab) => ({ id: tab.id, status: tab.status })),
        ).toEqual([{ id: tabId, status: "running" }]);
        expect(tabPosts).toHaveLength(1);
        await expect(fs.readFile(startsPath, "utf8")).resolves.toBe(
          initialStarts,
        );
        const screenshot = await page.screenshot({
          path: testInfo.outputPath("reload-" + reload + ".png"),
        });
        await testInfo.attach("terminal reload " + reload, {
          body: screenshot,
          contentType: "image/png",
        });
      }
    } finally {
      if (tabId) {
        const deleted = await page.request.delete(
          baseUrl + "/api/tabs/" + tabId,
        );
        expect(deleted.ok()).toBe(true);
      }
    }
  });

  test("selects an exact retained source through the real route and factory", async ({
    page,
  }, testInfo) => {
    let sourceRequests = 0;
    const posts: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/codex/state-sources") sourceRequests += 1;
      if (url.pathname === "/api/tabs" && request.method() === "POST")
        posts.push(request.postDataJSON());
    });
    let tabId: string | undefined;
    const sourceId =
      "legacy:" + Buffer.from("retained-001").toString("base64url");
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page
        .locator(".workspace-pane.active")
        .getByTitle("Add tab to this pane")
        .click();
      expect(sourceRequests).toBe(0);
      await page.getByLabel("Session", { exact: true }).selectOption("session");
      await expect(
        page.getByRole("button", { name: "Create", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByLabel("Session source", { exact: true }).locator("option"),
      ).toHaveCount(186);
      await page
        .getByLabel("Session source", { exact: true })
        .selectOption(
          "legacy:" + Buffer.from("retained-183").toString("base64url"),
        );
      await expect(page.getByLabel("Selected session source key")).toHaveCSS(
        "text-transform",
        "none",
      );
      await expect(page.getByLabel("Selected session source key")).toHaveText(
        "legacy:" + Buffer.from("retained-183").toString("base64url"),
        { useInnerText: true },
      );
      expect(
        await page
          .locator(".dialog")
          .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1),
      ).toBe(true);
      const longLabelScreenshot = await page.screenshot({
        path: testInfo.outputPath("source-long-label.png"),
      });
      await testInfo.attach("long source label", {
        body: longLabelScreenshot,
        contentType: "image/png",
      });
      await page.getByLabel("Session source", { exact: true }).selectOption("");
      await page
        .getByLabel("Session ID", { exact: true })
        .fill("same-synthetic-thread");
      await page.getByLabel("Find session source").fill("Duplicate Review");
      await expect(
        page.getByLabel("Session source", { exact: true }).locator("option"),
      ).toHaveCount(3);
      await page
        .getByLabel("Session source", { exact: true })
        .selectOption(
          "legacy:" + Buffer.from("retained-000").toString("base64url"),
        );
      await page
        .getByLabel("Session source", { exact: true })
        .selectOption(sourceId);
      await expect(page.getByLabel("Session ID", { exact: true })).toHaveValue(
        "same-synthetic-thread",
      );
      await expect(page.getByLabel("Selected session source key")).toHaveText(
        sourceId,
      );
      await expect(page.getByLabel("Selected session source key")).toHaveCSS(
        "text-transform",
        "none",
      );
      await expect(page.getByLabel("Selected session source key")).toHaveText(
        sourceId,
        { useInnerText: true },
      );
      await page.getByLabel("Find session source").fill(sourceId);
      await page.getByLabel("Session source", { exact: true }).focus();
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByLabel("Session source", { exact: true }),
      ).toHaveValue(sourceId);
      const screenshot = await page.screenshot({
        path: testInfo.outputPath("source-selector.png"),
      });
      await testInfo.attach("source selector", {
        body: screenshot,
        contentType: "image/png",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page.getByLabel("Session", { exact: true }).selectOption("new");
      await expect(
        page.getByLabel("Session source", { exact: true }),
      ).toHaveCount(0);
      expect(sourceRequests).toBe(1);
      await page.getByLabel("Session", { exact: true }).selectOption("session");
      await expect(page.getByLabel("Session ID", { exact: true })).toHaveValue(
        "",
      );
      await expect(
        page.getByLabel("Session source", { exact: true }),
      ).toHaveValue("");
      await page
        .getByLabel("Session ID", { exact: true })
        .fill("same-synthetic-thread");
      await page
        .getByLabel("Session source", { exact: true })
        .selectOption(sourceId);
      const creation = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/tabs",
      );
      await page.getByRole("button", { name: "Create", exact: true }).click();
      const created = await creation;
      expect(created.status()).toBe(201);
      tabId = ((await created.json()) as CreateTabResponse).tab.id;
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        initialInput: {
          resume: {
            mode: "session",
            sourceId,
            sessionId: "same-synthetic-thread",
          },
        },
      });
      await expect(page.locator(".xterm-rows")).toContainText("SOURCE:owner-1");
      const binding = JSON.parse(
        await fs.readFile(
          path.join(
            testRoot,
            "data",
            "codex-launches",
            tabId,
            ".cloudx-source.json",
          ),
          "utf8",
        ),
      );
      expect(binding.sourceId).toBe(sourceId);
      const starts = (
        await fs.readFile(path.join(testRoot, "fixture-starts.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(starts.at(-1)).toMatchObject({
        sourceId,
        marker: "owner-1",
        sqliteHome: binding.home,
      });
    } finally {
      if (tabId) await page.request.delete(`${baseUrl}/api/tabs/${tabId}`);
    }
  });

  test("discards a pending catalog after closing and reopening the resume dialog", async ({
    page,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await page.route("**/api/codex/state-sources", async (route) => {
      requests += 1;
      if (requests === 1) {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response }).catch(() => undefined);
      } else await route.continue();
    });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page
        .locator(".workspace-pane.active")
        .getByTitle("Add tab to this pane")
        .click();
      await page.getByLabel("Session", { exact: true }).selectOption("picker");
      await expect(page.getByText("Loading session sources…")).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .locator(".workspace-pane.active")
        .getByTitle("Add tab to this pane")
        .click();
      await page.getByLabel("Session", { exact: true }).selectOption("picker");
      await expect(
        page.getByLabel("Session source", { exact: true }).locator("option"),
      ).toHaveCount(186);
      release();
      await expect(
        page.getByLabel("Session source", { exact: true }),
      ).toHaveValue("");
      await expect(
        page.getByRole("button", { name: "Create", exact: true }),
      ).toBeDisabled();
      expect(requests).toBe(2);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test("creates a tab from the committed window without duplicate layout persistence", async ({
    page,
  }, testInfo) => {
    const workspaceRequests: Array<{
      method: "PATCH" | "POST";
      pathname: string;
      body: unknown;
    }> = [];
    page.on("request", (request) => {
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      if (
        (method === "PATCH" && /^\/api\/windows\/[^/]+$/.test(pathname)) ||
        (method === "POST" && pathname === "/api/tabs")
      ) {
        workspaceRequests.push({
          method,
          pathname,
          body: request.postDataJSON(),
        });
      }
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".workspace-pane")).toHaveCount(1);

    const visibleSplitButton = page.locator('button[title^="Split"]:visible');
    if ((await visibleSplitButton.count()) === 0) {
      await page.getByRole("button", { name: "Workspace actions" }).click();
    }
    const splitResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        /^\/api\/windows\/[^/]+$/.test(new URL(response.url()).pathname),
    );
    await visibleSplitButton.first().click();
    await expect(page.locator(".workspace-pane")).toHaveCount(2);
    expect((await splitResponsePromise).status()).toBe(200);

    const targetPane = page.locator(".workspace-pane.active");
    const paneId = await targetPane.getAttribute("data-pane-id");
    expect(paneId).toBeTruthy();
    await targetPane.getByTitle("Add tab to this pane").click();

    await page.getByLabel("Plugin").selectOption("local-web");
    await page.getByLabel("Title").fill("Browser placement");
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/tabs",
    );
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);

    const committed = (await createResponse.json()) as CreateTabResponse;
    const createRequest = workspaceRequests.find(
      (request) => request.method === "POST",
    );
    expect(workspaceRequests.map((request) => request.method)).toEqual([
      "PATCH",
      "POST",
    ]);
    expect(createRequest?.body).toMatchObject({
      pluginId: "local-web",
      windowId: committed.window.id,
      paneId,
    });
    const committedPane = findPane(committed.window.layout.root, paneId!);
    expect(committedPane?.tabIds).toContain(committed.tab.id);
    expect(committedPane?.activeTabId).toBe(committed.tab.id);
    await expect(
      targetPane.getByText("Browser placement", { exact: true }),
    ).toBeVisible();

    await page.waitForTimeout(500);
    expect(
      workspaceRequests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(1);

    const screenshot = await page.screenshot({
      path: testInfo.outputPath("tab-placement.png"),
    });
    await testInfo.attach("tab placement", {
      body: screenshot,
      contentType: "image/png",
    });
  });

  test("keeps a failed optimistic layout visible and persists it before a later tab command", async ({
    page,
  }) => {
    const workspaceRequests: Array<"PATCH" | "POST"> = [];
    let patchAttempts = 0;
    let startSecondPatch!: () => void;
    let releaseSecondPatch!: () => void;
    const secondPatchStarted = new Promise<void>((resolve) => {
      startSecondPatch = resolve;
    });
    const secondPatchRelease = new Promise<void>((resolve) => {
      releaseSecondPatch = resolve;
    });
    await page.route("**/api/windows/*", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      workspaceRequests.push("PATCH");
      patchAttempts += 1;
      if (patchAttempts === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "layout persistence failed" }),
        });
        return;
      }
      startSecondPatch();
      await secondPatchRelease;
      await route.continue();
    });
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/tabs"
      ) {
        workspaceRequests.push("POST");
      }
    });

    try {
      const workspaceResponse = await page.request.get(
        `${baseUrl}/api/workspace`,
      );
      const workspace =
        (await workspaceResponse.json()) as WorkspaceStateResponse;
      const activeWindow =
        workspace.windows.find(
          (window) => window.id === workspace.activeWindowId,
        ) ?? workspace.windows[0]!;
      const initialPaneCount = countPanes(activeWindow.layout.root);
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".workspace-pane")).toHaveCount(
        initialPaneCount,
      );
      const firstPatchResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          /^\/api\/windows\/[^/]+$/u.test(new URL(response.url()).pathname),
      );
      const splitButton = page.locator('button[title^="Split"]:visible');
      if ((await splitButton.count()) === 0) {
        await page.getByRole("button", { name: "Workspace actions" }).click();
      }
      await splitButton.first().click();
      await expect(page.locator(".workspace-pane")).toHaveCount(
        initialPaneCount + 1,
      );
      expect((await firstPatchResponse).status()).toBe(500);
      await expect(page.locator(".error-banner")).toContainText(
        "layout persistence failed",
      );

      const targetPane = page.locator(".workspace-pane.active");
      await targetPane.getByTitle("Add tab to this pane").click();
      await page.getByLabel("Plugin").selectOption("local-web");
      await page.getByLabel("Title").fill("Recovered layout placement");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await Promise.race([
        secondPatchStarted,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error("A later command did not retry the pending layout."),
              ),
            1_000,
          ),
        ),
      ]);

      await expect(page.locator(".error-banner")).toContainText(
        "layout persistence failed",
      );
      expect(workspaceRequests).toEqual(["PATCH", "PATCH"]);
      const createResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/tabs",
      );
      releaseSecondPatch();
      expect((await createResponse).status()).toBe(201);

      expect(workspaceRequests).toEqual(["PATCH", "PATCH", "POST"]);
      await expect(page.locator(".error-banner")).toHaveCount(0);
      await expect(
        targetPane.getByText("Recovered layout placement", { exact: true }),
      ).toBeVisible();
    } finally {
      releaseSecondPatch();
    }
  });

  test("refreshes reselected file listings while uploads and downloads keep running", async ({
    page,
  }) => {
    const files = await createTransferTestTab(
      page,
      "file-browser",
      "Transfer files",
    );
    const other = await createTransferTestTab(
      page,
      "file-browser",
      "Other files",
    );
    let releaseUpload!: () => void;
    let releaseDownload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const uploads: string[] = [];
    let downloads = 0;
    await page.route("**/api/config", async (route) => {
      const response = await route.fetch();
      const config = (await response.json()) as CloudxConfigResponse;
      config.values.plugins["file-browser"].showGitDiff = false;
      await route.fulfill({ response, json: config });
    });
    await page.route(
      `**/api/tabs/${files.tab.id}/files/upload?*`,
      async (route) => {
        uploads.push(
          new URL(route.request().url()).searchParams.get("relativePath")!,
        );
        await uploadGate;
        await route.continue();
      },
    );
    await page.route(
      `**/api/tabs/${files.tab.id}/files/download`,
      async (route) => {
        downloads += 1;
        await downloadGate;
        if (downloads === 1) {
          await route.continue();
        } else {
          await route.fulfill({
            status: 500,
            json: { message: "Transfer fixture download failed" },
          });
        }
      },
    );
    const selectFiles = () =>
      page
        .locator(".tab-activation")
        .filter({ hasText: "Transfer files" })
        .click();
    const selectOther = () =>
      page
        .locator(".tab-activation")
        .filter({ hasText: "Other files" })
        .click();
    const visibleFiles = page.locator(".file-browser-panel:visible");
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await selectFiles();
      const contents = ["first upload bytes", "second upload bytes"];
      await visibleFiles.locator('input[type="file"]').setInputFiles(
        contents.map((content, index) => ({
          name: `transfer-${index}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from(content),
        })),
      );
      await expect.poll(() => uploads.length).toBe(1);
      await selectOther();
      await expect(
        visibleFiles.getByRole("button", { name: "Upload files", exact: true }),
      ).toBeEnabled();
      await expect(
        visibleFiles.getByRole("status", { name: "Upload progress" }),
      ).toHaveCount(0);
      await fs.writeFile(
        path.join(testRoot, "workspace", "created-while-hidden.txt"),
        "Created outside the retained Files tab\n",
      );
      await selectFiles();
      await expect(visibleFiles.locator(".file-list")).toContainText(
        "created-while-hidden.txt",
      );
      await expect(
        visibleFiles.getByRole("status", { name: "Upload progress" }),
      ).toContainText("Uploading 1/2");
      await expect(
        visibleFiles.getByRole("button", { name: "Upload files", exact: true }),
      ).toBeDisabled();
      await selectOther();
      const uploadFinished = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/tabs/${files.tab.id}/files/upload?`) &&
          new URL(response.url()).searchParams.get("relativePath") ===
            "transfer-1.txt",
      );
      releaseUpload();
      expect((await uploadFinished).status()).toBe(200);
      expect(uploads).toHaveLength(2);
      for (const [index, content] of contents.entries()) {
        expect(
          await fs.readFile(
            path.join(testRoot, "workspace", `transfer-${index}.txt`),
            "utf8",
          ),
        ).toBe(content);
      }
      await selectFiles();
      await expect(
        visibleFiles.getByRole("status", { name: "Upload progress" }),
      ).toHaveCount(0);
      await expect(
        visibleFiles.getByRole("button", { name: "Upload files", exact: true }),
      ).toBeEnabled();
      expect(uploads).toEqual(["transfer-0.txt", "transfer-1.txt"]);
      await selectTransferDownload(visibleFiles);
      const downloadButton = visibleFiles.getByRole("button", {
        name: "Download 1 selected entries",
        exact: true,
      });
      await downloadButton.click();
      await expect.poll(() => downloads).toBe(1);
      await selectOther();
      await selectFiles();
      await expect(downloadButton).toBeDisabled();
      await selectOther();
      const downloaded = page.waitForEvent("download");
      releaseDownload();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe("transfer-0.txt");
      expect(await fs.readFile((await download.path())!, "utf8")).toBe(
        contents[0],
      );
      await selectFiles();
      const selectDownloads = visibleFiles.getByRole("button", {
        name: "Select files or folders to download",
        exact: true,
      });
      await expect(selectDownloads).toBeVisible();
      expect(downloads).toBe(1);

      await selectTransferDownload(visibleFiles);
      await downloadButton.click();
      await selectOther();
      await expect.poll(() => downloads).toBe(2);
      await selectFiles();
      await expect(visibleFiles.locator(".inline-error")).toContainText(
        "Transfer fixture download failed",
      );
      await expect(selectDownloads).toBeVisible();
    } finally {
      releaseUpload();
      releaseDownload();
      await page.unrouteAll({ behavior: "wait" });
      await page.request.delete(`${baseUrl}/api/tabs/${files.tab.id}`);
      await page.request.delete(`${baseUrl}/api/tabs/${other.tab.id}`);
    }
  });

  for (const viewer of ["local web", "plugin webview"] as const) {
    test(`keeps ${viewer} transfers running in a hidden tab`, async ({
      page,
    }) => {
      const fixtureUrl = `${baseUrl}/transfer-fixture`;
      const view = await createTransferTestTab(
        page,
        "local-web",
        "Transfer viewer",
        { url: fixtureUrl },
      );
      const other = await createTransferTestTab(
        page,
        "local-web",
        "Other viewer",
      );
      let release!: () => void;
      const transferGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requests: Array<{ method: string; body: string | null }> = [];
      const transferUrl = `${baseUrl}/transfer-fixture-bytes`;
      await page.route(`${transferUrl}/*`, async (route) => {
        requests.push({
          method: route.request().method(),
          body: route.request().postData(),
        });
        await transferGate;
        await route.fulfill({
          contentType: "text/plain",
          headers: { "access-control-allow-origin": "*" },
          body: "downloaded fixture bytes",
        });
      });
      const fixtureHtml = `<!doctype html><html><body>
        <input type="file" aria-label="Upload fixture">
        <button>Start transfers</button>
        <output id="upload">Ready</output>
        <output id="download">Ready</output>
        <script>
          document.querySelector('button').onclick = () => {
            const file = document.querySelector('input').files[0];
            document.querySelector('#upload').textContent = 'Uploading';
            document.querySelector('#download').textContent = 'Downloading';
            fetch('${transferUrl}/upload', { method: 'POST', body: file }).then(() => {
              document.querySelector('#upload').textContent = 'Upload complete';
            });
            fetch('${transferUrl}/download').then(response => response.blob()).then(blob => {
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = 'viewer-transfer.txt';
              document.body.append(link);
              link.click();
              link.remove();
              URL.revokeObjectURL(link.href);
              document.querySelector('#download').textContent = 'Download complete';
            });
          };
        </script></body></html>`;
      await page.route(
        viewer === "local web"
          ? `**/api/local-web/${view.tab.id}/proxy/**`
          : fixtureUrl,
        (route) =>
          route.fulfill({ contentType: "text/html", body: fixtureHtml }),
      );
      if (viewer === "plugin webview") {
        await page.route("**/api/plugins", async (route) => {
          const response = await route.fetch();
          const body = (await response.json()) as {
            plugins: PluginDescriptor[];
          };
          const plugin = body.plugins.find(
            (plugin) => plugin.id === "local-web",
          )!;
          plugin.panelKind = "placeholder";
          plugin.uiContributions = [
            {
              id: "transfer-fixture.panel",
              owner: { kind: "plugin", pluginId: "local-web" },
              slot: "plugin.panel",
              renderer: "plugin.webview",
              title: "Transfer fixture",
              targetPluginId: "local-web",
              state: {
                url: fixtureUrl,
                sandbox: "allow-scripts allow-forms allow-downloads",
              },
            },
          ];
          await route.fulfill({ response, json: body });
        });
      }
      try {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await page
          .locator(".tab-activation")
          .filter({ hasText: "Transfer viewer" })
          .click();
        const iframe = page.locator(
          ".workspace-pane.active .pane-body iframe:visible",
        );
        const element = (await iframe.elementHandle())!;
        const frame = (await element.contentFrame())!;
        await frame.getByLabel("Upload fixture").setInputFiles({
          name: "viewer-upload.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("uploaded fixture bytes"),
        });
        await frame.getByRole("button", { name: "Start transfers" }).click();
        await expect.poll(() => requests.length).toBe(2);
        await page
          .locator(".tab-activation")
          .filter({ hasText: "Other viewer" })
          .click();
        expect(await element.evaluate((node) => node.isConnected)).toBe(true);
        await expect(
          frame.getByRole("button", { name: "Start transfers" }),
        ).toBeHidden();
        await page
          .locator(".tab-activation")
          .filter({ hasText: "Transfer viewer" })
          .click();
        await expect(frame.locator("#upload")).toHaveText("Uploading");
        await page
          .locator(".tab-activation")
          .filter({ hasText: "Other viewer" })
          .click();
        const downloaded = page.waitForEvent("download");
        release();
        const download = await downloaded;
        expect(await fs.readFile((await download.path())!, "utf8")).toBe(
          "downloaded fixture bytes",
        );
        await expect(frame.locator("#upload")).toHaveText("Upload complete");
        await expect(frame.locator("#download")).toHaveText(
          "Download complete",
        );
        expect(requests).toEqual(
          expect.arrayContaining([
            { method: "POST", body: "uploaded fixture bytes" },
            { method: "GET", body: null },
          ]),
        );
        expect(requests).toHaveLength(2);
        await page
          .getByRole("button", { name: "Close Transfer viewer", exact: true })
          .click();
        await expect.poll(() => frame.isDetached()).toBe(true);
      } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
        await page.request.delete(`${baseUrl}/api/tabs/${view.tab.id}`);
        await page.request.delete(`${baseUrl}/api/tabs/${other.tab.id}`);
      }
    });
  }
});

async function selectTransferDownload(files: Locator) {
  await files
    .getByRole("button", {
      name: "Select files or folders to download",
      exact: true,
    })
    .click();
  if (
    !(await files
      .getByRole("region", { name: "File tree", exact: true })
      .isVisible())
  ) {
    await files.locator(".file-tree-dock").hover();
    await files.getByRole("button", { name: "File tree", exact: true }).click();
  }
  await files
    .getByRole("checkbox", {
      name: "Select transfer-0.txt for download",
      exact: true,
    })
    .check();
}

async function createTransferTestTab(
  page: Page,
  pluginId: string,
  title: string,
  initialInput?: Record<string, string>,
): Promise<CreateTabResponse> {
  const workspace = (await (
    await page.request.get(`${baseUrl}/api/workspace`)
  ).json()) as WorkspaceStateResponse;
  const window = workspace.windows.find(
    (candidate) => candidate.id === workspace.activeWindowId,
  )!;
  const response = await page.request.post(`${baseUrl}/api/tabs`, {
    data: {
      pluginId,
      title,
      cwd: path.join(testRoot, "workspace"),
      initialInput,
      windowId: window.id,
      paneId: window.layout.activePaneId,
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function writeTerminalFixture(root: string): Promise<string> {
  const executable = path.join(root, "codex-fixture.cjs");
  await fs.writeFile(
    executable,
    [
      "#!" + process.execPath,
      'const fs = require("node:fs");',
      'const { once } = require("node:events");',
      "const startLog = " +
        JSON.stringify(path.join(root, "fixture-starts.jsonl")) +
        ";",
      'const binding = JSON.parse(fs.readFileSync(require("node:path").join(process.env.CODEX_HOME, ".cloudx-source.json"), "utf8"));',
      'const markerPath = require("node:path").join(process.env.CODEX_SQLITE_HOME, "source-marker.txt");',
      'const sourceMarker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : "shared";',
      "const identity = { pid: process.pid, start: Date.now(), sourceId: binding.sourceId, sqliteHome: process.env.CODEX_SQLITE_HOME, marker: sourceMarker };",
      'fs.appendFileSync(startLog, JSON.stringify(identity) + "\\n");',
      'const marker = "PID:" + identity.pid + "\\r\\nSTART:" + identity.start + "\\r\\nSOURCE:" + sourceMarker;',
      'async function output(text) { if (!process.stdout.write(text)) await once(process.stdout, "drain"); }',
      "let filled = false;",
      "async function command(input) {",
      '  if (input === "fill" && !filled) {',
      "    filled = true;",
      "    for (let remaining = 1100000; remaining > 0; remaining -= 4096) {",
      '      await output("h".repeat(Math.min(4096, remaining)) + "\\r\\n");',
      "    }",
      '    await output("\\r\\nFILLED\\r\\n" + marker + "\\r\\nREADY\\r\\n");',
      "  } else {",
      '    await output("ECHO:" + input + "\\r\\n" + marker + "\\r\\nREADY\\r\\n");',
      "  }",
      "}",
      "process.stdin.setRawMode(true);",
      'process.stdin.setEncoding("utf8");',
      'let input = "";',
      'process.stdin.on("data", (data) => {',
      "  for (const character of data) {",
      '    if (character === "\\r" || character === "\\n") {',
      '      const complete = input; input = "";',
      "      if (complete) void command(complete).catch(() => process.exit(1));",
      "    } else if (/^[a-z0-9-]$/.test(character)) {",
      "      input += character;",
      "      if (input.length > 128) process.exit(2);",
      "    }",
      "  }",
      "});",
      'void output(marker + "\\r\\nREADY\\r\\n");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

function findPane(root: TabLayoutNode, paneId: string) {
  if (root.type === "pane") {
    return root.pane.id === paneId ? root.pane : undefined;
  }
  return (
    findPane(root.children[0], paneId) ?? findPane(root.children[1], paneId)
  );
}

function countPanes(root: TabLayoutNode): number {
  return root.type === "pane"
    ? 1
    : countPanes(root.children[0]) + countPanes(root.children[1]);
}

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

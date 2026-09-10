import { expect, test, type Page, type WebSocket } from "@playwright/test";
import type {
  CreateTabResponse,
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

  for (const mode of ["picker", "last", "session"] as const) {
    test(`resumes ${mode} from shared history without a source selector`, async ({
      page,
    }, testInfo) => {
      let sourceRequests = 0;
      const posts: Array<Record<string, unknown>> = [];
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/codex/state-sources") sourceRequests += 1;
        if (pathname === "/api/tabs" && request.method() === "POST")
          posts.push(request.postDataJSON());
      });
      let tabId: string | undefined;
      try {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await page
          .locator(".workspace-pane.active")
          .getByTitle("Add tab to this pane")
          .click();
        await page.getByLabel("Session", { exact: true }).selectOption(mode);
        await expect(
          page.getByLabel("Session source", { exact: true }),
        ).toHaveCount(0);
        await expect(page.getByLabel("Find session source")).toHaveCount(0);
        const create = page.getByRole("button", {
          name: "Create",
          exact: true,
        });
        if (mode === "session") {
          await expect(create).toBeDisabled();
          await page
            .getByLabel("Session ID", { exact: true })
            .fill("same-synthetic-thread");
        } else {
          await page.getByLabel("All directories", { exact: true }).check();
          await page
            .getByLabel("Include exec sessions", { exact: true })
            .check();
        }
        await expect(create).toBeEnabled();
        expect(
          await page
            .locator(".dialog")
            .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1),
        ).toBe(true);
        await testInfo.attach("shared resume dialog", {
          body: await page.screenshot({
            path: testInfo.outputPath("shared-resume.png"),
          }),
          contentType: "image/png",
        });
        const creation = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/tabs",
        );
        await create.click();
        const response = await creation;
        expect(response.status()).toBe(201);
        tabId = ((await response.json()) as CreateTabResponse).tab.id;
        expect(posts).toHaveLength(1);
        expect(posts[0]?.initialInput).toEqual({
          resume:
            mode === "session"
              ? { mode, sessionId: "same-synthetic-thread" }
              : { mode, all: true, includeNonInteractive: true },
        });
        await expect(page.locator(".xterm-rows")).toContainText(
          "SOURCE:shared",
        );
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
        expect(binding).toMatchObject({
          sourceId: "shared",
          home: await fs.realpath(path.join(testRoot, "codex-home")),
        });
        const starts = (
          await fs.readFile(path.join(testRoot, "fixture-starts.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(starts.at(-1)).toMatchObject({
          sourceId: "shared",
          marker: "shared",
          sqliteHome: binding.home,
          args:
            mode === "session"
              ? expect.arrayContaining(["resume", "same-synthetic-thread"])
              : expect.arrayContaining([
                  "resume",
                  "--all",
                  "--include-non-interactive",
                  ...(mode === "last" ? ["--last"] : []),
                ]),
        });
        expect(sourceRequests).toBe(0);
      } finally {
        if (tabId) await page.request.delete(`${baseUrl}/api/tabs/${tabId}`);
      }
    });
  }

  test("reopening the resume dialog resets the mode and ID without fetching sources", async ({
    page,
  }) => {
    let sourceRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/codex/state-sources")
        sourceRequests += 1;
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page
      .locator(".workspace-pane.active")
      .getByTitle("Add tab to this pane")
      .click();
    await page.getByLabel("Session", { exact: true }).selectOption("session");
    await page.getByLabel("Session ID", { exact: true }).fill("discarded-id");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .locator(".workspace-pane.active")
      .getByTitle("Add tab to this pane")
      .click();
    await expect(page.getByLabel("Session", { exact: true })).toHaveValue(
      "new",
    );
    await page.getByLabel("Session", { exact: true }).selectOption("session");
    await expect(page.getByLabel("Session ID", { exact: true })).toHaveValue(
      "",
    );
    await expect(
      page.getByRole("button", { name: "Create", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("Session", { exact: true }).selectOption("picker");
    await expect(
      page.getByRole("button", { name: "Create", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByLabel("Session source", { exact: true }),
    ).toHaveCount(0);
    expect(sourceRequests).toBe(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("keeps queued uploads and their progress with the original tab while switching tabs", async ({
    page,
    isMobile,
  }) => {
    const tabs = await createFileTransferTabs(page, "Upload");
    const files = [
      {
        name: "first.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("first upload\n"),
      },
      {
        name: "second.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("second upload\n"),
      },
    ];
    const releases: Array<() => void> = [];
    const pendingUploads = files.map(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    const uploadPaths: string[] = [];
    await page.route(
      `**/api/tabs/${tabs.source.id}/files/upload?*`,
      async (route) => {
        const index = uploadPaths.length;
        uploadPaths.push(
          new URL(route.request().url()).searchParams.get("relativePath")!,
        );
        const response = await route.fetch();
        await pendingUploads[index];
        await route.fulfill({ response });
      },
    );

    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      await page.locator(".file-upload-input").setInputFiles(files);
      await expect.poll(() => uploadPaths.length).toBe(1);
      await expect(
        page.getByRole("status", { name: "Upload progress" }),
      ).toContainText("Uploading 1/2");

      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.other.title })
        .click();
      await expect(
        page.getByRole("status", { name: "Upload progress" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Upload files", exact: true }),
      ).toBeEnabled();
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      await expect(
        page.getByRole("button", { name: "Upload files", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("status", { name: "Upload progress" }),
      ).toContainText("Uploading 1/2");

      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.other.title })
        .click();
      releases[0]!();
      await expect.poll(() => uploadPaths.length).toBe(2);
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      await expect(
        page.getByRole("status", { name: "Upload progress" }),
      ).toContainText("Uploading 2/2");
      await expect(
        page.getByRole("button", { name: "Upload files", exact: true }),
      ).toBeDisabled();

      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.other.title })
        .click();
      const completedUpload = page.waitForResponse(
        (response) =>
          new URL(response.url()).searchParams.get("relativePath") ===
          "second.txt",
      );
      releases[1]!();
      expect((await completedUpload).ok()).toBe(true);
      expect(uploadPaths).toEqual(files.map((file) => file.name));
      for (const file of files) {
        expect(
          await fs.readFile(path.join(tabs.source.cwd, file.name)),
        ).toEqual(file.buffer);
      }
      expect(await fs.readdir(tabs.other.cwd)).toEqual([]);

      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      await expect(
        page.getByRole("status", { name: "Upload progress" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Upload files", exact: true }),
      ).toBeEnabled();
      if (isMobile)
        await page
          .getByRole("button", { name: "File tree", exact: true })
          .press("Enter");
      for (const file of files) {
        await expect(
          page.locator(".file-list-entry").filter({ hasText: file.name }),
        ).toBeVisible();
      }
    } finally {
      releases.forEach((release) => release());
      await page.unrouteAll({ behavior: "wait" });
      for (const tab of [tabs.source, tabs.other]) {
        await page.request.delete(`${baseUrl}/api/tabs/${tab.id}`);
      }
    }
  });

  test("keeps a download busy across tab switches and saves it while another tab is active", async ({
    page,
    isMobile,
  }, testInfo) => {
    const tabs = await createFileTransferTabs(page, "Download");
    const filename = "download.bin";
    const contents = Buffer.from([0, 1, 127, 128, 254, 255]);
    await fs.writeFile(path.join(tabs.source.cwd, filename), contents);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let downloadRequests = 0;
    await page.route(
      `**/api/tabs/${tabs.source.id}/files/download`,
      async (route) => {
        downloadRequests += 1;
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
      },
    );

    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      await page
        .getByRole("button", {
          name: "Select files or folders to download",
          exact: true,
        })
        .click();
      if (isMobile)
        await page
          .getByRole("button", { name: "File tree", exact: true })
          .press("Enter");
      await page
        .getByRole("checkbox", { name: `Select ${filename} for download` })
        .check();
      await page
        .getByRole("button", {
          name: "Download 1 selected entries",
          exact: true,
        })
        .click();
      await expect.poll(() => downloadRequests).toBe(1);

      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.other.title })
        .click();
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      await expect(
        page.getByRole("status", { name: "Download progress" }),
      ).toContainText("Downloading files");
      await expect(
        page.getByRole("button", { name: "Upload files", exact: true }),
      ).toBeDisabled();
      const screenshot = await page.screenshot({
        path: testInfo.outputPath("background-download.png"),
      });
      await testInfo.attach("download continues after tab switch", {
        body: screenshot,
        contentType: "image/png",
      });

      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.other.title })
        .click();
      const downloaded = page.waitForEvent("download");
      release();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(filename);
      const savedPath = testInfo.outputPath(filename);
      await download.saveAs(savedPath);
      expect(await fs.readFile(savedPath)).toEqual(contents);
      expect(downloadRequests).toBe(1);
      await expect(page.locator(".tab-button.selected .tab-title")).toHaveText(
        tabs.other.title,
      );

      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      await page
        .getByRole("button", {
          name: "Select files or folders to download",
          exact: true,
        })
        .click();
      if (isMobile)
        await page
          .getByRole("button", { name: "File tree", exact: true })
          .press("Enter");
      await expect(
        page.getByRole("checkbox", { name: `Select ${filename} for download` }),
      ).toBeEnabled();
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      for (const tab of [tabs.source, tabs.other]) {
        await page.request.delete(`${baseUrl}/api/tabs/${tab.id}`);
      }
    }
  });

  test("keeps Local Web uploads and downloads running while another CloudX tab is active", async ({
    page,
  }, testInfo) => {
    const tabs = await createLocalWebTransferTabs(page);
    const files = [
      {
        name: "first.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("first embedded upload\n"),
      },
      {
        name: "second.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("second embedded upload\n"),
      },
    ];
    const filename = "embedded-download.bin";
    const contents = Buffer.from([0, 1, 127, 128, 254, 255]);
    const uploads: Array<{ name: string; bytes: Buffer | null }> = [];
    const failures: string[] = [];
    const releases: Array<() => void> = [];
    const held = Array.from(
      { length: 3 },
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    const proxyPath = `/api/local-web/${tabs.source.id}/proxy/`;
    let frameLoads = 0;
    let downloadRequests = 0;
    let savedDownloads = 0;
    page.on("download", () => (savedDownloads += 1));
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname.startsWith(proxyPath)) {
        failures.push(
          `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
        );
      }
    });
    await page.route(`**${proxyPath}**`, async (route) => {
      const url = new URL(route.request().url());
      const headers = { "access-control-allow-origin": "*" };
      if (url.pathname === `${proxyPath}transfers`) {
        frameLoads += 1;
        await route.fulfill({
          contentType: "text/html",
          body: localWebTransferPage(filename),
        });
      } else if (url.pathname === `${proxyPath}upload`) {
        const index = uploads.length;
        uploads.push({
          name: url.searchParams.get("filename")!,
          bytes: route.request().postDataBuffer(),
        });
        await held[index];
        await route.fulfill({
          headers,
          contentType: "text/plain",
          body: "uploaded",
        });
      } else if (url.pathname === `${proxyPath}download`) {
        downloadRequests += 1;
        await held[2];
        await route.fulfill({
          headers,
          contentType: "application/octet-stream",
          body: contents,
        });
      } else {
        throw new Error(`Unexpected Local Web fixture request: ${url}`);
      }
    });

    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".tab-button.selected .tab-title")).toHaveText(
        tabs.other.title,
      );
      expect(frameLoads).toBe(0);
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      const iframe = page.locator(".web-viewer-frame");
      await expect(iframe).toBeVisible();
      const frame = await (await iframe.elementHandle())!.contentFrame();
      if (!frame)
        throw new Error("The Local Web transfer fixture did not load.");
      await frame.locator('input[type="file"]').setInputFiles(files);
      await frame.getByRole("button", { name: "Download" }).click();
      await expect
        .poll(() => ({ uploads: uploads.length, downloads: downloadRequests }))
        .toEqual({ uploads: 1, downloads: 1 });
      const originalDocument = await frame.evaluateHandle(() => document);

      const localTabTitles = page
        .locator(".tab-title")
        .filter({ hasText: "Local Web transfer" });
      await expect(localTabTitles).toHaveText([
        tabs.source.title,
        tabs.other.title,
      ]);
      await page
        .locator(".tab-button")
        .filter({ hasText: tabs.other.title })
        .dragTo(
          page.locator(".tab-button").filter({ hasText: tabs.source.title }),
        );
      await expect(localTabTitles).toHaveText([
        tabs.other.title,
        tabs.source.title,
      ]);
      expect(
        await frame.evaluate(
          (original) => original === document,
          originalDocument,
        ),
      ).toBe(true);
      expect(frameLoads).toBe(1);

      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.other.title })
        .click();
      releases[0]!();
      await expect
        .poll(() => ({ uploads: uploads.length, failures }))
        .toEqual({ uploads: 2, failures: [] });
      await expect(iframe).toBeHidden();
      expect(frame.isDetached()).toBe(false);
      const downloaded = page.waitForEvent("download");
      releases[1]!();
      releases[2]!();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(filename);
      const savedPath = testInfo.outputPath(filename);
      await download.saveAs(savedPath);
      expect(await fs.readFile(savedPath)).toEqual(contents);
      await expect(frame.locator("#uploaded")).toHaveText("2");
      await expect(frame.locator("#downloaded")).toHaveText("1");
      expect(uploads).toEqual(
        files.map((file) => ({ name: file.name, bytes: file.buffer })),
      );
      expect(savedDownloads).toBe(1);
      expect(downloadRequests).toBe(1);
      expect(failures).toEqual([]);
      await expect(page.locator(".tab-button.selected .tab-title")).toHaveText(
        tabs.other.title,
      );

      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      await expect(iframe).toBeVisible();
      expect(await (await iframe.elementHandle())!.contentFrame()).toBe(frame);
      await expect(frame.locator("#uploaded")).toHaveText("2");
      await expect(frame.locator("#downloaded")).toHaveText("1");
      expect(frameLoads).toBe(1);
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.other.title })
        .click();
      await page
        .getByRole("button", {
          name: `Close ${tabs.source.title}`,
          exact: true,
        })
        .click();
      await expect(iframe).toHaveCount(0);
      expect(frame.isDetached()).toBe(true);
    } finally {
      releases.forEach((release) => release());
      await page.unrouteAll({ behavior: "wait" });
      for (const tab of [tabs.source, tabs.other]) {
        await page.request.delete(`${baseUrl}/api/tabs/${tab.id}`);
      }
    }
  });

  test("retains Local Web transfer failures received while its tab is hidden", async ({
    page,
  }) => {
    const tabs = await createLocalWebTransferTabs(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: string[] = [];
    let frameLoads = 0;
    let savedDownloads = 0;
    page.on("download", () => (savedDownloads += 1));
    await page.route(
      `**/api/local-web/${tabs.source.id}/proxy/**`,
      async (route) => {
        const endpoint = new URL(route.request().url()).pathname
          .split("/")
          .pop()!;
        if (endpoint === "transfers") {
          frameLoads += 1;
          await route.fulfill({
            contentType: "text/html",
            body: localWebTransferPage("failed.bin"),
          });
        } else {
          requests.push(endpoint);
          await held;
          await route.fulfill({
            status: 503,
            headers: { "access-control-allow-origin": "*" },
            contentType: "text/plain",
            body: "Transfer service unavailable",
          });
        }
      },
    );
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      const iframe = page.locator(".web-viewer-frame");
      const frame = page.frameLocator(".web-viewer-frame");
      await frame.locator('input[type="file"]').setInputFiles([
        {
          name: "first.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("first"),
        },
        {
          name: "second.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("second"),
        },
      ]);
      await frame.getByRole("button", { name: "Download" }).click();
      await expect.poll(() => requests.length).toBe(2);
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.other.title })
        .click();
      release();
      await expect(frame.locator("#upload-error")).toHaveText(
        "Upload failed: 503",
      );
      await expect(frame.locator("#download-error")).toHaveText(
        "Download failed: 503",
      );
      await expect(iframe).toBeHidden();
      await page
        .locator(".tab-activation")
        .filter({ hasText: tabs.source.title })
        .click();
      await expect(frame.locator("#upload-error")).toHaveText(
        "Upload failed: 503",
      );
      await expect(frame.locator("#download-error")).toHaveText(
        "Download failed: 503",
      );
      await expect(frame.locator("#uploaded")).toHaveText("0");
      await expect(frame.locator("#downloaded")).toHaveText("0");
      expect(requests.sort()).toEqual(["download", "upload"]);
      expect(savedDownloads).toBe(0);
      expect(frameLoads).toBe(1);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      for (const tab of [tabs.source, tabs.other]) {
        await page.request.delete(`${baseUrl}/api/tabs/${tab.id}`);
      }
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
});

async function createFileTransferTabs(page: Page, title: string) {
  const workspace = (await (
    await page.request.get(`${baseUrl}/api/workspace`)
  ).json()) as WorkspaceStateResponse;
  const window = workspace.windows.find(
    (candidate) => candidate.id === workspace.activeWindowId,
  )!;
  const tabs: CreateTabResponse["tab"][] = [];
  for (const role of ["source", "other"]) {
    const cwd = path.join(
      testRoot,
      "workspace",
      `${title.toLowerCase()}-${role}`,
    );
    await fs.mkdir(cwd);
    const response = await page.request.post(`${baseUrl}/api/tabs`, {
      data: {
        pluginId: "file-browser",
        title: `${title} ${role}`,
        cwd,
        windowId: window.id,
        paneId: window.layout.activePaneId,
      },
    });
    expect(response.status()).toBe(201);
    tabs.push(((await response.json()) as CreateTabResponse).tab);
  }
  return { source: tabs[0]!, other: tabs[1]! };
}

async function createLocalWebTransferTabs(page: Page) {
  const workspace = (await (
    await page.request.get(`${baseUrl}/api/workspace`)
  ).json()) as WorkspaceStateResponse;
  const window = workspace.windows.find(
    (candidate) => candidate.id === workspace.activeWindowId,
  )!;
  const tabs: CreateTabResponse["tab"][] = [];
  for (const role of ["source", "other"]) {
    const response = await page.request.post(`${baseUrl}/api/tabs`, {
      data: {
        pluginId: "local-web",
        title: `Local Web transfer ${role}`,
        windowId: window.id,
        paneId: window.layout.activePaneId,
        ...(role === "source"
          ? { initialInput: { url: "http://127.0.0.1:9/transfers" } }
          : {}),
      },
    });
    expect(response.status()).toBe(201);
    tabs.push(((await response.json()) as CreateTabResponse).tab);
  }
  return { source: tabs[0]!, other: tabs[1]! };
}

function localWebTransferPage(filename: string): string {
  return `<!doctype html><html><body>
    <input type="file" multiple>
    <button>Download</button>
    <output id="uploaded">0</output><output id="downloaded">0</output>
    <output id="upload-error"></output><output id="download-error"></output>
    <script>
      document.querySelector('input').onchange = async (event) => {
        try {
          for (const file of event.target.files) {
            await new Promise((resolve, reject) => {
              const request = new XMLHttpRequest();
              request.open('POST', 'upload?filename=' + encodeURIComponent(file.name));
              request.onload = () => request.status === 200 ? resolve() : reject(new Error('Upload failed: ' + request.status));
              request.onerror = () => reject(new Error('Upload request failed'));
              request.send(file);
            });
            document.querySelector('#uploaded').textContent = Number(document.querySelector('#uploaded').textContent) + 1;
          }
        } catch (error) {
          document.querySelector('#upload-error').textContent = error.message;
        }
      };
      document.querySelector('button').onclick = async () => {
        try {
          const response = await fetch('download');
          if (!response.ok) throw new Error('Download failed: ' + response.status);
          const url = URL.createObjectURL(await response.blob());
          const link = document.createElement('a');
          link.href = url;
          link.download = ${JSON.stringify(filename)};
          document.body.append(link);
          link.click();
          link.remove();
          document.querySelector('#downloaded').textContent = Number(document.querySelector('#downloaded').textContent) + 1;
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
          document.querySelector('#download-error').textContent = error.message;
        }
      };
    </script>
  </body></html>`;
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
      "const identity = { pid: process.pid, start: Date.now(), args: process.argv.slice(2), sourceId: binding.sourceId, sqliteHome: process.env.CODEX_SQLITE_HOME, marker: sourceMarker };",
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

import {
  expect,
  test,
  type Page,
  type TestInfo,
  type WebSocketRoute,
} from "@playwright/test";
import type {
  CloudxConfigResponse,
  CloudxLogsResponse,
  CloudxUpdatePreview,
  CloudxUpdateStatus,
  TabLayoutState,
  WorkspaceStateResponse,
} from "@cloudx/shared";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let testRoot: string;
let baseUrl: string;
let server: ChildProcess;
let serverLogs = "";
const mainUpdatePreview: CloudxUpdatePreview = {
  channel: "main",
  currentCommit: "a".repeat(40),
  checkedAt: "2026-09-15T04:00:00.000Z",
  state: "available",
  target: {
    commit: "b".repeat(40),
    name: "main",
    url: "https://github.com/davidomil/cloudx/commit/" + "b".repeat(40),
  },
  changelog: [
    {
      number: 82,
      title: "Choose a release channel and preview merged pull requests",
      url: "https://github.com/davidomil/cloudx/pull/82",
    },
  ],
  changelogComplete: true,
  compareUrl:
    "https://github.com/davidomil/cloudx/compare/" +
    "a".repeat(40) +
    "..." +
    "b".repeat(40),
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/system/update/preview", (route) =>
    route.fulfill({ json: mainUpdatePreview }),
  );
  serverLogs = "";
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-settings-"));
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

test("Settings uses the available space and finds controls across keyboard-accessible tabs", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const settings = await openSettings(page, isMobile);
  const search = settings.getByRole("searchbox", { name: "Search settings" });
  const general = settings.getByRole("tab", { name: "General", exact: true });
  const browser = settings.getByRole("tab", { name: "Browser", exact: true });
  const tabs = settings.getByRole("tab");
  await expect(general).toHaveAttribute("aria-selected", "true");
  await expect(search).toBeFocused();
  await expect(settings.getByRole("tabpanel")).toHaveCount(1);
  await expectSettingsFits(page, isMobile);
  const bounds = await settings.boundingBox();
  expect(bounds!.width).toBeGreaterThan(isMobile ? 350 : 900);
  await captureSample(page, testInfo, "settings");

  await general.focus();
  await general.press(isMobile ? "ArrowRight" : "ArrowDown");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await tabs.nth(1).press("End");
  await expect(tabs.last()).toBeFocused();
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
  await tabs.last().press("Home");
  await expect(general).toBeFocused();
  await expect(general).toHaveAttribute("aria-selected", "true");

  await settings
    .getByRole("tab", { name: "Forge Workers", exact: true })
    .click();
  const workerLimit = settings.getByRole("spinbutton", {
    name: "Worker time limit (minutes)",
  });
  await workerLimit.scrollIntoViewIfNeeded();
  await expect(workerLimit).toBeInViewport({ ratio: 1 });
  await expectSettingsFits(page, isMobile);

  await search.fill("git refresh");
  await expect(
    settings.getByRole("tab", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(general).toHaveText(/General\s*0/);
  await expect(
    settings.getByRole("spinbutton", { name: "Git refresh frequency" }),
  ).toBeVisible();
  await expect(
    settings.getByRole("spinbutton", { name: "UI scale" }),
  ).toHaveCount(0);
  await expectSettingsFits(page, isMobile);

  await search.fill("model");
  await settings
    .getByRole("tab", { name: "Documentation", exact: true })
    .click();
  await expect(
    settings.getByRole("combobox", { name: "Image analysis model" }),
  ).toBeVisible();
  await expectSettingsFits(page, isMobile);
  await captureSample(page, testInfo, "settings-search");
  await general.click();
  await expect(
    settings.getByRole("combobox", { name: "Voice model" }),
  ).toBeVisible();
  await expect(
    settings.getByRole("combobox", { name: "Theme", exact: true }),
  ).toHaveCount(0);

  await search.fill("notification");
  await expect(browser).toHaveAttribute("aria-selected", "true");
  await expect(browser).toBeInViewport({ ratio: 0.99 });
  await expect(
    settings.getByRole("button", { name: "Request permission" }),
  ).toBeVisible();
  await search.fill("there-is-no-such-setting");
  await expect(settings.getByRole("tabpanel")).toContainText(
    "No matching settings",
  );
  await settings
    .getByRole("button", { name: "Show all settings", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await general.click();
  await expect(
    settings.getByRole("spinbutton", { name: "UI scale" }),
  ).toBeVisible();
  await expectSettingsFits(page, isMobile);

  await search.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: isMobile ? "Workspace actions" : "Settings",
      exact: true,
    }),
  ).toBeFocused();
});

test("drafts survive tab switches and search, Save persists them, and Cancel discards later edits", async ({
  page,
  isMobile,
}) => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const settings = await openSettings(page, isMobile);
  const search = settings.getByRole("searchbox", { name: "Search settings" });
  await settings.getByRole("spinbutton", { name: "UI scale" }).fill("150");
  await settings.getByRole("tab", { name: "Files", exact: true }).click();
  await settings
    .getByRole("spinbutton", { name: "Git refresh frequency" })
    .fill("30");
  await search.fill("theme");
  await expect(
    settings.getByRole("tab", { name: "General", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await search.fill("");
  await expect(
    settings.getByRole("spinbutton", { name: "UI scale" }),
  ).toHaveValue("150");
  await settings.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    settings.getByRole("spinbutton", { name: "Git refresh frequency" }),
  ).toHaveValue("30");
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/config" &&
      response.request().method() === "PATCH",
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(settings).toHaveCount(0);
  const persisted = (await (
    await page.request.get(`${baseUrl}/api/config`)
  ).json()) as CloudxConfigResponse;
  expect(persisted.values.global.uiScale).toBe(150);
  expect(persisted.values.plugins["file-browser"]?.gitAutoRefreshSeconds).toBe(
    30,
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await openSettings(page, isMobile);
  await expectSettingsFits(page, isMobile);
  await expect(
    settings.getByRole("spinbutton", { name: "UI scale" }),
  ).toHaveValue("150");
  await settings.getByRole("spinbutton", { name: "UI scale" }).fill("135");
  await settings.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    settings.getByRole("spinbutton", { name: "Git refresh frequency" }),
  ).toHaveValue("30");
  await settings
    .getByRole("spinbutton", { name: "Git refresh frequency" })
    .fill("45");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await openSettings(page, isMobile);
  await expect(
    settings.getByRole("spinbutton", { name: "UI scale" }),
  ).toHaveValue("150");
  await settings.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    settings.getByRole("spinbutton", { name: "Git refresh frequency" }),
  ).toHaveValue("30");
});

test("Settings Logs shows the current server's recorded startup diagnostic", async ({
  page,
  isMobile,
}) => {
  const response = await page.request.get(`${baseUrl}/api/logs`);
  expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const snapshot = (await response.json()) as CloudxLogsResponse;
  expect(snapshot).toMatchObject({
    source: "current",
    truncated: false,
  });
  expect(snapshot.content).toContain(
    "Documentation background enrichment failed.",
  );

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const settings = await openSettings(page, isMobile);
  await settings.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(
    settings.getByRole("combobox", { name: "Log source" }),
  ).toHaveValue("current");
  await expect(
    settings.locator('pre[aria-label="Log contents"]'),
  ).toContainText("Documentation background enrichment failed.");
  await expectSettingsFits(page, isMobile);
});

test("Settings Logs searches, refreshes a selected source, and downloads the displayed synthetic snapshot as text", async ({
  page,
  isMobile,
}, testInfo) => {
  const capturedAt = "2026-09-15T12:34:56.000Z";
  const refreshedContent = [
    '<img src="invalid" onerror="document.body.dataset.logMarkupExecuted = true">',
    "Unicode diagnostic: 日本語",
    "long diagnostic line ".repeat(100),
    ...Array.from(
      { length: 60 },
      (_, index) => `Diagnostic entry ${index + 1}`,
    ),
    "",
  ].join("\n");
  const requestedSources: string[] = [];
  let serviceReads = 0;
  await page.route("**/api/logs?*", async (route) => {
    const source = new URL(route.request().url()).searchParams.get("source");
    expect(source === "current" || source === "services").toBe(true);
    requestedSources.push(source!);
    const snapshot: CloudxLogsResponse = {
      source: source as "current" | "services",
      content:
        source === "current"
          ? ""
          : ++serviceReads === 1
            ? "Initial installed service fixture snapshot.\n"
            : refreshedContent,
      capturedAt,
      truncated: source === "services" && serviceReads > 1,
    };
    await route.fulfill({ json: snapshot });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const settings = await openSettings(page, isMobile);
  await settings
    .getByRole("searchbox", { name: "Search settings" })
    .fill("logs");
  await expect(
    settings.getByRole("tab", { name: "Logs", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const viewer = settings.getByRole("region", { name: "Log viewer" });
  const contents = settings.locator('pre[aria-label="Log contents"]');
  await expect(viewer.getByRole("status")).toHaveText(
    "No logs available for this source.",
  );
  await expect(
    settings.getByRole("button", { name: "Download logs", exact: true }),
  ).toBeDisabled();

  const source = settings.getByRole("combobox", { name: "Log source" });
  await source.selectOption({ label: "All installed services" });
  await expect(contents).toHaveText(
    "Initial installed service fixture snapshot.\n",
  );
  await settings
    .getByRole("button", { name: "Refresh logs", exact: true })
    .click();
  await expect(contents).toHaveText(refreshedContent);
  expect(await contents.textContent()).toBe(refreshedContent);
  await expect(contents.locator("img")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-log-markup-executed",
  );
  await expect(viewer.getByRole("status")).toHaveText(
    "Some entries were omitted to keep this snapshot within the log limits.",
  );
  await expect(source).toHaveValue("services");
  await expectSettingsFits(page, isMobile);
  for (const name of ["Refresh logs", "Download logs"]) {
    const action = settings.getByRole("button", { name, exact: true });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport({ ratio: 1 });
    await action.click({ trial: true });
  }
  await captureSample(page, testInfo, "settings-logs-synthetic");

  const downloading = page.waitForEvent("download");
  await settings
    .getByRole("button", { name: "Download logs", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(
    "cloudx-services-2026-09-15T12-34-56-000Z.log",
  );
  const savedPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(savedPath);
  expect(await fs.readFile(savedPath, "utf8")).toBe(refreshedContent);
  expect(requestedSources).toEqual(["current", "services", "services"]);
});

test("Codex Settings saves shared defaults, keeps them after reload, and can restore model defaults", async ({
  page,
  isMobile,
}, testInfo) => {
  const configPath = path.join(testRoot, "codex-home", "config.toml");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const settings = await openCodexSettings(page, isMobile);
  const model = settings.getByRole("textbox", { name: "Default model" });
  const fastMode = settings.getByRole("combobox", { name: "Fast mode" });
  const save = settings.getByRole("button", {
    name: "Save Codex settings",
    exact: true,
  });
  await expect(model).toHaveValue("");
  await expect(fastMode).toHaveValue("");
  await expect(save).toBeDisabled();

  await model.fill("browser-fixture-model");
  await fastMode.selectOption({ label: "On" });
  await expectCodexSettingsFits(page);
  await save.click();
  await expect(settings.getByRole("status")).toHaveText(
    "Global Codex settings saved.",
  );
  expect(parse(await fs.readFile(configPath, "utf8"))).toEqual({
    model: "browser-fixture-model",
    service_tier: "priority",
    features: { fast_mode: true },
  });
  await captureSample(page, testInfo, "codex-settings-saved");

  await page.reload({ waitUntil: "domcontentloaded" });
  await openCodexSettings(page, isMobile);
  await expect(model).toHaveValue("browser-fixture-model");
  await expect(fastMode).toHaveValue("priority");
  await expect(save).toBeDisabled();
  await model.fill("");
  await fastMode.selectOption({ label: "Model default" });
  await save.click();
  await expect(settings.getByRole("status")).toHaveText(
    "Global Codex settings saved.",
  );
  expect(parse(await fs.readFile(configPath, "utf8"))).toEqual({
    features: { fast_mode: true },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await openCodexSettings(page, isMobile);
  await expect(model).toHaveValue("");
  await expect(fastMode).toHaveValue("");
});

test("Codex settings opens inside Settings without creating a workspace tab and is absent from New tab", async ({
  page,
  isMobile,
}) => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const before = await page.request.get(`${baseUrl}/api/workspace`);
  expect(before.ok()).toBe(true);
  const original = (await before.json()) as WorkspaceStateResponse;
  const tabCreations: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/tabs"
    ) {
      tabCreations.push(request.url());
    }
  });

  const settings = await openCodexSettings(page, isMobile);
  await expect(
    settings.getByRole("textbox", { name: "Default model" }),
  ).toHaveValue("");
  await expect(
    settings.getByRole("button", { name: "Save Codex settings", exact: true }),
  ).toBeDisabled();
  const after = await page.request.get(`${baseUrl}/api/workspace`);
  expect(after.ok()).toBe(true);
  expect(((await after.json()) as WorkspaceStateResponse).tabs).toEqual(
    original.tabs,
  );
  expect(tabCreations).toEqual([]);

  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page
    .locator(".workspace-pane.active")
    .getByTitle("Add tab to this pane")
    .click();
  await expect(
    page.getByRole("heading", { name: "New tab", exact: true }),
  ).toBeVisible();
  const plugins = page.getByRole("combobox", { name: "Plugin", exact: true });
  await expect(plugins).toBeEnabled();
  await expect(plugins.locator('option[value="codex-settings"]')).toHaveCount(
    0,
  );
  await expect(plugins).not.toContainText("Codex Settings");
});

const settingsNavigations = ["category switches", "search filtering"] as const;

for (const navigation of settingsNavigations) {
  test(`Codex Settings keeps drafts across ${navigation} and discards them when Settings closes`, async ({
    page,
    isMobile,
  }) => {
    const configPath = path.join(testRoot, "codex-home", "config.toml");
    await fs.writeFile(
      configPath,
      'model = "initial-model"\nservice_tier = "priority"\n',
    );
    const initialRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/hooks/codex-settings.read",
    );
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const settings = await openCodexSettings(page, isMobile);
    const initialRevision = (await (await initialRead).json()).result.settings
      .revision;
    const model = settings.getByRole("textbox", { name: "Default model" });
    const fastMode = settings.getByRole("combobox", { name: "Fast mode" });
    const save = settings.getByRole("button", {
      name: "Save Codex settings",
      exact: true,
    });
    await model.fill("unsaved-draft-model");
    await fastMode.selectOption({ label: "Off" });

    await navigateCodexSettings(page, navigation);
    await expect(model).toHaveValue("unsaved-draft-model");
    await expect(fastMode).toHaveValue("default");
    await expect(save).toBeEnabled();
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/hooks/codex-settings.update",
    );
    await save.click();
    const savedResponse = await saved;
    expect(savedResponse.ok()).toBe(true);
    expect(savedResponse.request().postDataJSON().input).toEqual({
      expectedRevision: initialRevision,
      model: "unsaved-draft-model",
      serviceTier: "default",
    });
    await expect(settings.getByRole("status")).toHaveText(
      "Global Codex settings saved.",
    );
    expect(parse(await fs.readFile(configPath, "utf8"))).toEqual({
      model: "unsaved-draft-model",
      service_tier: "default",
      features: { fast_mode: true },
    });

    await model.fill("discarded-draft-model");
    await fastMode.selectOption({ label: "Flex" });
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect(page.locator(".codex-settings-panel")).toHaveCount(0);
    await openCodexSettings(page, isMobile);
    await expect(model).toHaveValue("unsaved-draft-model");
    await expect(fastMode).toHaveValue("default");
    await expect(save).toBeDisabled();
  });

  test(`Codex Settings keeps a rejected stale draft and its revision across ${navigation} until Reload`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const configPath = path.join(testRoot, "codex-home", "config.toml");
    const unrelatedSettings =
      '# Keep this profile unchanged.\n[profiles.review]\nmodel = "profile-model"\n';
    await fs.writeFile(
      configPath,
      `model = "initial-model"\nservice_tier = "default"\n${unrelatedSettings}`,
    );
    const initialRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/hooks/codex-settings.read",
    );
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const settings = await openCodexSettings(page, isMobile);
    const initialRevision = (await (await initialRead).json()).result.settings
      .revision;
    const model = settings.getByRole("textbox", { name: "Default model" });
    const fastMode = settings.getByRole("combobox", { name: "Fast mode" });
    const save = settings.getByRole("button", {
      name: "Save Codex settings",
      exact: true,
    });
    await expect(model).toHaveValue("initial-model");
    await expect(fastMode).toHaveValue("default");
    await model.fill("unsaved-draft-model");
    await fastMode.selectOption({ label: "On" });

    const externalConfig = `model = "external-model"\nservice_tier = "flex"\n${unrelatedSettings}`;
    await fs.writeFile(configPath, externalConfig);
    const firstSave = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/hooks/codex-settings.update",
    );
    await save.click();
    const firstRejectedSave = await firstSave;
    expect(firstRejectedSave.ok()).toBe(false);
    expect(firstRejectedSave.request().postDataJSON().input).toEqual({
      expectedRevision: initialRevision,
      model: "unsaved-draft-model",
      serviceTier: "priority",
    });
    await expect(settings.getByRole("alert")).toHaveText(
      "Shared Codex settings changed. Reload before saving again.",
    );
    await expect(model).toHaveValue("unsaved-draft-model");
    await expect(fastMode).toHaveValue("priority");
    await expect(save).toBeEnabled();
    expect(await fs.readFile(configPath, "utf8")).toBe(externalConfig);
    await expectCodexSettingsFits(page);
    await settings.getByRole("alert").scrollIntoViewIfNeeded();
    await captureSample(page, testInfo, "codex-settings-stale-draft");

    await navigateCodexSettings(page, navigation);
    await expect(model).toHaveValue("unsaved-draft-model");
    await expect(fastMode).toHaveValue("priority");
    await expect(settings.getByRole("alert")).toHaveText(
      "Shared Codex settings changed. Reload before saving again.",
    );
    const secondSave = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/hooks/codex-settings.update",
    );
    await save.click();
    const secondRejectedSave = await secondSave;
    expect(secondRejectedSave.ok()).toBe(false);
    expect(secondRejectedSave.request().postDataJSON().input).toEqual(
      firstRejectedSave.request().postDataJSON().input,
    );
    await expect(settings.getByRole("alert")).toHaveText(
      "Shared Codex settings changed. Reload before saving again.",
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(externalConfig);

    await settings.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(model).toHaveValue("external-model");
    await expect(fastMode).toHaveValue("flex");
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await expect(save).toBeDisabled();
    await fastMode.selectOption({ label: "Off" });
    await save.click();
    await expect(settings.getByRole("status")).toHaveText(
      "Global Codex settings saved.",
    );
    const savedConfig = await fs.readFile(configPath, "utf8");
    expect(parse(savedConfig)).toEqual({
      model: "external-model",
      service_tier: "default",
      features: { fast_mode: true },
      profiles: { review: { model: "profile-model" } },
    });
    expect(savedConfig).toContain(unrelatedSettings);
  });
}

for (const serviceTier of ["priority", "default", "flex"]) {
  test(`Codex Settings enables disabled fast mode support with the saved ${serviceTier} tier unchanged`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const configPath = path.join(testRoot, "codex-home", "config.toml");
    const initialConfig = `model = "initial-model"\nservice_tier = "${serviceTier}"\n[features]\nfast_mode = false\n`;
    await fs.writeFile(configPath, initialConfig);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const settings = await openCodexSettings(page, isMobile);
    const fastMode = settings.getByRole("combobox", { name: "Fast mode" });
    const save = settings.getByRole("button", {
      name: "Save Codex settings",
      exact: true,
    });
    const enable = settings.getByRole("button", {
      name: "Enable fast mode support",
      exact: true,
    });
    await expect(fastMode).toHaveValue(serviceTier);
    await expect(save).toBeDisabled();
    await expect(enable).toBeVisible();
    await enable.scrollIntoViewIfNeeded();
    await captureSample(page, testInfo, "codex-settings-disabled-support");

    await enable.click();
    await expect(fastMode).toHaveValue(serviceTier);
    await expect(save).toBeEnabled();
    expect(await fs.readFile(configPath, "utf8")).toBe(initialConfig);
    await save.click();
    await expect(settings.getByRole("status")).toHaveText(
      "Global Codex settings saved.",
    );
    await expect(fastMode).toHaveValue(serviceTier);
    await expect(save).toBeDisabled();
    await expect(
      settings.getByRole("button", {
        name: "Enable fast mode support",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(parse(await fs.readFile(configPath, "utf8"))).toEqual({
      model: "initial-model",
      service_tier: serviceTier,
      features: { fast_mode: true },
    });
  });
}

for (const viewport of [
  { width: 667, height: 375 },
  { width: 1024, height: 375 },
  { width: 320, height: 521 },
  { width: 320, height: 640 },
]) {
  test(`searched settings remain editable at ${viewport.width} × ${viewport.height} and 150% UI scale`, async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const settings = await openSettings(page, isMobile);
    const scale = settings.getByRole("spinbutton", { name: "UI scale" });
    const search = settings.getByRole("searchbox", { name: "Search settings" });
    const save = settings.getByRole("button", { name: "Save", exact: true });
    const cancel = settings.getByRole("button", {
      name: "Cancel",
      exact: true,
    });

    await scale.fill("150");
    await save.click();
    await expect(settings).toHaveCount(0);
    await expect(page.locator("html")).toHaveCSS("font-size", "24px");

    await page.setViewportSize(viewport);
    await openSettings(page, viewport.width <= 700);
    await search.fill("UI scale");
    await expect(scale).toHaveValue("150");
    await search.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(scale).toBeFocused();
    await expect(scale).toBeInViewport({ ratio: 1 });
    await scale.click({ timeout: 5_000 });
    await expect(scale).toBeFocused();
    await expect(scale).toBeInViewport({ ratio: 1 });
    await expectSettingsActionsReachable(page);
    const scaleBounds = await scale.boundingBox();
    expect(scaleBounds!.y + scaleBounds!.height).toBeLessThanOrEqual(
      (await settings.locator(".settings-footer").boundingBox())!.y,
    );
    await captureSample(page, testInfo, "settings-landscape");
    await scale.fill("135");
    await save.click();
    await expect(settings).toHaveCount(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await openSettings(page, viewport.width <= 700);
    await search.fill("UI scale");
    await expect(scale).toHaveValue("135");
    await scale.click();
    await scale.fill("125");
    await expectSettingsActionsReachable(page);
    await cancel.click();
    await expect(settings).toHaveCount(0);

    await openSettings(page, viewport.width <= 700);
    await search.fill("UI scale");
    await expect(scale).toHaveValue("135");
    await scale.click();
  });
}

async function openCodexSettings(page: Page, isMobile: boolean) {
  const dialog = await openSettings(page, isMobile);
  await dialog.getByRole("tab", { name: "Codex", exact: true }).click();
  const settings = dialog.getByRole("region", {
    name: "Global Codex settings",
    exact: true,
  });
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute("aria-busy", "false");
  return settings;
}

async function navigateCodexSettings(
  page: Page,
  navigation: (typeof settingsNavigations)[number],
) {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const panel = dialog.getByRole("region", {
    name: "Global Codex settings",
    exact: true,
  });
  if (navigation === "category switches") {
    await dialog.getByRole("tab", { name: "General", exact: true }).click();
    await expect(panel).toBeHidden();
    await dialog.getByRole("tab", { name: "Codex", exact: true }).click();
  } else {
    const search = dialog.getByRole("searchbox", { name: "Search settings" });
    await search.fill("No matching Codex setting");
    await expect(panel).toBeHidden();
    await dialog.getByRole("tab", { name: "General", exact: true }).click();
    await search.fill("Codex service tier");
    await expect(
      dialog.getByRole("tab", { name: "Codex", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }
  await expect(panel).toBeVisible();
}

async function expectCodexSettingsFits(page: Page) {
  const settings = page.getByRole("region", {
    name: "Global Codex settings",
    exact: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    await settings.evaluate(
      (panel) => panel.scrollWidth <= panel.clientWidth + 1,
    ),
  ).toBe(true);
  for (const control of [
    settings.getByRole("textbox", { name: "Default model" }),
    settings.getByRole("combobox", { name: "Fast mode" }),
    settings.getByRole("button", { name: "Save Codex settings", exact: true }),
    settings.getByRole("button", { name: "Reload", exact: true }),
  ]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
    await control.click({ trial: true });
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
}

test("Updates selects persisted release channels and shows availability and merged pull requests", async ({
  page,
  isMobile,
}, testInfo) => {
  let preview = mainUpdatePreview;
  let checks = 0;
  await page.route("**/api/system/update", (route) =>
    route.fulfill({ json: { available: true } }),
  );
  await page.route("**/api/system/update/preview", async (route) => {
    checks += 1;
    if (route.request().method() === "PUT") {
      expect(route.request().postDataJSON()).toEqual({ channel: "releases" });
      preview = {
        ...mainUpdatePreview,
        channel: "releases",
        changelogComplete: false,
        target: {
          ...mainUpdatePreview.target!,
          name: "v0.2.0",
          url: "https://github.com/davidomil/cloudx/releases/tag/v0.2.0",
        },
        message: "Some pull request details could not be loaded.",
      };
    }
    await route.fulfill({ json: preview });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  expect(checks).toBe(0);
  let settings = await openSettings(page, isMobile);
  await settings
    .getByRole("searchbox", { name: "Search settings" })
    .fill("release channel");
  await expect(
    settings.getByText("New changes are available on main.", { exact: true }),
  ).toBeVisible();
  const channel = settings.getByRole("combobox", { name: "Update channel" });
  await channel.scrollIntoViewIfNeeded();
  await expect(channel).toBeInViewport({ ratio: 1 });
  expect((await channel.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await channel.selectOption("releases");
  await expect(
    settings.getByText("A new release is available.", { exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("link", { name: "v0.2.0", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://github.com/davidomil/cloudx/releases/tag/v0.2.0",
  );
  const change = settings.getByRole("link", {
    name: "#82 Choose a release channel and preview merged pull requests",
    exact: true,
  });
  await change.scrollIntoViewIfNeeded();
  await expect(change).toBeVisible();
  await expect(change).toHaveAttribute(
    "href",
    "https://github.com/davidomil/cloudx/pull/82",
  );
  await expect(
    settings.getByText("Some pull request details could not be loaded.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    settings.getByRole("link", {
      name: "View all changes on GitHub",
      exact: true,
    }),
  ).toHaveAttribute("href", mainUpdatePreview.compareUrl!);
  await expectSettingsFits(page, isMobile);
  await captureSample(page, testInfo, "settings-update-release-preview");
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  settings = await openSettings(page, isMobile);
  await settings
    .getByRole("searchbox", { name: "Search settings" })
    .fill("Updates");
  await expect(
    settings.getByRole("combobox", { name: "Update channel" }),
  ).toHaveValue("releases");
  expect(checks).toBe(3);
  preview = {
    ...preview,
    state: "current",
    changelog: [],
    changelogComplete: true,
    message: undefined,
  };
  const check = settings.getByRole("button", {
    name: "Check update status",
    exact: true,
  });
  await check.click();
  await expect(
    settings.getByText(
      "CloudX is on the latest release. You can still update dependencies.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", {
      name: "Update CloudX and dependencies",
      exact: true,
    }),
  ).toBeEnabled();
  preview = {
    ...preview,
    state: "unavailable",
    target: undefined,
    message: "No published stable release is available.",
  };
  await check.click();
  await expect(
    settings.getByText("No published stable release is available.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", {
      name: "Update CloudX and dependencies",
      exact: true,
    }),
  ).toBeDisabled();
});

test("Updates reconnects after restart and reloads once with Settings closed", async ({
  page,
  isMobile,
}, testInfo) => {
  let status: CloudxUpdateStatus = { available: true };
  let disconnected = false;
  let starts = 0;
  await page.route("**/api/system/update", async (route) => {
    if (route.request().method() === "POST") {
      starts += 1;
      expect(route.request().postDataJSON()).toEqual({
        channel: "main",
        targetCommit: mainUpdatePreview.target!.commit,
      });
      status = {
        available: true,
        run: {
          id: "browser-update",
          state: "running",
          message: "Installing CloudX and dependencies.",
          startedAt: "2026-09-15T04:00:00.000Z",
        },
      };
      await route.fulfill({ status: 202, json: status });
    } else if (disconnected) await route.abort("connectionrefused");
    else await route.fulfill({ json: status });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const settings = await openSettings(page, isMobile);
  await settings
    .getByRole("searchbox", { name: "Search settings" })
    .fill("Codex dependencies");
  await expect(
    settings.getByRole("tab", { name: "Updates", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    settings.getByText(/persistent Codex and terminal tabs reconnect/),
  ).toBeVisible();
  await expectSettingsFits(page, isMobile);
  const update = settings.getByRole("button", {
    name: "Update CloudX and dependencies",
    exact: true,
  });
  await update.scrollIntoViewIfNeeded();
  await expect(update).toBeInViewport({ ratio: 1 });
  await update.click();
  await expect(
    settings.getByRole("button", { name: "Updating CloudX…", exact: true }),
  ).toBeDisabled();
  expect(starts).toBe(1);
  disconnected = true;
  await expect(settings.getByText(/Waiting for CloudX to return/)).toBeVisible({
    timeout: 8_000,
  });
  await captureSample(page, testInfo, "settings-update-reconnect");
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(settings).toHaveCount(0);
  let reloads = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reloads += 1;
  });
  status = {
    available: true,
    run: {
      ...status.run!,
      state: "succeeded",
      message: "CloudX update completed.",
    },
  };
  disconnected = false;
  await expect.poll(() => reloads, { timeout: 8_000 }).toBe(1);
  const reopened = await openSettings(page, isMobile);
  await reopened
    .getByRole("searchbox", { name: "Search settings" })
    .fill("Updates");
  await expect(
    reopened.getByText("CloudX update completed.", { exact: true }),
  ).toBeVisible();
  await reopened
    .getByRole("button", { name: "Check update status", exact: true })
    .click();
  await expect(
    reopened.getByRole("button", { name: "Check update status", exact: true }),
  ).toBeEnabled();
  expect(reloads).toBe(1);
  expect(starts).toBe(1);
});

for (const failure of ["HTTP failure", "degraded persistence"]) {
  test(`Updates preserves a debounced layout after ${failure} with Settings closed`, async ({
    page,
    isMobile,
  }, testInfo) => {
    let status: CloudxUpdateStatus = { available: true };
    let starts = 0;
    let holdStatus = false;
    let heldStatusRequests = 0;
    let completeUpdate!: () => void;
    const completion = new Promise<void>((resolve) => {
      completeUpdate = resolve;
    });
    let allowSave = false;
    let saveAttempts = 0;
    let savedLayout: TabLayoutState | undefined;
    let workspaceSocket: WebSocketRoute | undefined;
    let degradedSnapshot: WorkspaceStateResponse | undefined;
    let staleSnapshot: WorkspaceStateResponse | undefined;
    const saveError =
      failure === "HTTP failure"
        ? "Layout save unavailable during update."
        : "Workspace layout could not be saved to disk: ENOSPC: Disk capacity exhausted";
    if (failure === "degraded persistence") {
      await page.routeWebSocket("**/ws/workspace", (socket) => {
        workspaceSocket = socket;
        socket.connectToServer();
      });
    }
    await page.clock.install();
    await page.route("**/api/system/update", async (route) => {
      if (route.request().method() === "POST") {
        starts += 1;
        status = {
          available: true,
          run: {
            id: "browser-layout-update",
            state: "running",
            message: "Installing CloudX and dependencies.",
            startedAt: new Date().toISOString(),
          },
        };
      } else if (holdStatus) {
        heldStatusRequests += 1;
        await completion;
      }
      await route.fulfill({ json: status });
    });
    await page.route("**/api/windows/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const layout = route.request().postDataJSON().layout as
        TabLayoutState | undefined;
      if (!layout) return route.continue();
      saveAttempts += 1;
      if (!allowSave) {
        if (failure === "degraded persistence") {
          staleSnapshot = (await (
            await page.request.get(`${baseUrl}/api/workspace`)
          ).json()) as WorkspaceStateResponse;
          const windowId = decodeURIComponent(
            new URL(route.request().url()).pathname.split("/").at(-1)!,
          );
          degradedSnapshot = {
            ...staleSnapshot,
            windows: staleSnapshot.windows.map((window) =>
              window.id === windowId ? { ...window, layout } : window,
            ),
            persistence: [
              {
                name: "Workspace layout",
                state: "degraded",
                path: "/workspace.json",
                code: "ENOSPC",
                message: "Disk capacity exhausted",
              },
            ],
          };
          await route.fulfill({ json: degradedSnapshot });
          return;
        }
        await route.fulfill({
          status: 503,
          json: { error: "Layout save unavailable during update." },
        });
      } else {
        savedLayout = layout;
        await route.continue();
      }
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const settings = await openSettings(page, isMobile);
    await settings
      .getByRole("searchbox", { name: "Search settings" })
      .fill("Updates");
    await settings
      .getByRole("button", {
        name: "Update CloudX and dependencies",
        exact: true,
      })
      .click();
    await expect(
      settings.getByRole("button", { name: "Updating CloudX…", exact: true }),
    ).toBeDisabled();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
    holdStatus = true;
    await settings
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect(settings).toHaveCount(0);
    await expect.poll(() => heldStatusRequests).toBeGreaterThan(0);
    let reloads = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) reloads += 1;
    });
    if (isMobile) {
      await page
        .getByRole("button", { name: "Workspace actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Split vertically", exact: true })
        .click();
    } else {
      await page
        .getByRole("button", { name: "Split columns", exact: true })
        .click();
    }
    await expect(page.locator(".workspace-pane")).toHaveCount(2);
    expect(saveAttempts).toBe(0);

    status = {
      available: true,
      run: {
        ...status.run!,
        state: "succeeded",
        message: "CloudX update completed.",
      },
    };
    holdStatus = false;
    completeUpdate();
    await expect(page.locator(".error-banner")).toHaveText(saveError);
    if (failure === "degraded persistence") {
      expect(workspaceSocket).toBeDefined();
      workspaceSocket!.send(
        JSON.stringify({ type: "workspace", ...degradedSnapshot }),
      );
      await expect(page.locator(".persistence-status.degraded")).toBeVisible();
      workspaceSocket!.send(
        JSON.stringify({ type: "workspace", ...staleSnapshot }),
      );
      await expect(page.locator(".persistence-status.degraded")).toHaveCount(0);
      await expect(page.locator(".workspace-pane")).toHaveCount(2);
      await expect(page.locator(".error-banner")).toHaveText(saveError);
    }
    await expect(page.locator(".error-banner")).toBeVisible();
    expect(saveAttempts).toBe(1);
    expect(reloads).toBe(0);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("cloudx.update.reloadedRun"),
      ),
    ).toBeNull();
    await captureSample(page, testInfo, "settings-update-layout-save-failed");

    await page.clock.resume();
    const reopened = await openSettings(page, isMobile);
    await reopened
      .getByRole("searchbox", { name: "Search settings" })
      .fill("Updates");
    await expect(reopened.getByRole("alert")).toContainText(
      "your workspace could not be saved",
    );
    allowSave = true;
    await reopened
      .getByRole("button", { name: "Check update status", exact: true })
      .click();
    await expect.poll(() => reloads).toBe(1);
    await expect(page.locator(".workspace-pane")).toHaveCount(2);
    await expect(page.locator(".error-banner")).toHaveCount(0);
    expect(savedLayout?.root.type).toBe("split");
    const persisted = (await (
      await page.request.get(`${baseUrl}/api/workspace`)
    ).json()) as WorkspaceStateResponse;
    expect(
      persisted.windows.find((window) => window.id === persisted.activeWindowId)
        ?.layout,
    ).toEqual(savedLayout);
    const afterReload = await openSettings(page, isMobile);
    await afterReload
      .getByRole("searchbox", { name: "Search settings" })
      .fill("Updates");
    await afterReload
      .getByRole("button", { name: "Check update status", exact: true })
      .click();
    await expect(
      afterReload.getByRole("button", {
        name: "Check update status",
        exact: true,
      }),
    ).toBeEnabled();
    expect(reloads).toBe(1);
    expect(starts).toBe(1);
  });
}

test("Updates explains unsupported installations and displays installer failures", async ({
  page,
  isMobile,
}, testInfo) => {
  let status: CloudxUpdateStatus = {
    available: false,
    unavailableReason: "Updates require the installed CloudX system service.",
  };
  let starts = 0;
  await page.route("**/api/system/update", async (route) => {
    if (route.request().method() === "POST") {
      starts += 1;
      status = {
        available: true,
        run: {
          id: "failed-browser-update",
          state: "failed",
          message: "Installer failed: the checkout has local changes.",
          startedAt: "2026-09-15T04:00:00.000Z",
        },
      };
    }
    await route.fulfill({ json: status });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const settings = await openSettings(page, isMobile);
  await settings
    .getByRole("searchbox", { name: "Search settings" })
    .fill("Updates");
  await expect(
    settings.getByText("Updates require the installed CloudX system service.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", {
      name: "Update CloudX and dependencies",
      exact: true,
    }),
  ).toBeDisabled();
  expect(starts).toBe(0);
  status = { available: true };
  await settings
    .getByRole("button", { name: "Check update status", exact: true })
    .click();
  await settings
    .getByRole("button", {
      name: "Update CloudX and dependencies",
      exact: true,
    })
    .click();
  await expect(settings.getByRole("alert")).toHaveText(
    "Installer failed: the checkout has local changes.",
  );
  expect(starts).toBe(1);
  await expectSettingsFits(page, isMobile);
  await captureSample(page, testInfo, "settings-update-failed");
});

async function openSettings(page: Page, isMobile: boolean) {
  await expect(page.locator(".workspace-pane").first()).toBeVisible();
  if (isMobile) {
    await page
      .getByRole("button", { name: "Workspace actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  return settings;
}

async function expectSettingsFits(page: Page, isMobile: boolean) {
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    await settings.evaluate(
      (dialog) => dialog.scrollWidth <= dialog.clientWidth + 1,
    ),
  ).toBe(true);
  await expect(settings).toBeInViewport({ ratio: 1 });
  await expect(settings.getByRole("tab", { selected: true })).toBeInViewport({
    ratio: 0.99,
  });
  await expect(
    settings.getByRole("searchbox", { name: "Search settings" }),
  ).toBeInViewport({ ratio: 1 });
  for (const name of ["Cancel", "Save"]) {
    await expect(
      settings.getByRole("button", { name, exact: true }),
    ).toBeInViewport({ ratio: 1 });
  }
  await expect(settings.getByRole("tablist")).toHaveAttribute(
    "aria-orientation",
    isMobile ? "horizontal" : "vertical",
  );
}

async function expectSettingsActionsReachable(page: Page) {
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeInViewport({ ratio: 1 });
  for (const name of ["Cancel", "Save"]) {
    const action = settings.getByRole("button", { name, exact: true });
    await expect(action).toBeInViewport({ ratio: 1 });
    await action.click({ trial: true });
  }
}

async function captureSample(page: Page, testInfo: TestInfo, name: string) {
  const displayedValues = await page
    .locator("input, textarea")
    .evaluateAll((elements) =>
      elements.map((element) => (element as HTMLInputElement).value).join("\n"),
    );
  const content = `${await page.locator("body").innerText()}\n${displayedValues}`;
  for (const privateText of [os.homedir(), "/home/", "token="]) {
    expect(content).not.toContain(privateText);
  }
  await testInfo.attach(name, {
    body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
    contentType: "image/png",
  });
}

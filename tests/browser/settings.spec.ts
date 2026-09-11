import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type {
  CloudxConfigResponse,
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

test.beforeEach(async () => {
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

test("Codex Settings saves shared defaults, keeps them after reload, and can restore model defaults", async ({
  page,
}, testInfo) => {
  const configPath = path.join(testRoot, "codex-home", "config.toml");
  const settings = await openCodexSettings(page);
  const model = settings.getByRole("textbox", { name: "Default model" });
  const fastMode = settings.getByRole("combobox", { name: "Fast mode" });
  const save = settings.getByRole("button", { name: "Save", exact: true });
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
  await expect(model).toHaveValue("");
  await expect(fastMode).toHaveValue("");
});

for (const delayedEndpoint of ["workspace", "plugins"]) {
  test(`Codex Settings waits for the initial workspace before tab creation when ${delayedEndpoint} is delayed`, async ({
    page,
  }) => {
    const response = await page.request.get(`${baseUrl}/api/workspace`);
    expect(response.ok()).toBe(true);
    const workspace = (await response.json()) as WorkspaceStateResponse;
    const activeWindow = workspace.windows.find(
      (window) => window.id === workspace.activeWindowId,
    )!;
    expect(activeWindow.layout.activePaneId).not.toBe("pane-1");

    await page.addInitScript(() => {
      document.addEventListener(
        "pointerdown",
        (event) => {
          const button = (event.target as Element).closest(
            'button[title="Add tab to this pane"]',
          );
          if (button) {
            document.body.dataset.tabCreationPaneId =
              button.closest<HTMLElement>("[data-pane-id]")!.dataset.paneId;
          }
        },
        { capture: true },
      );
    });
    // Keep the socket snapshot from satisfying workspace readiness first.
    await page.routeWebSocket("**/ws/workspace", () => {});
    await page.route(
      `**/api/${delayedEndpoint}`,
      async (route) => {
        const response = await route.fetch();
        await expect(page.locator(".workspace-pane.active")).toHaveAttribute(
          "data-pane-id",
          "pane-1",
        );
        // Inject slow startup; the opener must wait for state, not this timer.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await route.fulfill({ response });
      },
      { times: 1 },
    );

    const settings = await openCodexSettings(page);
    await expect(page.locator("body")).toHaveAttribute(
      "data-tab-creation-pane-id",
      activeWindow.layout.activePaneId,
    );
    await expect(
      settings.getByRole("textbox", { name: "Default model" }),
    ).toHaveValue("");
    await expect(
      settings.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
  });
}

const workspaceNavigations = [
  "tab switches",
  "window switches",
  "pane splits",
] as const;

for (const navigation of workspaceNavigations) {
  test(`Codex Settings keeps drafts across workspace ${navigation} and discards them when the tab closes`, async ({
    page,
    isMobile,
  }) => {
    const configPath = path.join(testRoot, "codex-home", "config.toml");
    await fs.writeFile(
      configPath,
      'model = "initial-model"\nservice_tier = "priority"\n',
    );
    if (navigation === "window switches") await prepareWindowSwitch(page);
    const initialRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/hooks/codex-settings.read",
    );
    const settings = await openCodexSettings(page);
    const initialRevision = (await (await initialRead).json()).result.settings
      .revision;
    await createWorkspaceTab(page, "Local Web", "Other work");
    await activateWorkspaceTab(page, "Codex defaults");
    const model = settings.getByRole("textbox", { name: "Default model" });
    const fastMode = settings.getByRole("combobox", { name: "Fast mode" });
    const save = settings.getByRole("button", { name: "Save", exact: true });
    await model.fill("unsaved-draft-model");
    await fastMode.selectOption({ label: "Off" });

    await navigateWorkspace(page, isMobile, navigation);
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
    await activateWorkspaceTab(page, "Other work");
    await page
      .getByRole("button", { name: "Close Codex defaults", exact: true })
      .click();
    await expect(page.locator(".codex-settings-panel")).toHaveCount(0);
    await createCodexSettingsTab(page);
    await expect(model).toHaveValue("unsaved-draft-model");
    await expect(fastMode).toHaveValue("default");
    await expect(save).toBeDisabled();
  });

  test(`Codex Settings keeps a rejected stale draft and its revision across workspace ${navigation} until Reload`, async ({
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
    if (navigation === "window switches") await prepareWindowSwitch(page);
    const initialRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/hooks/codex-settings.read",
    );
    const settings = await openCodexSettings(page);
    const initialRevision = (await (await initialRead).json()).result.settings
      .revision;
    await createWorkspaceTab(page, "Local Web", "Other work");
    await activateWorkspaceTab(page, "Codex defaults");
    const model = settings.getByRole("textbox", { name: "Default model" });
    const fastMode = settings.getByRole("combobox", { name: "Fast mode" });
    const save = settings.getByRole("button", { name: "Save", exact: true });
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

    await navigateWorkspace(page, isMobile, navigation);
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
  }, testInfo) => {
    const configPath = path.join(testRoot, "codex-home", "config.toml");
    const initialConfig = `model = "initial-model"\nservice_tier = "${serviceTier}"\n[features]\nfast_mode = false\n`;
    await fs.writeFile(configPath, initialConfig);
    const settings = await openCodexSettings(page);
    const fastMode = settings.getByRole("combobox", { name: "Fast mode" });
    const save = settings.getByRole("button", { name: "Save", exact: true });
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

async function openCodexSettings(page: Page) {
  const initialWorkspace = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/workspace" &&
      response.request().method() === "GET",
  );
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const response = await initialWorkspace;
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()) as WorkspaceStateResponse;
  const activeWindow = workspace.windows.find(
    (window) => window.id === workspace.activeWindowId,
  )!;
  await expect(page.locator(".workspace-pane.active")).toHaveAttribute(
    "data-pane-id",
    activeWindow.layout.activePaneId,
  );
  await expect(
    page.getByTitle("Workspace windows", { exact: true }),
  ).toHaveText(activeWindow.name);
  return createCodexSettingsTab(page);
}

async function createWorkspaceTab(page: Page, plugin: string, title: string) {
  await page
    .locator(".workspace-pane.active")
    .getByTitle("Add tab to this pane")
    .click();
  await expect(
    page.getByRole("heading", { name: "New tab", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Plugin", exact: true })
    .selectOption({
      label: plugin,
    });
  await expect(page.getByLabel("New tab directory")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".tab-button.selected .tab-title")).toHaveText(
    title,
  );
}

async function activateWorkspaceTab(page: Page, title: string) {
  await page.locator(".tab-activation").filter({ hasText: title }).click();
  await expect(page.locator(".tab-button.selected .tab-title")).toHaveText(
    title,
  );
}

async function prepareWindowSwitch(page: Page) {
  const response = await page.request.get(`${baseUrl}/api/workspace`);
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()) as WorkspaceStateResponse;
  const created = await page.request.post(`${baseUrl}/api/windows`, {
    data: { name: "Other workspace", defaultCwd: testRoot },
  });
  expect(created.status()).toBe(201);
  const restored = await page.request.post(
    `${baseUrl}/api/windows/${workspace.activeWindowId}/active`,
    { data: {} },
  );
  expect(restored.ok()).toBe(true);
  const settled = (await restored.json()) as WorkspaceStateResponse;
  expect(settled.activeWindowId).toBe(workspace.activeWindowId);
  expect(settled.windows).toContainEqual(
    expect.objectContaining({ name: "Other workspace", defaultCwd: testRoot }),
  );
}

async function navigateWorkspace(
  page: Page,
  isMobile: boolean,
  navigation: (typeof workspaceNavigations)[number],
) {
  const settings = page.getByRole("region", {
    name: "Global Codex settings",
    exact: true,
  });
  if (navigation === "tab switches") {
    await activateWorkspaceTab(page, "Other work");
    await expect(settings).toBeHidden();
    await activateWorkspaceTab(page, "Codex defaults");
    return;
  }
  if (navigation === "window switches") {
    const switcher = page.getByTitle("Workspace windows", { exact: true });
    const originalWindow = (await switcher.textContent())!.trim();
    await switcher.click();
    await page
      .locator(".window-row-main")
      .filter({ hasText: "Other workspace" })
      .click();
    await expect(switcher).toHaveText("Other workspace");
    await expect(settings).toBeHidden();
    await expect(page.locator(".window-menu")).toBeHidden();
    await switcher.click();
    await page
      .locator(".window-row-main")
      .filter({ hasText: originalWindow })
      .click();
    await expect(switcher).toHaveText(originalWindow);
    await expect(page.locator(".window-menu")).toBeHidden();
    return;
  }
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
  await activateWorkspaceTab(page, "Codex defaults");
}

async function createCodexSettingsTab(page: Page) {
  await createWorkspaceTab(page, "Codex Settings", "Codex defaults");
  const settings = page.getByRole("region", {
    name: "Global Codex settings",
    exact: true,
  });
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute("aria-busy", "false");
  return settings;
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
    settings.getByRole("button", { name: "Save", exact: true }),
    settings.getByRole("button", { name: "Reload", exact: true }),
  ]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
    await control.click({ trial: true });
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
}

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

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { CloudxConfigResponse } from "@cloudx/shared";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let testRoot: string;
let baseUrl: string;
let server: ChildProcess;

test.beforeEach(async () => {
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
  let serverLogs = "";
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

test.afterEach(async () => {
  if (server && server.exitCode === null) {
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

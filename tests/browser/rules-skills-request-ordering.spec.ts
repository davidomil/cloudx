import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CreateTabResponse, WorkspaceStateResponse } from "@cloudx/shared";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const serverEntry = "tests/browser/fixtures/catalog-server.mjs";
let testRoot: string;
let catalog: string;
let baseUrl: string;
let server: ChildProcess;
let serverLogs = "";

test.beforeEach(async () => {
  serverLogs = "";
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-rules-ordering-browser-"),
  );
  const data = path.join(testRoot, "data");
  catalog = path.join(data, "rules-skills");
  const codexHome = path.join(testRoot, "codex-home");
  const imagegen = path.join(codexHome, "skills", ".system", "imagegen");
  await fs.mkdir(imagegen, { recursive: true });
  await fs.writeFile(
    path.join(imagegen, "SKILL.md"),
    "---\nname: imagegen\ndescription: Browser fixture only.\n---\nFixture data only.\n",
  );
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate browser test port.");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  baseUrl = `http://127.0.0.1:${address.port}`;
  server = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLOUDX_ALLOWED_ROOTS: testRoot,
      CLOUDX_APP_SERVER_ENABLED: "false",
      CLOUDX_ASR_URL: "http://127.0.0.1:9",
      CLOUDX_AUTOMATION_START_DISABLED: "true",
      CLOUDX_DATA_DIR: data,
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
  });
  server.stdout!.on("data", (chunk) => {
    serverLogs += chunk.toString();
  });
  server.stderr!.on("data", (chunk) => {
    serverLogs += chunk.toString();
  });
  await expect
    .poll(
      async () => {
        if (server.exitCode !== null)
          throw new Error(`Browser test server exited.\n${serverLogs}`);
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
  const logPath = testInfo.outputPath("server.log");
  await fs.writeFile(logPath, serverLogs);
  await testInfo.attach("server.log", {
    path: logPath,
    contentType: "text/plain",
  });
  if (testRoot) await fs.rm(testRoot, { recursive: true, force: true });
});

async function openCatalogPanes(page: Page) {
  await fs.writeFile(
    path.join(catalog, "rules", "ordering-rule.md"),
    "---\nid: ordering-rule\ndescription: Preserve the rule description.\n---\nOriginal rule text.\n",
  );
  const workspace = (await (
    await page.request.get(`${baseUrl}/api/workspace`)
  ).json()) as WorkspaceStateResponse;
  const activeWindow = workspace.windows.find(
    (window) => window.id === workspace.activeWindowId,
  )!;
  const tabs = [];
  for (const title of ["Save pane", "Refresh pane"]) {
    const created = await page.request.post(`${baseUrl}/api/tabs`, {
      data: {
        pluginId: "rules-skills",
        title,
        windowId: activeWindow.id,
        paneId: activeWindow.layout.activePaneId,
      },
    });
    expect(created.status()).toBe(201);
    tabs.push(((await created.json()) as CreateTabResponse).tab);
  }
  const split = await page.request.patch(
    `${baseUrl}/api/windows/${activeWindow.id}`,
    {
      data: {
        layout: {
          activePaneId: "save-pane",
          root: {
            type: "split",
            id: "ordering-split",
            direction: "column",
            sizes: [50, 50],
            children: tabs.map((tab, index) => ({
              type: "pane",
              pane: {
                id: index === 0 ? "save-pane" : "refresh-pane",
                tabIds: [tab.id],
                activeTabId: tab.id,
              },
            })),
          },
        },
      },
    },
  );
  expect(split.status()).toBe(200);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const savePane = page.locator(
    '[data-pane-id="save-pane"] .rules-skills-panel',
  );
  const refreshPane = page.locator(
    '[data-pane-id="refresh-pane"] .rules-skills-panel',
  );
  for (const pane of [savePane, refreshPane]) {
    await expect(pane.getByLabel("Name", { exact: true })).toHaveValue(
      "Default Codex",
    );
    await expect(pane.locator(".rules-skills-save-state")).toHaveText("Saved");
  }
  return { savePane, refreshPane };
}

async function refreshWhileSaveDeliveryIsHeld(
  page: Page,
  refreshPane: Locator,
  saveButton: Locator,
  saveHook: "templates.save" | "rules.save",
) {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered: string[] = [];
  await page.route(
    `**/api/hooks/rules-skills.${saveHook}`,
    async (route) => {
      held.resolve();
      await release.promise;
      delivered.push("save");
      await route.continue();
    },
    { times: 1 },
  );
  await page.route(
    "**/api/hooks/rules-skills.catalog.list",
    async (route) => {
      delivered.push("refresh");
      const response = await route.fetch();
      await release.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  const saveResponse = page.waitForResponse(
    `**/api/hooks/rules-skills.${saveHook}`,
  );
  const refreshResponse = page.waitForResponse(
    "**/api/hooks/rules-skills.catalog.list",
  );
  try {
    await saveButton.click();
    await held.promise;
    const refreshButton = refreshPane.getByRole("button", {
      name: "Refresh rules and skills",
      exact: true,
    });
    await refreshButton.click();
    await expect(refreshButton).toBeDisabled();
  } finally {
    release.resolve();
  }
  expect((await saveResponse).ok()).toBe(true);
  expect((await refreshResponse).ok()).toBe(true);
  await expect(refreshPane).toContainText("Rules and skills refreshed.");
  return delivered;
}

test("both panes retain a template save held before delivery when another pane refreshes", async ({
  page,
}) => {
  const { savePane, refreshPane } = await openCatalogPanes(page);
  await savePane
    .getByLabel("Name", { exact: true })
    .fill("Saved after refresh was requested");
  const delivered = await refreshWhileSaveDeliveryIsHeld(
    page,
    refreshPane,
    savePane.getByRole("button", { name: "Save template", exact: true }),
    "templates.save",
  );
  const templatePath = path.join(catalog, "templates", "default-codex.json");
  expect(JSON.parse(await fs.readFile(templatePath, "utf8")).name).toBe(
    "Saved after refresh was requested",
  );
  for (const pane of [savePane, refreshPane]) {
    await expect(pane.getByLabel("Name", { exact: true })).toHaveValue(
      "Saved after refresh was requested",
    );
    await expect(pane.locator(".rules-skills-save-state")).toHaveText("Saved");
  }
  await refreshPane
    .getByRole("combobox", { name: "Color", exact: true })
    .selectOption("red");
  await refreshPane
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  for (const pane of [savePane, refreshPane]) {
    await expect(pane.getByLabel("Name", { exact: true })).toHaveValue(
      "Saved after refresh was requested",
    );
    await expect(
      pane.getByRole("combobox", { name: "Color", exact: true }),
    ).toHaveValue("red");
    await expect(pane.locator(".rules-skills-save-state")).toHaveText("Saved");
  }
  expect(JSON.parse(await fs.readFile(templatePath, "utf8"))).toMatchObject({
    name: "Saved after refresh was requested",
    color: "red",
  });
  expect(delivered).toEqual(["save", "refresh"]);
});

test("both panes retain a rule save held before delivery when another pane refreshes", async ({
  page,
}) => {
  const { savePane, refreshPane } = await openCatalogPanes(page);
  await savePane
    .getByRole("button", { name: "Edit rule ordering-rule", exact: true })
    .click();
  await savePane
    .getByRole("textbox", { name: "Rule text for ordering-rule", exact: true })
    .fill("Saved rule text after refresh was requested.");
  const delivered = await refreshWhileSaveDeliveryIsHeld(
    page,
    refreshPane,
    savePane.getByRole("button", {
      name: "Save rule ordering-rule",
      exact: true,
    }),
    "rules.save",
  );
  const rulePath = path.join(catalog, "rules", "ordering-rule.md");
  expect(await fs.readFile(rulePath, "utf8")).toContain(
    "Saved rule text after refresh was requested.",
  );
  for (const pane of [savePane, refreshPane]) {
    await expect(
      pane.getByRole("checkbox", {
        name: "Saved rule text after refresh was requested.",
      }),
    ).toBeVisible();
  }
  await refreshPane
    .getByRole("button", { name: "Edit rule ordering-rule", exact: true })
    .click();
  const editor = refreshPane.getByRole("textbox", {
    name: "Rule text for ordering-rule",
    exact: true,
  });
  await expect(editor).toHaveText(
    "Saved rule text after refresh was requested.",
  );
  await editor.fill(
    `${await editor.innerText()} Keep the subsequent edit too.`,
  );
  await refreshPane
    .getByRole("button", { name: "Save rule ordering-rule", exact: true })
    .click();
  const finalText =
    "Saved rule text after refresh was requested. Keep the subsequent edit too.";
  for (const pane of [savePane, refreshPane]) {
    await expect(pane.getByRole("checkbox", { name: finalText })).toBeVisible();
  }
  const saved = await fs.readFile(rulePath, "utf8");
  expect(saved).toContain(finalText);
  expect(saved).toContain("description: Preserve the rule description.");
  expect(delivered).toEqual(["save", "refresh"]);
});

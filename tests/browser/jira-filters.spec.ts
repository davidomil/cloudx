import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { JiraFilterState, WorkspaceStateResponse } from "@cloudx/shared";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let testRoot: string;
let baseUrl: string;
let server: ChildProcess;
let serverLogs = "";

test.beforeEach(async () => {
  serverLogs = "";
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-filters-"));
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

test("saved Jira filters can be created, edited, switched, restored and deleted", async ({
  page,
}, testInfo) => {
  await mockJiraQueries(page);
  await openJira(page);
  const selector = page.getByLabel("Jira filter", { exact: true });
  await expect(selector).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Edit filter" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete filter" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "New filter" }).click();
  await page.getByLabel("Filter name", { exact: true }).fill("Engineering");
  await page
    .getByRole("textbox", { name: "JQL", exact: true })
    .fill("project = ENG ORDER BY updated DESC");
  await captureJira(page, testInfo, "create-jira-filter");
  await page.getByRole("button", { name: "Save filter" }).click();
  await expect(page.getByLabel("Filter name", { exact: true })).toBeHidden();
  const engineering = (await readFilters(page)).filters[0]!;
  await expect(selector).toHaveValue(engineering.id);
  await expect(
    page.getByRole("heading", { name: "Engineering", exact: true }),
  ).toBeVisible();

  await saveNewFilter(
    page,
    "Operations",
    "project = OPS ORDER BY priority DESC",
  );
  const operations = (await readFilters(page)).filters.find(
    (filter) => filter.name === "Operations",
  )!;
  await expect(selector).toHaveValue(operations.id);
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();

  await selector.selectOption(engineering.id);
  await page.getByRole("button", { name: "Edit filter" }).click();
  await expect(page.getByLabel("Filter name", { exact: true })).toHaveValue(
    "Engineering",
  );
  await expect(
    page.getByRole("textbox", { name: "JQL", exact: true }),
  ).toHaveValue(engineering.jql);
  const editedName =
    "Engineering release readiness and unassigned customer support work";
  const editedJql =
    "project = ENG AND assignee IS EMPTY ORDER BY priority DESC";
  await page.getByLabel("Filter name", { exact: true }).fill(editedName);
  await page.getByRole("textbox", { name: "JQL", exact: true }).fill(editedJql);
  await page.getByRole("button", { name: "Save filter" }).click();
  await expect(page.getByLabel("Filter name", { exact: true })).toBeHidden();
  expect(await readFilters(page)).toEqual({
    filters: [
      { id: engineering.id, name: editedName, jql: editedJql },
      operations,
    ],
    selectedFilterId: engineering.id,
  });

  await page.reload();
  await expect(selector).toHaveValue(engineering.id);
  await expect(
    page.getByRole("heading", { name: editedName, exact: true }),
  ).toBeVisible();
  await captureJira(page, testInfo, "saved-jira-filter");
  await selector.selectOption("");
  await expect(
    page.getByRole("heading", { name: "Configured dashboard", exact: true }),
  ).toBeVisible();
  expect((await readFilters(page)).selectedFilterId).toBeNull();
  await selector.selectOption(operations.id);
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  await selector.selectOption(engineering.id);
  await expect(
    page.getByRole("heading", { name: editedName, exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Delete filter" }).click();
  await expect(selector).toHaveValue("");
  await expect(
    selector.getByRole("option", { name: editedName, exact: true }),
  ).toHaveCount(0);
  expect(await readFilters(page)).toEqual({
    filters: [operations],
    selectedFilterId: null,
  });
  await page.reload();
  await expect(selector).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Configured dashboard", exact: true }),
  ).toBeVisible();
  await expect(
    selector.getByRole("option", { name: "Operations", exact: true }),
  ).toHaveCount(1);
});

test("a rejected duplicate filter keeps the draft and the previously saved view", async ({
  page,
}) => {
  await mockJiraQueries(page);
  await openJira(page);
  await saveNewFilter(page, "Engineering", "project = ENG");
  const original = await readFilters(page);
  await page.getByRole("button", { name: "New filter" }).click();
  await expect(
    page.getByRole("button", { name: "Save filter" }),
  ).toBeDisabled();
  await page.getByLabel("Filter name", { exact: true }).fill("engineering");
  await page
    .getByRole("textbox", { name: "JQL", exact: true })
    .fill("project = OPS");
  await page.getByRole("button", { name: "Save filter" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "A Jira filter with this name already exists.",
  );
  await expect(page.getByLabel("Filter name", { exact: true })).toHaveValue(
    "engineering",
  );
  await expect(
    page.getByRole("textbox", { name: "JQL", exact: true }),
  ).toHaveValue("project = OPS");
  expect(await readFilters(page)).toEqual(original);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Filter name", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Jira filter", { exact: true })).toHaveValue(
    original.selectedFilterId!,
  );
  await expect(
    page.getByRole("heading", { name: "Engineering", exact: true }),
  ).toBeVisible();
});

async function saveNewFilter(page: Page, name: string, jql: string) {
  await page.getByRole("button", { name: "New filter" }).click();
  await page.getByLabel("Filter name", { exact: true }).fill(name);
  await page.getByRole("textbox", { name: "JQL", exact: true }).fill(jql);
  await page.getByRole("button", { name: "Save filter" }).click();
  await expect(page.getByLabel("Filter name", { exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

async function readFilters(page: Page): Promise<JiraFilterState> {
  const response = await page.request.post(
    `${baseUrl}/api/hooks/jira.filters.list`,
    {
      data: { input: {} },
    },
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).result;
}

async function captureJira(page: Page, testInfo: TestInfo, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  for (const control of await page
    .locator(
      ".jira-filter-bar input, .jira-filter-bar textarea, .jira-filter-bar select, .jira-filter-bar button",
    )
    .all()) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width + 1,
    );
  }
  await testInfo.attach(name, {
    body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
    contentType: "image/png",
  });
}

async function mockJiraQueries(page: Page) {
  const issues = new Map<string, Record<string, unknown>>();
  await page.route("**/api/hooks/jira.dashboard.list", async (route) => {
    const { input } = route.request().postDataJSON();
    const state = await readFilters(page);
    const filter = state.filters.find(
      (candidate) => candidate.id === input?.filterId,
    );
    if (input?.filterId) expect(filter).toBeDefined();
    const key = filter
      ? filter.jql.includes("OPS")
        ? "OPS-1"
        : "ENG-1"
      : "HOME-1";
    const issue = {
      key,
      url: `https://jira.example.test/browse/${key}`,
      summary: filter?.name ?? "Configured dashboard",
      description: filter?.jql ?? "Assigned unresolved issues",
      status: "In Progress",
      priority: "High",
    };
    issues.set(key, issue);
    await route.fulfill({
      json: {
        result: {
          issues: [issue],
          groups: [{ id: "all", title: "Issues", issues: [issue] }],
          jql: filter?.jql ?? "assignee = currentUser() AND resolution = EMPTY",
          groupBy: "none",
          sortBy: "custom_jql_order",
        },
      },
    });
  });
  await page.route("**/api/hooks/jira.issue.get", async (route) => {
    const { input } = route.request().postDataJSON();
    const issue = issues.get(input.issueIdOrKey);
    expect(issue).toBeDefined();
    await route.fulfill({ json: { result: { issue } } });
  });
  for (const field of ["comments", "transitions"]) {
    await page.route(`**/api/hooks/jira.issue.${field}.list`, (route) =>
      route.fulfill({ json: { result: { [field]: [] } } }),
    );
  }
}

async function openJira(page: Page) {
  const workspace = (await (
    await page.request.get(`${baseUrl}/api/workspace`)
  ).json()) as WorkspaceStateResponse;
  const activeWindow = workspace.windows.find(
    (window) => window.id === workspace.activeWindowId,
  )!;
  const created = await page.request.post(`${baseUrl}/api/tabs`, {
    data: {
      pluginId: "jira",
      title: "Jira filters",
      windowId: activeWindow.id,
      paneId: activeWindow.layout.activePaneId,
    },
  });
  expect(created.status()).toBe(201);
  await page.goto(baseUrl);
  await expect(page.getByLabel("Jira filter", { exact: true })).toBeVisible();
}

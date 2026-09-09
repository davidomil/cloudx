import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  CreateTabResponse,
  RulesSkillsStore,
  WorkspaceStateResponse,
} from "@cloudx/shared";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const serverEntry = "tests/browser/fixtures/catalog-server.mjs";
let testRoot: string;
let catalog: string;
let baseUrl: string;
let server: ChildProcess;
let serverLogs = "";

async function git(cwd: string, ...args: string[]) {
  const result = await execFileAsync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=CloudX Browser Test",
      "-c",
      "user.email=browser@example.test",
      "-C",
      cwd,
      ...args,
    ],
    {
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return result.stdout.trim();
}

test.beforeEach(async () => {
  serverLogs = "";
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-rules-git-origin-ordering-"),
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
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
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

test("both panes retain a delayed origin save and subsequently pull and push only its replacement", async ({
  page,
}) => {
  const { origin, replacement, oldHead, peer } = await createOriginFixture();
  const templatePath = path.join(peer, "templates", "default-codex.json");
  const template = JSON.parse(await fs.readFile(templatePath, "utf8"));
  await fs.writeFile(
    templatePath,
    `${JSON.stringify({ ...template, name: "Pulled from replacement origin" }, null, 2)}\n`,
  );
  await git(peer, "add", ".");
  await git(peer, "commit", "-m", "Update only replacement origin");
  await git(peer, "push", "origin", "main");

  const { savePane, refreshPane } = await openCatalogPanes(page);
  for (const pane of [savePane, refreshPane]) {
    await expect(pane.getByLabel("Origin URL")).toHaveValue(origin);
    await expect(
      pane.getByRole("button", { name: "Pull", exact: true }),
    ).toBeEnabled();
  }
  await savePane.getByLabel("Origin URL").fill(replacement);
  const delivered = await refreshWhileOriginSaveDeliveryIsHeld(
    page,
    savePane,
    refreshPane,
  );

  expect(await git(catalog, "remote", "get-url", "origin")).toBe(replacement);
  await expect(savePane).toContainText("Origin saved.");
  await expect(refreshPane).toContainText("Git status refreshed.");
  for (const pane of [savePane, refreshPane]) {
    await expect(pane.getByLabel("Origin URL")).toHaveValue(replacement);
    await expect(
      pane.getByRole("button", { name: "Save origin", exact: true }),
    ).toBeDisabled();
    await expect(
      pane.getByRole("button", { name: "Pull", exact: true }),
    ).toBeEnabled();
    await expect(
      pane.getByRole("button", { name: "Push commits", exact: true }),
    ).toBeEnabled();
  }
  expect(delivered).toEqual(["save origin", "refresh Git status"]);

  await refreshPane.getByRole("button", { name: "Pull", exact: true }).click();
  await expect(refreshPane).toContainText(
    "Pulled from origin. Rules and skills refreshed.",
  );
  for (const pane of [savePane, refreshPane]) {
    await expect(pane.getByLabel("Name", { exact: true })).toHaveValue(
      "Pulled from replacement origin",
    );
    await expect(pane.getByLabel("Origin URL")).toHaveValue(replacement);
  }
  expect(await git(catalog, "rev-parse", "HEAD")).toBe(
    await git(replacement, "rev-parse", "refs/heads/main"),
  );
  expect(await git(origin, "rev-parse", "refs/heads/main")).toBe(oldHead);

  await fs.writeFile(
    path.join(catalog, "rules", "replacement-only-rule.md"),
    "---\nid: replacement-only-rule\ndescription: Verify the push destination.\n---\nPublish only to replacement origin.\n",
  );
  await git(catalog, "add", ".");
  await git(catalog, "commit", "-m", "Commit outgoing replacement-only rule");
  const pushedRequest = page.waitForRequest(
    "**/api/hooks/rules-skills.git.push",
  );
  await refreshPane
    .getByRole("button", { name: "Push commits", exact: true })
    .click();
  expect((await pushedRequest).postDataJSON()).toMatchObject({
    input: { expectedOriginUrl: replacement },
  });
  await expect(refreshPane).toContainText("Commits pushed to origin.");
  expect(await git(replacement, "rev-parse", "refs/heads/main")).toBe(
    await git(catalog, "rev-parse", "HEAD"),
  );
  expect(await git(origin, "rev-parse", "refs/heads/main")).toBe(oldHead);
  expect(
    await git(
      replacement,
      "show",
      "refs/heads/main:rules/replacement-only-rule.md",
    ),
  ).toContain("Publish only to replacement origin.");
});

for (const heldSave of ["request", "response"] as const) {
  test(`a pull queued while the origin save ${heldSave} is held preserves its displayed destination`, async ({
    page,
  }) => {
    const { origin, replacement, oldHead, peer } = await createOriginFixture();
    const incomingRule = "Load this rule only from the displayed replacement.";
    await fs.writeFile(
      path.join(peer, "rules", "replacement-only-rule.md"),
      `---\nid: replacement-only-rule\ndescription: Verify the pull destination.\n---\n${incomingRule}\n`,
    );
    await git(peer, "add", ".");
    await git(peer, "commit", "-m", "Add replacement-only rule");
    await git(peer, "push", "origin", "main");
    const replacementHead = await git(
      replacement,
      "rev-parse",
      "refs/heads/main",
    );
    expect(replacementHead).not.toBe(oldHead);

    const { savePane, refreshPane: pullPane } = await openCatalogPanes(page);
    const originalStore = await readCatalog(page);
    for (const pane of [savePane, pullPane]) {
      await expect(pane.getByLabel("Origin URL")).toHaveValue(origin);
      await expect(
        pane.getByRole("checkbox", { name: incomingRule }),
      ).toHaveCount(0);
    }

    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(
      "**/api/hooks/rules-skills.git.setOrigin",
      async (route) => {
        if (heldSave === "request") {
          held.resolve();
          await release.promise;
          await route.continue();
        } else {
          const response = await route.fetch();
          held.resolve();
          await release.promise;
          await route.fulfill({ response });
        }
      },
      { times: 1 },
    );
    const saveResponse = page.waitForResponse(
      "**/api/hooks/rules-skills.git.setOrigin",
    );
    const pullRequest = page.waitForRequest(
      "**/api/hooks/rules-skills.git.pull",
    );
    const pullResponse = page.waitForResponse(
      "**/api/hooks/rules-skills.git.pull",
    );
    const pullButton = pullPane.getByRole("button", {
      name: "Pull",
      exact: true,
    });
    try {
      await savePane.getByLabel("Origin URL").fill(replacement);
      await savePane
        .getByRole("button", { name: "Save origin", exact: true })
        .click();
      await held.promise;
      expect(await git(catalog, "remote", "get-url", "origin")).toBe(
        heldSave === "request" ? origin : replacement,
      );
      await expect(savePane).toContainText("Saving origin…");
      await expect(pullPane.getByLabel("Origin URL")).toHaveValue(origin);
      await expect(pullButton).toBeEnabled();
      await pullButton.click();
      await expect(pullPane).toContainText("Pulling…");
      await expect(pullButton).toBeDisabled();
    } finally {
      release.resolve();
    }

    expect((await saveResponse).ok()).toBe(true);
    expect((await pullRequest).postDataJSON()).toEqual({
      input: { expectedOriginUrl: origin },
    });
    expect((await pullResponse).ok()).toBe(false);
    await expect(pullPane.getByRole("alert")).toContainText(
      "Origin changed since it was displayed.",
    );
    expect(await git(catalog, "rev-parse", "HEAD")).toBe(oldHead);
    expect(await git(catalog, "status", "--porcelain")).toBe("");
    expect(await readCatalog(page)).toEqual(originalStore);
    await expect(
      fs.stat(path.join(catalog, "rules", "replacement-only-rule.md")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const pane of [savePane, pullPane]) {
      await expect(pane.getByLabel("Origin URL")).toHaveValue(replacement);
      await expect(
        pane.getByRole("checkbox", { name: incomingRule }),
      ).toHaveCount(0);
    }

    const freshPullRequest = page.waitForRequest(
      "**/api/hooks/rules-skills.git.pull",
    );
    await pullButton.click();
    expect((await freshPullRequest).postDataJSON()).toEqual({
      input: { expectedOriginUrl: replacement },
    });
    await expect(pullPane).toContainText(
      "Pulled from origin. Rules and skills refreshed.",
    );
    for (const pane of [savePane, pullPane]) {
      await expect(
        pane.getByRole("checkbox", { name: incomingRule }),
      ).toBeVisible();
    }
    expect((await readCatalog(page)).rules).toContainEqual(
      expect.objectContaining({
        id: "replacement-only-rule",
        text: incomingRule,
      }),
    );
    expect(await git(catalog, "rev-parse", "HEAD")).toBe(replacementHead);
    expect(await git(catalog, "status", "--porcelain")).toBe("");
    expect(await git(origin, "rev-parse", "refs/heads/main")).toBe(oldHead);
    expect(await git(replacement, "rev-parse", "refs/heads/main")).toBe(
      replacementHead,
    );
  });
}

async function createOriginFixture() {
  const origin = path.join(testRoot, "old origin.git");
  const replacement = path.join(testRoot, "replacement origin.git");
  await git(catalog, "init", "--initial-branch=main");
  await git(catalog, "add", ".");
  await git(catalog, "commit", "-m", "Seed catalog fixture");
  for (const remote of [origin, replacement]) {
    await git(testRoot, "init", "--bare", "--initial-branch=main", remote);
    await git(catalog, "push", remote, "main");
  }
  await git(catalog, "remote", "add", "origin", origin);
  const oldHead = await git(origin, "rev-parse", "refs/heads/main");
  const peer = path.join(testRoot, "peer");
  await git(testRoot, "clone", replacement, peer);
  return { origin, replacement, oldHead, peer };
}

async function readCatalog(page: Page): Promise<RulesSkillsStore> {
  const response = await page.request.post(
    `${baseUrl}/api/hooks/rules-skills.catalog.list`,
    {
      data: { input: {} },
    },
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).result.store;
}

async function openCatalogPanes(page: Page) {
  const workspace = (await (
    await page.request.get(`${baseUrl}/api/workspace`)
  ).json()) as WorkspaceStateResponse;
  const activeWindow = workspace.windows.find(
    (window) => window.id === workspace.activeWindowId,
  )!;
  const tabs = [];
  for (const title of ["Save origin pane", "Refresh Git pane"]) {
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
            id: "origin-ordering-split",
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
  return {
    savePane: page.locator('[data-pane-id="save-pane"] .rules-skills-panel'),
    refreshPane: page.locator(
      '[data-pane-id="refresh-pane"] .rules-skills-panel',
    ),
  };
}

async function refreshWhileOriginSaveDeliveryIsHeld(
  page: Page,
  savePane: Locator,
  refreshPane: Locator,
) {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refreshed = Promise.withResolvers<void>();
  const delivered: string[] = [];
  await page.route("**/api/hooks/rules-skills.git.setOrigin", async (route) => {
    held.resolve();
    await release.promise;
    delivered.push("save origin");
    await route.continue();
  });
  await page.route("**/api/hooks/rules-skills.git.status", async (route) => {
    delivered.push("refresh Git status");
    const response = await route.fetch();
    refreshed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  const saveResponse = page.waitForResponse(
    "**/api/hooks/rules-skills.git.setOrigin",
  );
  const refreshResponse = page.waitForResponse(
    "**/api/hooks/rules-skills.git.status",
  );
  try {
    await savePane
      .getByRole("button", { name: "Save origin", exact: true })
      .click();
    await held.promise;
    const refreshButton = refreshPane.getByRole("button", {
      name: "Refresh Git status",
      exact: true,
    });
    await refreshButton.click();
    await expect(refreshButton).toBeDisabled();
    if (delivered.includes("refresh Git status")) await refreshed.promise;
  } finally {
    release.resolve();
  }
  expect((await saveResponse).ok()).toBe(true);
  expect((await refreshResponse).ok()).toBe(true);
  return delivered;
}

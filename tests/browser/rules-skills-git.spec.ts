import { expect, test } from "@playwright/test";
import type { WorkspaceStateResponse } from "@cloudx/shared";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
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

test.beforeAll(async () => {
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-rules-git-browser-"),
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
  server = spawn(process.execPath, ["apps/server/dist/index.js"], {
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

test.afterAll(async () => {
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

test("configures origin, pushes commits, and pulls into the visible catalog without discarding drafts", async ({
  page,
}, testInfo) => {
  const workspace = (await (
    await page.request.get(`${baseUrl}/api/workspace`)
  ).json()) as WorkspaceStateResponse;
  const activeWindow = workspace.windows.find(
    (window) => window.id === workspace.activeWindowId,
  )!;
  const created = await page.request.post(`${baseUrl}/api/tabs`, {
    data: {
      pluginId: "rules-skills",
      title: "Rules & Skills",
      windowId: activeWindow.id,
      paneId: activeWindow.layout.activePaneId,
    },
  });
  expect(created.status()).toBe(201);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const panel = page.getByRole("region", {
    name: "Rules and skills Git",
    exact: true,
  });
  await expect(panel).toContainText("This catalog is not a Git checkout.");

  const remote = path.join(testRoot, "origin.git");
  await git(testRoot, "init", "--bare", "--initial-branch=main", remote);
  await git(catalog, "init", "--initial-branch=main");
  await git(catalog, "add", ".");
  await git(catalog, "commit", "-m", "Seed catalog fixture");
  await panel.getByRole("button", { name: "Refresh Git status" }).click();
  await expect(panel).toContainText("Branch: main");
  await expect(
    panel.getByRole("button", { name: "Pull", exact: true }),
  ).toBeDisabled();
  await panel.getByLabel("Origin URL").fill(remote);
  await panel.getByRole("button", { name: "Save origin" }).click();
  await expect(panel).toContainText("Origin saved.");
  expect(await git(catalog, "remote", "get-url", "origin")).toBe(remote);
  await panel.getByRole("button", { name: "Push commits" }).click();
  await expect(panel).toContainText("Commits pushed to origin.");
  expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(
    await git(catalog, "rev-parse", "HEAD"),
  );

  const peer = path.join(testRoot, "peer");
  await git(testRoot, "clone", remote, peer);
  const templatePath = path.join(peer, "templates", "default-codex.json");
  const template = JSON.parse(await fs.readFile(templatePath, "utf8"));
  await fs.writeFile(
    templatePath,
    `${JSON.stringify({ ...template, name: "Pulled template" }, null, 2)}\n`,
  );
  await git(peer, "add", ".");
  await git(peer, "commit", "-m", "Rename template fixture");
  await git(peer, "push", "origin", "main");

  const name = page
    .locator(".rules-skills-template-fields")
    .getByLabel("Name", { exact: true });
  const originalName = await name.inputValue();
  await name.fill("Unsaved draft");
  await expect(
    panel.getByRole("button", { name: "Pull", exact: true }),
  ).toBeDisabled();
  await name.fill(originalName);
  await expect(
    panel.getByRole("button", { name: "Pull", exact: true }),
  ).toBeEnabled();
  let continuePull!: () => void;
  const waiting = new Promise<void>((resolve) => {
    continuePull = resolve;
  });
  await page.route("**/api/hooks/rules-skills.git.pull", async (route) => {
    await waiting;
    await route.continue();
  });
  await panel.getByRole("button", { name: "Pull", exact: true }).click();
  await expect(name).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Push commits" }),
  ).toBeDisabled();
  continuePull();
  await expect(name).toHaveValue("Pulled template");
  await expect(name).toBeEnabled();
  await expect(panel).toContainText("Rules and skills refreshed.");

  await name.fill("Locally saved template");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(page.locator(".rules-skills-save-state")).toHaveText("Saved");
  await panel.getByRole("button", { name: "Refresh Git status" }).click();
  await expect(panel).toContainText("Uncommitted catalog changes.");
  await expect(
    panel.getByRole("button", { name: "Pull", exact: true }),
  ).toBeDisabled();
  await git(catalog, "add", ".");
  await git(catalog, "commit", "-m", "Save template fixture");
  await panel.getByRole("button", { name: "Refresh Git status" }).click();
  await expect(
    panel.getByRole("button", { name: "Pull", exact: true }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Push commits" }).click();
  await expect(panel).toContainText("Commits pushed to origin.");
  expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(
    await git(catalog, "rev-parse", "HEAD"),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await panel.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await testInfo.attach("rules-skills-git", {
    body: await page.screenshot({
      path: testInfo.outputPath("rules-skills-git.png"),
      animations: "disabled",
    }),
    contentType: "image/png",
  });

  await panel.getByLabel("Origin URL").fill(path.join(testRoot, "missing.git"));
  await panel.getByRole("button", { name: "Save origin" }).click();
  await expect(panel).toContainText("Origin saved.");
  await panel.getByRole("button", { name: "Push commits" }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "Catalog Git command failed.",
  );
  await expect(
    panel.getByRole("button", { name: "Push commits" }),
  ).toBeEnabled();
});

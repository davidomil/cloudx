#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import {
  developmentLayout,
  documentationResults,
  knowledgeLayout,
  notificationWorkflow,
  terminalTranscripts,
  workspacePane,
} from "./readme-demo-fixtures.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const screenshotDir = path.join(repoRoot, "docs/screenshots");
const execFileAsync = promisify(execFile);

async function main() {
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_")) delete process.env[key];
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-desktop-demo-"));
  let app;
  let preview;
  let browser;
  try {
    const project = await createDemoRepository(root);
    preview = await startPreview();
    const server = await startCloudx(root, (runningApp) => {
      app = runningApp;
    });
    app = server.app;
    const baseUrl = server.baseUrl;
    const templates = await createSavedTemplates(baseUrl, project, preview.url);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    });
    const unexpectedRequests = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === baseUrl || url.origin === preview.url.slice(0, -1))
        return route.continue();
      unexpectedRequests.push(url.origin);
      await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await fs.mkdir(screenshotDir, { recursive: true });

    await showTemplate(page, baseUrl, templates.development, project);
    await expect(page.locator(".xterm-screen").first()).toBeVisible();
    await expect(
      page.frameLocator(".web-viewer-frame").locator("h1"),
    ).toHaveText("Release readiness");
    await openDiff(page);
    await capture(page, "cloudx-desktop-development.png", root);

    await showTemplate(page, baseUrl, templates.knowledge, project);
    await searchDocumentation(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await capture(page, "cloudx-desktop-knowledge.png", root);

    await capturePlugins(page, baseUrl, project, preview.url, root);
    await captureWorkspaceControls(
      page,
      baseUrl,
      templates.development,
      project,
      root,
    );

    assert.deepEqual(errors, [], "Browser runtime errors");
    assert.deepEqual(
      unexpectedRequests,
      [],
      "Unexpected browser network requests",
    );
    console.log(
      "Captured 2 saved-and-reloaded desktop templates and 14 plugin/control screens; no browser runtime errors or non-demo requests.",
    );
  } finally {
    const cleanup = await Promise.allSettled([
      browser?.close(),
      app?.close(),
      preview &&
        new Promise((resolve, reject) =>
          preview.server.close((error) => (error ? reject(error) : resolve())),
        ),
    ]);
    await fs.rm(root, { recursive: true, force: true });
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Demo cleanup failed.",
      );
  }
}

async function capturePlugins(page, baseUrl, project, previewUrl, root) {
  const pluginCases = [
    ["codex-terminal", "Codex implementation", ".xterm-screen"],
    ["standard-terminal", "Validation terminal", ".xterm-screen"],
    ["file-browser", "Review changes", ".file-browser-panel"],
    ["local-web", "Local preview", ".web-viewer-frame"],
    ["worktree-manager", "Parallel worktrees", ".worktree-manager-panel"],
    ["documentation", "Project knowledge", ".documentation-panel"],
    ["automation", "Review handoff", ".automation-panel"],
    ["rules-skills", "Engineering rules", ".rules-skills-panel"],
    ["jira", "Jira setup", ".jira-panel"],
    ["forge", "Forge Workers setup", ".forge-panel"],
  ];
  for (const [pluginId, title, selector] of pluginCases) {
    const cwd =
      pluginId === "worktree-manager" ? path.join(root, "worktrees") : project;
    await showPlugin(page, baseUrl, pluginId, title, cwd, previewUrl);
    await expect(page.locator(selector).first()).toBeVisible();
    if (pluginId === "file-browser") await openDiff(page);
    if (pluginId === "documentation") await searchDocumentation(page);
    if (pluginId === "worktree-manager") {
      await expect(page.locator(selector)).toContainText("review-release");
      await expect(page.locator(".worktree-size.unavailable")).toHaveCount(0);
    }
    if (pluginId === "rules-skills") {
      await expect(page.locator(selector)).toContainText("Engineering review");
      await page
        .locator(".rules-skills-panel")
        .getByRole("button", { name: /Engineering review/ })
        .click();
    }
    if (pluginId === "jira")
      await expect(page.locator(selector)).toContainText(
        "API token must be configured",
      );
    if (pluginId === "forge")
      await expect(
        page.getByRole("button", { name: "Configure Forge", exact: true }),
      ).toBeVisible();
    if (pluginId === "automation")
      await expect(page.locator(".react-flow__node")).toHaveCount(2);
    if (pluginId === "local-web")
      await expect(
        page.frameLocator(".web-viewer-frame").locator("h1"),
      ).toHaveText("Release readiness");
    await capture(page, `cloudx-plugin-${pluginId}.png`, root);
  }
}

async function captureWorkspaceControls(
  page,
  baseUrl,
  template,
  project,
  root,
) {
  await showTemplate(page, baseUrl, template, project);
  await openDiff(page);
  await page
    .getByRole("button", { name: "Layout templates", exact: true })
    .click();
  await expect(page.locator(".template-menu-row")).toHaveCount(2);
  await capture(page, "cloudx-plugin-workspace-control.png", root);
  await page
    .getByRole("button", { name: "Layout templates", exact: true })
    .click();

  await request(baseUrl, "/api/hooks/notifications.send", {
    input: {
      title: "Demo review handoff",
      body: "Inspect the release diff and validation notes.",
      level: "info",
    },
  });
  await page
    .getByRole("button", { name: "1 notification", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await capture(page, "cloudx-plugin-notifications.png", root);
  await page
    .getByRole("button", { name: "1 notification", exact: true })
    .click();

  await page.context().route("**/api/hooks/codex-settings.read", (route) =>
    route.fulfill({
      json: {
        result: {
          settings: {
            revision: "a".repeat(64),
            model: "demo-model",
            serviceTier: "default",
            fastModeEnabled: true,
            yoloMode: true,
            autoTrustWorkspace: false,
            defaultSkills: [{ id: "imagegen", enabled: true, available: true }],
            reasoningEffort: null,
            webSearch: null,
            personality: null,
          },
        },
      },
    }),
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(
    settings.getByRole("tab", { name: "General", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await capture(page, "cloudx-plugin-audio-ai.png", root);
  await settings.getByRole("tab", { name: "Codex", exact: true }).click();
  await expect(
    settings.getByRole("textbox", { name: "Default model", exact: true }),
  ).toHaveValue("demo-model");
  await capture(page, "cloudx-plugin-codex-settings.png", root);
}

async function createDemoRepository(root) {
  const project = path.join(root, "release-dashboard");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, "README.md"),
    "# Release dashboard\n\nSynthetic documentation demo.\n\nReview the release gate, check the diff, and inspect the local preview before handoff.\n",
  );
  await fs.writeFile(
    path.join(project, "release-checks.ts"),
    "export function canRelease(checksPassed: boolean, approved: boolean) {\n  return checksPassed;\n}\n",
  );
  const git = (...args) =>
    execFileAsync("git", args, {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  await git("init", "--initial-branch=main");
  await git(
    "-c",
    "user.name=CloudX Demo",
    "-c",
    "user.email=demo@example.invalid",
    "add",
    ".",
  );
  await git(
    "-c",
    "user.name=CloudX Demo",
    "-c",
    "user.email=demo@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "DEMO: seed release dashboard",
  );
  const worktrees = path.join(root, "worktrees");
  await fs.mkdir(worktrees);
  await git("clone", "--bare", project, path.join(worktrees, ".bare"));
  await git(
    "--git-dir",
    path.join(worktrees, ".bare"),
    "worktree",
    "add",
    path.join(worktrees, "main"),
    "main",
  );
  await git(
    "--git-dir",
    path.join(worktrees, ".bare"),
    "worktree",
    "add",
    "-b",
    "review-release",
    path.join(worktrees, "review-release"),
  );
  await fs.writeFile(
    path.join(project, "release-checks.ts"),
    "export function canRelease(checksPassed: boolean, approved: boolean) {\n  return checksPassed && approved;\n}\n",
  );
  return project;
}

async function startCloudx(root, onCreated) {
  const { loadConfig } = await import("../apps/server/dist/config.js");
  const { buildServer, buildServices } =
    await import("../apps/server/dist/server.js");
  const { CodexTerminalSession } =
    await import("../apps/server/dist/plugins/CodexTerminalPlugin.js");
  const port = await freePort();
  const config = loadConfig({
    CLOUDX_PORT: String(port),
    CLOUDX_ALLOWED_ROOTS: root,
    CLOUDX_DATA_DIR: path.join(root, "data"),
    CLOUDX_APP_SERVER_ENABLED: "false",
    CLOUDX_AUTOMATION_START_DISABLED: "true",
    CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
    CLOUDX_ASR_URL: "http://127.0.0.1:9",
    CLOUDX_LOG_LEVEL: "silent",
  });
  const services = buildServices(config);
  services.updates = {
    status: async () => ({
      available: false,
      unavailableReason: "Updates are disabled in the screenshot demo.",
    }),
    start: async () => {
      throw new Error("Updates are disabled in the screenshot demo.");
    },
  };
  for (const [pluginId, lines] of Object.entries(terminalTranscripts)) {
    services.plugins.get(pluginId).createSession = ({ tab, controls }) =>
      new CodexTerminalSession(tab, new DemoTerminal(lines), controls);
  }
  services.documentation.summary = async () => ({
    activeDocumentCount: 2,
    activeChunkCount: 2,
  });
  services.documentation.search = async () => ({
    results: documentationResults,
  });
  services.documentation.listDocuments = async () => ({
    documents: documentationResults,
    window: { offset: 0, limit: 50, total: 2, hasMore: false },
  });
  const app = await buildServer(config, services);
  onCreated(app);
  await services.pluginContributionsReady;
  await services.automation.ready();
  for (const group of await services.automation.listGroups())
    await services.automation.deleteGroup(group.id);
  await services.config.update({
    global: { themeId: "minimalist-dark", microphoneEnabled: false },
    plugins: { documentation: { aiEnrichmentEnabled: false } },
  });
  await services.rulesSkills.saveRule({
    id: "verify-boundaries",
    description: "Verify the changed behavior",
    text: "Test the normal path and the failure boundary before handing off a change.",
  });
  await services.rulesSkills.saveSkill({
    id: "release-review",
    name: "Release review",
    description: "Review approval and validation before release.",
    instructions:
      "# Release review\n\nInspect the diff. Verify the failure path. Record the validation command and result.",
  });
  await services.rulesSkills.saveTemplate({
    id: "engineering-review",
    name: "Engineering review",
    color: "green",
    ruleIds: ["verify-boundaries"],
    skillIds: ["release-review"],
  });
  const triggers = services.triggers.list();
  const trigger = triggers.find((item) => item.id === "worktree.created");
  assert.ok(
    trigger,
    `Missing worktree creation trigger: ${triggers.map((item) => item.id).join(", ")}`,
  );
  const workflow = await services.automation.saveGroup(
    notificationWorkflow(trigger.id),
  );
  assert.equal(workflow.enabled, false);
  assert.equal(
    workflow.lastValidation.valid,
    true,
    JSON.stringify(workflow.lastValidation),
  );
  await app.listen({ host: "127.0.0.1", port });
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

class DemoTerminal {
  constructor(lines) {
    this.output = `${lines.join("\r\n")}\r\n`;
  }
  onData(listener) {
    listener(this.output);
    return () => {};
  }
  onExit() {
    return () => {};
  }
  write() {
    throw new Error("Demo terminals do not execute input.");
  }
  resize() {}
  kill() {}
  detach() {}
  async terminate() {}
}

async function createSavedTemplates(baseUrl, project, previewUrl) {
  const templates = {};
  for (const kind of ["development", "knowledge"]) {
    const state = await request(baseUrl, "/api/windows", {
      name:
        kind === "development"
          ? "Implementation & review"
          : "Knowledge & automation",
      defaultCwd: project,
    });
    const windowId = state.activeWindowId;
    const paneId = state.windows.find((window) => window.id === windowId).layout
      .activePaneId;
    const entries =
      kind === "development"
        ? [
            ["codex", "codex-terminal", "Implementation"],
            ["terminal", "standard-terminal", "Checks"],
            ["files", "file-browser", "Review diff"],
            ["web", "local-web", "Local preview"],
          ]
        : [
            ["documentation", "documentation", "Release knowledge"],
            ["rules", "rules-skills", "Engineering rules"],
            ["automation", "automation", "Review handoff"],
          ];
    const tabs = {};
    for (const [key, pluginId, title] of entries) {
      const { tab } = await request(baseUrl, "/api/tabs", {
        pluginId,
        title,
        cwd: project,
        windowId,
        paneId,
        ...(pluginId === "local-web"
          ? { initialInput: { url: previewUrl } }
          : {}),
      });
      tabs[key] = tab;
    }
    await request(
      baseUrl,
      `/api/windows/${windowId}`,
      {
        layout:
          kind === "development"
            ? developmentLayout(tabs)
            : knowledgeLayout(tabs),
      },
      "PATCH",
    );
    const { template } = await request(baseUrl, "/api/layout-templates", {
      name:
        kind === "development"
          ? "Implementation & review"
          : "Knowledge & automation",
      basePath: project,
      windowId,
    });
    assert.equal(template.tabs.length, entries.length);
    assert.ok(template.tabs.every((tab) => tab.relativeCwd === ""));
    templates[kind] = template;
  }
  return templates;
}

async function showTemplate(page, baseUrl, template, project) {
  const { window, workspace } = await request(
    baseUrl,
    `/api/layout-templates/${template.id}/apply`,
    { projectPath: project, name: template.name },
  );
  assert.ok(workspace.templates.some((item) => item.id === template.id));
  assert.equal(window.name, template.name);
  await page.goto(baseUrl);
  await expect(page.locator(".workspace-pane")).toHaveCount(
    template.name.startsWith("Implementation") ? 3 : 2,
  );
}

async function showPlugin(page, baseUrl, pluginId, title, cwd, previewUrl) {
  const state = await request(baseUrl, "/api/windows", {
    name: `${title} · demo`,
    defaultCwd: cwd,
  });
  const { tab } = await request(baseUrl, "/api/tabs", {
    pluginId,
    title,
    cwd,
    windowId: state.activeWindowId,
    paneId: state.windows.find((window) => window.id === state.activeWindowId)
      .layout.activePaneId,
    ...(pluginId === "local-web" ? { initialInput: { url: previewUrl } } : {}),
  });
  await request(
    baseUrl,
    `/api/windows/${state.activeWindowId}`,
    {
      layout: {
        root: workspacePane("plugin-demo", [tab]),
        activePaneId: "plugin-demo",
      },
    },
    "PATCH",
  );
  await page.goto(baseUrl);
}

async function openDiff(page) {
  await page
    .locator(".file-browser-panel")
    .getByRole("button", { name: /release-checks\.ts/ })
    .last()
    .click();
  await expect(page.locator(".file-browser-panel")).toContainText(
    "checksPassed && approved",
  );
}

async function searchDocumentation(page) {
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search", exact: true })
    .fill("release approval");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".documentation-panel")).toContainText(
    "Release readiness handbook",
  );
}

async function capture(page, filename, root) {
  await page.evaluate(
    ({ root }) => {
      window.cloudxDemoPathObserver?.disconnect();
      const normalize = () => {
        observer.disconnect();
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        while (walker.nextNode())
          walker.currentNode.nodeValue =
            walker.currentNode.nodeValue.replaceAll(root, "/demo");
        for (const element of document.querySelectorAll("input, textarea"))
          element.value = element.value.replaceAll(root, "/demo");
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      };
      const observer = new MutationObserver(normalize);
      window.cloudxDemoPathObserver = observer;
      normalize();
    },
    { root },
  );
  const text = await page.locator("body").innerText();
  for (const privateText of [
    root,
    os.homedir(),
    "/home/",
    "token=",
    "api_key=",
  ])
    assert.ok(
      !text.includes(privateText),
      `Private text in ${filename}: ${text.split("\n").find((line) => line.includes(privateText))}`,
    );
  await page.screenshot({
    path: path.join(screenshotDir, filename),
    animations: "disabled",
  });
  console.log(filename);
}

async function request(baseUrl, route, body, method = "POST") {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.ok(
    response.ok,
    `${route}: ${response.status} ${await response.clone().text()}`,
  );
  return response.json();
}

async function startPreview() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:0;background:#151a22;color:#e6edf3;font:16px system-ui;padding:20px}small{color:#94a3b8}h1{font-size:24px;margin:12px 0}section{display:flex;gap:16px}article{padding:16px;background:#222b38;border:1px solid #405065;border-radius:8px;flex:1}strong{display:block;margin-top:12px;color:#7dd3fc}p{color:#b6c5d6;margin:0 0 18px}</style><small>RELEASE DASHBOARD · SYNTHETIC DEMO</small><h1>Release readiness</h1><p>Review the change before opening the release gate.</p><section><article>Required checks<strong>3 / 3 passed</strong></article><article>Review approval<strong>Pending</strong></article><article>Release gate<strong>Blocked</strong></article></section></html>`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

main().catch((error) => {
  console.dir(error, { depth: 8 });
  process.exitCode = 1;
});

#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));
const { chromium } = require("@playwright/test");
const execFileAsync = promisify(execFile);

const screenshotDir = path.join(repoRoot, "docs", "screenshots");

async function main() {
  const demoRoot = await createDemoWorkspace();
  const codexFixtureBin = await createCodexFixtureBin();
  const demoSite = await startDemoSite();
  const cloudx = await startCloudxServer(demoRoot, codexFixtureBin);

  try {
    const tabs = await createDemoTabs(cloudx.baseUrl, demoRoot, demoSite.url);
    await captureScreenshots(cloudx.baseUrl, tabs, demoRoot, [demoRoot]);
  } finally {
    await Promise.allSettled([cloudx.stop(), closeServer(demoSite.server), fs.rm(codexFixtureBin, { recursive: true, force: true }), fs.rm(demoRoot, { recursive: true, force: true })]);
  }
}

async function createDemoWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-readme-demo-"));
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "README.md"),
    [
      "# Demo Workspace",
      "",
      "This file is opened through the Cloudx file browser.",
      "",
      "- Inspect files without leaving the pane layout.",
      "- Review changed files with Git diff badges.",
      "- Keep a local dashboard open beside the workspace.",
      "- Save and reopen workspace windows as layout templates.",
      "- Route voice commands through the plugin control layer.",
      ""
    ].join("\n")
  );
  await fs.writeFile(
    path.join(root, "docs", "plan.md"),
    [
      "# Operator Plan",
      "",
      "1. Open a Codex tab.",
      "2. Watch progress in another pane.",
      "3. Use voice control for pane and plugin actions.",
      ""
    ].join("\n")
  );
  await fs.writeFile(path.join(root, "docs", "notes.md"), "# Notes\n\nPublic screenshot fixture.\n");
  await fs.writeFile(path.join(root, "src", "example.ts"), "export const status = 'ready';\n");
  await initializeDemoGitRepository(root);
  await fs.appendFile(path.join(root, "README.md"), "\nStatus: README changed for the screenshot.\n");
  return root;
}

async function initializeDemoGitRepository(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "demo@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Cloudx Demo"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "Initial demo workspace"], { cwd: root });
}

async function createCodexFixtureBin() {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-readme-bin-"));
  const codexPath = path.join(binDir, "codex");
  await fs.writeFile(
    codexPath,
    [
      "#!/bin/sh",
      "printf '\\033[32mCloudx Codex demo\\033[0m\\r\\n'",
      "printf 'model: gpt-5.3-codex-spark\\r\\n'",
      "printf 'workdir: demo workspace\\r\\n\\r\\n'",
      "printf '> inspect the split pane workspace and summarize next steps\\r\\n\\r\\n'",
      "printf '%s\\r\\n' '- Reading file browser context'",
      "printf '%s\\r\\n' '- Watching local dashboard pane'",
      "printf '%s\\r\\n' '- Ready for voice-driven follow-up'",
      "while true; do sleep 60; done",
      ""
    ].join("\n")
  );
  await fs.chmod(codexPath, 0o755);
  return binDir;
}

function startDemoSite() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="dark">
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #080b11; color: #e6f5ff; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top right, #00d4ff33, transparent 30%), #080b11; }
      main { width: min(760px, calc(100vw - 48px)); border: 1px solid #00ff8870; background: #0e131dcc; padding: 28px; box-shadow: 0 0 28px #00d4ff28; }
      h1 { margin: 0 0 14px; color: #00ff88; font: 800 28px/1.1 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
      p { margin: 0 0 20px; color: #b9c7d8; line-height: 1.55; }
      .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
      .metric { border: 1px solid #2a3650; padding: 14px; background: #111827; }
      .metric strong { display: block; color: #00d4ff; font-size: 24px; }
      .metric span { color: #8896aa; font-size: 12px; text-transform: uppercase; letter-spacing: .12em; }
    </style>
  </head>
  <body>
    <main class="demo-dashboard">
      <h1>Local Dashboard</h1>
      <p>A loopback web app can live beside files and Codex tabs without leaving Cloudx.</p>
      <section class="grid" aria-label="Demo metrics">
        <div class="metric"><strong>3</strong><span>Panes</span></div>
        <div class="metric"><strong>4</strong><span>Plugins</span></div>
        <div class="metric"><strong>Live</strong><span>Status</span></div>
      </section>
    </main>
  </body>
</html>`);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Demo site did not bind to a TCP port."));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function startCloudxServer(demoRoot, codexFixtureBin) {
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-readme-data-"));
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLOUDX_APP_SERVER_ENABLED: "false",
      CLOUDX_ALLOWED_ROOTS: demoRoot,
      CLOUDX_ASR_URL: "http://127.0.0.1:9",
      CLOUDX_DATA_DIR: dataDir,
      CLOUDX_HOST: "127.0.0.1",
      CLOUDX_PORT: String(port),
      PATH: `${codexFixtureBin}${path.delimiter}${process.env.PATH ?? ""}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, () => logs);

  return {
    baseUrl,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function createDemoTabs(baseUrl, demoRoot, demoSiteUrl) {
  const codexTab = await postJson(`${baseUrl}/api/tabs`, {
    pluginId: "codex-terminal",
    cwd: demoRoot,
    title: "Codex - workspace"
  });
  const filesTab = await postJson(`${baseUrl}/api/tabs`, {
    pluginId: "file-browser",
    cwd: demoRoot,
    title: "Files - git diff"
  });
  const webTab = await postJson(`${baseUrl}/api/tabs`, {
    pluginId: "local-web",
    title: "Dashboard",
    initialInput: { url: demoSiteUrl }
  });
  const workspace = await getJson(`${baseUrl}/api/workspace`);
  await patchJson(`${baseUrl}/api/windows/${workspace.activeWindowId}`, {
    name: "Codex Work",
    defaultCwd: demoRoot,
    layout: demoLayout({ codexTab: codexTab.tab, filesTab: filesTab.tab, webTab: webTab.tab })
  });
  await postJson(`${baseUrl}/api/windows`, {
    name: "Docs Review",
    defaultCwd: demoRoot
  });
  await postJson(`${baseUrl}/api/windows/${workspace.activeWindowId}/active`, {});
  await postJson(`${baseUrl}/api/tabs/${codexTab.tab.id}/active`, {});
  return {
    codexTab: codexTab.tab,
    filesTab: filesTab.tab,
    webTab: webTab.tab
  };
}

async function captureScreenshots(baseUrl, tabs, demoRoot, forbiddenText) {
  await fs.mkdir(screenshotDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const desktopPage = await prepareScreenshotPage(browser, baseUrl, demoRoot, forbiddenText, {
      viewport: { width: 1440, height: 960 }
    });
    await desktopPage.screenshot({
      path: path.join(screenshotDir, "cloudx-split-panes.png"),
      fullPage: false
    });

    const mobilePage = await prepareScreenshotPage(browser, baseUrl, demoRoot, forbiddenText, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    await mobilePage.screenshot({
      path: path.join(screenshotDir, "cloudx-mobile-portrait.png"),
      fullPage: false
    });
  } finally {
    await browser.close();
  }
}

async function prepareScreenshotPage(browser, baseUrl, demoRoot, forbiddenText, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".workspace-pane").first().waitFor({ timeout: 10_000 });
  await page.locator('[data-pane-id="pane-codex"]').getByText("Cloudx Codex demo").waitFor({ timeout: 10_000 });
  await page.locator('[data-pane-id="pane-files"] .file-list').getByRole("button", { name: /README\.md/ }).click();
  await page.frameLocator(".web-viewer-frame").locator(".demo-dashboard").waitFor({ timeout: 10_000 });
  await page.locator('[data-pane-id="pane-codex"]').click();
  await normalizeVolatileUi(page, [{ from: demoRoot, to: "/workspace" }]);
  await assertPublicSafe(page, forbiddenText);
  return page;
}

function demoLayout(tabs) {
  return {
    root: {
      type: "split",
      id: "split-root",
      direction: "row",
      sizes: [52, 48],
      children: [
        { type: "pane", pane: { id: "pane-codex", tabIds: [tabs.codexTab.id], activeTabId: tabs.codexTab.id } },
        {
          type: "split",
          id: "split-right",
          direction: "column",
          sizes: [54, 46],
          children: [
            { type: "pane", pane: { id: "pane-files", tabIds: [tabs.filesTab.id], activeTabId: tabs.filesTab.id } },
            { type: "pane", pane: { id: "pane-web", tabIds: [tabs.webTab.id], activeTabId: tabs.webTab.id } }
          ]
        }
      ]
    },
    activePaneId: "pane-codex"
  };
}

async function normalizeVolatileUi(page, replacements) {
  await page.locator(".connection-status").evaluate((element) => {
    const icon = element.querySelector("svg");
    element.replaceChildren();
    if (icon) {
      element.appendChild(icon);
    }
    element.setAttribute("title", "connected: 127.0.0.1:3001");
    element.setAttribute("aria-label", "connected: 127.0.0.1:3001");
  });
  await page.locator(".web-viewer-toolbar input").evaluate((element) => {
    if (element instanceof HTMLInputElement) {
      element.value = "http://127.0.0.1:5173/";
    }
  });
  await page.evaluate(({ replacements }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      let value = node.nodeValue ?? "";
      for (const replacement of replacements) {
        value = value.split(replacement.from).join(replacement.to);
      }
      node.nodeValue = value;
      node = walker.nextNode();
    }
    for (const element of document.querySelectorAll("input, textarea")) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        for (const replacement of replacements) {
          element.value = element.value.split(replacement.from).join(replacement.to);
        }
      }
    }
  }, { replacements });
  await page.locator('[data-pane-id="pane-codex"] .xterm-rows > div, [data-pane-id="pane-codex"] .xterm-accessibility-tree > div').evaluateAll((rows, { replacements }) => {
    for (const row of rows) {
      let value = row.textContent ?? "";
      for (const replacement of replacements) {
        value = value.split(replacement.from).join(replacement.to);
      }
      if (value !== row.textContent) {
        row.textContent = value;
      }
    }
  }, { replacements });
  await page.locator('[data-pane-id="pane-codex"]').evaluate((pane, { replacements }) => {
    for (const element of pane.querySelectorAll("*")) {
      let value = element.textContent ?? "";
      const original = value;
      for (const replacement of replacements) {
        value = value.split(replacement.from).join(replacement.to);
      }
      if (value !== original && original.trim().startsWith("cwd:")) {
        element.textContent = value;
      }
    }
  }, { replacements });
  await page.locator('[data-pane-id="pane-codex"] .terminal-panel').evaluate((panel) => {
    const screen = panel.querySelector(".xterm-screen");
    if (!(panel instanceof HTMLElement) || !(screen instanceof HTMLElement)) {
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const rowCount = Math.max(1, panel.querySelectorAll(".xterm-rows > div").length || 24);
    const rowHeight = screenRect.height / rowCount;
    const overlay = document.createElement("div");
    overlay.textContent = "cwd: /workspace";
    overlay.style.position = "absolute";
    overlay.style.left = `${screenRect.left - panelRect.left}px`;
    overlay.style.top = `${screenRect.top - panelRect.top + rowHeight}px`;
    overlay.style.width = `${screenRect.width}px`;
    overlay.style.height = `${rowHeight}px`;
    overlay.style.zIndex = "3";
    overlay.style.overflow = "hidden";
    overlay.style.background = "#05050a";
    overlay.style.color = "#e6edf3";
    overlay.style.font = "13px / 1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    overlay.style.letterSpacing = "0";
    panel.appendChild(overlay);
  });
}

async function assertPublicSafe(page, extraForbiddenText) {
  const bodyText = await page.locator("body").innerText();
  const forbidden = [os.homedir(), process.env.USER, process.env.HOSTNAME, "/home/", "token=", ...extraForbiddenText].filter(Boolean);
  for (const value of forbidden) {
    if (bodyText.includes(value)) {
      const excerpt = bodyText.split("\n").find((line) => line.includes(value)) ?? "";
      throw new Error(`Screenshot page contains private text: ${value}\n${excerpt}`);
    }
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function waitForHealth(baseUrl, readLogs) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Cloudx server did not become healthy. Last error: ${lastError?.message ?? "none"}\n${readLogs()}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

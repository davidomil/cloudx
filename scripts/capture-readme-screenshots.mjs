#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));
const { chromium } = require("@playwright/test");

const screenshotDir = path.join(repoRoot, "docs", "screenshots");

async function main() {
  const demoRoot = await createDemoWorkspace();
  const demoSite = await startDemoSite();
  const cloudx = await startCloudxServer(demoRoot);

  try {
    const tabs = await createDemoTabs(cloudx.baseUrl, demoRoot, demoSite.url);
    await captureScreenshots(cloudx.baseUrl, tabs, [demoRoot]);
  } finally {
    await Promise.allSettled([cloudx.stop(), closeServer(demoSite.server), fs.rm(demoRoot, { recursive: true, force: true })]);
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
      "- Keep a local dashboard open beside the workspace.",
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
  return root;
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

async function startCloudxServer(demoRoot) {
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
      CLOUDX_PORT: String(port)
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
  const filesTab = await postJson(`${baseUrl}/api/tabs`, {
    pluginId: "file-browser",
    cwd: demoRoot,
    title: "FB - demo"
  });
  const webTab = await postJson(`${baseUrl}/api/tabs`, {
    pluginId: "local-web",
    title: "WEB - dashboard",
    initialInput: { url: demoSiteUrl }
  });
  const notesTab = await postJson(`${baseUrl}/api/tabs`, {
    pluginId: "file-browser",
    cwd: path.join(demoRoot, "docs"),
    title: "FB - docs"
  });
  return {
    filesTab: filesTab.tab,
    webTab: webTab.tab,
    notesTab: notesTab.tab
  };
}

async function captureScreenshots(baseUrl, tabs, forbiddenText) {
  await fs.mkdir(screenshotDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.addInitScript(
      ({ layout }) => {
        window.localStorage.setItem("cloudx-layout-v2", JSON.stringify(layout));
      },
      { layout: demoLayout(tabs) }
    );

    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".workspace-pane").first().waitFor({ timeout: 10_000 });
    await page.locator('[data-pane-id="pane-files"]').getByRole("button", { name: /README\.md/ }).click();
    await page.locator('[data-pane-id="pane-notes"]').getByRole("button", { name: /plan\.md/ }).click();
    await page.frameLocator(".web-viewer-frame").locator(".demo-dashboard").waitFor({ timeout: 10_000 });
    await normalizeVolatileUi(page);
    await assertPublicSafe(page, forbiddenText);

    await page.screenshot({
      path: path.join(screenshotDir, "cloudx-split-panes.png"),
      fullPage: false
    });

    await page.locator('[data-pane-id="pane-web"] .add-tab-button').click();
    await page.locator(".dialog").waitFor({ timeout: 5_000 });
    await assertPublicSafe(page, forbiddenText);
    await page.screenshot({
      path: path.join(screenshotDir, "cloudx-new-tab-dialog.png"),
      fullPage: false
    });
  } finally {
    await browser.close();
  }
}

function demoLayout(tabs) {
  return {
    root: {
      type: "split",
      id: "split-root",
      direction: "row",
      sizes: [52, 48],
      children: [
        { type: "pane", pane: { id: "pane-files", tabIds: [tabs.filesTab.id], activeTabId: tabs.filesTab.id } },
        {
          type: "split",
          id: "split-right",
          direction: "column",
          sizes: [54, 46],
          children: [
            { type: "pane", pane: { id: "pane-web", tabIds: [tabs.webTab.id], activeTabId: tabs.webTab.id } },
            { type: "pane", pane: { id: "pane-notes", tabIds: [tabs.notesTab.id], activeTabId: tabs.notesTab.id } }
          ]
        }
      ]
    },
    activePaneId: "pane-files"
  };
}

async function normalizeVolatileUi(page) {
  await page.locator(".connection-status").evaluate((element) => {
    element.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent = " 127.0.0.1:3001";
      }
    });
    element.setAttribute("title", "Server connected: 127.0.0.1:3001");
  });
  await page.locator(".web-viewer-toolbar input").evaluate((element) => {
    if (element instanceof HTMLInputElement) {
      element.value = "http://127.0.0.1:5173/";
    }
  });
}

async function assertPublicSafe(page, extraForbiddenText) {
  const bodyText = await page.locator("body").innerText();
  const forbidden = [os.homedir(), process.env.USER, process.env.HOSTNAME, "/home/", "token=", ...extraForbiddenText].filter(Boolean);
  for (const value of forbidden) {
    if (bodyText.includes(value)) {
      throw new Error(`Screenshot page contains private text: ${value}`);
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

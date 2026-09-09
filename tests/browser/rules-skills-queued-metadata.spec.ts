import { expect, test, type Page } from "@playwright/test";
import type { CreateTabResponse, WorkspaceStateResponse } from "@cloudx/shared";
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

test.beforeEach(async () => {
  serverLogs = "";
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-rules-queued-metadata-"),
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

for (const heldPull of ["request", "response"] as const) {
  for (const draftStarted of ["before", "during"] as const) {
    test(`a rule draft started ${draftStarted} pull preserves incoming metadata when saved while its ${heldPull} is held`, async ({
      page,
    }) => {
      const description = "Description updated by the incoming commit.";
      const localText = `Local text drafted ${draftStarted} the held pull ${heldPull}.`;
      const { oldHead, incomingHead, rulePath } =
        await createRuleUpdate(description);
      const { draftPane, pullPane } = await openCatalogPanes(page);
      const editor = draftPane.getByRole("textbox", {
        name: "Rule text for queued-rule",
        exact: true,
      });
      const saveButton = draftPane.getByRole("button", {
        name: "Save rule queued-rule",
        exact: true,
      });
      async function startRuleDraft() {
        await draftPane
          .getByRole("button", { name: "Edit rule queued-rule", exact: true })
          .click();
        await editor.fill(localText);
      }
      if (draftStarted === "before") await startRuleDraft();

      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await page.route(
        "**/api/hooks/rules-skills.git.pull",
        async (route) => {
          if (heldPull === "request") {
            held.resolve();
            await release.promise;
            await route.continue();
          } else {
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            held.resolve();
            await release.promise;
            await route.fulfill({ response });
          }
        },
        { times: 1 },
      );
      const pullResponse = page.waitForResponse(
        "**/api/hooks/rules-skills.git.pull",
      );
      const saveRequest = page.waitForRequest(
        "**/api/hooks/rules-skills.rules.save",
      );
      const saveResponse = page.waitForResponse(
        "**/api/hooks/rules-skills.rules.save",
      );
      let saveDelivered = false;
      page.on("request", (request) => {
        if (request.url().endsWith("/api/hooks/rules-skills.rules.save"))
          saveDelivered = true;
      });
      try {
        await pullPane
          .getByRole("button", { name: "Pull", exact: true })
          .click();
        await held.promise;
        if (draftStarted === "during") await startRuleDraft();
        await expect(editor).toHaveText(localText);
        await expect(draftPane.locator(".rule-option-editing")).toHaveAttribute(
          "title",
          "Original rule description.",
        );
        expect(await git(catalog, "rev-parse", "HEAD")).toBe(
          heldPull === "request" ? oldHead : incomingHead,
        );
        await expect(saveButton).toBeEnabled();
        await saveButton.click();
        await expect(saveButton).toBeDisabled();
        await expect(pullPane).toContainText("Pulling…");
        expect(saveDelivered).toBe(false);
        expect(await fs.readFile(rulePath, "utf8")).not.toContain(localText);
      } finally {
        release.resolve();
      }

      expect((await pullResponse).ok()).toBe(true);
      expect((await saveResponse).ok()).toBe(true);
      await expect(editor).toHaveCount(0);
      await expect(draftPane).toContainText("Rule saved.");
      const savedRule = await fs.readFile(rulePath, "utf8");
      expect(savedRule).toContain(localText);
      expect(savedRule).toContain(`description: ${description}`);
      expect(savedRule).not.toContain("Original rule description.");
      expect((await saveRequest).postDataJSON()).toMatchObject({
        input: { rule: { id: "queued-rule", text: localText, description } },
      });
      expect(await git(catalog, "rev-parse", "HEAD")).toBe(incomingHead);
      for (const pane of [draftPane, pullPane]) {
        const savedRow = pane
          .locator(".rule-option")
          .filter({ hasText: localText });
        await expect(savedRow).toHaveAttribute("title", description);
        await expect(
          savedRow.getByRole("button", {
            name: "Edit rule queued-rule",
            exact: true,
          }),
        ).toBeEnabled();
      }
    });
  }
}

async function createRuleUpdate(description: string) {
  const rulePath = path.join(catalog, "rules", "queued-rule.md");
  await fs.writeFile(
    rulePath,
    "---\nid: queued-rule\ndescription: Original rule description.\n---\nOriginal rule text.\n",
  );
  const remote = path.join(testRoot, "origin.git");
  await git(testRoot, "init", "--bare", "--initial-branch=main", remote);
  await git(catalog, "init", "--initial-branch=main");
  await git(catalog, "add", ".");
  await git(catalog, "commit", "-m", "Seed rule metadata fixture");
  await git(catalog, "remote", "add", "origin", remote);
  await git(catalog, "push", "origin", "main");
  const oldHead = await git(catalog, "rev-parse", "HEAD");
  const peer = path.join(testRoot, "peer");
  await git(testRoot, "clone", remote, peer);
  await fs.writeFile(
    path.join(peer, "rules", "queued-rule.md"),
    `---\nid: queued-rule\ndescription: ${description}\n---\nRemote rule text.\n`,
  );
  await git(peer, "add", "rules/queued-rule.md");
  await git(peer, "commit", "-m", "Update the rule description upstream");
  await git(peer, "push", "origin", "main");
  const incomingHead = await git(peer, "rev-parse", "HEAD");
  return { oldHead, incomingHead, rulePath };
}

async function openCatalogPanes(page: Page) {
  const workspace = (await (
    await page.request.get(`${baseUrl}/api/workspace`)
  ).json()) as WorkspaceStateResponse;
  const activeWindow = workspace.windows.find(
    (window) => window.id === workspace.activeWindowId,
  )!;
  const tabs = [];
  for (const title of ["Rule draft pane", "Pull pane"]) {
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
          activePaneId: "draft-pane",
          root: {
            type: "split",
            id: "queued-metadata-split",
            direction: "column",
            sizes: [50, 50],
            children: tabs.map((tab, index) => ({
              type: "pane",
              pane: {
                id: index === 0 ? "draft-pane" : "pull-pane",
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
    draftPane: page.locator('[data-pane-id="draft-pane"] .rules-skills-panel'),
    pullPane: page.locator('[data-pane-id="pull-pane"] .rules-skills-panel'),
  };
}

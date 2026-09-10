import { expect, test } from "@playwright/test";
import type { CreateTabResponse, WorkspaceStateResponse } from "@cloudx/shared";
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

test.afterAll(async ({}, testInfo) => {
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

  await panel.getByLabel("Origin URL").fill(remote);
  await panel.getByRole("button", { name: "Save origin" }).click();
  await expect(panel).toContainText("Origin saved.");
  const localTemplatePath = path.join(
    catalog,
    "templates",
    "default-codex.json",
  );
  const localTemplate = JSON.parse(
    await fs.readFile(localTemplatePath, "utf8"),
  );
  for (const id of ["draft-rule", "removed-rule"]) {
    await fs.writeFile(
      path.join(catalog, "rules", `${id}.md`),
      `---\nid: ${id}\ndescription: Fixture rule.\n---\nKeep ${id} changes focused.\n`,
    );
  }
  const skillDirectory = path.join(catalog, "skills", "draft-skill");
  await fs.mkdir(skillDirectory);
  await fs.writeFile(
    path.join(skillDirectory, "SKILL.md"),
    "---\nname: draft-skill\ndescription: Fixture skill.\ncloudx_name: Draft skill\n---\nReview the fixture changes.\n",
  );
  const selectedTemplate = {
    ...localTemplate,
    ruleIds: [...localTemplate.ruleIds, "draft-rule", "removed-rule"],
    skillIds: [...localTemplate.skillIds, "draft-skill"],
  };
  await fs.writeFile(
    localTemplatePath,
    `${JSON.stringify(selectedTemplate)}\n`,
  );
  await git(catalog, "add", ".");
  await git(catalog, "commit", "-m", "Seed draft recovery fixtures");
  await git(catalog, "push", "origin", "main");

  await page.goto("about:blank");
  const { tab: firstTab } = (await created.json()) as CreateTabResponse;
  const secondCreated = await page.request.post(`${baseUrl}/api/tabs`, {
    data: {
      pluginId: "rules-skills",
      title: "Draft editor",
      windowId: activeWindow.id,
      paneId: activeWindow.layout.activePaneId,
    },
  });
  expect(secondCreated.status()).toBe(201);
  const { tab: secondTab } = (await secondCreated.json()) as CreateTabResponse;
  const split = await page.request.patch(
    `${baseUrl}/api/windows/${activeWindow.id}`,
    {
      data: {
        layout: {
          activePaneId: "draft-pane",
          root: {
            type: "split",
            id: "draft-split",
            direction: "column",
            sizes: [50, 50],
            children: [
              {
                type: "pane",
                pane: {
                  id: "pull-pane",
                  tabIds: [firstTab.id],
                  activeTabId: firstTab.id,
                },
              },
              {
                type: "pane",
                pane: {
                  id: "draft-pane",
                  tabIds: [secondTab.id],
                  activeTabId: secondTab.id,
                },
              },
            ],
          },
        },
      },
    },
  );
  expect(split.status()).toBe(200);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const pullPane = page.locator(
    '[data-pane-id="pull-pane"] .rules-skills-panel',
  );
  const draftPane = page.locator(
    '[data-pane-id="draft-pane"] .rules-skills-panel',
  );
  await expect(draftPane.getByLabel("Name", { exact: true })).toHaveValue(
    selectedTemplate.name,
  );
  await expect(
    draftPane.getByRole("button", { name: "Pull", exact: true }),
  ).toBeEnabled();
  await expect(
    draftPane.getByRole("checkbox", {
      name: /^Keep removed-rule changes focused\./,
    }),
  ).toBeChecked();
  for (const timing of ["before", "during"] as const) {
    await test.step(`saving a rule draft started ${timing} another pane's pull preserves the pulled description`, async () => {
      const description = `Description pulled with a draft started ${timing} pull.`;
      const localText = `Keep local text drafted ${timing} the other pane's pull.`;
      await git(peer, "pull", "--ff-only");
      await fs.writeFile(
        path.join(peer, "rules", "draft-rule.md"),
        `---\nid: draft-rule\ndescription: ${description}\n---\nRemote rule text.\n`,
      );
      await git(peer, "add", "rules/draft-rule.md");
      await git(peer, "commit", "-m", `Update rule description ${timing} pull`);
      await git(peer, "push", "origin", "main");

      const editor = draftPane.getByRole("textbox", {
        name: "Rule text for draft-rule",
        exact: true,
      });
      async function startRuleDraft() {
        await draftPane
          .getByRole("button", { name: "Edit rule draft-rule", exact: true })
          .click();
        await editor.fill(localText);
      }
      if (timing === "before") await startRuleDraft();

      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await page.route(
        "**/api/hooks/rules-skills.git.pull",
        async (route) => {
          held.resolve();
          await release.promise;
          await route.continue();
        },
        { times: 1 },
      );
      const pulled = page.waitForResponse("**/api/hooks/rules-skills.git.pull");
      try {
        await pullPane
          .getByRole("button", { name: "Pull", exact: true })
          .click();
        await held.promise;
        if (timing === "during") await startRuleDraft();
        await expect(editor).toHaveText(localText);
      } finally {
        release.resolve();
      }
      expect((await pulled).ok()).toBe(true);
      await expect(draftPane.locator(".rule-option-editing")).toHaveAttribute(
        "title",
        description,
      );
      await expect(editor).toHaveText(localText);
      await draftPane
        .getByRole("button", { name: "Save rule draft-rule", exact: true })
        .click();
      await expect(editor).toHaveCount(0);
      const savedRule = await fs.readFile(
        path.join(catalog, "rules", "draft-rule.md"),
        "utf8",
      );
      expect(savedRule).toContain(localText);
      expect(savedRule).toContain(`description: ${description}`);

      await git(catalog, "add", "rules/draft-rule.md");
      await git(
        catalog,
        "commit",
        "-m",
        `Save rule draft started ${timing} pull`,
      );
      await git(catalog, "push", "origin", "main");
      await pullPane
        .getByRole("button", { name: "Refresh Git status", exact: true })
        .click();
      await expect(
        pullPane.getByRole("button", { name: "Pull", exact: true }),
      ).toBeEnabled();
    });
  }
  await draftPane
    .getByLabel("Name", { exact: true })
    .fill("Preserved draft template");
  await expect(draftPane.getByLabel("Name", { exact: true })).toHaveValue(
    "Preserved draft template",
  );
  await draftPane
    .getByRole("button", { name: "Edit rule draft-rule", exact: true })
    .click();
  const ruleDraft = draftPane.getByRole("textbox", {
    name: "Rule text for draft-rule",
    exact: true,
  });
  await ruleDraft.fill("Keep this unsaved rule draft.");
  await expect(draftPane.getByLabel("Name", { exact: true })).toHaveValue(
    "Preserved draft template",
  );

  await git(peer, "pull", "--ff-only");
  await git(
    peer,
    "rm",
    "rules/draft-rule.md",
    "rules/removed-rule.md",
    "skills/draft-skill/SKILL.md",
  );
  await fs.writeFile(templatePath, `${JSON.stringify(localTemplate)}\n`);
  await git(peer, "add", ".");
  await git(peer, "commit", "-m", "Remove selected catalog entries");
  await git(peer, "push", "origin", "main");
  await pullPane.getByRole("button", { name: "Pull", exact: true }).click();
  await expect(draftPane).toContainText(
    "Removed from catalog. Save to restore this rule or cancel to discard the draft.",
  );
  await expect(ruleDraft).toHaveText("Keep this unsaved rule draft.");
  await expect(draftPane.getByLabel("Name", { exact: true })).toHaveValue(
    "Preserved draft template",
  );
  await expect(
    draftPane.getByRole("button", {
      name: "Save rule draft-rule",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    draftPane.getByRole("button", {
      name: "Cancel editing draft-rule",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    draftPane.getByRole("button", { name: "Save template", exact: true }),
  ).toBeDisabled();
  await ruleDraft.scrollIntoViewIfNeeded();
  await testInfo.attach("removed-rule-draft", {
    body: await page.screenshot({
      path: testInfo.outputPath("removed-rule-draft.png"),
      animations: "disabled",
    }),
    contentType: "image/png",
  });
  await draftPane
    .getByRole("button", { name: "Save rule draft-rule", exact: true })
    .click();
  await expect(ruleDraft).toHaveCount(0);
  expect(
    await fs.readFile(path.join(catalog, "rules", "draft-rule.md"), "utf8"),
  ).toContain("Keep this unsaved rule draft.");
  const missingRule = draftPane.getByRole("checkbox", {
    name: "Missing rule removed-rule",
    exact: true,
  });
  const missingSkill = draftPane.getByRole("checkbox", {
    name: "Missing skill draft-skill",
    exact: true,
  });
  await expect(missingRule).toBeChecked();
  await expect(missingSkill).toBeChecked();
  await missingRule.scrollIntoViewIfNeeded();
  await testInfo.attach("missing-rule-reference", {
    body: await page.screenshot({
      path: testInfo.outputPath("missing-rule-reference.png"),
      animations: "disabled",
    }),
    contentType: "image/png",
  });
  await missingSkill.scrollIntoViewIfNeeded();
  await testInfo.attach("missing-template-references", {
    body: await page.screenshot({
      path: testInfo.outputPath("missing-template-references.png"),
      animations: "disabled",
    }),
    contentType: "image/png",
  });
  await missingRule.click();
  await expect(missingRule).toHaveCount(0);
  await missingSkill.click();
  await expect(missingSkill).toHaveCount(0);
  await draftPane
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(draftPane.locator(".rules-skills-save-state")).toHaveText(
    "Saved",
  );
  expect(JSON.parse(await fs.readFile(localTemplatePath, "utf8"))).toEqual({
    ...localTemplate,
    name: "Preserved draft template",
    ruleIds: [...localTemplate.ruleIds, "draft-rule"],
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});

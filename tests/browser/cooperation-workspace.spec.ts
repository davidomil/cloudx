import { expect, test } from "@playwright/test";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  CreatePluginSessionInput,
  PluginSession,
} from "@cloudx/plugin-api";
import {
  listTabLayoutPanes,
  type CooperationOperation,
  type WorkspaceTab,
} from "@cloudx/shared";

import { loadConfig } from "../../apps/server/src/config.js";
import {
  buildServer,
  buildServices,
  type AppServices,
} from "../../apps/server/src/server.js";

let root: string;
let app: FastifyInstance;
let services: AppServices;
let baseURL: string;
let first: WorkspaceTab;
let second: WorkspaceTab;

// Only model processes are simulated. App, session lifecycle, storage, routes,
// origin admission, WebSockets and the native panel all run their production code.
function fixtureAgent(input: CreatePluginSessionInput): PluginSession {
  input.tab.status = "running";
  return {
    tab: input.tab,
    write() {},
    resize() {},
    stop() {},
    detach() {},
    terminate: async () => {},
    hasExited: () => false,
    restoreInput: () => input.initialInput,
    snapshot: () => ({
      tabId: input.tab.id,
      pluginId: input.tab.pluginId,
      title: input.tab.title,
      cwd: input.cwd,
      status: "running",
    }),
    voiceContext: () => ({
      kind: "terminal",
      cwd: input.cwd,
      summary: "Deterministic browser fixture agent",
    }),
    handleAction: () => ({}),
    onData: () => () => {},
    attachTerminal: async () => ({
      screen: { data: "Browser fixture agent\r\n", cols: 100, rows: 30 },
      dispose() {},
    }),
  };
}

test.beforeAll(async () => {
  root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-cooperation-workspace-"),
  );
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("A loopback listener is required.");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const config = loadConfig({
    CLOUDX_HOST: "127.0.0.1",
    CLOUDX_PORT: String(port),
    CLOUDX_ALLOWED_ROOTS: root,
    CLOUDX_DATA_DIR: path.join(root, "data"),
    CLOUDX_LOG_LEVEL: "silent",
    CLOUDX_APP_SERVER_ENABLED: "false",
    CLOUDX_AUTOMATION_START_DISABLED: "true",
  });
  services = buildServices(config);
  const plugin = services.plugins.get("codex-terminal");
  plugin.createSession = fixtureAgent;
  plugin.restoreSession = fixtureAgent;
  services.documentation = undefined;
  services.documentationEnrichment = undefined;
  app = await buildServer(config, services);
  const window = await services.workspace!.createWindow({
    name: "Cooperation workspace",
    projectPath: root,
  });
  const pane = listTabLayoutPanes(window.layout.root)[0];
  if (!pane) throw new Error("A workspace pane is required.");
  first = (
    await services.workspaceCommands!.createTab({
      windowId: window.id,
      paneId: pane.id,
      pluginId: plugin.id,
      cwd: root,
      title: "Codex architect",
      initialInput: { agent: { providerId: "codex" } },
    })
  ).tab;
  second = (
    await services.workspaceCommands!.createTab({
      windowId: window.id,
      paneId: pane.id,
      pluginId: plugin.id,
      cwd: root,
      title: "Claude colleague",
      initialInput: { agent: { providerId: "claude" } },
    })
  ).tab;
  await app.listen({ port, host: "127.0.0.1" });
  baseURL = `http://127.0.0.1:${port}`;
});
test.afterAll(async () => {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("full workspace assigns both providers, keeps the panel, updates remote badges and retains a closed board", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseURL);
  const firstTab = page
    .locator(".tab-button")
    .filter({ has: page.locator(".tab-title", { hasText: first.title }) });
  await expect(firstTab).toBeVisible();
  await expect(firstTab.locator(".tab-indicator")).toBeVisible();
  await firstTab.locator(".tab-activation").press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Create and assign", exact: true })
    .click();
  await page
    .getByLabel("Blackboard name", { exact: true })
    .fill("Workspace architecture");
  await page
    .getByRole("menuitem", {
      name: "Create and assign blackboard",
      exact: true,
    })
    .click();
  const panel = page.getByRole("region", {
    name: "Blackboard Workspace architecture",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  const boardId = await panel.getAttribute("data-board-id");
  if (!boardId)
    throw new Error("The real board panel did not expose its identity.");
  expect(services.cooperation!.getBoard(boardId).members[0]?.tabId).toBe(
    first.id,
  );

  const secondTab = page
    .locator(".tab-button")
    .filter({ has: page.locator(".tab-title", { hasText: second.title }) });
  await secondTab.locator(".tab-activation").press("Shift+F10");
  await page
    .getByRole("menuitemradio", { name: /Workspace architecture/ })
    .click();
  await expect
    .poll(() => services.cooperation!.getBoard(boardId).members.length)
    .toBe(2);
  await expect(
    secondTab.getByRole("button", {
      name: "Open blackboard Workspace architecture",
      exact: true,
    }),
  ).toBeVisible();
  await secondTab
    .getByRole("button", {
      name: "Open blackboard Workspace architecture",
      exact: true,
    })
    .click();
  await expect(panel).toBeVisible();
  expect(
    services.sessions
      .listTabs()
      .filter((tab) => tab.pluginId === "cooperation"),
  ).toHaveLength(1);

  // A native agent can change the board while the user is in another tab.
  await firstTab.locator(".tab-activation").click();
  let board = services.cooperation!.getBoard(boardId);
  const operations: CooperationOperation[] = [
    {
      kind: "createItem",
      item: {
        id: "remote-note",
        kind: "note",
        geometry: { x: 120, y: 100, width: 280, height: 180, rotation: 0 },
        content: {
          title: "Remote design",
          blocks: [
            {
              id: "remote-block",
              revision: 1,
              text: "Which boundary owns this state?",
            },
          ],
        },
      },
    },
    {
      kind: "addReaction",
      reaction: {
        id: "remote-question",
        kind: "question",
        glyph: "?",
        description: "Inspect the ownership boundary",
        target: { kind: "item", id: "remote-note" },
      },
    },
  ];
  await services.cooperation!.apply(
    {
      schemaVersion: 1,
      operationId: "remote-change",
      boardId,
      expectedBoardRevision: board.revision,
      preconditions: [],
      operations,
      respondsToEventIds: [],
      assignmentGeneration: board.members[0]!.assignmentGeneration,
    },
    {
      kind: "agent",
      tabId: first.id,
      assignmentGeneration: board.members[0]!.assignmentGeneration,
      providerId: "codex",
    },
  );
  await expect(
    firstTab.getByRole("button", {
      name: "Open blackboard Workspace architecture, 1 open questions",
      exact: true,
    }),
  ).toBeVisible();
  await firstTab
    .getByRole("button", { name: /Open blackboard Workspace architecture/ })
    .click();
  await panel
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await expect(
    panel.getByText("Remote design", { exact: true }).last(),
  ).toBeVisible();
  await page.reload();
  await expect(panel).toBeVisible();
  expect(
    services.sessions
      .listTabs()
      .filter((tab) => tab.pluginId === "cooperation")[0]?.pluginMetadata
      ?.cooperation?.boardId,
  ).toBe(boardId);

  const forbidden = await request.post(`${baseURL}/api/cooperation/boards`, {
    headers: { origin: "https://untrusted.example" },
    data: { title: "Forbidden" },
  });
  expect(forbidden.status()).toBe(403);
  await page
    .getByRole("button", { name: `Close ${first.title}`, exact: true })
    .click();
  await expect
    .poll(() => services.cooperation!.getBoard(boardId).members.length)
    .toBe(1);
  await page
    .getByRole("button", { name: `Close ${second.title}`, exact: true })
    .click();
  await expect
    .poll(() => services.cooperation!.getBoard(boardId).status)
    .toBe("closed");
  await expect(
    panel.getByText(
      "This board is closed. Your saved work and original images remain available.",
      { exact: true },
    ),
  ).toBeVisible();
  board = services.cooperation!.getBoard(boardId);
  expect(board.items[0]?.id).toBe("remote-note");
  await testInfo.attach("workspace-closed-board", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  expect(errors).toEqual([]);
});

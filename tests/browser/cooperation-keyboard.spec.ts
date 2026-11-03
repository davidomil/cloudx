import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type { CooperationTransaction } from "@cloudx/shared";
import { BlackboardService } from "../../apps/server/src/cooperation/BlackboardService.js";
import { AgentCooperationContext } from "../../apps/server/src/cooperationAgent/AgentCooperationContext.js";
import { registerCooperationRoutes } from "../../apps/server/src/cooperationHost/CooperationRoutes.js";
import type { SessionStore } from "../../apps/server/src/sessionStore.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let api: FastifyInstance;
let web: ViteDevServer;
let boards: BlackboardService;
let root: string;
let browserUrl: string;
test.use({
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP cooperation.test 127.0.0.1",
      "--no-proxy-server",
    ],
  },
});

test.beforeAll(async () => {
  root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-cooperation-keyboard-"),
  );
  boards = new BlackboardService({ rootDir: path.join(root, "boards") });
  await boards.init();
  const contexts = new AgentCooperationContext({
    dataDir: root,
    endpoint: () => "http://127.0.0.1/api/cooperation/agent",
    binding: () => undefined,
  });
  const sessions = {
    getTab: () => {
      throw new Error("No agent tabs are assigned in this fixture.");
    },
  } as unknown as SessionStore;
  api = Fastify();
  await api.register(websocket);
  await registerCooperationRoutes(api, { boards, contexts, sessions });
  await api.listen({ port: 0, host: "127.0.0.1" });
  const address = api.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing cooperation API port");
  const target = `http://127.0.0.1:${address.port}`;
  web = await createServer({
    configFile: false,
    root: repoRoot,
    plugins: [react()],
    resolve: {
      alias: {
        "@cloudx/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      },
    },
    optimizeDeps: { entries: ["tests/browser/fixtures/cooperation.html"] },
    server: {
      host: "127.0.0.1",
      allowedHosts: ["cooperation.test"],
      port: 0,
      strictPort: false,
      proxy: {
        "/api": target,
        "/ws": { target: target.replace("http:", "ws:"), ws: true },
      },
    },
  });
  await web.listen();
  const webAddress = web.httpServer!.address();
  if (!webAddress || typeof webAddress === "string")
    throw new Error("Missing cooperation UI port");
  browserUrl = `http://cooperation.test:${webAddress.port}`;
});
test.afterAll(async () => {
  await web?.close();
  await api?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function open(page: Page, id: string) {
  await page.goto(`${browserUrl}/tests/browser/fixtures/cooperation.html`);
  await page
    .locator(`.cooperation-manager-row[data-board-id="${id}"]`)
    .getByRole("button", { name: "Open board", exact: true })
    .click();
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  const node = page.locator(
    '.cooperation-board:visible .react-flow__node[data-id="move"]',
  );
  await expect(node).toBeVisible();
  await node.focus();
  await node.press("Enter");
  await expect(node).toHaveClass(/selected/);
  return node;
}

async function create(title: string) {
  const board = await boards.createBoard({ title });
  await boards.apply(
    {
      schemaVersion: 1,
      operationId: crypto.randomUUID(),
      boardId: board.boardId,
      expectedBoardRevision: board.revision,
      preconditions: [],
      respondsToEventIds: [],
      operations: [
        {
          kind: "createItem",
          item: {
            id: "move",
            kind: "shape",
            geometry: { x: 0, y: 40, width: 180, height: 100, rotation: 0 },
            content: {
              title: "Move with arrows",
              shape: "rectangle",
              label: "Move with arrows",
            },
          },
        },
      ],
    },
    { kind: "user", userId: "local" },
  );
  return board.boardId;
}

test("keyboard movement saves with its observed revision, shows Saving until receipt and survives reload", async ({
  page,
}) => {
  const id = await create("Keyboard layout");
  const before = boards.getBoard(id);
  const node = await open(page, id);
  const transactions: CooperationTransaction[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/cooperation/boards/${id}/transactions`,
    async (route) => {
      transactions.push(route.request().postDataJSON());
      await released;
      await route.continue();
    },
  );
  try {
    await node.press("ArrowRight");
    await expect.poll(() => transactions.length).toBe(1);
    expect(transactions[0]!.expectedBoardRevision).toBe(before.revision);
    expect(transactions[0]!.preconditions).toEqual([
      {
        targetKind: "item",
        targetId: "move",
        expectedRevision: before.items[0]!.revision,
      },
    ]);
    await expect(page.locator(".cooperation-save-state:visible")).toContainText(
      "Saving",
    );
    expect(boards.getBoard(id).items[0]!.geometry.x).toBe(0);
    release();
    await expect.poll(() => boards.getBoard(id).items[0]!.geometry.x).toBe(20);
    await expect(page.locator(".cooperation-save-state:visible")).toContainText(
      "Saved",
    );
    await node.press("Shift+ArrowDown");
    await expect.poll(() => boards.getBoard(id).items[0]!.geometry.y).toBe(120);
    await expect(page.locator(".cooperation-save-state:visible")).toContainText(
      "Saved",
    );
    expect(transactions).toHaveLength(2);
    expect(transactions[1]!.expectedBoardRevision).toBe(before.revision + 1);
    const reopened = await open(page, id);
    await expect(reopened).toHaveCSS(
      "transform",
      "matrix(1, 0, 0, 1, 20, 120)",
    );
    expect(boards.getBoard(id).revision).toBe(before.revision + 2);
  } finally {
    release();
    await page.unroute(`**/api/cooperation/boards/${id}/transactions`);
  }
});

test("a concurrent edit rejects keyboard movement and retains the intended position for explicit review", async ({
  page,
}) => {
  const id = await create("Conflicting keyboard layout");
  const before = boards.getBoard(id);
  const node = await open(page, id);
  let writes = 0;
  await page.route(
    `**/api/cooperation/boards/${id}/transactions`,
    async (route) => {
      writes++;
      if (writes === 1)
        await boards.apply(
          {
            schemaVersion: 1,
            operationId: crypto.randomUUID(),
            boardId: id,
            expectedBoardRevision: before.revision,
            preconditions: [
              {
                targetKind: "item",
                targetId: "move",
                expectedRevision: before.items[0]!.revision,
              },
            ],
            respondsToEventIds: [],
            operations: [
              {
                kind: "updateItem",
                itemId: "move",
                patch: {
                  geometry: { ...before.items[0]!.geometry, x: 200, y: 180 },
                },
              },
            ],
          },
          { kind: "user", userId: "remote" },
        );
      await route.continue();
    },
  );
  await node.press("ArrowRight");
  await expect(
    page.getByText("Review local drafts · 1", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Local drafts",
  );
  await expect(node).toHaveCSS("transform", "matrix(1, 0, 0, 1, 200, 180)");
  expect(boards.getBoard(id).items[0]!.geometry).toMatchObject({
    x: 200,
    y: 180,
  });
  expect(writes).toBe(1);
  await page.locator(".cooperation-local-drafts summary").click();
  await expect(page.locator(".cooperation-local-drafts pre")).toContainText(
    '"x": 20',
  );
  await page
    .getByRole("button", { name: "Apply reviewed draft", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).items[0]!.geometry.x).toBe(20);
  await expect(
    page.getByText("Review local drafts · 1", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  expect(writes).toBe(2);
  const reopened = await open(page, id);
  await expect(reopened).toHaveCSS("transform", "matrix(1, 0, 0, 1, 20, 40)");
});

test("a failed keyboard save keeps its intended geometry as a draft until its receipt is checked and the draft is reviewed", async ({
  page,
}) => {
  const id = await create("Failed keyboard layout");
  const node = await open(page, id);
  const url = `**/api/cooperation/boards/${id}/transactions`;
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/boards/${id}/transactions`)
    )
      writes++;
  });
  await page.route(url, (route) => route.abort("failed"));
  await node.press("ArrowRight");
  await expect(
    page.getByText("Review local drafts · 1", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Local drafts",
  );
  expect(boards.getBoard(id).items[0]!.geometry.x).toBe(0);
  expect(writes).toBe(1);
  await page.locator(".cooperation-local-drafts summary").click();
  await expect(page.locator(".cooperation-local-drafts pre")).toContainText(
    '"x": 20',
  );
  await page.unroute(url);
  await page
    .getByRole("button", { name: "Check original save receipt", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply reviewed draft", exact: true }),
  ).toBeVisible();
  expect(boards.getBoard(id).items[0]!.geometry.x).toBe(0);
  expect(writes).toBe(1);
  await page
    .getByRole("button", { name: "Apply reviewed draft", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).items[0]!.geometry.x).toBe(20);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  expect(writes).toBe(2);
  const reopened = await open(page, id);
  await expect(reopened).toHaveCSS("transform", "matrix(1, 0, 0, 1, 20, 40)");
});

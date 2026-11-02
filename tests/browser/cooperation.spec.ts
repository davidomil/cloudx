import { expect, test, type Page, type TestInfo } from "@playwright/test";
import react from "@vitejs/plugin-react";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type {
  CooperationBoard,
  CooperationOperation,
  CooperationTransaction,
  WorkspaceTab,
} from "@cloudx/shared";
import { BlackboardService } from "../../apps/server/src/cooperation/BlackboardService.js";
import { AgentCooperationContext } from "../../apps/server/src/cooperationAgent/AgentCooperationContext.js";
import { registerCooperationRoutes } from "../../apps/server/src/cooperationHost/CooperationRoutes.js";
import type { SessionStore } from "../../apps/server/src/sessionStore.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let api: FastifyInstance;
let web: ViteDevServer;
let boards: BlackboardService;
let root: string;
let baseUrl: string;
let browserUrl: string;
test.use({
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP cooperation.test 127.0.0.1",
      "--no-proxy-server",
    ],
  },
});
const fixtureTabs = [
  { id: "fixture-codex", title: "Codex Architect" },
  { id: "fixture-claude", title: "Claude Reviewer", ownerPluginId: "forge" },
].map((tab) => ({
  ...tab,
  pluginId: "codex-terminal",
  cwd: "/fixture",
  status: "idle",
})) as WorkspaceTab[];

test.beforeAll(async () => {
  root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-cooperation-browser-"),
  );
  boards = new BlackboardService({ rootDir: path.join(root, "boards") });
  await boards.init();
  const contexts = new AgentCooperationContext({
    dataDir: root,
    endpoint: () => "http://127.0.0.1/api/cooperation/agent",
    binding: (tabId) =>
      fixtureTabs.some((tab) => tab.id === tabId)
        ? {
            ...boards.metadataForTab(tabId),
            providerId: tabId === "fixture-claude" ? "claude" : "codex",
          }
        : undefined,
  });
  const sessions = {
    getTab: (id: string) => {
      const tab = fixtureTabs.find((tab) => tab.id === id);
      if (!tab) throw new Error("No fixture tab");
      return tab;
    },
    agentProvider: (id: string) =>
      id === "fixture-claude" ? "claude" : "codex",
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
  baseUrl = `http://127.0.0.1:${webAddress.port}`;
  browserUrl = `http://cooperation.test:${webAddress.port}`;
});
test.afterAll(async () => {
  await web?.close();
  await api?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await page.goto(`${browserUrl}/tests/browser/fixtures/cooperation.html`);
});

async function create(
  page: Page,
  title: string,
  template = "blank",
  agent = "",
) {
  await page
    .getByRole("button", { name: "New blackboard", exact: true })
    .click();
  await page.getByLabel("Blackboard name", { exact: true }).fill(title);
  await page.getByLabel("Template", { exact: true }).selectOption(template);
  await page.getByLabel("Assign to", { exact: true }).selectOption(agent);
  await page
    .getByRole("button", { name: "Create blackboard", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: `Blackboard ${title}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  return (await page
    .locator(".cooperation-board:visible")
    .getAttribute("data-board-id"))!;
}
async function snapshot(id: string) {
  return boards.getBoard(id);
}
async function captured(page: Page, testInfo: TestInfo, name: string) {
  if (await page.locator(".cooperation-save-state:visible").count())
    await expect(
      page.locator(".cooperation-save-state:visible"),
    ).not.toContainText("Saving");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await testInfo.attach(name, {
    body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
    contentType: "image/png",
  });
}
async function apply(id: string, operations: CooperationOperation[]) {
  const board = boards.getBoard(id);
  const preconditions = (
    [
      ["item", board.items],
      ["connection", board.connections],
      ["region", board.regions],
      ["reaction", board.reactions],
      ["thread", board.threads],
    ] as const
  ).flatMap(([targetKind, records]) =>
    records.map((record) => ({
      targetKind,
      targetId: record.id,
      expectedRevision: record.revision,
    })),
  );
  const transaction: CooperationTransaction = {
    schemaVersion: 1,
    operationId: crypto.randomUUID(),
    boardId: id,
    expectedBoardRevision: board.revision,
    operations,
    preconditions,
    respondsToEventIds: [],
  };
  await boards.apply(transaction, { kind: "user", userId: "local" });
}

test("no active tool pans empty canvas and moves items; Hand pans without editing and connections follow dragging", async ({
  page,
}) => {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/transactions"))
      writes.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "warning" && message.text().includes("[React Flow]"))
      errors.push(message.text());
  });
  expect(
    await page.evaluate(() => ({
      secure: isSecureContext,
      uuid: typeof crypto.randomUUID,
    })),
  ).toEqual({ secure: false, uuid: "undefined" });
  const id = await create(page, "Natural canvas gestures");
  await apply(id, [
    {
      kind: "createItem",
      item: {
        id: "gesture-from",
        kind: "shape",
        geometry: { x: 0, y: 0, width: 180, height: 100, rotation: 0 },
        content: { title: "Source", shape: "rectangle", label: "Source" },
      },
    },
    {
      kind: "createItem",
      item: {
        id: "gesture-to",
        kind: "shape",
        geometry: { x: 360, y: 160, width: 180, height: 100, rotation: 0 },
        content: {
          title: "Destination",
          shape: "rectangle",
          label: "Destination",
        },
      },
    },
  ]);
  await page
    .getByRole("button", { name: "Fit board to view", exact: true })
    .click();
  const tools = page.getByRole("navigation", {
    name: "Blackboard tools",
    exact: true,
  });
  await expect(tools.locator('[aria-pressed="true"]')).toHaveCount(0);
  const viewport = page.locator(
    ".cooperation-board:visible .react-flow__viewport",
  );
  const pane = page.locator(".cooperation-board:visible .react-flow__pane");
  const canvas = (await pane.boundingBox())!;
  async function drag(x: number, y: number, dx: number, dy: number) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 10 });
    await page.mouse.up();
  }
  const beforePan = await viewport.getAttribute("style");
  const beforeGeometry = structuredClone(
    boards.getBoard(id).items.map((item) => item.geometry),
  );
  await drag(
    canvas.x + canvas.width * 0.5,
    canvas.y + canvas.height * 0.85,
    35,
    -25,
  );
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(beforePan);
  expect(boards.getBoard(id).items.map((item) => item.geometry)).toEqual(
    beforeGeometry,
  );
  const source = page.locator(
    '[data-item-id="gesture-from"] .cooperation-shape',
  );
  let bounds = (await source.boundingBox())!;
  await drag(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 45, 30);
  await expect
    .poll(
      () =>
        boards.getBoard(id).items.find((item) => item.id === "gesture-from")!
          .geometry.x,
    )
    .not.toBe(0);
  await page.getByRole("button", { name: "Pan (H)", exact: true }).click();
  const stored = structuredClone(
    boards.getBoard(id).items.map((item) => item.geometry),
  );
  const handViewport = await viewport.getAttribute("style");
  bounds = (await source.boundingBox())!;
  await drag(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
    40,
    -25,
  );
  await expect
    .poll(() => viewport.getAttribute("style"))
    .not.toBe(handViewport);
  expect(boards.getBoard(id).items.map((item) => item.geometry)).toEqual(
    stored,
  );
  await page.getByRole("button", { name: "Pan (H)", exact: true }).click();
  await expect(tools.locator('[aria-pressed="true"]')).toHaveCount(0);
  await page
    .getByRole("button", { name: "Connect items (L)", exact: true })
    .click();
  await source.click({ position: { x: 20, y: 20 } });
  const beforeInspect = writes.length;
  await page
    .getByRole("button", { name: "Inspect Destination", exact: true })
    .click();
  await expect(page.getByLabel("Inspector", { exact: true })).toBeVisible();
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  expect(writes).toHaveLength(beforeInspect);
  expect(boards.getBoard(id).connections).toHaveLength(0);
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .locator('[data-item-id="gesture-to"] .cooperation-shape')
    .click({ position: { x: 20, y: 20 } });
  await expect.poll(() => boards.getBoard(id).connections.length).toBe(1);
  const fromPort = page.locator(
    '[data-nodeid="gesture-from"][data-handleid="east"]',
  );
  const toPort = page.locator(
    '[data-nodeid="gesture-to"][data-handleid="west"]',
  );
  await expect(fromPort).toHaveClass(/connectablestart/);
  const fromBounds = (await fromPort.boundingBox())!;
  const toBounds = (await toPort.boundingBox())!;
  await page.mouse.move(
    fromBounds.x + fromBounds.width / 2,
    fromBounds.y + fromBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    toBounds.x + toBounds.width / 2,
    toBounds.y + toBounds.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect.poll(() => boards.getBoard(id).connections.length).toBe(2);
  expect(boards.getBoard(id).connections.at(-1)).toMatchObject({
    from: { itemId: "gesture-from", port: "east" },
    to: { itemId: "gesture-to", port: "west" },
  });
  const northPort = page.locator(
    '[data-nodeid="gesture-from"][data-handleid="north"]',
  );
  const southPort = page.locator(
    '[data-nodeid="gesture-to"][data-handleid="south"]',
  );
  await expect(northPort).toHaveClass(/connectablestart/);
  const beforePortClicks = writes.length;
  await northPort.click();
  await southPort.click();
  await expect.poll(() => boards.getBoard(id).connections.length).toBe(3);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  expect(writes).toHaveLength(beforePortClicks + 1);
  expect(boards.getBoard(id).connections.at(-1)).toMatchObject({
    from: { itemId: "gesture-from", port: "north" },
    to: { itemId: "gesture-to", port: "south" },
  });
  await expect(page.locator(".cooperation-board-error:visible")).toHaveCount(0);
  await expect(northPort).toHaveClass(/connectablestart/);
  await northPort.click();
  await page.keyboard.press("Escape");
  await expect(tools.locator('[aria-pressed="true"]')).toHaveCount(0);
  await page
    .getByRole("button", { name: "Connect items (L)", exact: true })
    .click();
  await expect(fromPort).toHaveClass(/connectablestart/);
  const beforeCancelledConnection = writes.length;
  await fromPort.click();
  await toPort.click();
  await expect.poll(() => boards.getBoard(id).connections.length).toBe(4);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  expect(writes).toHaveLength(beforeCancelledConnection + 1);
  expect(boards.getBoard(id).connections.at(-1)).toMatchObject({
    from: { itemId: "gesture-from", port: "east" },
    to: { itemId: "gesture-to", port: "west" },
  });
  await expect(page.locator(".cooperation-board-error:visible")).toHaveCount(0);
  const edge = page
    .locator(".cooperation-board:visible .react-flow__edge-path")
    .first();
  const edgePath = await edge.getAttribute("d");
  await page
    .getByRole("button", { name: "Connect items (L)", exact: true })
    .click();
  bounds = (await source.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width / 2 + 35,
    bounds.y + bounds.height / 2 + 30,
    { steps: 8 },
  );
  await expect.poll(() => edge.getAttribute("d")).not.toBe(edgePath);
  await page.mouse.up();
  await expect(
    page.locator(".cooperation-save-state:visible"),
  ).not.toContainText("Saving");
  await source.dblclick();
  await expect(page.getByLabel("Inspector", { exact: true })).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Moved source");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      () =>
        boards.getBoard(id).items.find((item) => item.id === "gesture-from")!
          .content.title,
    )
    .toBe("Moved source");
  expect(errors).toEqual([]);
});

test("Select boxes and moves a group; Pan crosses the selection and note text without editing", async ({
  page,
}) => {
  const id = await create(page, "Selection and hand gestures");
  await apply(id, [
    {
      kind: "createItem",
      item: {
        id: "group-note",
        kind: "note",
        geometry: { x: 0, y: 0, width: 220, height: 120, rotation: 0 },
        content: {
          title: "Group note",
          blocks: [
            {
              id: "group-body",
              revision: 1,
              text: "Select this text outside Pan mode.",
            },
          ],
        },
      },
    },
    {
      kind: "createItem",
      item: {
        id: "group-shape",
        kind: "shape",
        geometry: { x: 340, y: 140, width: 180, height: 100, rotation: 0 },
        content: {
          title: "Group shape",
          shape: "rectangle",
          label: "Group shape",
        },
      },
    },
  ]);
  await page
    .getByRole("button", { name: "Fit board to view", exact: true })
    .click();
  await page.getByRole("button", { name: "Select (V)", exact: true }).click();
  await page
    .getByRole("button", { name: "Collapse tools", exact: true })
    .click();
  const note = page.locator('[data-item-id="group-note"]');
  const shape = page.locator('[data-item-id="group-shape"]');
  const noteBounds = (await note.boundingBox())!;
  const shapeBounds = (await shape.boundingBox())!;
  const viewport = page.locator(
    ".cooperation-board:visible .react-flow__viewport",
  );
  const beforeSelect = await viewport.getAttribute("style");
  await page.mouse.move(noteBounds.x - 10, noteBounds.y - 10);
  await page.mouse.down();
  await page.mouse.move(
    shapeBounds.x + shapeBounds.width + 10,
    shapeBounds.y + shapeBounds.height + 10,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect(
    page.locator(".cooperation-board:visible .react-flow__node.selected"),
  ).toHaveCount(2);
  expect(await viewport.getAttribute("style")).toBe(beforeSelect);
  const group = page.locator(
    ".cooperation-board:visible .react-flow__nodesselection-rect",
  );
  let bounds = (await group.boundingBox())!;
  async function drag(x: number, y: number, dx: number, dy: number) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 10 });
    await page.mouse.up();
  }
  await drag(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 60, 40);
  await expect.poll(() => boards.getBoard(id).items[0]!.geometry.x).not.toBe(0);
  const moved = boards.getBoard(id).items.map((item) => item.geometry);
  expect(moved[1]!.x - moved[0]!.x).toBe(340);
  expect(moved[1]!.y - moved[0]!.y).toBe(140);
  await page.keyboard.press("h");
  bounds = (await group.boundingBox())!;
  const beforePan = await viewport.getAttribute("style");
  await drag(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
    25,
    -20,
  );
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(beforePan);
  expect(boards.getBoard(id).items.map((item) => item.geometry)).toEqual(moved);
  bounds = (await note.locator(".cooperation-item-text").boundingBox())!;
  const beforeTextPan = await viewport.getAttribute("style");
  await drag(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 20, 15);
  await expect
    .poll(() => viewport.getAttribute("style"))
    .not.toBe(beforeTextPan);
  expect(boards.getBoard(id).items.map((item) => item.geometry)).toEqual(moved);
  await page.keyboard.press("l");
  await note
    .locator(".cooperation-item-heading")
    .click({ position: { x: 30, y: 12 } });
  await shape
    .locator(".cooperation-shape")
    .click({ position: { x: 20, y: 20 } });
  await expect.poll(() => boards.getBoard(id).connections.length).toBe(1);
});

for (const [label, kind, shape] of [
  ["Add note (N)", "note", undefined],
  ["Add code (C)", "code", undefined],
  ["Flowchart shapes (R)", "shape", "rectangle"],
  ["Decision diamond", "shape", "diamond"],
  ["Ellipse", "shape", "ellipse"],
  ["Database cylinder", "shape", "cylinder"],
  ["Work in progress region (W)", "region", undefined],
] as const) {
  test(`HTTP LAN canvas places and edits ${shape ?? kind}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const id = await create(page, `Canvas ${shape ?? kind}`);
    if (shape)
      await page
        .getByRole("button", { name: "Flowchart shapes (R)", exact: true })
        .click();
    if (label !== "Flowchart shapes (R)")
      await page.getByRole("button", { name: label, exact: true }).click();
    const pane = page.locator(".cooperation-board:visible .react-flow__pane");
    const bounds = (await pane.boundingBox())!;
    await pane.click({
      position: { x: bounds.width * 0.6, y: bounds.height * 0.5 },
    });
    await expect
      .poll(() =>
        kind === "region"
          ? boards.getBoard(id).regions.length
          : boards.getBoard(id).items.length,
      )
      .toBe(1);
    await expect(page.getByLabel("Inspector", { exact: true })).toBeVisible();
    await page
      .getByLabel(kind === "region" ? "Region name" : "Title", { exact: true })
      .fill(`Created ${shape ?? kind}`);
    if (kind === "note" || kind === "code")
      await page
        .getByLabel("Text block 1", { exact: true })
        .fill("Saved over the LAN HTTP origin.");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(() =>
        kind === "region"
          ? boards.getBoard(id).regions[0]?.title
          : boards.getBoard(id).items[0]?.content.title,
      )
      .toBe(`Created ${shape ?? kind}`);
    if (shape)
      expect(boards.getBoard(id).items[0]).toMatchObject({
        kind: "shape",
        content: { shape },
      });
    await page
      .getByRole("button", { name: "Close drawer", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Board options", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "New board view", exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("manager and owned agent menu create, rename, assign, detach, reopen, export and delete real boards", async ({
  page,
}, testInfo) => {
  const id = await create(
    page,
    "Assignment study",
    "system-design",
    "fixture-codex",
  );
  expect((await snapshot(id)).members.map((member) => member.tabId)).toEqual([
    "fixture-codex",
  ]);
  await captured(page, testInfo, "system-design");
  await page
    .getByRole("button", { name: "Claude Reviewer", exact: true })
    .focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menu", { name: "Agent actions for Claude Reviewer" }),
  ).toBeVisible();
  await page.getByRole("menuitemradio", { name: /Assignment study/ }).click();
  await expect.poll(() => boards.getBoard(id).members.length).toBe(2);
  await page.getByRole("button", { name: "Coworkers", exact: true }).click();
  await page
    .getByLabel("Default responder", { exact: true })
    .selectOption("fixture-claude");
  await expect
    .poll(
      () =>
        boards
          .getBoard(id)
          .members.find((member) => member.role === "responder")?.tabId,
    )
    .toBe("fixture-claude");
  await page
    .getByRole("button", { name: "Detach Codex Architect", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).members.length).toBe(1);
  await page
    .getByRole("button", { name: "Detach Claude Reviewer", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reopen and assign", exact: true }),
  ).toBeVisible();
  expect(boards.getBoard(id).status).toBe("closed");
  await page
    .getByRole("button", { name: "Reopen and assign", exact: true })
    .click();
  await page
    .getByLabel("Agent tab", { exact: true })
    .selectOption("fixture-codex");
  await page
    .getByRole("button", { name: "Assign to blackboard", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).status).toBe("active");
  await page.getByRole("button", { name: "Cooperation", exact: true }).click();
  await page
    .getByRole("button", { name: "Rename Assignment study", exact: true })
    .click();
  await page
    .getByLabel("Rename blackboard", { exact: true })
    .fill("Assignment complete");
  await page
    .getByRole("button", { name: "Save blackboard name", exact: true })
    .click();
  await expect
    .poll(() => boards.getBoard(id).title)
    .toBe("Assignment complete");
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export Assignment complete", exact: true })
    .click();
  expect((await downloaded).suggestedFilename()).toBe(
    "Assignment-complete.blackboard.json",
  );
  await boards.createBoard({
    title: "Decision review",
    template: "decision-review",
    tab: {
      tabId: "fixture-claude",
      providerId: "claude",
      label: "Claude Reviewer",
    },
  });
  const savedSketch = await boards.createBoard({
    title: "Sketch exploration",
    template: "sketch-wip",
  });
  await boards.closeBoard(savedSketch.boardId);
  await captured(page, testInfo, "assignment-and-manager");
  await page
    .getByRole("button", { name: "Codex Architect", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Detach blackboard", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).status).toBe("closed");
  await page
    .getByRole("button", { name: "Refresh blackboards", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete Assignment complete", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page.locator(`.cooperation-manager-row[data-board-id="${id}"]`),
  ).toHaveCount(0);
});

test("notes, code, shapes, exact connectors, text feedback, reactions, threads and undo persist through the UI", async ({
  page,
}, testInfo) => {
  const id = await create(page, "Editing study");
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Replay boundary");
  await page
    .getByLabel("Text block 1", { exact: true })
    .fill(
      "Replay records the receipt only. It does not call the payment provider.",
    );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => boards.getBoard(id).items[0]?.content.title)
    .toBe("Replay boundary");
  const note = boards.getBoard(id).items[0]!;
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  const block = page.locator(
    `[data-cooperation-item="${note.id}"][data-cooperation-block]`,
  );
  await block.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = element.firstChild!;
    range.setStart(text, 0);
    range.setEnd(text, element.textContent!.indexOf(".") + 1);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  const quoteBounds = await block.evaluate(() => {
    const rect = getSelection()!.getRangeAt(0).getClientRects()[0]!;
    return { x: rect.left + 5, y: rect.top + 5 };
  });
  await page.mouse.click(quoteBounds.x, quoteBounds.y, { button: "right" });
  await page
    .getByRole("menuitem", { name: "Ask about selection", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("Could replay charge a customer twice?");
  await page.getByRole("button", { name: "Ask question", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Anchored discussion", exact: true }),
  ).toBeVisible();
  expect(boards.getBoard(id).threads[0]?.target.anchor?.exact).toBe(
    "Replay records the receipt only.",
  );
  await page
    .getByLabel("Reply", { exact: true })
    .fill(
      "The replay boundary is receipt processing. Payment initiation is outside it.",
    );
  await page
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  await expect
    .poll(() => boards.getBoard(id).threads[0]?.messages.length)
    .toBe(2);
  await page
    .getByRole("button", { name: "Resolve question", exact: true })
    .click();
  await expect
    .poll(() => boards.getBoard(id).threads[0]?.status)
    .toBe("resolved");
  await captured(page, testInfo, "feedback-review");
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Receipt example");
  await page.getByLabel("Code language", { exact: true }).fill("json");
  await page
    .getByLabel("Text block 1", { exact: true })
    .fill('{"receiptId":"example"}');
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      () =>
        boards.getBoard(id).items.filter((item) => item.kind === "code").length,
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Ledger worker");
  await page.getByLabel("Label", { exact: true }).fill("Ledger worker");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("From item", { exact: true }).selectOption(note.id);
  const worker = boards
    .getBoard(id)
    .items.find((item) => item.kind === "shape")!;
  await page.getByLabel("To item", { exact: true }).selectOption(worker.id);
  await page
    .getByLabel("Relation description", { exact: true })
    .fill("records accepted receipt");
  await page
    .getByRole("button", { name: "Create connection", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).connections.length).toBe(1);
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .getByRole("button", { name: "Undo my last edit", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).connections.length).toBe(0);
});

test("WIP, freehand ink, original images, collapse controls, drafts and remote conflicts remain usable in a narrow pane", async ({
  page,
}, testInfo) => {
  const id = await create(page, "Sketch study", "sketch-wip");
  await boards.assign(
    { tabId: "fixture-codex", providerId: "codex", label: "Codex Architect" },
    id,
  );
  const agentBinding = boards.assignmentForTab("fixture-codex")!;
  const outside = boards
    .getBoard(id)
    .items.find((item) => item.kind === "note")!;
  if (outside.kind === "note") {
    const before = boards.getBoard(id);
    await boards.apply(
      {
        schemaVersion: 1,
        operationId: crypto.randomUUID(),
        boardId: id,
        assignmentGeneration: agentBinding.assignmentGeneration,
        expectedBoardRevision: before.revision,
        preconditions: [
          {
            targetKind: "item",
            targetId: outside.id,
            expectedRevision: outside.revision,
          },
        ],
        operations: [
          {
            kind: "updateItem",
            itemId: outside.id,
            patch: {
              content: {
                ...outside.content,
                title: "Codex · comment outside your work area",
              },
            },
          },
        ],
        respondsToEventIds: [],
      },
      {
        kind: "agent",
        tabId: "fixture-codex",
        assignmentGeneration: agentBinding.assignmentGeneration,
      },
    );
  }
  await expect(page.locator(".changed-by-agent")).toHaveCount(1);
  await captured(page, testInfo, "sketch-work-in-progress");
  const region = boards
    .getBoard(id)
    .regions.find((region) => region.mode === "wip")!;
  await page
    .locator(`[data-testid="region-${region.id}"]`)
    .getByRole("button", { name: "Mark ready", exact: true })
    .click();
  await expect
    .poll(
      () =>
        boards
          .getBoard(id)
          .regions.find((candidate) => candidate.id === region.id)?.mode,
    )
    .toBe("ready");
  const drawingCount = boards
    .getBoard(id)
    .items.filter((item) => item.kind === "drawing").length;
  await page
    .getByRole("button", { name: "Draw freehand (P)", exact: true })
    .click();
  const bounds = (await page
    .getByLabel("Draw freehand", { exact: true })
    .boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 90);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + 150, {
    steps: 8,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "Save ink", exact: true }).click();
  await expect
    .poll(
      () =>
        boards.getBoard(id).items.filter((item) => item.kind === "drawing")
          .length,
    )
    .toBe(drawingCount + 1);
  await page.getByRole("button", { name: "Add image", exact: true }).click();
  await page
    .getByLabel("Choose board images", { exact: true })
    .setInputFiles(
      path.join(
        repoRoot,
        "docs/design/cooperation/examples/assets/reference.png",
      ),
    );
  await expect(page.getByLabel("Image drafts", { exact: true })).toHaveCount(0);
  await expect.poll(() => boards.getBoard(id).assets.length).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Select (V)", exact: true }).click();
  await page
    .getByRole("button", { name: "Fit board to view", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open original", exact: true })
    .last()
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Original image", exact: true })
      .locator("img"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close original image", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Collapse tools", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add image", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Expand tools", exact: true }).click();
  await page
    .getByRole("button", { name: "Board options", exact: true })
    .click();
  await page.getByRole("button", { name: "Snap to grid", exact: true }).click();
  await page.getByRole("button", { name: "Minimap", exact: true }).click();
  await expect(page.locator(".react-flow__minimap:visible")).toBeVisible();
  await page
    .getByRole("button", { name: "AI change marks", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Board options", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Unfinished draft");
  await page.getByRole("button", { name: "Cooperation", exact: true }).click();
  await page.getByRole("button", { name: "Sketch study", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Unfinished draft",
  );
  const selected = boards.getBoard(id).items.at(-1)!;
  if (selected.kind === "note")
    await apply(id, [
      {
        kind: "updateItem",
        itemId: selected.id,
        patch: { content: { ...selected.content, title: "Coworker edit" } },
      },
    ]);
  await expect(page.getByRole("alert")).toContainText("This record changed");
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 640, height: 820 });
  await captured(page, testInfo, "narrow-inspector-draft");
  await page
    .getByRole("button", {
      name: "Discard draft and load current record",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Coworker edit",
  );
  await page.getByRole("button", { name: "Focus canvas", exact: true }).click();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await captured(page, testInfo, "narrow-focus-canvas");
});

test("inspector editing covers blocks, every shape, geometry, ports and manual route points", async ({
  page,
}) => {
  const id = await create(page, "Inspector controls");
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Acceptance boundary");
  await page
    .getByLabel("Text block 1", { exact: true })
    .fill("Only accepted receipts reach the ledger.");
  await page
    .getByRole("button", { name: "Add text block", exact: true })
    .click();
  await page
    .getByLabel("Text block 2", { exact: true })
    .fill("Evidence still needed.");
  await page
    .getByRole("button", { name: "Remove text block 2", exact: true })
    .click();
  await page.getByText("Position and size", { exact: true }).click();
  await page.getByLabel("Geometry x", { exact: true }).fill("40");
  await page.getByLabel("Geometry y", { exact: true }).fill("60");
  await page.getByLabel("Geometry width", { exact: true }).fill("380");
  await page.getByLabel("Geometry height", { exact: true }).fill("200");
  await page.getByLabel("Geometry rotation", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => boards.getBoard(id).items[0]?.geometry.rotation)
    .toBe(15);
  const note = boards.getBoard(id).items[0]!;
  await page.getByLabel("Title", { exact: true }).fill("Discard this wording");
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Acceptance boundary",
  );
  await page.getByLabel("Text block 1", { exact: true }).press("n");
  expect(boards.getBoard(id).items).toHaveLength(1);
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Receipt gate");
  await page.getByLabel("Label", { exact: true }).fill("Receipt valid?");
  for (const shape of ["diamond", "ellipse", "cylinder", "rectangle"]) {
    await page.getByLabel("Shape", { exact: true }).selectOption(shape);
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(() => {
        const item = boards
          .getBoard(id)
          .items.find((item) => item.kind === "shape");
        return item?.kind === "shape" ? item.content.shape : undefined;
      })
      .toBe(shape);
  }
  const gate = boards.getBoard(id).items.find((item) => item.kind === "shape")!;
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("From item", { exact: true }).selectOption(note.id);
  await page.getByLabel("From port", { exact: true }).selectOption("south");
  await page.getByLabel("To item", { exact: true }).selectOption(gate.id);
  await page.getByLabel("To port", { exact: true }).selectOption("north");
  await page
    .getByLabel("Relation description", { exact: true })
    .fill("Checks accepted receipts");
  await page.getByLabel("Direction", { exact: true }).selectOption("both");
  await page
    .getByRole("button", { name: "Create connection", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).connections.length).toBe(1);
  const relation = page.locator(".cooperation-outline-record").filter({
    has: page.locator("summary", { hasText: "Checks accepted receipts" }),
  });
  await relation.locator("summary").click();
  await relation
    .getByRole("button", { name: "Inspect / edit", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add route point", exact: true })
    .click();
  await page.getByLabel("Route 1 x", { exact: true }).fill("520");
  await page.getByLabel("Route 1 y", { exact: true }).fill("180");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => boards.getBoard(id).connections[0]?.waypoints)
    .toEqual([[520, 180]]);
  expect(boards.getBoard(id).connections[0]).toMatchObject({
    direction: "both",
    from: { port: "south" },
    to: { port: "north" },
  });
  await page
    .getByRole("button", { name: "Remove route point 1", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => boards.getBoard(id).connections[0]?.waypoints)
    .toEqual([]);
  await page
    .getByRole("button", { name: "Delete connection", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).connections.length).toBe(0);
});

test("all emotes can be edited, messages retain sources, and deleted targets can be explicitly reattached", async ({
  page,
}, testInfo) => {
  const id = await create(page, "Feedback controls", "decision-review");
  const note = boards
    .getBoard(id)
    .items.find((item) => item.id === "unicode-note")!;
  const node = page.locator(`[data-item-id="${note.id}"]`);
  for (const [label, description] of [
    ["Agree", "Looks good"],
    ["Concern", "Needs a receipt example"],
    ["Idea", "Show the audit boundary"],
    ["Custom emote", "Inspect the source"],
  ]) {
    if (
      await page
        .getByRole("button", { name: "Close drawer", exact: true })
        .count()
    )
      await page
        .getByRole("button", { name: "Close drawer", exact: true })
        .click();
    await node.click({ button: "right" });
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    if (label === "Custom emote")
      await page.getByLabel("Custom emote", { exact: true }).fill("🔎");
    await page
      .getByLabel("Feedback description", { exact: true })
      .fill(description!);
    await page
      .getByRole("button", { name: "Add reaction", exact: true })
      .click();
    await expect
      .poll(() =>
        boards
          .getBoard(id)
          .reactions.some((reaction) => reaction.description === description),
      )
      .toBe(true);
  }
  await page
    .getByRole("button", { name: "Edit reaction: Looks good", exact: true })
    .click();
  await page
    .getByLabel("Edit reaction", { exact: true })
    .fill("Agreed on the outcome");
  await page
    .getByRole("button", { name: "Save reaction", exact: true })
    .click();
  await expect
    .poll(() =>
      boards
        .getBoard(id)
        .reactions.some(
          (reaction) => reaction.description === "Agreed on the outcome",
        ),
    )
    .toBe(true);
  await page
    .getByRole("button", {
      name: "Remove reaction: Inspect the source",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      boards
        .getBoard(id)
        .reactions.some(
          (reaction) => reaction.description === "Inspect the source",
        ),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await node.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Ask a question", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("Which receipt is authoritative?");
  await page.getByRole("button", { name: "Ask question", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Anchored discussion", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Resolve question", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reopen question", exact: true })
    .click();
  await page
    .getByLabel("Reply", { exact: true })
    .fill("Proposal: use the durable provider receipt as the boundary.");
  await page.getByText("Sources and response", { exact: true }).click();
  await page
    .getByLabel("Sources · one per line", { exact: true })
    .fill("https://example.test/receipt-contract\nlocal:receipt-contract.md");
  await page
    .getByRole("checkbox", { name: "Request a response", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  await expect
    .poll(
      () =>
        boards
          .getBoard(id)
          .threads.find(
            (thread) =>
              thread.messages[0]?.text === "Which receipt is authoritative?",
          )
          ?.messages.at(-1)?.sourceRefs,
    )
    .toEqual([
      "https://example.test/receipt-contract",
      "local:receipt-contract.md",
    ]);
  await captured(page, testInfo, "feedback-sources");
  const thread = boards
    .getBoard(id)
    .threads.find(
      (thread) =>
        thread.messages[0]?.text === "Which receipt is authoritative?",
    )!;
  await apply(id, [{ kind: "deleteItem", itemId: note.id }]);
  await expect(
    page.getByText("Removed target · retained evidence", { exact: true }),
  ).toBeVisible();
  await page
    .getByText("Removed target · retained evidence", { exact: true })
    .click();
  await expect(page.locator(".cooperation-tombstone")).toContainText(
    "🔎 Review café receipt routing with Claude.",
  );
  await page
    .getByRole("button", { name: "Choose a new target", exact: true })
    .click();
  await page
    .getByLabel("New target item", { exact: true })
    .selectOption("provider-shape");
  await page
    .getByRole("button", { name: "Attach to whole item", exact: true })
    .click();
  await expect
    .poll(
      () =>
        boards
          .getBoard(id)
          .threads.find((candidate) => candidate.id === thread.id)?.target,
    )
    .toEqual({ kind: "item", id: "provider-shape" });
});

test("paste, drop, upload failures, disconnect drafts and uncertain save receipts keep one predictable document", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const id = await create(page, "Recovery controls");
  const surface = page.locator(".cooperation-board:visible");
  await surface.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "A pasted design note.");
    data.setData(
      "text/html",
      '<img src="https://untrusted.example.test/tracker.png">',
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(() => boards.getBoard(id).items.length).toBe(1);
  const imageBase64 = (
    await fs.readFile(
      path.join(
        repoRoot,
        "docs/design/cooperation/examples/assets/reference.png",
      ),
    )
  ).toString("base64");
  await page.route(`**/api/cooperation/boards/${id}/assets`, (route) =>
    route.fulfill({
      status: 400,
      json: {
        code: "ASSET_INVALID",
        message: "Fixture image validation refused this upload.",
      },
    }),
  );
  await surface.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, imageBase64);
  await expect(
    page.getByText("Fixture image validation refused this upload.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await page.unroute(`**/api/cooperation/boards/${id}/assets`);
  await page
    .getByRole("button", { name: "Upload image draft", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).assets.length).toBe(1);
  await expect(page.getByLabel("Image drafts", { exact: true })).toHaveCount(0);
  await surface.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    element.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
        clientX: 500,
        clientY: 400,
      }),
    );
  }, imageBase64);
  await expect.poll(() => boards.getBoard(id).assets.length).toBe(2);
  for (const socket of api.websocketServer.clients)
    socket.close(1001, "Fixture disconnect");
  await expect(
    page.locator(".cooperation-connection-banner:visible"),
  ).toContainText("Disconnected");
  const beforeDraft = boards.getBoard(id).items.length;
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await expect(
    page.getByText("Review local drafts · 1", { exact: true }),
  ).toBeVisible();
  expect(boards.getBoard(id).items.length).toBe(beforeDraft);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(
    page.locator(".cooperation-connection-banner:visible"),
  ).toHaveCount(0);
  await page.locator(".cooperation-local-drafts summary").click();
  await page
    .getByRole("button", { name: "Apply reviewed draft", exact: true })
    .click();
  await expect
    .poll(() => boards.getBoard(id).items.length)
    .toBe(beforeDraft + 1);
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  let mutations = 0;
  await page.route(
    `**/api/cooperation/boards/${id}/transactions`,
    async (route) => {
      mutations++;
      await route.fetch({
        url: route.request().url().replace(browserUrl, baseUrl),
      });
      await route.abort("failed");
    },
  );
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await expect(
    page.getByText("Review local drafts · 1", { exact: true }),
  ).toBeVisible();
  await page.locator(".cooperation-local-drafts summary").click();
  await expect(
    page.getByRole("button", {
      name: "Check original save receipt",
      exact: true,
    }),
  ).toBeVisible();
  await page.unroute(`**/api/cooperation/boards/${id}/transactions`);
  await page
    .getByRole("button", { name: "Check original save receipt", exact: true })
    .click();
  await expect(
    page.getByText("Review local drafts · 1", { exact: true }),
  ).toHaveCount(0);
  expect(mutations).toBe(1);
  expect(boards.getBoard(id).items.length).toBe(beforeDraft + 2);
});

test("touch assignment, template creation, theme changes and keyboard focus use the same working controls", async ({
  page,
}, testInfo) => {
  const agent = page.getByRole("button", {
    name: "Claude Reviewer",
    exact: true,
  });
  const bounds = (await agent.boundingBox())!;
  await agent.dispatchEvent("pointerdown", {
    pointerType: "touch",
    pointerId: 10,
    button: 0,
    clientX: bounds.x + 5,
    clientY: bounds.y + 5,
  });
  await expect(
    page.getByRole("menu", {
      name: "Agent actions for Claude Reviewer",
      exact: true,
    }),
  ).toBeVisible();
  await agent.dispatchEvent("pointerup", {
    pointerType: "touch",
    pointerId: 10,
  });
  await page
    .getByRole("menuitem", { name: "Create and assign", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Cancel creation", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Create and assign", exact: true })
    .click();
  await page
    .getByLabel("Blackboard name", { exact: true })
    .fill("Touch design");
  await page
    .getByLabel("Template", { exact: true })
    .selectOption("decision-review");
  await page
    .getByRole("menuitem", {
      name: "Create and assign blackboard",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Blackboard Touch design", exact: true }),
  ).toBeVisible();
  const id = (await page
    .locator(".cooperation-board:visible")
    .getAttribute("data-board-id"))!;
  expect(boards.getBoard(id).members.map((member) => member.tabId)).toEqual([
    "fixture-claude",
  ]);
  await page
    .getByLabel("Fixture theme", { exact: true })
    .selectOption("minimalist-dark");
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page
    .getByLabel("Search board outline", { exact: true })
    .fill("unicode-note");
  await expect(
    page
      .locator(".cooperation-outline-record summary")
      .filter({ hasText: "Anchor example" }),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".cooperation-outline-record summary")
      .filter({ hasText: "Payment provider" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page.getByRole("button", { name: "Coworkers", exact: true }).click();
  await page
    .getByRole("button", { name: "Assign agent tab", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Assign Touch design",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(
      () => document.activeElement?.closest('[role="dialog"]') !== null,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Focus canvas", exact: true }).click();
  await captured(page, testInfo, "minimalist-dark-focus");
});

test("multi-selection alignment, WIP grouping and inspector Ready produce the expected durable region notice", async ({
  page,
}) => {
  const id = await create(
    page,
    "Grouping controls",
    "system-design",
    "fixture-codex",
  );
  const first = boards
    .getBoard(id)
    .items.find((item) => item.id === "checkout-api")!;
  await apply(id, [
    {
      kind: "updateItem",
      itemId: first.id,
      patch: { geometry: { ...first.geometry, y: first.geometry.y + 40 } },
    },
  ]);
  await page.locator('[data-item-id="checkout-api"]').click();
  await page.keyboard.down("Control");
  await page.locator('[data-item-id="event-queue"]').click();
  await page.keyboard.up("Control");
  await expect(
    page.getByRole("button", { name: "Align top", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Align top", exact: true }).click();
  await expect
    .poll(() => {
      const board = boards.getBoard(id);
      return (
        board.items.find((item) => item.id === "checkout-api")!.geometry.y ===
        board.items.find((item) => item.id === "event-queue")!.geometry.y
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: "Align left", exact: true }).click();
  await expect
    .poll(() => {
      const board = boards.getBoard(id);
      return (
        board.items.find((item) => item.id === "checkout-api")!.geometry.x ===
        board.items.find((item) => item.id === "event-queue")!.geometry.x
      );
    })
    .toBe(true);
  await page
    .getByRole("button", { name: "Undo my last edit", exact: true })
    .click();
  await expect
    .poll(
      () =>
        boards.getBoard(id).items.find((item) => item.id === "event-queue")!
          .geometry.x,
    )
    .toBe(560);
  await page
    .getByRole("button", { name: "Group in WIP region", exact: true })
    .click();
  await page.getByLabel("Region name", { exact: true }).fill("Checkout sketch");
  await page.getByLabel("Region state", { exact: true }).selectOption("ready");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      () =>
        boards
          .getBoard(id)
          .regions.find((region) => region.title === "Checkout sketch")?.mode,
    )
    .toBe("ready");
  const region = boards
    .getBoard(id)
    .regions.find((region) => region.title === "Checkout sketch")!;
  expect(
    boards
      .inbox(id)
      .filter(
        (event) => event.kind === "ready" && event.target.id === region.id,
      ),
  ).toHaveLength(1);
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  const entry = page
    .locator(".cooperation-outline-record")
    .filter({ has: page.locator("summary", { hasText: "Checkout sketch" }) });
  await entry.locator("summary").click();
  await entry
    .getByRole("button", { name: "Select region contents", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Align top", exact: true }),
  ).toBeVisible();
});

test("feedback and reply drafts survive drawer and target changes, and an unassigned question stays in the inbox", async ({
  page,
}, testInfo) => {
  const id = await create(
    page,
    "Decision review",
    "decision-review",
    "fixture-claude",
  );
  const proposal = page.locator('[data-item-id="review-decision"]');
  const askProposal = async () => {
    const block = proposal.locator('[data-cooperation-block="review-replay"]');
    await block.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await page
      .getByRole("button", { name: "Ask about selection", exact: true })
      .click();
  };
  await askProposal();
  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("Can this receipt replay initiate a second payment?");
  await page.getByLabel("Responder", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .locator('[data-item-id="unicode-note"]')
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Ask a question", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Question", exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await askProposal();
  await expect(
    page.getByRole("textbox", { name: "Question", exact: true }),
  ).toHaveValue("Can this receipt replay initiate a second payment?");
  await expect(page.getByLabel("Responder", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Ask question", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Anchored discussion", exact: true }),
  ).toBeVisible();
  const thread = boards
    .getBoard(id)
    .threads.find(
      (thread) =>
        thread.messages[0]?.text ===
        "Can this receipt replay initiate a second payment?",
    )!;
  expect(
    boards.inbox(id).find((event) => event.threadId === thread.id),
  ).toMatchObject({ state: "needsResponder" });
  expect(
    boards.inbox(id).find((event) => event.threadId === thread.id),
  ).not.toHaveProperty("recipientTabId");
  await page
    .getByLabel("Reply", { exact: true })
    .fill(
      "Replay processes the stored receipt. It must not initiate a new payment.",
    );
  await page.getByText("Sources and response", { exact: true }).click();
  await page
    .getByLabel("Sources · one per line", { exact: true })
    .fill("local:receipt-boundary.md");
  await page
    .getByRole("checkbox", { name: "Request a response", exact: true })
    .check();
  await page.getByLabel("Reply responder", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .getByRole("button", { name: "Activity and sources", exact: true })
    .click();
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .getByRole("button", {
      name: "question: Can this receipt replay initiate a second payment?",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Reply", { exact: true })).toHaveValue(
    "Replay processes the stored receipt. It must not initiate a new payment.",
  );
  await page.getByText("Sources and response", { exact: true }).click();
  await expect(
    page.getByLabel("Sources · one per line", { exact: true }),
  ).toHaveValue("local:receipt-boundary.md");
  await expect(
    page.getByRole("checkbox", { name: "Request a response", exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel("Reply responder", { exact: true })).toHaveValue(
    "",
  );
  await captured(page, testInfo, "decision-review-draft");
  await page
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  await expect
    .poll(
      () =>
        boards
          .getBoard(id)
          .threads.find((candidate) => candidate.id === thread.id)?.messages
          .length,
    )
    .toBe(2);
  expect(
    boards
      .inbox(id)
      .filter((event) => event.threadId === thread.id)
      .every(
        (event) => event.state === "needsResponder" && !event.recipientTabId,
      ),
  ).toBe(true);
  await page.locator(".cooperation-drawer-content").evaluate((element) => {
    element.scrollTop = 0;
  });
  await captured(page, testInfo, "decision-review");
});

test("real view retirement releases uncommitted image stages and preserves originals with committed receipts", async ({
  page,
}) => {
  const original = await fs.readFile(
    path.join(
      repoRoot,
      "docs/design/cooperation/examples/assets/reference.png",
    ),
  );
  const stagesFor = async (boardId: string) =>
    Object.values(
      JSON.parse(
        await fs.readFile(path.join(root, "boards/state.json"), "utf8"),
      ).stagedAssets as Record<string, { boardId: string }>,
    ).filter((stage) => stage.boardId === boardId).length;
  const upload = async () =>
    page
      .locator('.cooperation-board:visible input[type="file"]')
      .setInputFiles({
        name: "retired.png",
        mimeType: "image/png",
        buffer: original,
      });
  const failedId = await create(page, "Retired image");
  await page.route(
    `**/api/cooperation/boards/${failedId}/transactions`,
    (route) =>
      route.fulfill({
        status: 409,
        json: {
          code: "REVISION_CONFLICT",
          message: "Fixture rejected the attachment before commit.",
        },
      }),
  );
  await upload();
  await expect(
    page.getByText(
      "Image not saved. Your original file remains in this local draft.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await stagesFor(failedId)).toBe(1);
  await page
    .getByRole("button", { name: "Close Retired image view", exact: true })
    .click();
  await expect.poll(() => stagesFor(failedId)).toBe(0);
  expect(boards.getBoard(failedId).assets).toHaveLength(0);
  await page.unroute(`**/api/cooperation/boards/${failedId}/transactions`);

  const savedId = await create(page, "Committed image");
  await page.route(
    `**/api/cooperation/boards/${savedId}/transactions`,
    async (route) => {
      await route.fetch({
        url: route.request().url().replace(browserUrl, baseUrl),
      });
      await route.abort("failed");
    },
  );
  await upload();
  await expect(
    page.getByText(
      "Image not saved. Your original file remains in this local draft.",
      { exact: true },
    ),
  ).toBeVisible();
  const saved = boards.getBoard(savedId);
  expect(saved.assets).toHaveLength(1);
  await page
    .getByRole("button", { name: "Close Committed image view", exact: true })
    .click();
  await expect.poll(() => stagesFor(savedId)).toBe(0);
  const asset = await page.request.get(
    `${baseUrl}/api/cooperation/boards/${savedId}/assets/${saved.assets[0]!.id}`,
  );
  expect(asset.status()).toBe(200);
  expect(await asset.body()).toEqual(original);
  await page.unroute(`**/api/cooperation/boards/${savedId}/transactions`);

  const lateId = await create(page, "Late image");
  let arrived!: () => void;
  let release!: () => void;
  const staged = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/cooperation/boards/${lateId}/assets`,
    async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace(browserUrl, baseUrl),
      });
      arrived();
      await released;
      await route.fulfill({ response });
    },
  );
  await upload();
  await staged;
  expect(await stagesFor(lateId)).toBe(1);
  await page
    .getByRole("button", { name: "Close Late image view", exact: true })
    .click();
  release();
  await expect.poll(() => stagesFor(lateId)).toBe(0);
  expect(boards.getBoard(lateId).items).toHaveLength(0);
});

test("Undo skips addressed questions and keeps their discussion and native delivery evidence", async ({
  page,
}) => {
  const id = await create(page, "Editable undo", "blank", "fixture-codex");
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await expect.poll(() => boards.getBoard(id).items.length).toBe(1);
  const note = boards.getBoard(id).items[0]!;
  await page.getByLabel("Title", { exact: true }).fill("Editable proposal");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => boards.getBoard(id).items[0]?.content.title)
    .toBe("Editable proposal");
  await page.getByRole("button", { name: "Add feedback", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("Ask the assigned architect");
  await page.getByRole("button", { name: "Ask question", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Anchored discussion", exact: true }),
  ).toBeVisible();
  expect(boards.inbox(id).at(-1)).toMatchObject({
    state: "queued",
    recipientTabId: "fixture-codex",
  });
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .getByRole("button", { name: "Undo my last edit", exact: true })
    .click();
  await expect
    .poll(
      () =>
        boards.getBoard(id).items.find((item) => item.id === note.id)?.content
          .title,
    )
    .toBe("New note");
  expect(boards.getBoard(id).threads.at(-1)?.messages[0]?.text).toBe(
    "Ask the assigned architect",
  );
  expect(boards.inbox(id).at(-1)).toMatchObject({
    state: "queued",
    recipientTabId: "fixture-codex",
  });
});

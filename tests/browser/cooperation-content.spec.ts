import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
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
let baseUrl: string;
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
    path.join(os.tmpdir(), "cloudx-cooperation-content-"),
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
    throw new Error("Missing content API port");
  const target = `http://127.0.0.1:${address.port}`;
  web = await createServer({
    configFile: false,
    root: repoRoot,
    cacheDir: path.join(root, "vite-cache"),
    plugins: [react()],
    resolve: {
      alias: {
        "@cloudx/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      },
    },
    optimizeDeps: { entries: ["tests/browser/fixtures/cooperation.html"] },
    server: {
      hmr: false,
      watch: null,
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
    throw new Error("Missing content UI port");
  browserUrl = `http://cooperation.test:${webAddress.port}`;
  baseUrl = `http://127.0.0.1:${webAddress.port}`;
});
test.afterAll(async () => {
  await web?.close();
  await api?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function createBoard(page: Page, title: string) {
  await page.goto(`${browserUrl}/tests/browser/fixtures/cooperation.html`);
  await page
    .getByRole("button", { name: "New blackboard", exact: true })
    .click();
  await page.getByLabel("Blackboard name", { exact: true }).fill(title);
  await page
    .getByRole("button", { name: "Create blackboard", exact: true })
    .click();
  const surface = page.getByRole("region", {
    name: `Blackboard ${title}`,
    exact: true,
  });
  await expect(surface).toBeVisible();
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  return (await surface.getAttribute("data-board-id"))!;
}

async function boardViewport(page: Page) {
  return page
    .locator(".cooperation-board:visible .react-flow__viewport")
    .evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      const canvas = element
        .closest(".cooperation-canvas")!
        .getBoundingClientRect();
      return {
        x: matrix.e,
        y: matrix.f,
        zoom: matrix.a,
        left: canvas.left,
        top: canvas.top,
      };
    });
}

function wave() {
  const bytes = Buffer.alloc(44 + 8000);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(8000, 40);
  bytes.fill(128, 44);
  return bytes;
}

async function video(page: Page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) =>
      chunks.push(event.data),
    );
    const stopped = new Promise<void>((resolve) =>
      recorder.addEventListener("stop", () => resolve(), { once: true }),
    );
    recorder.start();
    await new Promise<void>((resolve) => {
      let frame = 0;
      const timer = setInterval(() => {
        context.fillStyle = frame++ % 2 ? "red" : "blue";
        context.fillRect(0, 0, 32, 32);
        if (frame === 6) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  });
  return Buffer.from(base64, "base64");
}

test("users share original images, PDFs, binary files, audio and video through the same board", async ({
  page,
}, testInfo) => {
  const id = await createBoard(page, "Shared originals");
  const files = [
    {
      name: "reference.png",
      mimeType: "image/png",
      buffer: await fs.readFile(
        path.join(
          repoRoot,
          "docs/design/cooperation/examples/assets/reference.png",
        ),
      ),
    },
    {
      name: "review.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\nOriginal review evidence\n%%EOF\n"),
    },
    {
      name: "evidence.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0, 1, 255, 128]),
    },
    { name: "recording.wav", mimeType: "audio/wav", buffer: wave() },
    { name: "demo.webm", mimeType: "video/webm", buffer: await video(page) },
  ];
  await page
    .getByLabel("Choose board files", { exact: true })
    .setInputFiles(files);
  await expect.poll(() => boards.getBoard(id).assets.length).toBe(files.length);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  expect(boards.getBoard(id).items.map((item) => item.kind)).toEqual([
    "image",
    "file",
    "file",
    "file",
    "file",
  ]);
  for (const original of files) {
    const item = boards
      .getBoard(id)
      .items.find((item) => item.content.title === original.name)!;
    expect(item.kind === "image" || item.kind === "file").toBe(true);
    if (item.kind !== "image" && item.kind !== "file")
      throw new Error("Missing original item");
    const response = await page.request.get(
      `${baseUrl}/api/cooperation/boards/${id}/assets/${item.content.assetId}?download=1`,
    );
    expect(response.status()).toBe(200);
    expect(response.headers()["content-disposition"]).toContain("attachment");
    expect(await response.body()).toEqual(original.buffer);
  }
  const audioItem = boards
    .getBoard(id)
    .items.find((item) => item.content.title === "recording.wav")!;
  const audio = page.locator(`[data-item-id="${audioItem.id}"] audio`);
  await expect(audio).toHaveAttribute("controls", "");
  await audio.evaluate(async (element) => {
    const media = element as HTMLAudioElement;
    media.muted = true;
    await media.play();
  });
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).currentTime),
    )
    .toBeGreaterThan(0);
  await audio.evaluate((element) => {
    const media = element as HTMLAudioElement;
    media.pause();
    media.currentTime = 0.5;
  });
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).currentTime),
    )
    .toBeCloseTo(0.5, 1);
  const videoItem = boards
    .getBoard(id)
    .items.find((item) => item.content.title === "demo.webm")!;
  const player = page.locator(`[data-item-id="${videoItem.id}"] video`);
  await player.evaluate(async (element) => {
    const media = element as HTMLVideoElement;
    media.muted = true;
    await media.play();
  });
  await expect
    .poll(() =>
      player.evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0);
  await player.evaluate((element) => (element as HTMLVideoElement).pause());
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  const binary = page.locator(".cooperation-outline-record").filter({
    has: page.locator("summary", {
      hasText: boards
        .getBoard(id)
        .items.find((item) => item.content.title === "evidence.bin")!.id,
    }),
  });
  await binary.locator("summary").click();
  const downloadEvent = page.waitForEvent("download");
  await binary
    .getByRole("link", { name: "Download original", exact: true })
    .click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("evidence.bin");
  expect(await fs.readFile((await download.path())!)).toEqual(files[2]!.buffer);
  await page
    .getByRole("button", { name: "Board options", exact: true })
    .click();
  const textExport = page.getByRole("link", {
    name: "Export text (.md)",
    exact: true,
  });
  await expect(textExport).toHaveAttribute(
    "href",
    `/api/cooperation/boards/${id}/export?format=markdown`,
  );
  const textDownloadEvent = page.waitForEvent("download");
  await textExport.click();
  const textDownload = await textDownloadEvent;
  expect(textDownload.suggestedFilename()).toBe(`${id}.blackboard.md`);
  const text = await fs.readFile((await textDownload.path())!, "utf8");
  expect(text).toContain("# Shared originals");
  for (const asset of boards.getBoard(id).assets)
    expect(text).toContain(`Path: ${asset.relativePath}`);
  await page
    .getByRole("button", { name: "Board options", exact: true })
    .click();
  await page.screenshot({ path: testInfo.outputPath("shared-files.png") });
  await page.reload();
  await page
    .locator(`.cooperation-manager-row[data-board-id="${id}"]`)
    .getByRole("button", { name: "Open board", exact: true })
    .click();
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  expect(boards.getBoard(id).assets).toHaveLength(files.length);
});

test("link cards and note URLs stay editable and clickable after reload", async ({
  page,
}) => {
  const id = await createBoard(page, "Shared links");
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  await page.getByRole("button", { name: "Link", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Add link", exact: true })
    .getByLabel("Link URL", { exact: true })
    .fill("https://example.com/spec");
  await page
    .getByLabel("Link title", { exact: true })
    .fill("Interface specification");
  await page
    .getByRole("dialog", { name: "Add link", exact: true })
    .getByLabel("Link description", { exact: true })
    .fill("Read section 4.");
  await page
    .getByRole("dialog", { name: "Add link", exact: true })
    .getByRole("button", { name: "Add link", exact: true })
    .click();
  await expect.poll(() => boards.getBoard(id).items.length).toBe(1);
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page
    .getByLabel("Text block 1", { exact: true })
    .fill("Read https://example.com/design, then continue.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".cooperation-note-block a")).toHaveAttribute(
    "href",
    "https://example.com/design",
  );
  await expect(page.locator(".cooperation-note-block")).toHaveText(
    "Read https://example.com/design, then continue.",
  );
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page.locator(".cooperation-note-block").evaluate((block) => {
    const range = document.createRange();
    range.setStart(block.firstChild!, 2);
    range.setEnd(block.lastChild!, 6);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page
    .getByRole("button", { name: "Ask about selection", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("Is this linked section current?");
  await page.getByRole("button", { name: "Ask question", exact: true }).click();
  const quote = "ad https://example.com/design, then";
  await expect
    .poll(() => boards.getBoard(id).threads[0]?.target.anchor)
    .toMatchObject({ exact: quote, start: 2, end: 2 + quote.length });
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  const link = boards.getBoard(id).items.find((item) => item.kind === "link")!;
  await page
    .getByRole("button", { name: "Board outline", exact: true })
    .click();
  const outline = page.locator(".cooperation-outline-record").filter({
    has: page.locator("summary", { hasText: "Interface specification" }),
  });
  await outline.locator("summary").click();
  await outline
    .getByRole("button", { name: "Inspect / edit", exact: true })
    .click();
  await page
    .getByLabel("Link URL", { exact: true })
    .fill("https://example.com/revised");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      () =>
        boards.getBoard(id).items.find((item) => item.id === link.id)?.content,
    )
    .toMatchObject({ url: "https://example.com/revised" });
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .getByRole("button", { name: "Fit board to view", exact: true })
    .click();
  await page.getByRole("button", { name: "Pan (H)", exact: true }).click();
  const viewport = page.locator(
    ".cooperation-board:visible .react-flow__viewport",
  );
  const beforePan = await viewport.getAttribute("style");
  const description = (await page
    .locator(`[data-item-id="${link.id}"] .cooperation-link-content p`)
    .boundingBox())!;
  await page.mouse.move(
    description.x + description.width / 2,
    description.y + description.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    description.x + description.width / 2 + 32,
    description.y + description.height / 2 + 22,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(beforePan);
  await page.reload();
  await page
    .locator(`.cooperation-manager-row[data-board-id="${id}"]`)
    .getByRole("button", { name: "Open board", exact: true })
    .click();
  await expect(page.locator(`[data-item-id="${link.id}"] a`)).toHaveAttribute(
    "href",
    "https://example.com/revised",
  );
  await expect(
    page.locator(`[data-item-id="${link.id}"] .cooperation-link-host`),
  ).toContainText("example.com");
});

test("clipboard files and dropped files or web links use the shared content paths", async ({
  page,
}) => {
  const id = await createBoard(page, "Clipboard and drop");
  const surface = page.locator(".cooperation-board:visible");
  await surface.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(
      new File(["Original pasted evidence"], "pasted.txt", {
        type: "text/plain",
      }),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(() => boards.getBoard(id).assets.length).toBe(1);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  await surface.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "https://example.com/pasted");
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(() => boards.getBoard(id).items.length).toBe(2);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  await surface.evaluate((element) => {
    const files = new DataTransfer();
    files.items.add(new File([new Uint8Array([0, 255, 128])], "dropped.bin"));
    element.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: files,
        bubbles: true,
        cancelable: true,
        clientX: 180,
        clientY: 240,
      }),
    );
  });
  await expect.poll(() => boards.getBoard(id).assets.length).toBe(2);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  await surface.evaluate((element) => {
    const links = new DataTransfer();
    links.setData(
      "text/uri-list",
      "# Specification\nhttps://example.com/dropped",
    );
    element.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: links,
        bubbles: true,
        cancelable: true,
        clientX: 180,
        clientY: 240,
      }),
    );
  });
  await expect.poll(() => boards.getBoard(id).items.length).toBe(4);
  expect(
    boards
      .getBoard(id)
      .items.filter((item) => item.kind === "link")
      .map((item) => item.content.url),
  ).toEqual(["https://example.com/pasted", "https://example.com/dropped"]);
  const pasted = boards
    .getBoard(id)
    .items.find(
      (item) => item.kind === "file" && item.content.title === "pasted.txt",
    )!;
  if (pasted.kind !== "file") throw new Error("Missing pasted file");
  expect(
    (await boards.resolveAsset(id, pasted.content.assetId)).bytes.toString(),
  ).toBe("Original pasted evidence");
});

test("file headers move with no selected tool and native controls do not move the item", async ({
  page,
}, testInfo) => {
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/transactions"))
      writes++;
  });
  const id = await createBoard(page, "File gestures");
  await page.getByLabel("Choose board files", { exact: true }).setInputFiles({
    name: "recording.wav",
    mimeType: "audio/wav",
    buffer: wave(),
  });
  await expect.poll(() => boards.getBoard(id).items.length).toBe(1);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  await page
    .getByRole("button", { name: "Fit board to view", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inspect recording.wav", exact: true })
    .click();
  await page
    .getByLabel("File description", { exact: true })
    .fill("Pan across this recording description.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .getByRole("button", { name: "Fit board to view", exact: true })
    .click();
  const item = boards.getBoard(id).items[0]!;
  const header = page.locator(
    `[data-item-id="${item.id}"] .cooperation-item-heading`,
  );
  const before = structuredClone(item.geometry);
  async function drag(dx: number, dy: number, target = header) {
    const bounds = (await target.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width / 2 + dx,
      bounds.y + bounds.height / 2 + dy,
      { steps: 8 },
    );
    await page.mouse.up();
  }
  await drag(96, 72);
  await expect
    .poll(() => boards.getBoard(id).items[0]!.geometry.x)
    .not.toBe(before.x);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Saved",
  );
  const moved = structuredClone(boards.getBoard(id).items[0]!.geometry);
  const audio = page.locator(`[data-item-id="${item.id}"] audio`);
  const savedWrites = writes;
  await audio.press("ArrowRight");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(writes).toBe(savedWrites);
  expect(boards.getBoard(id).items[0]!.geometry).toEqual(moved);
  await page.getByRole("button", { name: "Pan (H)", exact: true }).click();
  const viewport = page.locator(
    ".cooperation-board:visible .react-flow__viewport",
  );
  const beforePan = await viewport.getAttribute("style");
  await drag(
    -20,
    16,
    page.locator(`[data-item-id="${item.id}"] .cooperation-file-description`),
  );
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(beforePan);
  expect(boards.getBoard(id).items[0]!.geometry).toEqual(moved);
  await page.screenshot({
    path: testInfo.outputPath("shared-media-controls.png"),
  });
});

for (const zoomButton of ["Zoom out", "Zoom in"] as const) {
  test(`new items keep the pointer offset on their first coarse drag after ${zoomButton}`, async ({
    page,
  }) => {
    const id = await createBoard(page, `Placement ${zoomButton}`);
    await page
      .getByRole("button", { name: "Board options", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Snap to grid", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Board options", exact: true })
      .click();
    for (let i = 0; i < 2; i++)
      await page.getByRole("button", { name: zoomButton, exact: true }).click();
    const pane = page.locator(".cooperation-board:visible .react-flow__pane");
    const bounds = (await pane.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width * 0.6,
      bounds.y + bounds.height * 0.85,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width * 0.6 + 40,
      bounds.y + bounds.height * 0.85 + 20,
      { steps: 8 },
    );
    await page.mouse.up();
    const view = await boardViewport(page);
    const x = Math.round(bounds.x + bounds.width * 0.2);
    const y = Math.round(bounds.y + bounds.height * 0.3);
    await page
      .getByRole("button", { name: "Add note (N)", exact: true })
      .click();
    await page.mouse.click(x, y);
    await expect.poll(() => boards.getBoard(id).items.length).toBe(1);
    const item = structuredClone(boards.getBoard(id).items[0]!);
    expect(item.geometry.x).toBeCloseTo(
      (x - view.left - view.x) / view.zoom,
      0,
    );
    expect(item.geometry.y).toBeCloseTo((y - view.top - view.y) / view.zoom, 0);
    await expect(page.getByLabel("Inspector", { exact: true })).toBeVisible();
    await expect(page.locator(".cooperation-save-state:visible")).toContainText(
      "Saved",
    );
    await page
      .getByRole("button", { name: "Close drawer", exact: true })
      .click();
    const header = (await page
      .locator(`[data-item-id="${item.id}"] .cooperation-item-heading`)
      .boundingBox())!;
    const from = {
      x: Math.round(header.x + header.width / 2),
      y: Math.round(header.y + header.height / 2),
    };
    const before = await boardViewport(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 30);
    await page.mouse.up();
    const after = await boardViewport(page);
    const dx =
      (from.x + 60 - after.left - after.x) / after.zoom -
      (from.x - before.left - before.x) / before.zoom;
    const dy =
      (from.y + 30 - after.top - after.y) / after.zoom -
      (from.y - before.top - before.y) / before.zoom;
    await expect
      .poll(() => boards.getBoard(id).items[0]!.geometry.x)
      .toBeCloseTo(item.geometry.x + dx, 0);
    await expect
      .poll(() => boards.getBoard(id).items[0]!.geometry.y)
      .toBeCloseTo(item.geometry.y + dy, 0);
  });
}

test("selected zones resize from opposite corners at zoom and pan, then reload with the same bounds", async ({
  page,
  isMobile,
}, testInfo) => {
  const id = await createBoard(page, "Resizable zone");
  await page
    .getByRole("button", { name: "Work in progress region (W)", exact: true })
    .click();
  const pane = page.locator(".cooperation-board:visible .react-flow__pane");
  const canvas = (await pane.boundingBox())!;
  await page.mouse.click(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height / 3,
  );
  await expect.poll(() => boards.getBoard(id).regions.length).toBe(1);
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .getByRole("button", { name: "Collapse tools", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /^Resize zone / })).toHaveCount(
    8,
  );
  await page
    .getByRole("button", { name: "Board options", exact: true })
    .click();
  await page.getByRole("button", { name: "Snap to grid", exact: true }).click();
  await page
    .getByRole("button", { name: "Board options", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Fit board to view", exact: true })
    .click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.mouse.move(
    canvas.x + canvas.width * 0.8,
    canvas.y + canvas.height * 0.8,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvas.x + canvas.width * 0.8 + 20,
    canvas.y + canvas.height * 0.8 + 15,
  );
  await page.mouse.up();
  const original = structuredClone(boards.getBoard(id).regions[0]!);
  async function resize(direction: string, dx: number, dy: number) {
    const handle = page.getByRole("button", {
      name: `Resize zone ${direction}`,
      exact: true,
    });
    const bounds = (await handle.boundingBox())!;
    const start = {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    };
    const view = await boardViewport(page);
    const previous = boards.getBoard(id).revision;
    if (isMobile) {
      const session = await page.context().newCDPSession(page);
      try {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ ...start, id: 1 }],
        });
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: start.x + dx, y: start.y + dy, id: 1 }],
        });
        await session.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } finally {
        await session.detach();
      }
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + dx, start.y + dy);
      await page.mouse.up();
    }
    await expect.poll(() => boards.getBoard(id).revision).toBe(previous + 1);
    await expect(page.locator(".cooperation-save-state:visible")).toContainText(
      "Saved",
    );
    return { dx: dx / view.zoom, dy: dy / view.zoom };
  }
  const growth = await resize("south east", isMobile ? 20 : 60, 30);
  const grown = structuredClone(boards.getBoard(id).regions[0]!.geometry);
  expect(grown.x).toBe(original.geometry.x);
  expect(grown.y).toBe(original.geometry.y);
  expect(grown.width).toBeCloseTo(original.geometry.width + growth.dx, 0);
  expect(grown.height).toBeCloseTo(original.geometry.height + growth.dy, 0);
  const shrink = await resize("north west", 30, 20);
  const saved = structuredClone(boards.getBoard(id).regions[0]!.geometry);
  expect(saved.x).toBeCloseTo(grown.x + shrink.dx, 0);
  expect(saved.y).toBeCloseTo(grown.y + shrink.dy, 0);
  expect(saved.x + saved.width).toBeCloseTo(grown.x + grown.width, 6);
  expect(saved.y + saved.height).toBeCloseTo(grown.y + grown.height, 6);
  await page.screenshot({ path: testInfo.outputPath("zone-resize.png") });
  await page.reload();
  await page
    .locator(`.cooperation-manager-row[data-board-id="${id}"]`)
    .getByRole("button", { name: "Open board", exact: true })
    .click();
  const region = page.getByTestId(`region-${original.id}`);
  await expect(region).toBeVisible();
  await expect
    .poll(() =>
      region.evaluate((element) =>
        parseFloat((element as HTMLElement).style.width),
      ),
    )
    .toBeCloseTo(saved.width, 3);
  await expect
    .poll(() =>
      region.evaluate((element) =>
        parseFloat((element as HTMLElement).style.height),
      ),
    )
    .toBeCloseTo(saved.height, 3);
  expect(boards.getBoard(id).regions[0]!.geometry).toEqual(saved);
});

test("zone resize cancels cleanly and preserves a concurrent edit as a local conflict draft", async ({
  page,
  isMobile,
}) => {
  const id = await createBoard(page, "Zone conflict");
  await page
    .getByRole("button", { name: "Work in progress region (W)", exact: true })
    .click();
  const canvas = (await page
    .locator(".cooperation-board:visible .react-flow__pane")
    .boundingBox())!;
  await page.mouse.click(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height / 3,
  );
  await expect.poll(() => boards.getBoard(id).regions.length).toBe(1);
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page
    .getByRole("button", { name: "Collapse tools", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Fit board to view", exact: true })
    .click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  const region = structuredClone(boards.getBoard(id).regions[0]!);
  const revision = boards.getBoard(id).revision;
  const handle = page.getByRole("button", {
    name: "Resize zone south east",
    exact: true,
  });
  const bounds = (await handle.boundingBox())!;
  const start = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
  if (isMobile) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...start, id: 1 }],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x + 20, y: start.y + 20, id: 1 }],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchCancel",
        touchPoints: [],
      });
    } finally {
      await session.detach();
    }
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y + 20);
    await page.keyboard.press("Escape");
    await page.mouse.up();
  }
  const frame = page.getByTestId(`region-${region.id}`);
  await expect
    .poll(() =>
      frame.evaluate((element) =>
        parseFloat((element as HTMLElement).style.width),
      ),
    )
    .toBe(region.geometry.width);
  expect(boards.getBoard(id).revision).toBe(revision);
  await frame.locator(".cooperation-region-label").click();
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  const activeBounds = (await handle.boundingBox())!;
  const activeStart = {
    x: Math.round(activeBounds.x + activeBounds.width / 2),
    y: Math.round(activeBounds.y + activeBounds.height / 2),
  };
  await page.mouse.move(activeStart.x, activeStart.y);
  await page.mouse.down();
  const remote = await page.request.post(
    `${baseUrl}/api/cooperation/boards/${id}/transactions`,
    {
      data: {
        schemaVersion: 1,
        operationId: "concurrent-zone-title",
        boardId: id,
        expectedBoardRevision: revision,
        preconditions: [
          {
            targetKind: "region",
            targetId: region.id,
            expectedRevision: region.revision,
          },
        ],
        operations: [
          {
            kind: "updateRegion",
            regionId: region.id,
            patch: { title: "Concurrent title" },
          },
        ],
        respondsToEventIds: [],
      },
    },
  );
  expect(remote.status()).toBe(200);
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    `r${revision + 1}`,
  );
  await page.mouse.move(activeStart.x + 40, activeStart.y + 30);
  await page.mouse.up();
  await expect(page.locator(".cooperation-save-state:visible")).toContainText(
    "Local drafts",
  );
  expect(boards.getBoard(id).revision).toBe(revision + 1);
  expect(boards.getBoard(id).regions[0]!.title).toBe("Concurrent title");
  expect(boards.getBoard(id).regions[0]!.geometry).toEqual(region.geometry);
  await expect
    .poll(() =>
      frame.evaluate((element) =>
        parseFloat((element as HTMLElement).style.width),
      ),
    )
    .toBe(region.geometry.width);
});

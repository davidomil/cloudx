import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer, type ViteDevServer } from "vite";
import { NativeCodexCopySession } from "./fixtures/native-codex-copy.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let server: ViteDevServer;
let httpServer: Server;
let baseUrl: string;

test.beforeAll(async () => {
  httpServer = createHttpServer();
  server = await createServer({
    configFile: false,
    root: repoRoot,
    plugins: [react()],
    resolve: {
      alias: {
        "@cloudx/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      },
    },
    server: { middlewareMode: { server: httpServer }, ws: false },
    optimizeDeps: { entries: ["tests/browser/fixtures/terminal-copy.html"] },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing browser fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/terminal-copy.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function terminalStream(
  page: Page,
  pausedClock = false,
  view = "codex",
  split = false,
) {
  let socket: WebSocketRoute;
  const input: string[] = [];
  let connections = 0;
  await page.routeWebSocket("**/ws/terminal/*", (connection) => {
    if (!split || !connections) socket = connection;
    connections++;
    connection.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === "input") input.push(event.data);
    });
  });
  await page.goto(`${baseUrl}?view=${view}&split=${split}`);
  if (pausedClock) {
    await expect(page.locator(".xterm")).toBeVisible();
    await page.clock.runFor(50);
  }
  await expect.poll(() => connections).toBe(split ? 2 : 1);
  await expect(page.locator(".xterm-rows").first()).toContainText("Cloudx tab");
  return {
    input,
    connections: () => connections,
    data: (data: string) => socket.send(JSON.stringify({ type: "data", data })),
    screen: (data: string) =>
      socket.send(JSON.stringify({ type: "screen", data, cols: 80, rows: 24 })),
    close: () => socket.close({ code: 1000 }),
  };
}

async function cells(page: Page) {
  return page
    .locator(".xterm-screen")
    .first()
    .evaluate((element) => {
      const screen = element.getBoundingClientRect();
      const row = element
        .querySelector(".xterm-rows > div")!
        .getBoundingClientRect();
      const measure = document.querySelector(".xterm-char-measure-element")!;
      return {
        x: screen.x,
        y: screen.y,
        width: screen.width,
        cell:
          measure.getBoundingClientRect().width / measure.textContent!.length,
        height: row.height,
      };
    });
}

async function dragSelection(
  page: Page,
  from: [number, number],
  to: [number, number],
  shift = false,
) {
  const size = await cells(page);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(
    size.x + from[0] * size.cell + 1,
    size.y + (from[1] + 0.5) * size.height,
  );
  await page.mouse.down();
  await page.mouse.move(
    size.x + to[0] * size.cell + 1,
    size.y + (to[1] + 0.5) * size.height,
    { steps: 8 },
  );
}

async function select(
  page: Page,
  from: [number, number],
  to: [number, number],
  shift = false,
) {
  await dragSelection(page, from, to, shift);
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}

for (const view of ["terminal", "codex", "forge"]) {
  for (const gesture of [
    "Control+c",
    "Control+Shift+c",
    "Meta+c",
    "button",
    "preview",
  ]) {
    test(`${view} copies the finalized extended drag across queued and streaming output using ${gesture}`, async ({
      page,
      context,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop-chromium",
        "Desktop mouse selection.",
      );
      await page.clock.install();
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const stream = await terminalStream(page, false, view);
      await page.clock.pauseAt(
        new Date((await page.evaluate(() => Date.now())) + 200),
      );
      const size = await cells(page);
      const cols = Math.round(size.width / size.cell);
      const original = `    const answer = "界 café";\n    /tmp/界-café.ts ${"x".repeat(cols + 8)}\n    return answer;`;
      const initialWrites = await page.evaluate(
        () => window.terminalWriteCount,
      );
      stream.data(`\x1bc${original.replaceAll("\n", "\r\n")}`);
      await expect
        .poll(() => page.evaluate(() => window.terminalWriteCount))
        .toBe(initialWrites + 1);
      await page.clock.runFor(50);
      await expect(page.locator(".xterm-rows")).toContainText("return answer;");
      const queuedWrites = await page.evaluate(() => window.terminalWriteCount);
      const output = (chunk: number) =>
        view === "terminal"
          ? `\r\nstreamed output ${chunk}`
          : `\x1b[H\x1b[2Kreplacement output ${chunk}\r\n\x1b[2Kreplacement middle ${chunk}`;
      await page.evaluate(() => {
        window.queuedTerminalOutputPaused = false;
        window.testTerminal.parser.registerOscHandler(
          776,
          () =>
            new Promise<boolean>((resolve) => {
              window.queuedTerminalOutputPaused = true;
              window.resumeQueuedTerminalOutput = () => resolve(true);
            }),
        );
      });
      stream.data(`\x1b]776;wait\x07${output(1)}`);
      await expect
        .poll(() => page.evaluate(() => window.terminalWriteCount))
        .toBe(queuedWrites + 1);
      await page.clock.runFor(20);
      await expect
        .poll(() => page.evaluate(() => window.queuedTerminalOutputPaused))
        .toBe(true);
      await dragSelection(page, [0, 0], [12, 0]);
      expect(
        await page.evaluate(() => window.testTerminal.getSelection()),
      ).toBe("    const an");
      await page.evaluate(() => window.resumeQueuedTerminalOutput());
      await page.clock.runFor(20);
      await expect(page.locator(".xterm-rows")).toContainText(
        view === "terminal" ? "streamed output 1" : "replacement output 1",
      );
      for (const chunk of [2, 3]) {
        const writes = await page.evaluate(() => window.terminalWriteCount);
        stream.data(
          view !== "terminal" && chunk === 2
            ? `\x1b[?1049h\x1b[2J${output(chunk)}`
            : output(chunk),
        );
        await expect
          .poll(() => page.evaluate(() => window.terminalWriteCount))
          .toBe(writes + 1);
        await page.clock.runFor(20);
      }
      const finalSize = await cells(page);
      await page.mouse.move(
        finalSize.x + 18 * finalSize.cell + 1,
        finalSize.y + 3.5 * finalSize.height,
        { steps: 8 },
      );
      await page.mouse.up();
      const preview = page.getByRole("textbox", {
        name: "Selected terminal text",
      });
      await expect(preview).toHaveValue(original);
      const writes = await page.evaluate(() => window.terminalWriteCount);
      stream.data("\x1bcafter release redraw\r\nmore output before copy");
      await expect
        .poll(() => page.evaluate(() => window.terminalWriteCount))
        .toBe(writes + 1);
      await page.clock.runFor(30);
      await expect(page.locator(".xterm-rows")).toContainText(
        "more output before copy",
      );
      await expect(preview).toHaveValue(original);
      if (gesture === "button")
        await page
          .getByRole("button", { name: "Copy selection", exact: true })
          .click();
      else if (gesture === "preview") {
        await preview.focus();
        await preview.evaluate((element: HTMLTextAreaElement) => {
          const start = element.value.indexOf("return");
          element.setSelectionRange(start, start + "return answer;".length);
        });
        await page.keyboard.press("Control+c");
      } else {
        await page.locator(".xterm-helper-textarea").focus();
        await page.keyboard.press(gesture);
      }
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(gesture === "preview" ? "return answer;" : original);
      expect(stream.input).toEqual([]);
      if (gesture === "preview")
        await page.getByRole("button", { name: "Clear selection" }).click();
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Control+c");
      await expect.poll(() => stream.input.join("")).toBe("\x03");
      testInfo.annotations.push({
        type: "browser-version",
        description: page.context().browser()!.version(),
      });
    });
  }
}

test("extends a backward drag through a streamed screen reset", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  const original = "beginning\n    界 café middle\nlast line";
  stream.data(`\x1bc${original.replaceAll("\n", "\r\n")}`);
  await expect(page.locator(".xterm-rows")).toContainText("last line");
  await dragSelection(page, [9, 2], [4, 2]);
  stream.screen("replacement text");
  await expect(page.locator(".xterm-rows")).toContainText("replacement text");
  const size = await cells(page);
  await page.mouse.move(size.x + 1, size.y + size.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(original);
  await page
    .getByRole("button", { name: "Copy selection", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(original);
  expect(stream.input).toEqual([]);
});

test("extends a streamed drag into earlier history through autoscroll", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await page.clock.install();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page, false, "terminal");
  await page.clock.pauseAt(
    new Date((await page.evaluate(() => Date.now())) + 200),
  );
  const lines = Array.from(
    { length: 100 },
    (_, row) => `original row ${String(row).padStart(3, "0")}`,
  );
  const writes = await page.evaluate(() => window.terminalWriteCount);
  stream.data(`\x1bc${lines.join("\r\n")}`);
  await expect
    .poll(() => page.evaluate(() => window.terminalWriteCount))
    .toBe(writes + 1);
  await page.clock.runFor(50);
  await page.evaluate(() => window.testTerminal.scrollToLine(30));
  await page.clock.runFor(30);
  await expect(page.locator(".xterm-rows")).toContainText("original row 030");
  await dragSelection(page, [0, 2], [7, 2]);
  const queued = await page.evaluate(() => window.terminalWriteCount);
  stream.data("\r\nstreaming after selection started");
  await expect
    .poll(() => page.evaluate(() => window.terminalWriteCount))
    .toBe(queued + 1);
  await page.clock.runFor(20);
  const size = await cells(page);
  await page.mouse.move(size.x + 1, size.y - 20, { steps: 8 });
  await page.clock.runFor(100);
  const viewport = await page.evaluate(
    () => window.testTerminal.buffer.active.viewportY,
  );
  expect(viewport).toBeLessThan(30);
  await page.mouse.move(size.x + 1, size.y + size.height / 2);
  await page.mouse.up();
  const original = `${lines.slice(viewport, 32).join("\n")}\n`;
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(original);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(original);
  expect(stream.input).toEqual([]);
});

test("keeps original row mapping when streamed output scrolls the viewport", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await page.clock.install();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page, false, "terminal");
  await page.clock.pauseAt(
    new Date((await page.evaluate(() => Date.now())) + 200),
  );
  const lines = Array.from(
    { length: 100 },
    (_, row) => `original row ${String(row).padStart(3, "0")}`,
  );
  const writes = await page.evaluate(() => window.terminalWriteCount);
  stream.data(`\x1bc${lines.join("\r\n")}`);
  await expect
    .poll(() => page.evaluate(() => window.terminalWriteCount))
    .toBe(writes + 1);
  await page.clock.runFor(50);
  const viewport = await page.evaluate(
    () => window.testTerminal.buffer.active.viewportY,
  );
  await dragSelection(page, [0, 0], [7, 0]);
  const queued = await page.evaluate(() => window.terminalWriteCount);
  stream.data(
    Array.from({ length: 50 }, (_, row) => `\r\nnew output ${row}`).join(""),
  );
  await expect
    .poll(() => page.evaluate(() => window.terminalWriteCount))
    .toBe(queued + 1);
  await page.clock.runFor(50);
  expect(
    await page.evaluate(() => window.testTerminal.buffer.active.viewportY),
  ).toBeGreaterThan(viewport);
  const size = await cells(page);
  await page.mouse.move(
    size.x + 16 * size.cell + 1,
    size.y + 3.5 * size.height,
    { steps: 8 },
  );
  await page.mouse.up();
  const original = lines.slice(viewport, viewport + 4).join("\n");
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(original);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(original);
  expect(stream.input).toEqual([]);
});

test("keeps a double-clicked word when output arrives before mouse release", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  stream.data("\x1bcbeginning command end");
  await expect(page.locator(".xterm-rows")).toContainText(
    "beginning command end",
  );
  const size = await cells(page);
  await page.mouse.move(size.x + 12 * size.cell + 1, size.y + size.height / 2);
  await page.mouse.click(size.x + 12 * size.cell + 1, size.y + size.height / 2);
  await page.mouse.down({ clickCount: 2 });
  stream.data("\x1b[H\x1b[2Kreplacement");
  await expect(page.locator(".xterm-rows")).toContainText("replacement");
  await page.mouse.up({ clickCount: 2 });
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue("command");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("command");
  expect(stream.input).toEqual([]);
});

for (const view of ["terminal", "codex", "forge"]) {
  for (const clicks of [2, 3]) {
    for (const direction of ["shrink", "reverse"]) {
      test(`${view} preserves original ${clicks === 2 ? "word" : "line"} bounds through grow-stream-${direction}`, async ({
        page,
        context,
      }, testInfo) => {
        test.skip(
          testInfo.project.name !== "desktop-chromium",
          "Desktop mouse selection.",
        );
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        const stream = await terminalStream(page, false, view);
        const line = "beforeword firstword secondword thirdword";
        stream.data(`\x1bcbefore line\r\n${line}\r\nthird line\r\nfourth line`);
        await expect(page.locator(".xterm-rows")).toContainText("fourth line");
        const size = await cells(page);
        const move = (column: number, row: number) =>
          page.mouse.move(
            size.x + column * size.cell + 1,
            size.y + (row + 0.5) * size.height,
            { steps: 8 },
          );
        await move(15, 1);
        await page.mouse.click(
          size.x + 15 * size.cell + 1,
          size.y + 1.5 * size.height,
          { clickCount: clicks - 1 },
        );
        await page.mouse.down({ clickCount: clicks });
        await move(25, clicks === 2 ? 1 : 3);
        const grown =
          clicks === 2
            ? "firstword secondword"
            : `${line}\nthird line\nfourth line`;
        expect(
          await page.evaluate(() => window.testTerminal.getSelection()),
        ).toBe(grown);
        stream.data("\x1b[24;1Hstreamed\x1b[1;1H");
        await expect(page.locator(".xterm-rows")).toContainText("streamed");
        await move(
          direction === "shrink" ? 15 : 4,
          clicks === 2 || direction === "shrink" ? 1 : 0,
        );
        await page.mouse.up({ clickCount: clicks });
        const native = await page.evaluate(() =>
          window.testTerminal.getSelection(),
        );
        expect(native).toBe(
          clicks === 2
            ? direction === "shrink"
              ? "firstword"
              : "beforeword firstword"
            : direction === "shrink"
              ? line
              : `before line\n${line}`,
        );
        await expect(
          page.getByRole("textbox", { name: "Selected terminal text" }),
        ).toHaveValue(native);
        await page.locator(".xterm-helper-textarea").focus();
        await page.keyboard.press("Control+c");
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(native);
        expect(stream.input).toEqual([]);
      });
    }
  }
}

for (const clicks of [2, 3]) {
  for (const alt of [false, true]) {
    test(`finalizes a streamed ${clicks === 2 ? "word" : "line"} drag using the native selection boundaries${alt ? " with Alt" : ""}`, async ({
      page,
      context,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop-chromium",
        "Desktop mouse selection.",
      );
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const stream = await terminalStream(page);
      const text =
        "firstword secondword thirdword\r\n    second line\r\n    third line";
      stream.data(`\x1bc${text}`);
      await expect(page.locator(".xterm-rows")).toContainText("third line");
      const size = await cells(page);
      const x = size.x + 4 * size.cell + 1;
      const y = size.y + size.height / 2;
      if (alt) await page.keyboard.down("Alt");
      await page.mouse.click(x, y, { clickCount: clicks - 1 });
      await page.mouse.down({ clickCount: clicks });
      stream.data("\x1b[24;1Hstreamed\x1b[1;1H");
      await expect(page.locator(".xterm-rows")).toContainText("streamed");
      await page.mouse.move(
        size.x + (alt ? 8 : 14) * size.cell + 1,
        size.y + (clicks === 2 ? (alt ? 1.5 : 0.5) : 2.5) * size.height,
        { steps: 8 },
      );
      await page.mouse.up({ clickCount: clicks });
      if (alt) await page.keyboard.up("Alt");
      const native = await page.evaluate(() =>
        window.testTerminal.getSelection(),
      );
      expect(native).toBe(
        clicks === 2
          ? alt
            ? "firstword secondword thirdword\n    second"
            : "firstword secondword"
          : text.replaceAll("\r\n", "\n"),
      );
      await expect(
        page.getByRole("textbox", { name: "Selected terminal text" }),
      ).toHaveValue(native);
      const inputBeforeCopy = [...stream.input];
      if (!alt) expect(inputBeforeCopy).toEqual([]);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Control+c");
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(native);
      expect(stream.input).toEqual(inputBeforeCopy);
    });
  }
}

test("keeps an Alt single-click drag rectangular across streaming output", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  stream.data(
    "\x1bcfirstword secondword thirdword\r\n    second line\r\n    third line",
  );
  await expect(page.locator(".xterm-rows")).toContainText("third line");
  const size = await cells(page);
  await page.keyboard.down("Alt");
  await page.mouse.move(size.x + 4 * size.cell + 1, size.y + size.height / 2);
  await page.mouse.down();
  stream.data("\x1b[24;1Hstreamed\x1b[1;1H");
  await expect(page.locator(".xterm-rows")).toContainText("streamed");
  await page.mouse.move(
    size.x + 14 * size.cell + 1,
    size.y + 2.5 * size.height,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const native = await page.evaluate(() => window.testTerminal.getSelection());
  expect(native).toBe("tword seco\nsecond lin\nthird line");
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(native);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(native);
  expect(stream.input).toEqual([]);
});

for (const view of ["terminal", "codex", "forge"]) {
  for (const anchor of [
    {
      name: "continuation forward",
      start: 3,
      end: 7,
      rectangle: false,
      text: "cde",
    },
    {
      name: "continuation reverse",
      start: 3,
      end: 1,
      rectangle: false,
      text: "b界",
    },
    {
      name: "leading forward",
      start: 2,
      end: 7,
      rectangle: false,
      text: "界cde",
    },
    {
      name: "continuation rectangle",
      start: 3,
      end: 7,
      rectangle: true,
      text: "cde\n567",
    },
  ]) {
    test(`${view} normalizes the original wide-glyph ${anchor.name} anchor before output and movement`, async ({
      page,
      context,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop-chromium",
        "Desktop mouse selection.",
      );
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const stream = await terminalStream(page, false, view);
      stream.data("\x1bcab界cdef\r\n123456789");
      await expect(page.locator(".xterm-rows")).toContainText("123456789");
      const size = await cells(page);
      if (anchor.rectangle) await page.keyboard.down("Alt");
      await page.mouse.move(
        size.x + anchor.start * size.cell + 1,
        size.y + 0.5 * size.height,
      );
      await page.mouse.down();
      expect(
        await page.evaluate(() => window.testTerminal.getSelectionPosition()),
      ).toBeUndefined();
      stream.data("\x1b[24;1Hstreamed\x1b[1;1H");
      await expect(page.locator(".xterm-rows")).toContainText("streamed");
      await page.mouse.move(
        size.x + anchor.end * size.cell + 1,
        size.y + (anchor.rectangle ? 1.5 : 0.5) * size.height,
        { steps: 8 },
      );
      await page.mouse.up();
      if (anchor.rectangle) await page.keyboard.up("Alt");
      const native = await page.evaluate(() =>
        window.testTerminal.getSelection(),
      );
      expect(native).toBe(anchor.text);
      expect
        .soft(
          await page
            .getByRole("textbox", { name: "Selected terminal text" })
            .inputValue(),
        )
        .toBe(native);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Control+c");
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(native);
      expect(stream.input).toEqual([]);
    });
  }
}

for (const boundary of ["start", "end"]) {
  test(`keeps wide-glyph ${boundary} boundary cells in a streamed rectangle`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Desktop mouse selection.",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const stream = await terminalStream(page);
    stream.data("\x1bc123456789\r\nab界cdef");
    await expect(page.locator(".xterm-rows")).toContainText("ab界cdef");
    const from: [number, number] = [boundary === "start" ? 3 : 1, 0];
    const to: [number, number] = [boundary === "start" ? 7 : 3, 1];
    await page.keyboard.down("Alt");
    await dragSelection(page, from, [from[0] + 1, 0]);
    stream.data("\x1b[24;1Hstreamed\x1b[1;1H");
    await expect(page.locator(".xterm-rows")).toContainText("streamed");
    const size = await cells(page);
    await page.mouse.move(
      size.x + to[0] * size.cell + 1,
      size.y + 1.5 * size.height,
      { steps: 8 },
    );
    await page.mouse.up();
    await page.keyboard.up("Alt");
    const native = await page.evaluate(() =>
      window.testTerminal.getSelection(),
    );
    expect(native).toBe(boundary === "start" ? "4567\n cde" : "234\nb界");
    await expect(
      page.getByRole("textbox", { name: "Selected terminal text" }),
    ).toHaveValue(native);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(native);
    expect(stream.input).toEqual([]);
  });
}

test("finalizes all rows when a streamed drag releases below the viewport", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await page.clock.install();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page, false, "terminal");
  await page.clock.pauseAt(
    new Date((await page.evaluate(() => Date.now())) + 200),
  );
  const lines = Array.from(
    { length: 100 },
    (_, row) => `original row ${String(row).padStart(3, "0")}`,
  );
  const writes = await page.evaluate(() => window.terminalWriteCount);
  stream.data(`\x1bc${lines.join("\r\n")}`);
  await expect
    .poll(() => page.evaluate(() => window.terminalWriteCount))
    .toBe(writes + 1);
  await page.clock.runFor(50);
  await page.evaluate(() => window.testTerminal.scrollToLine(30));
  await page.clock.runFor(30);
  await dragSelection(page, [0, 2], [7, 2]);
  const queued = await page.evaluate(() => window.terminalWriteCount);
  stream.data("\r\nstreaming at bottom");
  await expect
    .poll(() => page.evaluate(() => window.terminalWriteCount))
    .toBe(queued + 1);
  await page.clock.runFor(20);
  const size = await cells(page);
  const height = await page
    .locator(".xterm-screen")
    .evaluate((element) => element.getBoundingClientRect().height);
  await page.mouse.move(size.x + 4 * size.cell + 1, size.y + height + 20, {
    steps: 8,
  });
  await page.clock.runFor(50);
  await page.mouse.up();
  const native = await page.evaluate(() => window.testTerminal.getSelection());
  expect(native).toMatch(/^original row 032\n/u);
  expect(native).toMatch(/original row \d{3}$/u);
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(native);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(native);
  expect(stream.input).toEqual([]);
});

for (const gesture of ["Control+c", "Meta+c", "button", "preview"]) {
  test(`copies static Forge worker history using ${gesture}`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Desktop mouse selection.",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`${baseUrl}?view=forge-history`);
    await page.evaluate(() => navigator.clipboard.writeText("before copy"));
    await expect(
      page.getByRole("region", { name: "Saved worker terminal output" }),
    ).toBeVisible();
    await expect(page.locator(".xterm-rows")).toContainText("last saved line");
    await select(page, [0, 0], [19, 2]);
    const original =
      "    first saved line\n    界 café middle\n    last saved line";
    const preview = page.getByRole("textbox", {
      name: "Selected terminal text",
    });
    await expect(preview).toHaveValue(original);
    if (gesture === "button")
      await page
        .getByRole("button", { name: "Copy selection", exact: true })
        .click();
    else if (gesture === "preview") {
      await preview.focus();
      await preview.evaluate((element: HTMLTextAreaElement) => {
        const start = element.value.indexOf("café");
        element.setSelectionRange(start, start + "café".length);
      });
      await page.keyboard.press("Control+c");
    } else {
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press(gesture);
    }
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(gesture === "preview" ? "café" : original);
  });
}

test("continues extending a drag when layout measurement leaves the terminal unchanged", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  const original = "original /tmp/answer.ts";
  stream.data(`\x1bc${original}`);
  await expect(page.locator(".xterm-rows")).toContainText(original);
  await dragSelection(page, [0, 0], [8, 0]);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("resize"));
    return new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const size = await cells(page);
  await page.mouse.move(
    size.x + original.length * size.cell + 1,
    size.y + size.height / 2,
  );
  await page.mouse.up();
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(original);
  expect(stream.input).toEqual([]);
});

for (const queuedOutput of [
  "cursor erase",
  "plain text",
  "split escape",
  "screen replay",
]) {
  test(`preserves a drag started after ${queuedOutput} was queued`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Desktop mouse selection.",
    );
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 200));
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const stream = await terminalStream(page, true);
    const original = "original /tmp/answer.ts";
    const replacement = "replaced /tmp/answer.ts";
    const initialWrites = await page.evaluate(() => window.terminalWriteCount);
    stream.data(`\x1bc${original}\x1b[1;1H`);
    await expect
      .poll(() => page.evaluate(() => window.terminalWriteCount))
      .toBe(initialWrites + 1);
    await page.clock.runFor(50);
    await expect(page.locator(".xterm-rows")).toContainText(original);
    const writes = await page.evaluate(() => window.terminalWriteCount);
    if (queuedOutput === "screen replay") stream.screen(replacement);
    else if (queuedOutput === "plain text") stream.data(replacement);
    else if (queuedOutput === "split escape") {
      stream.data("\x1b[1;");
      stream.data(`1H\x1b[2K${replacement}`);
    } else stream.data(`\x1b[1;1H\x1b[2K${replacement}`);

    await expect
      .poll(() => page.evaluate(() => window.terminalWriteCount))
      .toBe(writes + (queuedOutput === "split escape" ? 2 : 1));
    await dragSelection(page, [0, 0], [original.length, 0]);
    expect(await page.evaluate(() => window.testTerminal.getSelection())).toBe(
      original,
    );
    await expect(page.locator(".xterm-rows")).toContainText(original);
    await expect(page.getByLabel("Saved terminal selection")).toBeHidden();
    await page.clock.runFor(20);
    await expect(page.locator(".xterm-rows")).toContainText(replacement);
    await expect(
      page.getByRole("textbox", { name: "Selected terminal text" }),
    ).toHaveValue(original);
    await page.mouse.up();
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(original);
    expect(stream.input).toEqual([]);
  });
}

test("preserves a drag before an asynchronous parser continuation", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  const original = "original /tmp/answer.ts";
  stream.data(`\x1bc${original}\x1b[1;1H`);
  await expect(page.locator(".xterm-rows")).toContainText(original);
  let resume: (() => void) | undefined;
  await page.exposeFunction(
    "pauseTerminalParser",
    () =>
      new Promise<boolean>((resolve) => {
        resume = () => resolve(true);
      }),
  );
  await page.evaluate(() => {
    const fixture = window as Window & {
      pauseTerminalParser(): Promise<boolean>;
    };
    fixture.testTerminal.parser.registerOscHandler(777, () =>
      fixture.pauseTerminalParser(),
    );
  });
  stream.data("\x1b]777;wait\x07replaced /tmp/answer.ts");
  await expect.poll(() => typeof resume).toBe("function");
  await dragSelection(page, [0, 0], [original.length, 0]);
  expect(await page.evaluate(() => window.testTerminal.getSelection())).toBe(
    original,
  );
  await expect(page.getByLabel("Saved terminal selection")).toBeHidden();
  resume!();
  await expect(page.locator(".xterm-rows")).toContainText(
    "replaced /tmp/answer.ts",
  );
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(original);
  await page.mouse.up();
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(original);
  expect(stream.input).toEqual([]);
});

for (const redraw of [
  "cursor erase",
  "alternate screen",
  "screen replay",
  "resize",
]) {
  test(`copies the original drag before mouse release across ${redraw}`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Desktop mouse selection.",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const stream = await terminalStream(page);
    const original = "original /tmp/answer.ts";
    stream.data(`\x1bc${original}`);
    await expect(page.locator(".xterm-rows")).toContainText(original);
    await dragSelection(page, [0, 0], [original.length, 0]);
    if (redraw === "screen replay") stream.screen("replaced /tmp/answer.ts");
    else if (redraw === "alternate screen")
      stream.data("\x1b[?1049h\x1b[2J\x1b[Hreplaced /tmp/answer.ts");
    else {
      if (redraw === "resize")
        await page.setViewportSize({ width: 900, height: 650 });
      stream.data("\x1b[1;1H\x1b[2Kreplaced /tmp/answer.ts");
    }
    await expect(page.locator(".xterm-rows")).toContainText(
      "replaced /tmp/answer.ts",
    );
    await expect(
      page.getByRole("textbox", { name: "Selected terminal text" }),
    ).toHaveValue(original);
    const size = await cells(page);
    await page.mouse.move(
      size.x + (original.length + 3) * size.cell,
      size.y + size.height / 2,
    );
    await page.mouse.up();
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(original);
    expect(stream.input).toEqual([]);
  });
}

for (const gesture of [
  "Control+c",
  "Control+Shift+c",
  "Meta+c",
  "button",
  "context menu",
  "browser copy",
]) {
  test(`copies original cells after an in-place redraw using ${gesture}`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Desktop copy gestures use a mouse and keyboard.",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const stream = await terminalStream(page);
    const original = "original /tmp/answer.ts";
    stream.data(`\x1bc${original}`);
    await expect(page.locator(".xterm-rows")).toContainText(original);
    await select(page, [0, 0], [original.length, 0]);
    await expect(
      page.getByRole("textbox", { name: "Selected terminal text" }),
    ).toHaveValue(original);
    stream.data("\x1b[1;1H\x1b[2Kreplacement cells");
    await expect(page.locator(".xterm-rows")).toContainText(
      "replacement cells",
    );
    if (gesture === "button") {
      await page
        .getByRole("button", { name: "Copy selection", exact: true })
        .click();
    } else if (gesture === "context menu") {
      const size = await cells(page);
      await page.mouse.click(size.x + 40, size.y + size.height / 2, {
        button: "right",
      });
      await page
        .getByRole("menuitem", { name: "Copy saved selection" })
        .click();
    } else if (gesture === "browser copy") {
      await page.locator(".xterm-helper-textarea").focus();
      expect(await page.evaluate(() => document.execCommand("copy"))).toBe(
        true,
      );
    } else {
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press(gesture);
    }
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(original);
    expect(stream.input).toEqual([]);
    await expect(
      page.getByRole("complementary", { name: "Saved terminal selection" }),
    ).toBeHidden();
    testInfo.annotations.push({
      type: "browser-version",
      description: page.context().browser()!.version(),
    });
  });
}

test("retains multiline, wrapped Unicode and indentation across alternate screen, resize, reconnect and replay", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  const size = await cells(page);
  const cols = Math.round(size.width / size.cell);
  const line = `    /tmp/界-café.ts ${"x".repeat(cols + 8)}`;
  const original = `    const answer = "界 café";\n${line}\n    return answer;`;
  stream.data(`\x1bc\x1b[32m${original.replaceAll("\n", "\r\n")}\x1b[0m`);
  await expect(page.locator(".xterm-rows")).toContainText("return answer;");
  await select(page, [0, 0], [18, 3]);
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(original);
  stream.data("\x1b[?1049h\x1b[2J\x1b[Halternate screen");
  await expect(page.locator(".xterm-rows")).toContainText("alternate screen");
  await page.setViewportSize({ width: 900, height: 650 });
  stream.data("\x1b[?1049l\r\nordered output 1\r\nordered output 2");
  await expect(page.locator(".xterm-rows")).toContainText("ordered output 1");
  await expect(page.locator(".xterm-rows")).toContainText("ordered output 2");
  stream.close();
  await expect.poll(stream.connections).toBe(2);
  stream.screen("replayed screen\r\nlatest output");
  await expect(page.locator(".xterm-rows")).toContainText("latest output");
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(original);
  await page
    .getByRole("button", { name: "Copy selection", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(original);
  expect(stream.input).toEqual([]);
});

test("clears selection when switching tabs and preserves normal input, paste and application mouse reports", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  stream.data("\x1bcfirst selection");
  await expect(page.locator(".xterm-rows")).toContainText("first selection");
  await select(page, [0, 0], [15, 0]);
  await page.getByRole("button", { name: "Switch tab" }).click();
  await expect.poll(stream.connections).toBe(2);
  await expect(
    page.getByRole("complementary", { name: "Saved terminal selection" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Switch tab" }).click();
  await expect(
    page.getByRole("complementary", { name: "Saved terminal selection" }),
  ).toBeHidden();
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("input");
  await page.keyboard.press("Control+c");
  await expect.poll(() => stream.input.join("")).toBe("input\x03");
  await page.evaluate(() => navigator.clipboard.writeText(" pasted"));
  await page.keyboard.press("Control+Shift+v");
  await expect.poll(() => stream.input.join("")).toBe("input\x03 pasted");
});

test("Shift-drag selects while mouse reporting is active and copy does not reach the application", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  stream.data("\x1bcselected original\x1b[?1000h\x1b[?1006h");
  await expect(page.locator(".xterm-rows")).toContainText("selected original");
  await select(page, [0, 0], [17, 0], true);
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue("selected original");
  const size = await cells(page);
  await page.mouse.click(size.x + 20, size.y + size.height / 2, {
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Copy saved selection" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("selected original");
  expect(stream.input).toEqual([]);
  await page.mouse.click(size.x + 20, size.y + size.height / 2);
  await expect.poll(() => stream.input.join("")).toMatch(/\x1b\[<0;/u);
});

for (const [target, selector] of [
  ["source terminal", '[aria-label="Source pane"] .xterm-screen'],
  ["other terminal", '[aria-label="Other pane"] .xterm-screen'],
  ["sidebar", '[aria-label="Sidebar"] button'],
  ["other pane input", '[aria-label="Other pane input"]'],
  ["empty workbench", '[aria-label="Empty workbench space"]'],
] as const) {
  test(`outside clicks in ${target} dismiss both terminal copy previews without taking the click or copying stale text`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Desktop mouse selection.",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const stream = await terminalStream(page, false, "codex", true);
    const source = page.getByRole("region", { name: "Source pane" });
    const saved = source.getByLabel("Saved terminal selection");
    const outside = page.locator(selector);
    await page.evaluate(() =>
      navigator.clipboard.writeText("clipboard sentinel"),
    );
    stream.data("\x1bcsaved text");
    await expect(source.locator(".xterm-rows")).toContainText("saved text");
    await select(page, [0, 0], [10, 0]);
    await expect(saved.getByRole("textbox")).toHaveValue("saved text");
    await saved.getByRole("textbox").click();
    await expect(saved).toBeVisible();
    const size = await cells(page);
    await page.mouse.click(size.x + 20, size.y + size.height / 2, {
      button: "right",
    });
    await expect(
      page.getByRole("menuitem", { name: "Copy saved selection" }),
    ).toBeVisible();

    await outside.click();
    await expect(saved).toBeHidden();
    await expect(page.getByRole("menu", { exact: true })).toBeHidden();
    if (target === "sidebar") {
      await expect(page.getByLabel("Sidebar clicks")).toHaveText("1");
      await expect(outside).toBeFocused();
    } else if (target === "other pane input") {
      await expect(outside).toBeFocused();
      await page.keyboard.type("next action");
      await expect(outside).toHaveValue("next action");
    } else if (target.endsWith("terminal")) {
      const pane = page.getByRole("region", {
        name: target === "source terminal" ? "Source pane" : "Other pane",
      });
      await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    }
    await source.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+c");
    await expect.poll(() => stream.input.join("")).toBe("\x03");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "clipboard sentinel",
    );

    await select(page, [0, 0], [10, 0]);
    await expect(saved.getByRole("textbox")).toHaveValue("saved text");
    await saved.getByRole("button", { name: "Clear selection" }).click();
    await expect(saved).toBeHidden();
    const application = "application text";
    const request = source.getByLabel("Application clipboard request");
    stream.data(`\x1b]52;c;${Buffer.from(application).toString("base64")}\x07`);
    await expect(request.getByRole("textbox")).toHaveValue(application);
    await request.getByRole("textbox").click();
    await expect(request).toBeVisible();
    await outside.click();
    await expect(request).toBeHidden();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "clipboard sentinel",
    );

    stream.data(`\x1b]52;c;${Buffer.from(application).toString("base64")}\x07`);
    await expect(request.getByRole("textbox")).toHaveValue(application);
    await request
      .getByRole("button", { name: "Copy application text" })
      .click();
    await expect(request).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(application);
  });
}

test("finishing a selection outside its terminal keeps the preview until a later outside click", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  const stream = await terminalStream(page, false, "codex", true);
  stream.data("\x1bcsaved text");
  await expect(
    page.getByRole("region", { name: "Source pane" }).locator(".xterm-rows"),
  ).toContainText("saved text");
  await dragSelection(page, [0, 0], [10, 0]);
  stream.data("\x1b[1;1H\x1b[2Kredrawn text");
  const source = page.getByRole("region", { name: "Source pane" });
  const saved = source.getByLabel("Saved terminal selection");
  await expect(saved.getByRole("textbox")).toHaveValue("saved text");
  const input = page.getByRole("textbox", { name: "Other pane input" });
  const bounds = (await page
    .getByRole("region", { name: "Other pane" })
    .locator(".xterm-screen")
    .boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
    { steps: 8 },
  );
  await expect(saved).toBeVisible();
  await page.mouse.up();
  await expect(saved).toBeVisible();
  await expect(saved.getByRole("textbox")).not.toHaveValue("");
  await input.click();
  await expect(saved).toBeHidden();
  await expect(input).toBeFocused();
});

test("touch taps inside terminal previews preserve them and outside taps dismiss without approving copy", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "Touchscreen input.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page, false, "codex", true);
  stream.data("\x1bcsaved");
  await expect(
    page.getByRole("region", { name: "Source pane" }).locator(".xterm-rows"),
  ).toContainText("saved");
  await page.evaluate(() =>
    navigator.clipboard.writeText("clipboard sentinel"),
  );
  await select(page, [0, 0], [5, 0]);
  const source = page.getByRole("region", { name: "Source pane" });
  const saved = source.getByLabel("Saved terminal selection");
  await expect(saved.getByRole("textbox")).toHaveValue("saved");
  await saved.getByRole("textbox").tap();
  await expect(saved).toBeVisible();
  await page.getByRole("button", { name: "Sidebar action" }).tap();
  await expect(saved).toBeHidden();
  await expect(page.getByLabel("Sidebar clicks")).toHaveText("1");
  await select(page, [0, 0], [5, 0]);
  await expect(saved.getByRole("textbox")).toHaveValue("saved");
  await saved.getByRole("button", { name: "Clear selection" }).tap();
  await expect(saved).toBeHidden();
  const request = source.getByLabel("Application clipboard request");
  stream.data("\x1b]52;c;c2F2ZWQ=\x07");
  await expect(request.getByRole("textbox")).toHaveValue("saved");
  await request.getByRole("textbox").tap();
  await expect(request).toBeVisible();
  await page.getByRole("button", { name: "Sidebar action" }).tap();
  await expect(request).toBeHidden();
  await expect(page.getByLabel("Sidebar clicks")).toHaveText("2");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "clipboard sentinel",
  );
});

test("keeps one saved selection through bounded scrollback churn and clears it deliberately", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  stream.data("\x1bcoriginal selected output");
  await expect(page.locator(".xterm-rows")).toContainText(
    "original selected output",
  );
  await select(page, [0, 0], ["original selected output".length, 0]);
  for (let batch = 0; batch < 20; batch++) {
    stream.data(
      Array.from(
        { length: 100 },
        (_, index) => `\r\noutput ${batch * 100 + index}`,
      ).join(""),
    );
  }
  await expect(page.locator(".xterm-rows")).toContainText("output 1998");
  await expect(page.locator(".xterm-rows")).toContainText("output 1999");
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue("original selected output");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("complementary", { name: "Saved terminal selection" }),
  ).toBeHidden();
  expect(stream.input).toEqual([]);
  stream.data("\x1bcnew selected output");
  await expect(page.locator(".xterm-rows")).toContainText(
    "new selected output",
  );
  await select(page, [0, 0], [19, 0]);
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(
    page.getByRole("complementary", { name: "Saved terminal selection" }),
  ).toBeHidden();
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect.poll(() => stream.input.join("")).toBe("\x03");
});

for (const clipboardDenied of [false, true]) {
  for (const gesture of ["Control+c", "browser copy"]) {
    test(`copies only the highlighted preview word using ${gesture}, clipboard denied: ${clipboardDenied}`, async ({
      page,
      context,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop-chromium",
        "Desktop mouse selection.",
      );
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const stream = await terminalStream(page);
      const original = "please run command then inspect the output";
      stream.data(`\x1bc${original}`);
      await expect(page.locator(".xterm-rows")).toContainText(original);
      await select(page, [0, 0], [original.length, 0]);
      if (clipboardDenied) {
        await page.evaluate(() => {
          navigator.clipboard.writeText = async () => {
            throw new Error("Permission denied");
          };
        });
        await page
          .getByRole("button", { name: "Copy selection", exact: true })
          .click();
        await expect(page.getByRole("status")).toContainText(
          "Copy failed: Permission denied",
        );
      }
      const preview = page.getByRole("textbox", {
        name: "Selected terminal text",
      });
      await expect(preview).toHaveValue(original);
      const word = await preview.evaluate((element: HTMLTextAreaElement) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const measure = document.createElement("canvas").getContext("2d")!;
        measure.font = style.font;
        return {
          x:
            bounds.x +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.paddingLeft) +
            measure.measureText("please run com").width,
          y:
            bounds.y +
            parseFloat(style.borderTopWidth) +
            parseFloat(style.paddingTop) +
            parseFloat(style.fontSize) / 2,
        };
      });
      await page.mouse.dblclick(word.x, word.y);
      await expect
        .poll(() =>
          preview.evaluate((element: HTMLTextAreaElement) =>
            element.value.slice(element.selectionStart, element.selectionEnd),
          ),
        )
        .toBe("command");
      if (gesture === "browser copy")
        expect(await page.evaluate(() => document.execCommand("copy"))).toBe(
          true,
        );
      else await page.keyboard.press(gesture);
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe("command");
      await expect(preview).toHaveValue(original);
      expect(stream.input).toEqual([]);
    });
  }
}

test("explains forced terminal selection without taking application mouse gestures", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop mouse selection.",
  );
  const stream = await terminalStream(page);
  await page.getByText("Copy help", { exact: true }).click();
  await expect(page.locator(".terminal-copy-help")).toContainText(
    "Hold Shift and drag",
  );
  await expect(page.locator(".terminal-copy-help")).toContainText(
    "Fullscreen applications own normal dragging",
  );
  await page.getByText("Copy help", { exact: true }).click();
  stream.data("\x1bcnative selection\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  await expect(page.locator(".xterm-rows")).toContainText("native selection");
  await select(page, [0, 0], [16, 0]);
  await expect(
    page.getByRole("complementary", { name: "Saved terminal selection" }),
  ).toBeHidden();
  await page.keyboard.press("Control+c");
  expect(stream.input.join("")).toContain("\x1b[<0;");
  await expect.poll(() => stream.input.join("")).toContain("\x03");
});

test("stages application clipboard text until an explicit trusted copy and preserves native input", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop clipboard.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  await page.evaluate(() =>
    navigator.clipboard.writeText("clipboard sentinel"),
  );
  const text = "native application selection · 界 café";
  stream.data(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  const request = page.getByRole("complementary", {
    name: "Application clipboard request",
  });
  await expect(request.getByRole("textbox")).toHaveValue(text);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "clipboard sentinel",
  );
  await request
    .getByRole("button", { name: "Copy application text" })
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(request).toContainText("Use the Copy application text button");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "clipboard sentinel",
  );
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect.poll(() => stream.input.join("")).toBe("\x03");
  stream.data(
    `\x1b]52;c;${Buffer.from("unexpected replacement").toString("base64")}\x1b\\`,
  );
  await expect(request).toContainText(
    "Another application clipboard request was ignored",
  );
  await expect(request.getByRole("textbox")).toHaveValue(text);
  await request.getByRole("button", { name: "Copy application text" }).click();
  await expect(request).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(text);
  expect(stream.input).toEqual(["\x03"]);
});

for (const gesture of ["Control+c", "browser copy"]) {
  test(`copies only the highlighted application preview word while a terminal selection is saved using ${gesture}`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Desktop clipboard.",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const stream = await terminalStream(page);
    const saved = "old saved terminal text";
    stream.data(`\x1bc${saved}`);
    await expect(page.locator(".xterm-rows")).toContainText(saved);
    await select(page, [0, 0], [saved.length, 0]);
    const selection = page.getByRole("textbox", {
      name: "Selected terminal text",
    });
    await expect(selection).toHaveValue(saved);
    const application = "review this command before copying";
    stream.data(`\x1b]52;c;${Buffer.from(application).toString("base64")}\x07`);
    const preview = page.getByRole("textbox", {
      name: "Application clipboard text",
    });
    await expect(preview).toHaveValue(application);
    await preview.focus();
    await preview.evaluate((element: HTMLTextAreaElement) => {
      const start = element.value.indexOf("command");
      element.setSelectionRange(start, start + "command".length);
    });
    if (gesture === "browser copy")
      expect(await page.evaluate(() => document.execCommand("copy"))).toBe(
        true,
      );
    else await page.keyboard.press(gesture);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("command");
    await expect(preview).toHaveValue(application);
    await expect(selection).toHaveValue(saved);
    expect(stream.input).toEqual([]);

    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(saved);
    await expect(selection).toBeHidden();
    await expect(preview).toHaveValue(application);
    expect(stream.input).toEqual([]);
    await page.keyboard.press("Control+c");
    await expect.poll(() => stream.input.join("")).toBe("\x03");
  });
}

test("keeps application preview context menus and Escape native while a terminal selection is saved", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop clipboard.");
  const stream = await terminalStream(page);
  const saved = "old saved terminal text";
  stream.data(`\x1bc${saved}`);
  await expect(page.locator(".xterm-rows")).toContainText(saved);
  await select(page, [0, 0], [saved.length, 0]);
  stream.data(
    `\x1b]52;c;${Buffer.from("review application text").toString("base64")}\x07`,
  );
  const preview = page.getByRole("textbox", {
    name: "Application clipboard text",
  });
  await expect(preview).toHaveValue("review application text");
  const contextMenu = await preview.evaluate((element) => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    return element.dispatchEvent(event);
  });
  expect(contextMenu).toBe(true);
  await expect(page.getByRole("menu", { exact: true })).toBeHidden();
  await preview.focus();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(saved);
  expect(stream.input).toEqual([]);

  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toBeHidden();
  await expect(preview).toHaveValue("review application text");
  expect(stream.input).toEqual([]);
});

test("reports application clipboard permission denial and retains the reviewed text", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop clipboard.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  });
  stream.data(
    `\x1b]52;c;${Buffer.from("review this application text").toString("base64")}\x07`,
  );
  const request = page.getByRole("complementary", {
    name: "Application clipboard request",
  });
  await request.getByRole("button", { name: "Copy application text" }).click();
  await expect(request).toContainText("Copy failed: Permission denied");
  await expect(request.getByRole("textbox")).toHaveValue(
    "review this application text",
  );
  await request
    .getByRole("button", { name: "Dismiss clipboard request" })
    .click();
  await expect(request).toBeHidden();
  expect(stream.input).toEqual([]);
});

for (const [description, payload, rejection] of [
  ["read", "c;?", "Clipboard reads are blocked"],
  ["primary target", "p;YQ==", "Only clipboard text requests are supported"],
  ["malformed base64", "c;Y!==", "invalid base64"],
  ["invalid UTF-8", "c;/w==", "not valid UTF-8"],
  [
    "control data",
    `c;${Buffer.from("bad\x1b[31m").toString("base64")}`,
    "unsafe control characters",
  ],
  [
    "oversize",
    `c;${Buffer.from("x".repeat(100_001)).toString("base64")}`,
    "exceeds 100,000 bytes",
  ],
] as const) {
  test(`rejects ${description} application clipboard requests without reading or replacing the clipboard`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Desktop clipboard.",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const stream = await terminalStream(page);
    await page.evaluate(() =>
      navigator.clipboard.writeText("clipboard sentinel"),
    );
    stream.data(`\x1b]52;${payload}\x07`);
    const request = page.getByRole("complementary", {
      name: "Application clipboard request",
    });
    await expect(request).toContainText(rejection);
    await expect(
      request.getByRole("button", { name: "Copy application text" }),
    ).toBeDisabled();
    await expect(request.getByRole("textbox")).toHaveValue("");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "clipboard sentinel",
    );
    expect(stream.input).toEqual([]);
  });
}

test("clears application clipboard requests when switching terminal tabs", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop clipboard.");
  const stream = await terminalStream(page);
  stream.data("\x1b]52;c;c2F2ZWQ=\x07");
  const request = page.getByRole("complementary", {
    name: "Application clipboard request",
  });
  await expect(request.getByRole("textbox")).toHaveValue("saved");
  await page.getByRole("button", { name: "Switch tab" }).click();
  await expect.poll(stream.connections).toBe(2);
  await expect(request).toBeHidden();
  await page.getByRole("button", { name: "Switch tab" }).click();
  await expect(request).toBeHidden();
});

test("copies a real Codex fullscreen selection through OSC 52 to browser paste", async ({
  page,
  context,
}, testInfo) => {
  const codex = process.env.CLOUDX_NATIVE_CODEX;
  test.skip(
    !codex || testInfo.project.name !== "desktop-chromium",
    "Set CLOUDX_NATIVE_CODEX to an installed native CLI with fullscreen selection and OSC 52 support.",
  );
  test.setTimeout(60_000);
  expect(path.isAbsolute(codex!)).toBe(true);
  const version = execFileSync(codex!, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (process.env.CLOUDX_NATIVE_CODEX_VERSION)
    expect(version).toBe(
      `codex-cli ${process.env.CLOUDX_NATIVE_CODEX_VERSION}`,
    );
  const native = await NativeCodexCopySession.create(codex!);
  const answer = native.answer;
  try {
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket("**/ws/terminal/*", (connection) => {
      socket = connection;
      connection.onMessage((message) =>
        native.input(JSON.parse(String(message))),
      );
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(baseUrl);
    await expect(page.locator(".xterm-rows")).toContainText("Cloudx tab");
    const dimensions = await page.evaluate(() => ({
      cols: window.testTerminal.cols,
      rows: window.testTerminal.rows,
    }));
    await native.start(dimensions, (chunk) =>
      socket!.send(JSON.stringify({ type: "data", data: chunk })),
    );
    await expect
      .poll(
        () => page.evaluate(() => window.testTerminal.modes.mouseTrackingMode),
        { timeout: 15_000 },
      )
      .not.toBe("none");
    await expect(page.locator(".xterm-rows")).toContainText(
      "Ask Codex to do anything",
    );
    await page.locator(".xterm-helper-textarea").focus();
    await page.evaluate(() =>
      navigator.clipboard.writeText(
        "Provide the isolated clipboard test answer.",
      ),
    );
    await page.keyboard.press("Control+Shift+v");
    await expect(page.locator(".xterm-rows")).toContainText(
      "Provide the isolated clipboard test answer.",
    );
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(answer, {
      timeout: 15_000,
    });
    await expect.poll(() => native.requestCount).toBe(1);
    await page.evaluate(() =>
      navigator.clipboard.writeText("clipboard sentinel"),
    );
    const row = await page
      .locator(".xterm-rows > div")
      .evaluateAll(
        (elements, expected) =>
          elements.findIndex((element) =>
            element.textContent?.includes(expected),
          ),
        answer,
      );
    expect(row).toBeGreaterThanOrEqual(0);
    const column = await page.evaluate(
      ({ row, answer }) =>
        window.testTerminal.buffer.active
          .getLine(row)!
          .translateToString(false)
          .indexOf(answer),
      { row, answer },
    );
    expect(column).toBeGreaterThanOrEqual(0);
    await select(page, [column, row], [column + answer.length, row]);
    expect(await page.evaluate(() => window.testTerminal.getSelection())).toBe(
      "",
    );
    await expect(
      page.getByRole("complementary", { name: "Saved terminal selection" }),
    ).toBeHidden();
    await page.keyboard.press("Control+c");
    const request = page.getByRole("complementary", {
      name: "Application clipboard request",
    });
    await expect(request.getByRole("textbox")).toHaveValue(answer);
    expect(native.output).toContain("\x1b]52;c;");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "clipboard sentinel",
    );
    await page.screenshot({
      path: testInfo.outputPath("native-codex-clipboard-request.png"),
    });
    await request
      .getByRole("button", { name: "Copy application text" })
      .click();
    await expect(request).toBeHidden();
    await page.evaluate(() => {
      const paste = document.createElement("textarea");
      paste.setAttribute("aria-label", "Browser paste target");
      document.body.append(paste);
    });
    const paste = page.getByRole("textbox", { name: "Browser paste target" });
    await paste.focus();
    await page.keyboard.press("Control+v");
    await expect(paste).toHaveValue(answer);
    testInfo.annotations.push(
      { type: "native-cli-version", description: version },
      { type: "browser-version", description: context.browser()!.version() },
    );
  } finally {
    try {
      await fs.writeFile(
        testInfo.outputPath("native-codex-terminal.txt"),
        native.output,
      );
    } finally {
      await native.dispose();
    }
  }
});

test("copies the saved selection while a supported native Codex picker hands off and redraws", async ({
  page,
  context,
}, testInfo) => {
  const capturePath = process.env.CLOUDX_NATIVE_TERMINAL_CAPTURE;
  test.skip(
    !capturePath || testInfo.project.name !== "desktop-chromium",
    "Set CLOUDX_NATIVE_TERMINAL_CAPTURE to the isolated native recovery test's raw PTY capture.",
  );
  const nativeOutput = await fs.readFile(capturePath!, "utf8");
  const handoff = nativeOutput.indexOf("\x1b[?1049l");
  expect(handoff).toBeGreaterThan(0);
  const version = nativeOutput.match(/\(v(\d+\.\d+\.\d+)\)/u)?.[1];
  expect(version).toBeTruthy();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stream = await terminalStream(page);
  stream.data(nativeOutput.slice(0, handoff));
  const original = "Resume a previous session";
  await expect(page.locator(".xterm-rows")).toContainText(original);
  await select(page, [1, 0], [1 + original.length, 0]);
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(original);
  stream.data(nativeOutput.slice(handoff));
  await expect(page.locator(".xterm-rows")).toContainText(
    "Saved picker conversation.",
  );
  await expect(page.locator(".xterm-rows")).not.toContainText(original);
  await expect(
    page.getByRole("textbox", { name: "Selected terminal text" }),
  ).toHaveValue(original);
  const screenshot = testInfo.outputPath("native-codex-selection.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("native-codex-selection.png", {
    path: screenshot,
    contentType: "image/png",
  });
  stream.input.length = 0;
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(original);
  expect(stream.input).toEqual([]);
  testInfo.annotations.push(
    { type: "native-cli-version", description: version! },
    {
      type: "browser-version",
      description: page.context().browser()!.version(),
    },
  );
});

import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
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
  baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/tests/browser/fixtures/terminal-copy.html?view=codex`;
});
test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

test("keeps the native composer draft, caret, selection, focus and input through backend bursts and resize", async ({
  page,
}, testInfo) => {
  test.skip(
    !process.env.CLOUDX_NATIVE_CODEX,
    "Set CLOUDX_NATIVE_CODEX to exercise the real native TUI.",
  );
  const native = await NativeCodexCopySession.create(
    process.env.CLOUDX_NATIVE_CODEX!,
    true,
  );
  try {
    await page.routeWebSocket("**/ws/terminal/*", (socket) => {
      socket.onMessage((message) => native.input(JSON.parse(String(message))));
      void native.start({ cols: 100, rows: 30 }, (chunk) =>
        socket.send(JSON.stringify({ type: "data", data: chunk })),
      );
    });
    await page.goto(baseUrl);
    const terminal = page.locator(".xterm-rows");
    const input = page.locator(".xterm-helper-textarea");
    await expect(terminal).toContainText("OpenAI Codex", { timeout: 10_000 });
    await input.focus();
    await page.keyboard.type("Composer draft café");
    await expect(terminal).toContainText("Composer draft café");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const draftCaret = await page.evaluate(() => {
      const buffer = window.testTerminal.buffer.active;
      for (let row = 0; row < buffer.length; row++) {
        const column = buffer
          .getLine(row)!
          .translateToString()
          .indexOf("Composer draft café");
        if (column >= 0) return column + "Composer draft ".length;
      }
      throw new Error("Native draft is missing from the terminal buffer.");
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.testTerminal.buffer.active.cursorX),
      )
      .toBe(draftCaret);
    const cursor = await page.evaluate(() => ({
      x: window.testTerminal.buffer.active.cursorX,
      y: window.testTerminal.buffer.active.cursorY,
    }));
    const selection = await page.evaluate(() => {
      const buffer = window.testTerminal.buffer.active;
      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row)!.translateToString();
        const column = line.indexOf("Composer draft café");
        if (column >= 0) {
          window.testTerminal.select(column, row, "Composer draft café".length);
          return window.testTerminal.getSelection();
        }
      }
      throw new Error("Native draft is missing from the terminal buffer.");
    });
    expect(selection).toBe("Composer draft café");
    const preview = page.getByRole("textbox", {
      name: "Selected terminal text",
    });
    await expect(preview).toHaveValue(selection);
    const firstBurst = await native.emitBackendDiagnostics();
    await expect.poll(() => native.backendDiagnostics()).toContain(firstBurst);
    await expect(input).toBeFocused();
    expect(
      await page.evaluate(() => ({
        x: window.testTerminal.buffer.active.cursorX,
        y: window.testTerminal.buffer.active.cursorY,
      })),
    ).toEqual(cursor);
    expect(await page.evaluate(() => window.testTerminal.getSelection())).toBe(
      selection,
    );
    await expect(terminal).toContainText("Composer draft café");
    await expect(terminal).not.toContainText("BACKEND_DIAGNOSTIC_ONLY");
    const writesBeforeResize = await page.evaluate(
      () => window.terminalWriteCount,
    );
    await page.setViewportSize({ width: 1000, height: 780 });
    await expect
      .poll(() => page.evaluate(() => window.terminalWriteCount))
      .toBeGreaterThan(writesBeforeResize);
    await expect(terminal).toContainText("Composer draft café");
    await expect(preview).toHaveValue(selection);
    const resizedBurst = await native.emitBackendDiagnostics();
    await expect
      .poll(() => native.backendDiagnostics())
      .toContain(resizedBurst);
    await expect(input).toBeFocused();
    await expect(terminal).not.toContainText("BACKEND_DIAGNOSTIC_ONLY");
    await page.evaluate(() => window.testTerminal.clearSelection());
    await page.keyboard.type("X");
    await expect(terminal).toContainText("Composer draft Xcafé");
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        native.prompts.some((prompt) =>
          prompt.includes("Composer draft Xcafé"),
        ),
      )
      .toBe(true);
    await expect(terminal).toContainText(native.answer, { timeout: 10_000 });
    expect(native.toolOutputs.join("\n")).toContain("Failed to read file");
    expect(native.output).not.toContain("BACKEND_DIAGNOSTIC_ONLY");
    expect(
      Buffer.byteLength(await native.backendDiagnostics()),
    ).toBeLessThanOrEqual(256 * 1024);
    const screenshot = testInfo.outputPath("native-composer-diagnostics.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("native-composer-diagnostics", {
      path: screenshot,
      contentType: "image/png",
    });
  } finally {
    await native.dispose();
  }
});

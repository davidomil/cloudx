import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type { CodexCommandDetailsSnapshot } from "../../packages/shared/src/codexCommandDetails.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let server: ViteDevServer;
let httpServer: Server;
let baseUrl: string;
const command = `python3 - <<'PY'\nprint("quotes: \\\" and literal \\n")\n\tprint('indented text')\nPY\n${"# long command with quotes ' and escapes \\n\n".repeat(120)}`;
const output = `quotes: " and literal \\n\n\tindented output\n<script>text, never markup</script>\n${"long output ".repeat(90)}\n${Array.from({ length: 5_000 }, (_, i) => `row ${i}: preserved  whitespace`).join("\n")}\n`;

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
    optimizeDeps: { entries: ["tests/browser/fixtures/command-details.html"] },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/command-details.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

function snapshot(tabId: string, text = command): CodexCommandDetailsSnapshot {
  return {
    version: 1,
    tabId,
    executionId: `${tabId}-execution`,
    status: "available",
    commands: [
      {
        threadId: `${tabId}-thread`,
        turnId: `${tabId}-turn`,
        id: `${tabId}-command`,
        command: text,
        cwd: `/workspace/${tabId}`,
        status: "inProgress",
        output,
        commandTruncated: false,
        outputTruncated: false,
      },
    ],
  };
}

async function openFixture(page: Page) {
  const snapshots: Record<string, CodexCommandDetailsSnapshot> = {
    alpha: snapshot("alpha"),
    beta: snapshot("beta", "printf 'beta output'"),
  };
  const input: string[] = [];
  const reads: string[] = [];
  await page.route("**/api/tabs/*/command-details", async (route) => {
    reads.push(route.request().method());
    const tabId = route.request().url().split("/").at(-2)!;
    await route.fulfill({ json: snapshots[tabId] });
  });
  await page.routeWebSocket("**/ws/terminal/*", (socket) => {
    socket.send(JSON.stringify({ type: "data", data: "Codex prompt > " }));
    socket.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === "input") {
        input.push(event.data);
        socket.send(JSON.stringify({ type: "data", data: event.data }));
      }
    });
  });
  await page.goto(baseUrl);
  const opener = page.getByRole("button", {
    name: "Open command details",
    exact: true,
  });
  await expect(opener).toBeEnabled();
  return { snapshots, input, reads, opener };
}

test("preserves multiline text, native copy, scrolling and draft while output continues", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { snapshots, input, reads, opener } = await openFixture(page);
  const terminal = page.locator('[data-tab="alpha"] .xterm-helper-textarea');
  await terminal.focus();
  const draft = `keep draft "quotes" \\n`;
  await page.keyboard.type(draft);
  await expect.poll(() => input.join("")).toBe(draft);
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Codex command and output" });
  const fullCommand = dialog.getByRole("textbox", {
    name: "Full command",
    exact: true,
  });
  const commandOutput = dialog.getByRole("textbox", {
    name: "Command output",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Codex alpha");
  await expect(dialog).toContainText("alpha-command");
  await expect(fullCommand).toHaveValue(command);
  await expect(commandOutput).toHaveValue(output);
  await expect(fullCommand).not.toBeEditable();
  await expect(commandOutput).not.toBeEditable();
  expect(
    await commandOutput.evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await fullCommand.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+C");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(command);
  await page.keyboard.type("must stay read-only");
  await expect(fullCommand).toHaveValue(command);
  const continued = `${output}continued output belongs to alpha\n`;
  snapshots.alpha.commands[0].output = continued;
  await expect(commandOutput).toHaveValue(continued);
  await expect(fullCommand).toBeFocused();
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(fullCommand).toBeFocused();
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.height).toBeLessThanOrEqual(640);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath("narrow-command-details.png"),
  });
  await page.setViewportSize({ width: 980, height: 720 });
  await page.screenshot({ path: testInfo.outputPath("command-details.png") });
  await testInfo.attach("browser-version", {
    body: page.context().browser()!.version(),
    contentType: "text/plain",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  snapshots.alpha.commands[0].output += "after dismissal\n";
  await page.waitForTimeout(1_200);
  await expect(dialog).not.toBeVisible();
  expect(input.join("")).toBe(draft);
  expect(reads.every((method) => method === "GET")).toBe(true);
  await terminal.focus();
  await page.keyboard.type(" tail");
  await expect.poll(() => input.join("")).toBe(`${draft} tail`);
  await expect(page.locator('[data-tab="alpha"] .xterm-rows')).toContainText(
    "keep draft",
  );
});

test("keeps details tied to their tab, execution and selected command", async ({
  page,
}) => {
  const { snapshots, input, opener } = await openFixture(page);
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Codex command and output" });
  await expect(dialog).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { activateCommandTab(id: string): void }
    ).activateCommandTab("beta"),
  );
  await expect(dialog).not.toBeVisible();
  await expect(
    page.locator('[data-tab="beta"] .xterm-helper-textarea'),
  ).toBeFocused();
  await opener.click();
  await expect(dialog).toContainText("Codex beta");
  await expect(
    dialog.getByRole("textbox", { name: "Full command", exact: true }),
  ).toHaveValue("printf 'beta output'");
  await page.getByRole("button", { name: "Close command details" }).click();
  await expect(opener).toBeFocused();
  await page.getByRole("button", { name: "alpha", exact: true }).click();
  await opener.click();
  snapshots.alpha.executionId = "new-alpha-execution";
  snapshots.alpha.commands[0].command = "printf 'new execution'";
  await expect(dialog).not.toBeVisible();
  await opener.click();
  await expect(
    dialog.getByRole("textbox", { name: "Full command", exact: true }),
  ).toHaveValue("printf 'new execution'");
  expect(input).toEqual([]);
});

test("retains the selected execution when another command arrives and exposes truncation", async ({
  page,
}) => {
  const { snapshots, opener } = await openFixture(page);
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Codex command and output" });
  await expect(dialog).toBeVisible();
  const later = {
    ...snapshots.alpha.commands[0],
    turnId: "later-turn",
    command: "printf 'later command'",
    output: "retained later output\n",
    status: "completed" as const,
    commandTruncated: true,
    outputTruncated: true,
  };
  snapshots.alpha.commands.push(later);
  const selector = page.getByRole("combobox", {
    name: "Recent Codex commands",
  });
  await expect(selector).toHaveCount(1);
  await expect(
    dialog.getByRole("textbox", { name: "Full command", exact: true }),
  ).toHaveValue(command);
  await expect(
    dialog.getByRole("textbox", { name: "Command output", exact: true }),
  ).toHaveValue(output);
  await page.getByRole("button", { name: "Close command details" }).click();
  await selector.selectOption(
    JSON.stringify([later.threadId, later.turnId, later.id]),
  );
  await opener.click();
  await expect(dialog).toContainText("later-turn");
  await expect(
    dialog.getByRole("textbox", { name: "Full command", exact: true }),
  ).toHaveValue(later.command);
  await expect(dialog).toContainText("Command exceeds the retained size limit");
  await expect(dialog).toContainText("Output exceeds the retained size limit");
  await page.keyboard.press("Escape");
  await selector.selectOption(
    JSON.stringify(["alpha-thread", "alpha-turn", "alpha-command"]),
  );
  await opener.click();
  await expect(
    dialog.getByRole("textbox", { name: "Full command", exact: true }),
  ).toHaveValue(command);
});

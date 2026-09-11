import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  startTerminalBroker,
  stopTestProcess,
} from "../../scripts/test-terminal-broker.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let root: string;
let baseUrl: string;
let env: NodeJS.ProcessEnv;
let broker: ChildProcess;
let server: ChildProcess;
let logs = "";

test.beforeEach(async () => {
  logs = "";
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-modes-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const imagegen = path.join(
    root,
    "codex-home",
    "skills",
    ".system",
    "imagegen",
  );
  await fs.mkdir(imagegen, { recursive: true });
  await fs.writeFile(
    path.join(imagegen, "SKILL.md"),
    "---\nname: imagegen\ndescription: Browser fixture only.\n---\nFixture data only.\n",
  );
  const fixture = path.join(root, "terminal.py");
  await fs.writeFile(
    fixture,
    `#!/usr/bin/env python3
import os, sys, tty, time
from pathlib import Path
tty.setraw(sys.stdin.fileno())
log = Path(${JSON.stringify(path.join(root, "input.bin"))})
log.write_bytes(b'')
os.write(1, b'NORMAL-BUFFER\\r\\n\\x1b[?1049h\\x1b[?1h\\x1b[?2004hREADY')
while True:
    data = os.read(0, 65536)
    with log.open('ab') as output:
        output.write(data)
    if data == b'f':
        for _ in range(80):
            os.write(1, b'output-before-update ' * 1024 + b'\\r\\n')
            time.sleep(0.005)
        os.write(1, b'\\x1b[2J\\x1b[HMODE-RECOVERED')
    elif data == b'n':
        os.write(1, b'\\x1b[?1049l')
    elif data == b's':
        os.write(1, b'\\x1b[2J\\x1b[HHEADER\\x1b[2;1Hone\\x1b[3;1Htwo\\x1b[4;1Hthree\\x1b[5;1HFOOTER\\x1b[2;4r\\x1b[4;1H')
    elif data == b't':
        os.write(1, b'\\r\\nNEXT')
    elif data == b'c':
        os.write(1, b'\\x1b[r\\x1b[0m\\x1b[2J\\x1b[HMARKER \\x1b[31')
    elif data == b'C':
        os.write(1, b'mRED\\x1b[0m')
    elif data == b'o':
        os.write(1, b'\\x1b[r\\x1b[2J\\x1b[HMARKER \\x1b]2;recovered')
    elif data == b'O':
        os.write(1, b'-title\\x07DONE')
`,
    { mode: 0o755 },
  );
  const port = await new Promise<number>((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address() as net.AddressInfo;
      listener.close(() => resolve(address.port));
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
  env = {
    ...process.env,
    CLOUDX_ALLOWED_ROOTS: workspace,
    CLOUDX_APP_SERVER_ENABLED: "false",
    CLOUDX_ASSISTANT_BIN: fixture,
    CLOUDX_ASR_URL: "http://127.0.0.1:9",
    CLOUDX_AUTOMATION_START_DISABLED: "true",
    CLOUDX_DATA_DIR: path.join(root, "data"),
    CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
    CLOUDX_HOST: "127.0.0.1",
    CLOUDX_LOG_LEVEL: "warn",
    CLOUDX_PORT: String(port),
    CODEX_HOME: path.join(root, "codex-home"),
    CODEX_SQLITE_HOME: "",
    SHELL: "/bin/bash",
  };
  broker = await startTerminalBroker("apps/server/dist/terminal/broker.js", {
    cwd: repoRoot,
    env,
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    onSpawn: captureLogs,
  });
  await startServer();
});

test.afterEach(async ({}, testInfo) => {
  await stopTestProcess(server);
  await stopTestProcess(broker);
  await testInfo.attach("terminal-recovery-server.log", {
    body: logs,
    contentType: "text/plain",
  });
  await fs.rm(root, { recursive: true, force: true });
});

test("preserves real xterm screen and input modes after replay truncation, reconnect, server restart, and reload", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openFixtureTerminal(page);
  await page.keyboard.type("f");
  await expect(page.locator(".xterm-rows")).toContainText("MODE-RECOVERED");

  await recoverTerminal(page, "socket reconnect");
  await verifyInputModes(page, "socket");

  await recoverTerminal(page, "web-server restoration");
  await verifyInputModes(page, "server");

  await page.reload();
  await verifyInputModes(page, "reload");
  const largePaste = "🙂漢".repeat(50_000);
  const inputStart = (await fs.readFile(path.join(root, "input.bin"))).length;
  await paste(page, largePaste);
  const expectedPaste = Buffer.from(`\x1b[200~${largePaste}\x1b[201~`);
  await expect
    .poll(async () =>
      (await fs.readFile(path.join(root, "input.bin")))
        .subarray(inputStart)
        .equals(expectedPaste),
    )
    .toBe(true);
  await verifyInputModes(page, "after-large-paste");
  await page.keyboard.type("n");
  await expect(page.locator(".xterm-rows")).toContainText("NORMAL-BUFFER");
  await expect(page.locator(".xterm-rows")).not.toContainText("MODE-RECOVERED");
});

for (const recovery of [
  "socket reconnect",
  "web-server restoration",
] as const) {
  test(`preserves scroll margins after ${recovery}`, async ({ page }) => {
    await openFixtureTerminal(page);
    await page.keyboard.type("s");
    const rows = page.locator(".xterm-rows > div");
    await expect(rows.nth(0)).toHaveText("HEADER");
    await expect(rows.nth(4)).toHaveText("FOOTER");

    await recoverTerminal(page, recovery);
    await page.keyboard.type("t");

    await expect(rows.nth(3)).toHaveText("NEXT");
    await expect(rows.nth(0)).toHaveText("HEADER");
    await expect(rows.nth(1)).toHaveText("two");
    await expect(rows.nth(2)).toHaveText("three");
    await expect(rows.nth(4)).toHaveText("FOOTER");
  });

  test(`completes a split CSI sequence after ${recovery}`, async ({ page }) => {
    await openFixtureTerminal(page);
    const firstRow = page.locator(".xterm-rows > div").first();
    await page.keyboard.type("c");
    await expect(firstRow).toHaveText("MARKER ");

    await recoverTerminal(page, recovery);
    await page.keyboard.type("C");

    await expect(firstRow).toHaveText("MARKER RED");
    await expect(firstRow.locator(".xterm-fg-1")).toHaveText("RED");
  });

  test(`completes a split OSC sequence after ${recovery}`, async ({ page }) => {
    await openFixtureTerminal(page);
    const firstRow = page.locator(".xterm-rows > div").first();
    await page.keyboard.type("o");
    await expect(firstRow).toHaveText("MARKER ");

    await recoverTerminal(page, recovery);
    await page.keyboard.type("O");

    await expect(firstRow).toHaveText("MARKER DONE");
  });
}

async function openFixtureTerminal(page: Page) {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    const recovery = { screens: 0 };
    Object.assign(window, {
      terminalTestSockets: sockets,
      terminalTestRecovery: recovery,
    });
    window.WebSocket = class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!String(url).includes("/ws/terminal/")) return;
        sockets.push(this);
        this.addEventListener("message", (event) => {
          if (JSON.parse(event.data).type === "screen") recovery.screens++;
        });
      }
    };
  });
  await page.goto(baseUrl);
  await page
    .locator(".workspace-pane.active")
    .getByTitle("Add tab to this pane")
    .click();
  await page.getByLabel("Plugin").selectOption("codex-terminal");
  await page.getByLabel("Title").fill("Terminal mode recovery");
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/tabs",
  );
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const created = await creation;
  expect(created.status(), await created.text()).toBe(201);
  await expect(page.locator(".xterm-rows")).toContainText("READY");
  await page.locator(".xterm-helper-textarea").focus();
}

async function recoverTerminal(
  page: Page,
  recovery: "socket reconnect" | "web-server restoration",
) {
  const screens = await screenCount(page);
  if (recovery === "socket reconnect") {
    await page.evaluate(() => {
      const sockets = (
        window as unknown as { terminalTestSockets: WebSocket[] }
      ).terminalTestSockets;
      sockets.at(-1)!.close(4000, "Test transport interruption");
    });
  } else {
    await stopTestProcess(server);
    await startServer();
  }
  await expect.poll(() => screenCount(page)).toBeGreaterThan(screens);
  await page.locator(".xterm-helper-textarea").focus();
}

async function screenCount(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { terminalTestRecovery: { screens: number } })
        .terminalTestRecovery.screens,
  );
}

async function verifyInputModes(page: Page, stage: string) {
  await expect(page.locator(".xterm-rows")).toContainText("MODE-RECOVERED");
  await page.locator(".xterm-helper-textarea").focus();
  const start = (await fs.readFile(path.join(root, "input.bin"))).length;
  await page.keyboard.press("ArrowUp");
  await paste(page, `${stage}-one\n${stage}-two`);
  const expected = `\x1bOA\x1b[200~${stage}-one\r${stage}-two\x1b[201~`;
  await expect
    .poll(async () =>
      (await fs.readFile(path.join(root, "input.bin")))
        .subarray(start)
        .toString(),
    )
    .toBe(expected);
}

async function paste(page: Page, text: string) {
  await page.locator(".xterm-helper-textarea").evaluate((textarea, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    textarea.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}

function captureLogs(child: ChildProcess) {
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
}

async function startServer() {
  server = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  captureLogs(server);
  await expect
    .poll(
      async () => {
        if (server.exitCode !== null) throw new Error(logs);
        return fetch(`${baseUrl}/health`).then(
          (response) => response.status,
          () => 0,
        );
      },
      { timeout: 10_000 },
    )
    .toBe(200);
}

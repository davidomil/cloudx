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

test.beforeAll(async () => {
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

test.afterAll(async ({}, testInfo) => {
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
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    Object.assign(window, { terminalTestSockets: sockets });
    window.WebSocket = class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/ws/terminal/")) sockets.push(this);
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
  await page.keyboard.type("f");
  await expect(page.locator(".xterm-rows")).toContainText("MODE-RECOVERED");

  await page.evaluate(() => {
    const sockets = (window as unknown as { terminalTestSockets: WebSocket[] })
      .terminalTestSockets;
    sockets.at(-1)!.close(4000, "Test transport interruption");
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { terminalTestSockets: WebSocket[] })
            .terminalTestSockets.length,
      ),
    )
    .toBe(2);
  await verifyInputModes(page, "socket");

  await stopTestProcess(server);
  await startServer();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { terminalTestSockets: WebSocket[] }
          ).terminalTestSockets.at(-1)?.readyState,
      ),
    )
    .toBe(1);
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

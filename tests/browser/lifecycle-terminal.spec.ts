import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { LifecycleBrowserProfile } from "../../scripts/ci/lifecycle-browser.mjs";

let server: Server;
let terminals: WebSocketServer;
let baseURL: string;
const inputs: string[] = [];
const attached: string[] = [];
const savedResponse = "\x1b[HThe lifecycle acceptance conversation is saved.";

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Lifecycle terminal probe</title>");
  });
  terminals = new WebSocketServer({ server });
  terminals.on("connection", (socket, request) => {
    const tabId = request.url?.split("/").at(-1);
    attached.push(tabId!);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      inputs.push(message.data);
      socket.send(
        JSON.stringify({ type: "data", data: "LIFECYCLE_AFTER:saved-state:" }),
      );
      socket.send(JSON.stringify({ type: "data", data: "123\r\n" }));
    });
    if (tabId === "closed") return socket.close(1011, "Attachment failed");
    if (tabId === "silent") return;
    socket.send(
      JSON.stringify({
        type: tabId === "data" ? "data" : "screen",
        data:
          tabId === "shell"
            ? "LIFECYCLE_AFTER:wrong-state:456\r\n"
            : savedResponse,
        cols: 80,
        rows: 24,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  for (const socket of terminals.clients) socket.terminate();
  await new Promise<void>((resolve) => terminals.close(() => resolve()));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test.beforeEach(async ({ page }) => {
  inputs.length = 0;
  attached.length = 0;
  await page.clock.install();
  await page.goto(baseURL);
});

for (const type of ["screen", "data"]) {
  test(`attaches to a ${type} replay after the Codex banner has scrolled away`, async ({
    page,
  }) => {
    const profile = new LifecycleBrowserProfile({ page });
    await expect(profile.readTerminal(type)).resolves.toBe(savedResponse);
    expect(attached).toEqual([type]);
    expect(inputs).toEqual([]);
  });
}

test("requires the preserved shell state and PID from subsequent input", async ({
  page,
}) => {
  const profile = new LifecycleBrowserProfile({ page });
  await expect(
    profile.readTerminal(
      "shell",
      "LIFECYCLE_AFTER:saved-state:123",
      "print-shell-state",
    ),
  ).resolves.toContain("LIFECYCLE_AFTER:saved-state:123");
  expect(inputs).toEqual(["print-shell-state\r"]);
});

test("rejects a closed terminal before its replay", async ({ page }) => {
  const profile = new LifecycleBrowserProfile({ page });
  await expect(profile.readTerminal("closed")).rejects.toThrow(
    "Terminal closed before returning the expected output.",
  );
});

test("fails at the existing deadline when an open terminal supplies no replay", async ({
  page,
}) => {
  const profile = new LifecycleBrowserProfile({ page });
  const rejected = expect(profile.readTerminal("silent")).rejects.toThrow(
    "Terminal did not return the expected replay before its deadline.",
  );
  await expect.poll(() => attached).toEqual(["silent"]);
  await page.clock.fastForward(30_000);
  await rejected;
});

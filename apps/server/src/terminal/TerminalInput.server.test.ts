import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";
import { TerminalBroker } from "./TerminalBroker.js";
import { MAX_TERMINAL_INPUT_BYTES, terminalSocketPath } from "./TerminalBrokerProtocol.js";
import type { TerminalProducer } from "./TerminalProcess.js";
import type { TerminalExit } from "./TerminalSupervisor.js";
import { terminalInputMessages } from "@cloudx/shared";

describe("large terminal input through public transports", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ documents: [] })));
  });

  afterEach(() => {
    const requests = vi.mocked(fetch).mock.calls;
    vi.unstubAllGlobals();
    for (const [url, options] of requests) {
      const requestUrl = new URL(String(url));
      expect(requestUrl.origin).toBe("http://127.0.0.1:9");
      expect(requestUrl.pathname).toBe("/enrichment/pending");
      expect(options?.method).toBe("GET");
    }
  });

  it.each(["action", "websocket"] as const)("preserves ASCII and Unicode input at and above the IPC limit through %s", async (transport) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-input-"));
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"), CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
      CLOUDX_TRUSTED_ORIGINS: "http://localhost", CLOUDX_LOG_LEVEL: "silent"
    });
    const terminal = new RecordingTerminal();
    const socketPath = terminalSocketPath(config.dataDir);
    const broker = new TerminalBroker(socketPath, { spawn: async () => terminal });
    await broker.start();
    const services = buildServices(config);
    const app = await buildServer(config, services);
    let socket: WebSocket | undefined;
    try {
      const window = services.workspace!.getActiveWindow();
      const created = await app.inject({
        method: "POST", url: "/api/tabs", headers: { host: "localhost" },
        payload: { pluginId: "standard-terminal", cwd: root, windowId: window.id, paneId: window.layout.activePaneId }
      });
      expect(created.statusCode).toBe(201);
      const { tab } = created.json<{ tab: { id: string } }>();
      if (transport === "websocket") {
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
        socket = new WebSocket(`${address.replace("http:", "ws:")}/ws/terminal/${tab.id}`, { origin: "http://localhost", headers: { host: "localhost" } });
        await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
      }
      const send = async (text: string) => {
        if (socket) for (const message of terminalInputMessages(text)) socket.send(message);
        else {
          const response = await app.inject({
            method: "POST", url: `/api/tabs/${tab.id}/actions`, headers: { host: "localhost" },
            payload: { action: "enter_text", input: { text, submit: false } }
          });
          expect(response.statusCode).toBe(200);
        }
      };
      for (const input of [
        "a".repeat(MAX_TERMINAL_INPUT_BYTES), "b".repeat(300 * 1024),
        "😀".repeat(MAX_TERMINAL_INPUT_BYTES / 4), "😀".repeat(MAX_TERMINAL_INPUT_BYTES / 4) + "界",
        "\u001b\u0000\"\\".repeat(50 * 1024)
      ]) {
        terminal.write.mockClear();
        await send(input);
        await send("\nNEXT_COMMAND\n");
        await vi.waitFor(() => expect(terminal.write.mock.calls.reduce((length, [data]) => length + data.length, 0)).toBe(input.length + "\nNEXT_COMMAND\n".length));
        expect(terminal.write.mock.calls.map(([data]) => data).join("") === input + "\nNEXT_COMMAND\n").toBe(true);
        expect(services.sessions.getTab(tab.id).status).toBe("running");
        if (socket) expect(socket.readyState).toBe(WebSocket.OPEN);
      }
      const closed = await app.inject({ method: "DELETE", url: `/api/tabs/${tab.id}`, headers: { host: "localhost" } });
      expect(closed.statusCode).toBe(200);
      expect(terminal.terminate).toHaveBeenCalledOnce();
    } finally {
      socket?.terminate();
      await app.close();
      await broker.stop();
      await fs.rm(path.dirname(socketPath), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

class RecordingTerminal implements TerminalProducer {
  private exit = (_event: TerminalExit) => {};
  onData() { return () => {}; }
  onExit(listener: (event: TerminalExit) => void) { this.exit = listener; return () => {}; }
  write = vi.fn((_data: string) => {});
  pauseOutput() {}
  resumeOutput() {}
  resize() {}
  kill() {}
  terminate = vi.fn(async () => { this.exit({ exitCode: 0 }); });
}

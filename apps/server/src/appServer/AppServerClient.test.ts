import { describe, expect, it } from "vitest";

import { AppServerClient, buildCodexAppServerLaunch, type AppServerTransport } from "./AppServerClient.js";

class FakeTransport implements AppServerTransport {
  private listener: ((message: Record<string, unknown>) => void) | undefined;
  sent: Record<string, unknown>[] = [];

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
    if (message.method === "initialize") {
      this.listener?.({ id: message.id as number, result: { codexHome: "/tmp/codex" } });
    }
    if (message.method === "thread/list") {
      this.listener?.({ id: message.id as number, result: { data: [{ id: "thread-1", preview: "test" }] } });
    }
  }

  onMessage(listener: (message: Record<string, unknown>) => void): void {
    this.listener = listener;
  }

  close(): void {
    return undefined;
  }
}

describe("AppServerClient", () => {
  it("launches Codex app-server with the configured assistant binary", () => {
    expect(buildCodexAppServerLaunch({ CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", SHELL: "/bin/bash" })).toEqual({
      command: "/usr/bin/codex",
      args: ["app-server", "--listen", "stdio://"]
    });
  });

  it("initializes and reads thread context", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient(transport);

    const context = await client.readVoiceContext("/tmp/project");

    expect(context).toEqual({ threads: { data: [{ id: "thread-1", preview: "test" }] } });
    expect(transport.sent.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/list"]);
  });
});

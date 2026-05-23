import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  AppServerClient,
  buildCodexAppServerLaunch,
  parseAppServerMessageLine,
  StdioAppServerTransport,
  type AppServerTransport
} from "./AppServerClient.js";

class FakeTransport implements AppServerTransport {
  private listener: ((message: Record<string, unknown>) => void) | undefined;
  sent: Record<string, unknown>[] = [];
  closed = false;

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
    this.closed = true;
  }
}

class ControlledTransport implements AppServerTransport {
  private listener: ((message: Record<string, unknown>) => void) | undefined;
  sent: Record<string, unknown>[] = [];
  closed = false;

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
  }

  onMessage(listener: (message: Record<string, unknown>) => void): void {
    this.listener = listener;
  }

  respondTo(index: number, result: unknown): void {
    const id = this.sent[index]?.id;
    if (typeof id !== "number") {
      throw new Error(`No request id recorded at index ${index}.`);
    }
    this.listener?.({ id, result });
  }

  close(): void {
    this.closed = true;
  }
}

class SilentTransport implements AppServerTransport {
  sent: Record<string, unknown>[] = [];
  closed = false;

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
  }

  onMessage(): void {
    return undefined;
  }

  close(): void {
    this.closed = true;
  }
}

class FailingSendTransport implements AppServerTransport {
  closed = false;

  send(): void {
    throw new Error("write failed");
  }

  onMessage(): void {
    return undefined;
  }

  close(): void {
    this.closed = true;
  }
}

class ErroringTransport implements AppServerTransport {
  private errorListener: ((error: Error) => void) | undefined;
  sent: Record<string, unknown>[] = [];
  closed = false;

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
  }

  onMessage(): void {
    return undefined;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  close(): void {
    this.closed = true;
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
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

  it("serializes concurrent initialization before sending app-server requests", async () => {
    const transport = new ControlledTransport();
    const client = new AppServerClient(transport);

    const firstContext = client.readVoiceContext("/tmp/project-a");
    const secondContext = client.readVoiceContext("/tmp/project-b");

    expect(transport.sent.map((message) => message.method)).toEqual(["initialize"]);

    transport.respondTo(0, { codexHome: "/tmp/codex" });
    await flushAsyncWork();

    expect(transport.sent.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/list", "thread/list"]);
    expect(transport.sent[2]).toMatchObject({ params: { cwd: ["/tmp/project-a"] } });
    expect(transport.sent[3]).toMatchObject({ params: { cwd: ["/tmp/project-b"] } });

    transport.respondTo(2, { data: [{ id: "thread-a" }] });
    transport.respondTo(3, { data: [{ id: "thread-b" }] });

    await expect(firstContext).resolves.toEqual({ threads: { data: [{ id: "thread-a" }] } });
    await expect(secondContext).resolves.toEqual({ threads: { data: [{ id: "thread-b" }] } });
  });

  it("parses app-server stdio messages defensively", () => {
    expect(parseAppServerMessageLine('{"id":1,"result":{"ok":true}}')).toEqual({ id: 1, result: { ok: true } });
    expect(parseAppServerMessageLine("{not-json")).toBeUndefined();
    expect(parseAppServerMessageLine('"not-an-object"')).toBeUndefined();
  });

  it("rejects pending and future requests when the client closes", async () => {
    const transport = new SilentTransport();
    const client = new AppServerClient(transport);
    const request = client.request("thread/list");

    client.close();

    await expect(request).rejects.toThrow("codex app-server client closed.");
    await expect(client.request("thread/list")).rejects.toThrow("codex app-server client closed.");
    expect(transport.closed).toBe(true);
  });

  it("rejects requests immediately when sending to the transport fails", async () => {
    const transport = new FailingSendTransport();
    const client = new AppServerClient(transport);

    await expect(client.request("thread/list")).rejects.toThrow("write failed");
    await expect(client.request("thread/list")).rejects.toThrow("codex app-server client closed.");
    expect(transport.closed).toBe(true);
  });

  it("rejects pending requests when the transport reports an error", async () => {
    const transport = new ErroringTransport();
    const client = new AppServerClient(transport);
    const request = client.request("thread/list");

    transport.emitError(new Error("spawn ENOENT"));

    await expect(request).rejects.toThrow("spawn ENOENT");
    await expect(client.request("thread/list")).rejects.toThrow("codex app-server client closed.");
    expect(transport.closed).toBe(true);
  });

  it("closes the stdio transport when app-server emits an oversized line", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fake-app-server-"));
    const fakeCodexPath = path.join(tempDir, "fake-codex.mjs");
    const previousAssistantBin = process.env.CLOUDX_ASSISTANT_BIN;

    await fs.writeFile(
      fakeCodexPath,
      "#!/usr/bin/env node\nsetTimeout(() => process.stdout.write('x'.repeat(1_100_000)), 20);\nsetTimeout(() => {}, 10_000);\n",
      "utf8"
    );
    await fs.chmod(fakeCodexPath, 0o755);
    process.env.CLOUDX_ASSISTANT_BIN = fakeCodexPath;

    try {
      const transport = new StdioAppServerTransport();
      const error = new Promise<Error>((resolve) => transport.onError(resolve));

      await expect(error).resolves.toMatchObject({ message: expect.stringContaining("stdout line limit") });
      expect(() => transport.send({ method: "thread/list", params: {} })).toThrow("closed");
    } finally {
      if (previousAssistantBin === undefined) {
        delete process.env.CLOUDX_ASSISTANT_BIN;
      } else {
        process.env.CLOUDX_ASSISTANT_BIN = previousAssistantBin;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

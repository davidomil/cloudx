import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { AsrClient } from "./asrClient.js";

describe("AsrClient", () => {
  const servers: Array<{ httpServer: http.Server; wsServer: WebSocketServer }> = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        ({ httpServer, wsServer }) =>
          new Promise<void>((resolve) => {
            wsServer.close(() => httpServer.close(() => resolve()));
          })
      )
    );
  });

  it("relays partial transcript messages before the final transcript", async () => {
    const startMessages: unknown[] = [];
    const { url } = await startAsrWebSocketServer((message, socket, isBinary) => {
      if (isBinary) {
        socket.send(JSON.stringify({ type: "partial", text: "list directory" }));
        return;
      }
      const payload = JSON.parse(message.toString()) as { type?: string };
      if (payload.type === "start") {
        startMessages.push(payload);
      }
      if (payload.type === "end") {
        socket.send(JSON.stringify({ type: "transcript", text: "list directory", language: "en" }));
      }
    });
    const partials: string[] = [];
    const client = new AsrClient(url);

    const result = await client.transcribeStream(audioChunks(), "voice.webm", (partial) => partials.push(partial.text));

    expect(partials).toEqual(["list directory"]);
    expect(result).toMatchObject({ text: "list directory", language: "en" });
    expect(startMessages).toEqual([{ type: "start", filename: "voice.webm" }]);
  });

  it("rejects when the audio stream fails before the end marker", async () => {
    const textMessages: string[] = [];
    const { url } = await startAsrWebSocketServer((message, _socket, isBinary) => {
      if (!isBinary) {
        textMessages.push(message.toString());
      }
    });
    const client = new AsrClient(url);

    await expect(client.transcribeStream(failingAudioChunks(), "voice.webm")).rejects.toThrow("too small to decode");

    expect(textMessages).not.toContain(JSON.stringify({ type: "end" }));
  });

  async function startAsrWebSocketServer(
    onMessage: (message: Buffer, socket: WebSocket, isBinary: boolean) => void
  ): Promise<{ url: string }> {
    const httpServer = http.createServer();
    const wsServer = new WebSocketServer({ server: httpServer, path: "/transcribe/ws" });
    servers.push({ httpServer, wsServer });
    wsServer.on("connection", (socket) => {
      socket.on("message", (message, isBinary) => onMessage(Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer), socket, isBinary));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("ASR test server did not expose a port.");
    }
    return { url: `http://127.0.0.1:${address.port}` };
  }
});

async function* audioChunks(): AsyncIterable<Buffer> {
  yield Buffer.from("audio");
}

async function* failingAudioChunks(): AsyncIterable<Buffer> {
  yield Buffer.from("audio");
  throw new Error("too small to decode");
}

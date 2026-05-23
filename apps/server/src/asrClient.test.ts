import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { AsrClient, parseAsrStreamMessage } from "./asrClient.js";

describe("AsrClient", () => {
  const servers: Array<{ httpServer: http.Server; wsServer?: WebSocketServer }> = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        ({ httpServer, wsServer }) =>
          new Promise<void>((resolve) => {
            if (!wsServer) {
              httpServer.close(() => resolve());
              return;
            }
            for (const client of wsServer.clients) {
              client.terminate();
            }
            wsServer.close(() => httpServer.close(() => resolve()));
          })
      )
    );
  });

  it("times out slow HTTP transcription requests", async () => {
    const { url } = await startAsrHttpServer((_request, _response) => {
      // Keep the request open until the client aborts it.
    });
    const client = new AsrClient(url, { timeoutMs: 20 });

    await expect(client.transcribe(Buffer.from("audio"), "voice.webm")).rejects.toThrow("ASR request timed out after 20 ms.");
  });

  it("keeps the HTTP transcription timeout active while reading the response body", async () => {
    const { url } = await startAsrHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"text":');
    });
    const client = new AsrClient(url, { timeoutMs: 20 });

    await expect(client.transcribe(Buffer.from("audio"), "voice.webm")).rejects.toThrow("ASR request timed out after 20 ms.");
  });

  it("posts HTTP transcription requests to the ASR endpoint with base path and query intact", async () => {
    let requestUrl: string | undefined;
    const { url } = await startAsrHttpServer((request, response) => {
      requestUrl = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "list directory" }));
    });
    const client = new AsrClient(`${url}/speech/?token=local`);

    const result = await client.transcribe(Buffer.from("audio"), "voice.webm");

    expect(result).toEqual({ text: "list directory" });
    expect(requestUrl).toBe("/speech/transcribe?token=local");
  });

  it("rejects oversized HTTP transcription responses before JSON parsing", async () => {
    const { url } = await startAsrHttpServer((_request, response) => {
      const body = JSON.stringify({ text: "x".repeat(64) });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
    });
    const client = new AsrClient(url, { responseMaxBytes: 16 });

    await expect(client.transcribe(Buffer.from("audio"), "voice.webm")).rejects.toThrow("ASR response exceeded 16 byte limit.");
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

  it("rejects malformed streaming responses instead of throwing from the websocket handler", async () => {
    const { url } = await startAsrWebSocketServer((message, socket, isBinary) => {
      if (isBinary) {
        return;
      }
      const payload = JSON.parse(message.toString()) as { type?: string };
      if (payload.type === "end") {
        socket.send("{not-json");
      }
    });
    const client = new AsrClient(url);

    await expect(client.transcribeStream(audioChunks(), "voice.webm")).rejects.toThrow("ASR streaming response was not a valid JSON object.");
  });

  it("rejects oversized streaming transcription responses", async () => {
    const { url } = await startAsrWebSocketServer((message, socket, isBinary) => {
      if (isBinary) {
        return;
      }
      const payload = JSON.parse(message.toString()) as { type?: string };
      if (payload.type === "end") {
        socket.send(JSON.stringify({ type: "transcript", text: "x".repeat(64) }));
      }
    });
    const client = new AsrClient(url, { responseMaxBytes: 16 });

    await expect(client.transcribeStream(audioChunks(), "voice.webm")).rejects.toThrow(/Max payload size exceeded|byte limit/);
  });

  it("rejects when the ASR socket closes before sending a transcript", async () => {
    const { url } = await startAsrWebSocketServer((message, socket, isBinary) => {
      if (isBinary) {
        return;
      }
      const payload = JSON.parse(message.toString()) as { type?: string };
      if (payload.type === "end") {
        socket.close(1000);
      }
    });
    const client = new AsrClient(url);

    await expect(client.transcribeStream(audioChunks(), "voice.webm")).rejects.toThrow("ASR streaming socket closed before a transcript was received.");
  });

  it("times out streaming transcription requests after the end marker", async () => {
    const textMessages: string[] = [];
    const { url } = await startAsrWebSocketServer((message, _socket, isBinary) => {
      if (!isBinary) {
        textMessages.push(message.toString());
      }
    });
    const client = new AsrClient(url, { timeoutMs: 20 });

    await expect(client.transcribeStream(audioChunks(), "voice.webm")).rejects.toThrow("ASR streaming request timed out after 20 ms.");
    expect(textMessages).toContain(JSON.stringify({ type: "end" }));
  });

  it("parses ArrayBuffer streaming transcript payloads", () => {
    const payload = Buffer.from(JSON.stringify({ type: "transcript", text: "list directory", language: "en" }));
    const raw = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;

    expect(parseAsrStreamMessage(raw)).toEqual({ type: "transcript", text: "list directory", language: "en", language_probability: undefined, message: undefined });
  });

  it("parses fragmented streaming transcript payloads", () => {
    const payload = Buffer.from(JSON.stringify({ type: "transcript", text: "list directory" }));
    const raw = [payload.subarray(0, 12), payload.subarray(12)];

    expect(parseAsrStreamMessage(raw)).toMatchObject({ type: "transcript", text: "list directory" });
  });

  it("rejects oversized fragmented streaming payloads before concatenating them", () => {
    expect(() => parseAsrStreamMessage([Buffer.alloc(12), Buffer.alloc(12)], 16)).toThrow("ASR streaming response exceeded 16 byte limit.");
  });

  async function startAsrHttpServer(onRequest: http.RequestListener): Promise<{ url: string }> {
    const httpServer = http.createServer(onRequest);
    servers.push({ httpServer });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("ASR test server did not expose a port.");
    }
    return { url: `http://127.0.0.1:${address.port}` };
  }

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

import WebSocket from "ws";

export const DEFAULT_ASR_TIMEOUT_MS = 30_000;
export const MAX_ASR_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_ASR_RESPONSE_MAX_BYTES = 1024 * 1024;

export interface TranscriptionResult {
  text: string;
  language?: string;
  language_probability?: number;
}

export interface PartialTranscriptionResult {
  text: string;
}

interface AsrStreamMessage {
  type?: string;
  message?: string;
  text?: string;
  language?: string;
  language_probability?: number;
}

export interface AsrClientOptions {
  timeoutMs?: number;
  responseMaxBytes?: number;
}

export class AsrClient {
  private readonly timeoutMs: number;
  private readonly responseMaxBytes: number;

  constructor(
    private readonly baseUrl: string,
    options: AsrClientOptions = {}
  ) {
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    this.responseMaxBytes = normalizePositiveByteLimit(options.responseMaxBytes ?? DEFAULT_ASR_RESPONSE_MAX_BYTES, "ASR response byte limit");
  }

  async transcribe(audio: Buffer, filename: string): Promise<TranscriptionResult> {
    const form = new FormData();
    const audioBytes = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    form.set("audio", new Blob([audioBytes]), filename);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.httpUrl("/transcribe"), {
        method: "POST",
        body: form,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`ASR request failed with ${response.status}.`);
      }

      const body = parseAsrHttpResponse(await readAsrResponseJson(response, this.responseMaxBytes));
      return body;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`ASR request timed out after ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async transcribeStream(
    chunks: AsyncIterable<Buffer>,
    filename: string,
    onPartial?: (partial: PartialTranscriptionResult) => void
  ): Promise<TranscriptionResult> {
    const ws = new WebSocket(this.websocketUrl("/transcribe/ws"), {
      handshakeTimeout: this.timeoutMs,
      maxPayload: this.responseMaxBytes,
      perMessageDeflate: false
    });
    await waitForOpen(ws, this.timeoutMs);

    const result = waitForTranscript(ws, this.responseMaxBytes, onPartial);

    try {
      await sendAsrWebSocketMessage(ws, JSON.stringify({ type: "start", filename }));
      for await (const chunk of chunks) {
        if (chunk.byteLength > 0) {
          await sendAsrWebSocketMessage(ws, chunk);
        }
      }
      await sendAsrWebSocketMessage(ws, JSON.stringify({ type: "end" }));
    } catch (error) {
      void result.catch(() => undefined);
      closeAsrWebSocket(ws);
      throw error;
    }

    return withTimeout(result, this.timeoutMs, () => closeAsrWebSocket(ws), `ASR streaming request timed out after ${this.timeoutMs} ms.`);
  }

  private httpUrl(pathname: string): string {
    return this.serviceUrl(pathname).toString();
  }

  private websocketUrl(pathname: string): string {
    const url = this.serviceUrl(pathname);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private serviceUrl(pathname: string): URL {
    const url = new URL(this.baseUrl);
    url.pathname = appendUrlPath(url.pathname, pathname);
    return url;
  }
}

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      suppressAsrWebSocketErrorsUntilClose(ws);
      closeAsrWebSocket(ws);
      reject(new Error(`ASR streaming socket did not open within ${timeoutMs} ms.`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", handleOpen);
      ws.off("error", handleError);
      ws.off("close", handleClose);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleClose = (code: number) => {
      cleanup();
      reject(new Error(`ASR streaming socket closed before opening with code ${code}.`));
    };
    ws.once("open", handleOpen);
    ws.once("error", handleError);
    ws.once("close", handleClose);
  });
}

function waitForTranscript(ws: WebSocket, responseMaxBytes: number, onPartial?: (partial: PartialTranscriptionResult) => void): Promise<TranscriptionResult> {
  return new Promise<TranscriptionResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      ws.off("message", handleMessage);
      ws.off("error", handleError);
      ws.off("close", handleClose);
    };
    const resolveOnce = (value: TranscriptionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const handleMessage = (raw: WebSocket.RawData) => {
      let message: AsrStreamMessage | undefined;
      try {
        message = parseAsrStreamMessage(raw, responseMaxBytes);
      } catch (error) {
        closeAsrWebSocket(ws);
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!message) {
        closeAsrWebSocket(ws);
        rejectOnce(new Error("ASR streaming response was not a valid JSON object."));
        return;
      }
      if (message.type === "partial" && typeof message.text === "string") {
        onPartial?.({ text: message.text });
        return;
      }
      if (message.type === "transcript") {
        closeAsrWebSocket(ws);
        if (typeof message.text !== "string") {
          rejectOnce(new Error("ASR response did not include transcript text."));
          return;
        }
        resolveOnce({
          text: message.text,
          language: message.language,
          language_probability: message.language_probability
        });
        return;
      }
      if (message.type === "error") {
        closeAsrWebSocket(ws);
        rejectOnce(new Error(message.message ?? "ASR streaming request failed."));
      }
    };
    const handleError = (error: Error) => {
      rejectOnce(error);
    };
    const handleClose = (code: number) => {
      rejectOnce(new Error(code === 1000 ? "ASR streaming socket closed before a transcript was received." : `ASR streaming socket closed with code ${code}.`));
    };
    ws.on("message", handleMessage);
    ws.on("error", handleError);
    ws.on("close", handleClose);
  });
}

function sendAsrWebSocketMessage(ws: WebSocket, data: string | Buffer): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("ASR streaming socket is not open."));
  }
  return new Promise((resolve, reject) => {
    try {
      ws.send(data, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function closeAsrWebSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
    return;
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
}

function suppressAsrWebSocketErrorsUntilClose(ws: WebSocket): void {
  const ignoreError = () => undefined;
  ws.on("error", ignoreError);
  ws.once("close", () => ws.off("error", ignoreError));
}

export function parseAsrStreamMessage(raw: WebSocket.RawData, maxBytes = DEFAULT_ASR_RESPONSE_MAX_BYTES): AsrStreamMessage | undefined {
  assertAsrResponseWithinLimit(rawAsrMessageByteLength(raw), maxBytes, "ASR streaming response");
  try {
    const parsed = JSON.parse(rawAsrMessageToString(raw)) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return {
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      text: typeof parsed.text === "string" ? parsed.text : undefined,
      language: typeof parsed.language === "string" ? parsed.language : undefined,
      language_probability: typeof parsed.language_probability === "number" ? parsed.language_probability : undefined
    };
  } catch {
    return undefined;
  }
}

async function readAsrResponseJson(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readResponseTextWithLimit(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("ASR response was not valid JSON.");
  }
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const length = Number(contentLength);
    if (Number.isFinite(length)) {
      assertAsrResponseWithinLimit(length, maxBytes, "ASR response");
    }
  }
  if (!response.body) {
    throw new Error("ASR response did not include a body.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`ASR response exceeded ${maxBytes} byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function parseAsrHttpResponse(value: unknown): TranscriptionResult {
  if (!isRecord(value)) {
    throw new Error("ASR response was not a valid JSON object.");
  }
  if (typeof value.text !== "string") {
    throw new Error("ASR response did not include transcript text.");
  }
  return {
    text: value.text,
    language: typeof value.language === "string" ? value.language : undefined,
    language_probability: typeof value.language_probability === "number" ? value.language_probability : undefined
  };
}

function rawAsrMessageToString(raw: WebSocket.RawData): string {
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  return Buffer.concat(raw).toString("utf8");
}

function rawAsrMessageByteLength(raw: WebSocket.RawData): number {
  if (Buffer.isBuffer(raw)) {
    return raw.byteLength;
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength;
  }
  return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
}

function assertAsrResponseWithinLimit(bytes: number, maxBytes: number, label: string): void {
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} byte limit.`);
  }
}

function appendUrlPath(basePathname: string, pathname: string): string {
  const base = basePathname.replace(/\/+$/, "");
  const child = pathname.replace(/^\/+/, "");
  return `${base || ""}/${child}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTimeoutMs(timeoutMs = DEFAULT_ASR_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_ASR_TIMEOUT_MS) {
    throw new Error(`ASR timeout must be a positive integer no greater than ${MAX_ASR_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

function normalizePositiveByteLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

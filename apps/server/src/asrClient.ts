import WebSocket from "ws";

export interface TranscriptionResult {
  text: string;
  language?: string;
  language_probability?: number;
}

export class AsrClient {
  constructor(private readonly baseUrl: string) {}

  async transcribe(audio: Buffer, filename: string, context?: string): Promise<TranscriptionResult> {
    const form = new FormData();
    const audioBytes = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    form.set("audio", new Blob([audioBytes]), filename);
    if (context) {
      form.set("context", context);
    }

    const response = await fetch(`${this.baseUrl}/transcribe`, {
      method: "POST",
      body: form
    });

    if (!response.ok) {
      throw new Error(`ASR request failed with ${response.status}.`);
    }

    const body = (await response.json()) as TranscriptionResult;
    if (!body.text || typeof body.text !== "string") {
      throw new Error("ASR response did not include transcript text.");
    }
    return body;
  }

  async transcribeStream(chunks: AsyncIterable<Buffer>, filename: string, context?: string): Promise<TranscriptionResult> {
    const ws = new WebSocket(this.websocketUrl("/transcribe/ws"));
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: "start", filename, context }));
    for await (const chunk of chunks) {
      if (chunk.byteLength > 0) {
        ws.send(chunk);
      }
    }
    ws.send(JSON.stringify({ type: "end" }));

    return new Promise((resolve, reject) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string; message?: string; text?: string; language?: string; language_probability?: number };
        if (message.type === "transcript") {
          ws.close();
          if (!message.text) {
            reject(new Error("ASR response did not include transcript text."));
            return;
          }
          resolve({
            text: message.text,
            language: message.language,
            language_probability: message.language_probability
          });
        }
        if (message.type === "error") {
          ws.close();
          reject(new Error(message.message ?? "ASR streaming request failed."));
        }
      });
      ws.on("error", reject);
      ws.on("close", (code) => {
        if (code !== 1000) {
          reject(new Error(`ASR streaming socket closed with code ${code}.`));
        }
      });
    });
  }

  private websocketUrl(pathname: string): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}${pathname}`;
    return url.toString();
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

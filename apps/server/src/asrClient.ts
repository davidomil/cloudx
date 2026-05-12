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
}

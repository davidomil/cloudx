export const DEFAULT_DOCUMENTATION_URL = "http://127.0.0.1:7820";
export const DEFAULT_DOCUMENTATION_TIMEOUT_MS = 30 * 60_000;
export const MAX_DOCUMENTATION_TIMEOUT_MS = 12 * 60 * 60_000;
export const DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENTATION_RESPONSE_MAX_BYTES = 1024 * 1024 * 1024;

export interface DocumentationClientOptions {
  timeoutMs?: number;
  responseMaxBytes?: number;
}

export interface DocumentationUploadInput {
  filename: string;
  content: Uint8Array;
  contentType?: string;
  title?: string;
  sourceType?: string;
  collection?: string;
  tags?: string[];
}

export interface DocumentationEnrichInput {
  documentId: string;
  spans: Array<{ locator: string; text: string }>;
  model: string;
  skillIds: string[];
  summary?: string;
  payload?: Record<string, unknown>;
}

export class DocumentationClient {
  private readonly timeoutMs: number;
  private readonly responseMaxBytes: number;

  constructor(
    private readonly baseUrl: string = DEFAULT_DOCUMENTATION_URL,
    options: DocumentationClientOptions = {}
  ) {
    this.timeoutMs = normalizeDocumentationTimeoutMs(options.timeoutMs);
    this.responseMaxBytes = normalizeDocumentationResponseMaxBytes(options.responseMaxBytes);
  }

  health(): Promise<Record<string, unknown>> {
    return this.get("/health");
  }

  stats(): Promise<Record<string, unknown>> {
    return this.get("/stats");
  }

  portableManifest(): Promise<Record<string, unknown>> {
    return this.get("/portable-manifest");
  }

  listDocuments(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const states = Array.isArray(input.states) ? input.states.filter((state): state is string => typeof state === "string" && state.trim().length > 0).join(",") : undefined;
    return this.get(states ? `/documents?states=${encodeURIComponent(states)}` : "/documents");
  }

  getDocument(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.get(`/documents/${encodeURIComponent(requireString(input.documentId, "documentId"))}`);
  }

  enrichDocument(input: DocumentationEnrichInput): Promise<Record<string, unknown>> {
    const { documentId, ...body } = input;
    return this.post(`/documents/${encodeURIComponent(requireString(documentId, "documentId"))}/enrich`, body);
  }

  remove(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(`/documents/${encodeURIComponent(requireString(input.documentId, "documentId"))}`, { method: "DELETE" });
  }

  search(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/search", input);
  }

  ingestPath(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/ingest/path", input);
  }

  ingestUrl(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/ingest/url", input);
  }

  ingestUpload(input: DocumentationUploadInput): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append("file", new Blob([arrayBufferCopy(input.content)], { type: input.contentType || "application/octet-stream" }), input.filename);
    appendOptionalFormValue(form, "title", input.title);
    appendOptionalFormValue(form, "sourceType", input.sourceType);
    appendOptionalFormValue(form, "collection", input.collection);
    for (const tag of input.tags ?? []) {
      appendOptionalFormValue(form, "tags", tag);
    }
    return this.request("/ingest/upload", { method: "POST", body: form });
  }

  ingestText(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/ingest/text", input);
  }

  invalidate(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/invalidate", input);
  }

  rebuildIndex(): Promise<Record<string, unknown>> {
    return this.post("/rebuild-index", {});
  }

  private get(pathname: string): Promise<Record<string, unknown>> {
    return this.request(pathname, { method: "GET" });
  }

  private post(pathname: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(pathname, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  }

  private async request(pathname: string, init: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.serviceUrl(pathname), { ...init, signal: controller.signal });
      const text = await readBoundedText(response, this.responseMaxBytes);
      if (!response.ok) {
        throw new Error(errorMessage(text, response.status));
      }
      const value = text ? JSON.parse(text) : {};
      if (!isRecord(value)) {
        throw new Error("Documentation service response must be a JSON object.");
      }
      return value;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Documentation request timed out after ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private serviceUrl(pathname: string): string {
    const url = new URL(this.baseUrl);
    url.pathname = appendUrlPath(url.pathname, pathname);
    return url.toString();
  }
}

export function normalizeDocumentationTimeoutMs(timeoutMs = DEFAULT_DOCUMENTATION_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DOCUMENTATION_TIMEOUT_MS) {
    throw new Error(`Documentation timeout must be a positive integer no greater than ${MAX_DOCUMENTATION_TIMEOUT_MS} ms.`);
  }
  return timeoutMs;
}

export function normalizeDocumentationResponseMaxBytes(maxBytes = DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_DOCUMENTATION_RESPONSE_MAX_BYTES) {
    throw new Error(`Documentation response size must be a positive integer no greater than ${MAX_DOCUMENTATION_RESPONSE_MAX_BYTES} bytes.`);
  }
  return maxBytes;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`Documentation service response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatChunks(chunks, total));
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function errorMessage(text: string, status: number): string {
  if (!text) {
    return `Documentation request failed with ${status}.`;
  }
  try {
    const value = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
    for (const candidate of [value.detail, value.message, value.error]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }
  } catch {
    return text;
  }
  return text;
}

function appendUrlPath(basePath: string, appendPath: string): string {
  return `${basePath.replace(/\/+$/u, "")}/${appendPath.replace(/^\/+/u, "")}`;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function appendOptionalFormValue(form: FormData, name: string, value: string | undefined): void {
  if (value?.trim()) {
    form.append(name, value.trim());
  }
}

function arrayBufferCopy(content: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(content.byteLength);
  new Uint8Array(copy).set(content);
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

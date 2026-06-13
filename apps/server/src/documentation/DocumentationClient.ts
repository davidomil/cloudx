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
  acceptGeneratedCodeDocumentation?: boolean;
  retainRawCodeArtifacts?: boolean;
}

export interface DocumentationEnrichInput {
  documentId: string;
  spans: Array<{ locator: string; text: string }>;
  model: string;
  skillIds: string[];
  summary?: string;
  payload?: Record<string, unknown>;
}

export interface DocumentationIngestProgressEvent {
  stage?: string;
  progress?: number;
  etaSeconds?: number;
  metrics?: Record<string, unknown>;
  channel?: string;
  channelLabel?: string;
  channelProgress?: number;
}

export interface DocumentationIngestRequestOptions {
  onProgress?: (event: DocumentationIngestProgressEvent) => void;
}

export interface DocumentationArtifactResponse {
  content: Uint8Array;
  contentType: string;
  filename: string;
}

export interface DocumentationArtifactStreamResponse {
  statusCode: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export interface DocumentationArchiveUploadInput {
  filename: string;
  content: Uint8Array;
  contentType?: string;
  confirmation?: string;
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
    const params = new URLSearchParams();
    appendOptionalQueryString(params, "states", states);
    appendOptionalQueryNumber(params, "limit", input.limit);
    appendOptionalQueryNumber(params, "offset", input.offset);
    appendOptionalQueryString(params, "query", input.query);
    appendOptionalQueryString(params, "collection", input.collection);
    appendOptionalQueryString(params, "sortDirection", input.sortDirection);
    const query = params.toString();
    return this.get(`/documents${query ? `?${query}` : ""}`);
  }

  getDocument(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const documentId = encodeURIComponent(requireString(input.documentId, "documentId"));
    const params = new URLSearchParams();
    appendOptionalQueryNumber(params, "chunkOffset", input.chunkOffset);
    appendOptionalQueryNumber(params, "chunkLimit", input.chunkLimit);
    appendOptionalQueryIntegerList(params, "chunkIds", input.chunkIds);
    appendOptionalQueryNumber(params, "chunkContext", input.chunkContext);
    appendOptionalQueryNumber(params, "chunkTextMaxChars", input.chunkTextMaxChars);
    appendOptionalQueryNumber(params, "artifactOffset", input.artifactOffset);
    appendOptionalQueryNumber(params, "artifactLimit", input.artifactLimit);
    const query = params.toString();
    return this.get(`/documents/${documentId}${query ? `?${query}` : ""}`);
  }

  getArtifact(input: Record<string, unknown>): Promise<DocumentationArtifactResponse> {
    const documentId = encodeURIComponent(requireString(input.documentId, "documentId"));
    const path = encodeURIComponent(requireString(input.path, "path"));
    return this.requestBytes(`/documents/${documentId}/artifact?path=${path}`, { method: "GET" });
  }

  async streamArtifact(input: Record<string, unknown>, headers: Record<string, string | undefined> = {}): Promise<DocumentationArtifactStreamResponse> {
    const documentId = encodeURIComponent(requireString(input.documentId, "documentId"));
    const path = encodeURIComponent(requireString(input.path, "path"));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.serviceUrl(`/documents/${documentId}/artifact?path=${path}`), {
        method: "GET",
        headers: compactHeaders(headers),
        signal: controller.signal
      });
      if (!response.ok && response.status !== 416) {
        throw new Error(errorMessage(await response.text(), response.status));
      }
      return {
        statusCode: response.status,
        headers: response.headers,
        body: response.body
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Documentation request timed out after ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  exportArchive(): Promise<DocumentationArtifactResponse> {
    return this.requestBytes("/archive/export", { method: "GET" });
  }

  async streamArchiveExport(headers: Record<string, string | undefined> = {}): Promise<DocumentationArtifactStreamResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.serviceUrl("/archive/export"), {
        method: "GET",
        headers: compactHeaders(headers),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(errorMessage(await response.text(), response.status));
      }
      return {
        statusCode: response.status,
        headers: response.headers,
        body: response.body
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Documentation request timed out after ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  importArchiveReplacePath(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/archive/import/replace/path", {
      path: requireString(input.path, "path"),
      confirmation: requireString(input.confirmation, "confirmation")
    });
  }

  importArchiveMergePath(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/archive/import/merge/path", {
      path: requireString(input.path, "path")
    });
  }

  importArchiveReplaceUpload(input: DocumentationArchiveUploadInput): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append("file", new Blob([arrayBufferCopy(input.content)], { type: input.contentType || "application/zip" }), input.filename);
    appendOptionalFormValue(form, "confirmation", input.confirmation);
    return this.request("/archive/import/replace", { method: "POST", body: form });
  }

  importArchiveMergeUpload(input: DocumentationArchiveUploadInput): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append("file", new Blob([arrayBufferCopy(input.content)], { type: input.contentType || "application/zip" }), input.filename);
    return this.request("/archive/import/merge", { method: "POST", body: form });
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

  ingestUrl(input: Record<string, unknown>, options: DocumentationIngestRequestOptions = {}): Promise<Record<string, unknown>> {
    if (options.onProgress) {
      return this.postStream("/ingest/url?stream=1", input, options.onProgress);
    }
    return this.post("/ingest/url", input);
  }

  ingestUpload(input: DocumentationUploadInput): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append("file", new Blob([arrayBufferCopy(input.content)], { type: input.contentType || "application/octet-stream" }), input.filename);
    appendOptionalFormValue(form, "title", input.title);
    appendOptionalFormValue(form, "sourceType", input.sourceType);
    appendOptionalFormValue(form, "collection", input.collection);
    appendOptionalFormBoolean(form, "acceptGeneratedCodeDocumentation", input.acceptGeneratedCodeDocumentation);
    appendOptionalFormBoolean(form, "retainRawCodeArtifacts", input.retainRawCodeArtifacts);
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

  private async postStream(pathname: string, body: Record<string, unknown>, onProgress: (event: DocumentationIngestProgressEvent) => void): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resetTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    resetTimeout();
    try {
      const response = await fetch(this.serviceUrl(pathname), {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", "accept": "application/x-ndjson" },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(errorMessage(await readBoundedText(response, this.responseMaxBytes), response.status));
      }
      return await readDocumentationProgressStream(response, this.responseMaxBytes, onProgress, resetTimeout);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Documentation progress stream was quiet for ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
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

  private async requestBytes(pathname: string, init: RequestInit): Promise<DocumentationArtifactResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.serviceUrl(pathname), { ...init, signal: controller.signal });
      const content = await readBoundedBytes(response, this.responseMaxBytes);
      if (!response.ok) {
        throw new Error(errorMessage(new TextDecoder().decode(content), response.status));
      }
      return {
        content,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        filename: contentDispositionFilename(response.headers.get("content-disposition")) || pathname.split("/").pop()?.split("?")[0] || "artifact",
      };
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
    const [path, query] = splitPathAndQuery(pathname);
    url.pathname = appendUrlPath(url.pathname, path);
    if (query) {
      for (const [name, value] of new URLSearchParams(query)) {
        url.searchParams.append(name, value);
      }
    }
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
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes));
}

async function readDocumentationProgressStream(
  response: Response,
  maxBytes: number,
  onProgress: (event: DocumentationIngestProgressEvent) => void,
  onActivity: () => void
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Documentation progress response did not include a stream.");
  }
  const decoder = new TextDecoder();
  let buffered = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    onActivity();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Documentation service response exceeded ${maxBytes} bytes.`);
    }
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        const result = handleDocumentationStreamEvent(line, onProgress);
        if (result) {
          await reader.cancel().catch(() => undefined);
          return result;
        }
      }
      newline = buffered.indexOf("\n");
    }
  }
  const finalLine = buffered.trim();
  if (finalLine) {
    const result = handleDocumentationStreamEvent(finalLine, onProgress);
    if (result) {
      return result;
    }
  }
  throw new Error("Documentation progress stream ended without a result.");
}

function handleDocumentationStreamEvent(line: string, onProgress: (event: DocumentationIngestProgressEvent) => void): Record<string, unknown> | undefined {
  const event = JSON.parse(line) as unknown;
  if (!isRecord(event)) {
    throw new Error("Documentation progress stream event was not a JSON object.");
  }
  if (event.type === "progress") {
    onProgress({
      stage: typeof event.stage === "string" ? event.stage : undefined,
      progress: typeof event.progress === "number" ? event.progress : undefined,
      etaSeconds: typeof event.etaSeconds === "number" ? event.etaSeconds : undefined,
      metrics: isRecord(event.metrics) ? event.metrics : undefined,
      channel: typeof event.channel === "string" ? event.channel : undefined,
      channelLabel: typeof event.channelLabel === "string" ? event.channelLabel : undefined,
      channelProgress: typeof event.channelProgress === "number" ? event.channelProgress : undefined
    });
    return undefined;
  }
  if (event.type === "error") {
    throw new Error(typeof event.error === "string" ? event.error : "Documentation ingest stream failed.");
  }
  if (event.type === "result") {
    if (!isRecord(event.result)) {
      throw new Error("Documentation progress stream result was not a JSON object.");
    }
    return event.result;
  }
  return undefined;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Documentation service response exceeded ${maxBytes} bytes.`);
    }
    return new Uint8Array(buffer);
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
  return concatChunks(chunks, total);
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

function splitPathAndQuery(pathname: string): [string, string | undefined] {
  const index = pathname.indexOf("?");
  return index === -1 ? [pathname, undefined] : [pathname.slice(0, index), pathname.slice(index + 1)];
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

function appendOptionalFormBoolean(form: FormData, name: string, value: boolean | undefined): void {
  if (value !== undefined) {
    form.append(name, String(value));
  }
}

function appendOptionalQueryNumber(params: URLSearchParams, name: string, value: unknown): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    params.set(name, String(value));
  }
}

function appendOptionalQueryIntegerList(params: URLSearchParams, name: string, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  const integers = value.filter((candidate): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0);
  if (integers.length > 0) {
    params.set(name, integers.join(","));
  }
}

function appendOptionalQueryString(params: URLSearchParams, name: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    params.set(name, value.trim());
  }
}

function compactHeaders(headers: Record<string, string | undefined>): HeadersInit {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function arrayBufferCopy(content: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(content.byteLength);
  new Uint8Array(copy).set(content);
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentDispositionFilename(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = /(?:^|;)\s*filename="?([^";]+)"?/iu.exec(value);
  return match?.[1];
}

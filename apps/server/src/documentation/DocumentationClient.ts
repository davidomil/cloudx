import { openAsBlob } from "node:fs";
import type { DocumentationArchiveExportJob } from "@cloudx/shared";

export const DEFAULT_DOCUMENTATION_URL = "http://127.0.0.1:7820";
export const DEFAULT_DOCUMENTATION_TIMEOUT_MS = 30 * 60_000;
export const MAX_DOCUMENTATION_TIMEOUT_MS = 12 * 60 * 60_000;
export const DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENTATION_RESPONSE_MAX_BYTES = 1024 * 1024 * 1024;

export interface DocumentationClientOptions {
  timeoutMs?: number;
  responseMaxBytes?: number;
}

export interface DocumentationUploadFileInput {
  filename: string;
  path: string;
  contentType?: string;
  title?: string;
  sourceType?: string;
  collection?: string;
  tags?: string[];
  acceptGeneratedCodeDocumentation?: boolean;
  retainRawCodeArtifacts?: boolean;
}

export interface DocumentationSupportAnchor {
  documentId: string;
  extractionRevision: string;
  locator: string;
  chunkId?: number;
  artifactId?: string;
}

export interface DocumentationEnrichmentSpan {
  locator: string;
  text: string;
  kind: "content" | "diagnostic";
  supportAnchors: DocumentationSupportAnchor[];
}

export interface DocumentationEnrichmentBatchOutput {
  summary: string;
  spans: DocumentationEnrichmentSpan[];
  metadata: Record<string, string | number | boolean | null>;
  warnings: string[];
}

export interface DocumentationEnrichmentRun {
  runId: string;
  status: "running" | "complete";
  extractionRevision: string;
  leaseToken: string;
}

export interface DocumentationEnrichmentEvidenceCounts {
  chunkCount: number;
  artifactCount: number;
  keyframeCount: number;
  mediaTranscriptChars: number;
}

export interface DocumentationMediaEvidencePage {
  complete: boolean;
  chunks: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  metadata: Record<string, unknown> | null;
  window: { offset: number; limit: number; total: number; hasMore: boolean };
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

export interface DocumentationRequestOptions {
  signal?: AbortSignal;
}

export interface DocumentationPendingEnrichment {
  documentId: string;
  title: string;
  extractionRevision: string;
}

export interface DocumentationIngestRequestOptions extends DocumentationRequestOptions {
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

export interface DocumentationArchiveFileInput {
  filename: string;
  path: string;
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

  health(options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.get("/health", options.signal);
  }

  stats(): Promise<Record<string, unknown>> {
    return this.get("/stats");
  }

  summary(): Promise<Record<string, unknown>> {
    return this.get("/summary");
  }

  portableManifest(): Promise<Record<string, unknown>> {
    return this.get("/portable-manifest");
  }

  async pendingEnrichments(limit: number, options: DocumentationRequestOptions = {}): Promise<DocumentationPendingEnrichment[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer between 1 and 100.");
    }
    const response = await this.get(`/enrichment/pending?limit=${limit}`, options.signal);
    if (!Array.isArray(response.documents) || response.documents.length > limit) {
      throw new Error("Invalid pending documentation enrichment response.");
    }
    const documentIds = new Set<string>();
    return response.documents.map((document: unknown) => {
      if (!document || typeof document !== "object" || !("documentId" in document) || !("title" in document) || typeof document.documentId !== "string" || !document.documentId.trim() || typeof document.title !== "string" || documentIds.has(document.documentId)) {
        throw new Error("Invalid pending documentation enrichment document.");
      }
      if (!("extractionRevision" in document) || typeof document.extractionRevision !== "string" || document.extractionRevision.length !== 32 || !/^[0-9a-f]{32}$/.test(document.extractionRevision)) {
        throw new Error("Invalid pending documentation enrichment extraction revision.");
      }
      documentIds.add(document.documentId);
      return { documentId: document.documentId, title: document.title, extractionRevision: document.extractionRevision };
    });
  }

  recordEnrichmentOutcome(documentId: string, outcome: { extractionRevision: string; status: "failed" | "skipped"; error: string }, options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.post(`/documents/${encodeURIComponent(requireString(documentId, "documentId"))}/enrichment-outcome`, outcome, options.signal);
  }

  async beginEnrichmentRun(documentId: string, input: { extractionRevision: string; processorFingerprint: string; ownerId: string; resume: boolean; force: boolean }, options: DocumentationRequestOptions = {}): Promise<DocumentationEnrichmentRun> {
    const response = await this.post(`/documents/${encodeURIComponent(requireString(documentId, "documentId"))}/enrichment-runs`, input, options.signal);
    const run = response.run as Partial<DocumentationEnrichmentRun> | undefined;
    if (!run || typeof run.runId !== "string" || !run.runId || !["running", "complete"].includes(run.status ?? "") || typeof run.extractionRevision !== "string" || !/^[0-9a-f]{32}$/u.test(run.extractionRevision) || typeof run.leaseToken !== "string" || !/^[0-9a-f]+$/u.test(run.leaseToken)) {
      throw new Error("Invalid documentation enrichment run response.");
    }
    if (run.extractionRevision !== input.extractionRevision) throw new Error("Enrichment run returned a different extraction revision.");
    return run as DocumentationEnrichmentRun;
  }

  async lookupEnrichmentBatch(runId: string, index: number, input: { leaseToken: string; inputFingerprint: string; model: string }, options: DocumentationRequestOptions = {}): Promise<{ status: "pending" | "complete"; output?: DocumentationEnrichmentBatchOutput }> {
    const response = await this.post(`${enrichmentRunPath(runId)}/batches/${enrichmentBatchIndex(index)}/lookup`, input, options.signal);
    const batch = response.batch as { status?: unknown; output?: DocumentationEnrichmentBatchOutput } | undefined;
    if (!batch || !["pending", "complete"].includes(String(batch.status)) || batch.status === "complete" && !isEnrichmentBatchOutput(batch.output)) {
      throw new Error("Invalid documentation enrichment batch response.");
    }
    return batch as { status: "pending" | "complete"; output?: DocumentationEnrichmentBatchOutput };
  }

  checkpointEnrichmentBatch(runId: string, index: number, input: { leaseToken: string; inputFingerprint: string; model: string; output: DocumentationEnrichmentBatchOutput }, options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.request(`${enrichmentRunPath(runId)}/batches/${enrichmentBatchIndex(index)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }, options.signal);
  }

  async completeEnrichmentRun(runId: string, input: { leaseToken: string; batchCount: number; skillIds: string[]; evidence: DocumentationEnrichmentEvidenceCounts }, options: DocumentationRequestOptions = {}): Promise<{ chunkCount: number; warnings: string[] }> {
    const response = await this.post(`${enrichmentRunPath(runId)}/complete`, input, options.signal);
    if (!Number.isSafeInteger(response.chunkCount) || Number(response.chunkCount) < 0 || !Array.isArray(response.warnings) || response.warnings.some((warning) => typeof warning !== "string")) {
      throw new Error("Invalid completed documentation enrichment response.");
    }
    return { chunkCount: Number(response.chunkCount), warnings: response.warnings as string[] };
  }

  recordEnrichmentRunOutcome(runId: string, input: { leaseToken: string; status: "failed" | "cancelled" | "skipped"; code: string; error: string }, options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.post(`${enrichmentRunPath(runId)}/outcome`, input, options.signal);
  }

  heartbeatEnrichmentRun(runId: string, leaseToken: string, options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.post(`${enrichmentRunPath(runId)}/heartbeat`, { leaseToken }, options.signal);
  }

  async getEnrichmentMedia(runId: string, leaseToken: string, offset = 0, options: DocumentationRequestOptions = {}): Promise<DocumentationMediaEvidencePage> {
    const params = new URLSearchParams({ offset: String(enrichmentBatchIndex(offset)), limit: "100" });
    const response = await this.request(`${enrichmentRunPath(runId)}/media-evidence?${params}`, { method: "GET", headers: { authorization: `Bearer ${leaseToken}` } }, options.signal);
    const window = response.window;
    if (typeof response.complete !== "boolean" || !Array.isArray(response.chunks) || !response.chunks.every(isRecord) || !Array.isArray(response.artifacts) || !response.artifacts.every(isRecord) || response.chunks.length + response.artifacts.length > 100 || !(isRecord(response.metadata) || response.complete === false && response.metadata === null) || !isRecord(window) || window.offset !== offset || !Number.isSafeInteger(window.limit) || Number(window.limit) < 1 || Number(window.limit) > 100 || !Number.isSafeInteger(window.total) || Number(window.total) < 0 || typeof window.hasMore !== "boolean") {
      throw new Error("Invalid retained enrichment media page.");
    }
    return response as unknown as DocumentationMediaEvidencePage;
  }

  completeEnrichmentMedia(runId: string, leaseToken: string, metadata: Record<string, unknown>, options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.post(`${enrichmentRunPath(runId)}/media-complete`, { leaseToken, metadata }, options.signal);
  }

  async retainMediaEvidence(documentId: string, input: {
    runId: string; leaseToken: string; extractionRevision: string;
    transcript?: { text: string; locator: string; producer?: Record<string, unknown>; segments?: Array<{ startSeconds: number; endSeconds: number; text: string }> };
    keyframes?: Array<{ filename: string; contentBase64: string; offsetSeconds?: number }>;
  }, options: DocumentationRequestOptions = {}): Promise<{ chunks: Record<string, unknown>[]; artifacts: Record<string, unknown>[] }> {
    const response = await this.post(`/documents/${encodeURIComponent(requireString(documentId, "documentId"))}/media-evidence`, input, options.signal);
    if (!Array.isArray(response.chunks) || !response.chunks.every(isRecord) || !Array.isArray(response.artifacts) || !response.artifacts.every(isRecord)) {
      throw new Error("Invalid retained documentation media evidence response.");
    }
    return { chunks: response.chunks, artifacts: response.artifacts };
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

  getDocument(input: Record<string, unknown>, options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    const documentId = encodeURIComponent(requireString(input.documentId, "documentId"));
    const params = new URLSearchParams();
    appendOptionalQueryNumber(params, "chunkOffset", input.chunkOffset);
    appendOptionalQueryNumber(params, "chunkLimit", input.chunkLimit);
    if (input.chunkLocators !== undefined) {
      if (input.chunkIds !== undefined || !Array.isArray(input.chunkLocators) || !input.chunkLocators.length || input.chunkLocators.length > 100 || input.chunkLocators.some((locator) => typeof locator !== "string" || !locator.trim())) {
        throw new Error("chunkLocators must contain 1 to 100 exact locators and cannot be combined with chunkIds.");
      }
      for (const locator of input.chunkLocators) params.append("chunkLocators", locator);
    }
    if (input.chunkOrigins !== undefined) {
      if (input.chunkIds !== undefined || !Array.isArray(input.chunkOrigins) || !input.chunkOrigins.length || input.chunkOrigins.length > 3 || input.chunkOrigins.some((origin) => typeof origin !== "string" || !["source", "ai", "media"].includes(origin))) throw new Error("chunkOrigins must contain 1 to 3 source, ai or media origins and cannot be combined with chunkIds.");
      for (const origin of input.chunkOrigins) params.append("chunkOrigins", origin);
    }
    appendOptionalQueryIntegerList(params, "chunkIds", input.chunkIds);
    appendOptionalQueryNumber(params, "chunkContext", input.chunkContext);
    appendOptionalQueryNumber(params, "chunkTextMaxChars", input.chunkTextMaxChars);
    if (input.artifactOrigins !== undefined) {
      if (!Array.isArray(input.artifactOrigins) || !input.artifactOrigins.length || input.artifactOrigins.length > 2 || input.artifactOrigins.some((origin) => typeof origin !== "string" || !["source", "media"].includes(origin))) throw new Error("artifactOrigins must contain source or media origins.");
      for (const origin of input.artifactOrigins) params.append("artifactOrigins", origin);
    }
    appendOptionalQueryNumber(params, "artifactOffset", input.artifactOffset);
    appendOptionalQueryNumber(params, "artifactLimit", input.artifactLimit);
    appendOptionalQueryBoolean(params, "includeEnrichments", input.includeEnrichments);
    appendOptionalQueryBoolean(params, "includeEvents", input.includeEvents);
    const query = params.toString();
    return this.get(`/documents/${documentId}${query ? `?${query}` : ""}`, options.signal);
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

  async startArchiveExport(): Promise<DocumentationArchiveExportJob> {
    return parseArchiveExportJob(await this.post("/archive/exports", {}));
  }

  async getArchiveExport(jobId: string): Promise<DocumentationArchiveExportJob> {
    return parseArchiveExportJob(await this.get(`/archive/exports/${encodeURIComponent(jobId)}`));
  }

  streamArchiveExportDownload(jobId: string, headers: Record<string, string | undefined> = {}): Promise<DocumentationArtifactStreamResponse> {
    return this.streamArchive(`/archive/exports/${encodeURIComponent(jobId)}/download`, headers);
  }

  streamArchiveExport(headers: Record<string, string | undefined> = {}): Promise<DocumentationArtifactStreamResponse> {
    return this.streamArchive("/archive/export", headers);
  }

  private async streamArchive(pathname: string, headers: Record<string, string | undefined>): Promise<DocumentationArtifactStreamResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.serviceUrl(pathname), {
        method: "GET",
        headers: compactHeaders(headers),
        signal: controller.signal
      });
      if (!response.ok && response.status !== 416) {
        throw Object.assign(new Error(errorMessage(await readBoundedText(response, this.responseMaxBytes), response.status)), { statusCode: response.status });
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

  async importArchiveReplaceFile(input: DocumentationArchiveFileInput, options: DocumentationIngestRequestOptions = {}): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append("file", await openAsBlob(input.path, { type: input.contentType || "application/zip" }), input.filename);
    appendOptionalFormValue(form, "confirmation", input.confirmation);
    if (options.onProgress) {
      return this.requestProgress("/archive/import/replace", { method: "POST", body: form }, options.onProgress, options.signal);
    }
    return this.request("/archive/import/replace", { method: "POST", body: form }, options.signal);
  }

  async importArchiveMergeFile(input: DocumentationArchiveFileInput, options: DocumentationIngestRequestOptions = {}): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append("file", await openAsBlob(input.path, { type: input.contentType || "application/zip" }), input.filename);
    if (options.onProgress) {
      return this.requestProgress("/archive/import/merge", { method: "POST", body: form }, options.onProgress, options.signal);
    }
    return this.request("/archive/import/merge", { method: "POST", body: form }, options.signal);
  }

  startReanalysisCampaign(documentIds: string[]): Promise<Record<string, unknown>> {
    if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > 100_000 || documentIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(documentIds).size !== documentIds.length) throw new Error("A reanalysis campaign requires 1 to 100000 distinct document IDs.");
    return this.post("/reanalysis-campaigns", { documentIds });
  }

  getReanalysisCampaign(campaignId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error("Campaign offset must be nonnegative and limit must be between 1 and 200.");
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.get(`/reanalysis-campaigns/${encodeURIComponent(requireString(campaignId, "campaignId"))}?${params}`);
  }

  resumeReanalysisCampaign(campaignId: string): Promise<Record<string, unknown>> {
    return this.post(`/reanalysis-campaigns/${encodeURIComponent(requireString(campaignId, "campaignId"))}/resume`, {});
  }

  cancelReanalysisCampaign(campaignId: string): Promise<Record<string, unknown>> {
    return this.post(`/reanalysis-campaigns/${encodeURIComponent(requireString(campaignId, "campaignId"))}/cancel`, {});
  }

  listDocumentRevisions(documentId: string): Promise<Record<string, unknown>> {
    return this.get(`/documents/${encodeURIComponent(requireString(documentId, "documentId"))}/revisions`);
  }

  checkDocumentRevision(documentId: string, sourceAccess: { allowedRoots: string[] }, options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.post(`/documents/${encodeURIComponent(requireString(documentId, "documentId"))}/check-revision`, sourceAccess, options.signal);
  }

  refreshDocument(documentId: string, sourceAccess: { allowedRoots: string[] }, options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.post(`/documents/${encodeURIComponent(requireString(documentId, "documentId"))}/refresh`, sourceAccess, options.signal);
  }

  purgeDocument(documentId: string, reason: string): Promise<Record<string, unknown>> {
    return this.post(`/documents/${encodeURIComponent(requireString(documentId, "documentId"))}/purge`, { reason: requireString(reason, "reason") });
  }

  assignDocumentSource(documentId: string, sourceKey: string): Promise<Record<string, unknown>> {
    return this.request(`/documents/${encodeURIComponent(requireString(documentId, "documentId"))}/source`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceKey: requireString(sourceKey, "sourceKey") }) });
  }

  reanalyzeDocument(input: { documentId: string }, options: DocumentationRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.post(`/documents/${encodeURIComponent(requireString(input.documentId, "documentId"))}/reanalyze`, {}, options.signal);
  }

  remove(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(`/documents/${encodeURIComponent(requireString(input.documentId, "documentId"))}`, { method: "DELETE" });
  }

  search(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/search", input);
  }

  ingestPath(input: Record<string, unknown>, options: DocumentationIngestRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.post("/ingest/path", input, options.signal);
  }

  ingestUrl(input: Record<string, unknown>, options: DocumentationIngestRequestOptions = {}): Promise<Record<string, unknown>> {
    if (options.onProgress) {
      return this.postStream("/ingest/url?stream=1", input, options.onProgress, options.signal);
    }
    return this.post("/ingest/url", input, options.signal);
  }

  async ingestUploadFile(input: DocumentationUploadFileInput, options: DocumentationIngestRequestOptions = {}): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append("file", await openAsBlob(input.path, { type: input.contentType || "application/octet-stream" }), input.filename);
    appendOptionalFormValue(form, "title", input.title);
    appendOptionalFormValue(form, "sourceType", input.sourceType);
    appendOptionalFormValue(form, "collection", input.collection);
    appendOptionalFormBoolean(form, "acceptGeneratedCodeDocumentation", input.acceptGeneratedCodeDocumentation);
    appendOptionalFormBoolean(form, "retainRawCodeArtifacts", input.retainRawCodeArtifacts);
    for (const tag of input.tags ?? []) {
      appendOptionalFormValue(form, "tags", tag);
    }
    return this.request("/ingest/upload", { method: "POST", body: form }, options.signal);
  }

  ingestText(input: Record<string, unknown>, options: DocumentationIngestRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.post("/ingest/text", input, options.signal);
  }

  invalidate(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/invalidate", input);
  }

  rebuildIndex(): Promise<Record<string, unknown>> {
    return this.post("/rebuild-index", {});
  }

  private get(pathname: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request(pathname, { method: "GET" }, signal);
  }

  private post(pathname: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request(pathname, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, signal);
  }

  private postStream(pathname: string, body: Record<string, unknown>, onProgress: (event: DocumentationIngestProgressEvent) => void, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestProgress(pathname, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, onProgress, signal);
  }

  private async requestProgress(pathname: string, init: RequestInit, onProgress: (event: DocumentationIngestProgressEvent) => void, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const scope = createDocumentationRequestAbortScope(signal);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resetTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => scope.abortForTimeout(), this.timeoutMs);
    };
    resetTimeout();
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/x-ndjson");
      const response = await fetch(this.serviceUrl(pathname), {
        ...init,
        headers,
        signal: scope.signal
      });
      if (!response.ok) {
        throw new Error(errorMessage(await readBoundedText(response, this.responseMaxBytes), response.status));
      }
      return await readDocumentationProgressStream(response, this.responseMaxBytes, onProgress, resetTimeout);
    } catch (error) {
      if (signal?.aborted) {
        throw abortReason(signal, "Documentation ingest was cancelled.");
      }
      if (scope.timedOut) {
        throw new Error(`Documentation progress stream was quiet for ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      scope.dispose();
    }
  }

  private async request(pathname: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const scope = createDocumentationRequestAbortScope(signal);
    const timeout = setTimeout(() => scope.abortForTimeout(), this.timeoutMs);
    try {
      const response = await fetch(this.serviceUrl(pathname), { ...init, signal: scope.signal });
      const text = await readBoundedText(response, this.responseMaxBytes);
      if (!response.ok) {
        throw Object.assign(new Error(errorMessage(text, response.status)), { statusCode: response.status });
      }
      const value = text ? JSON.parse(text) : {};
      if (!isRecord(value)) {
        throw new Error("Documentation service response must be a JSON object.");
      }
      return value;
    } catch (error) {
      if (signal?.aborted) {
        throw abortReason(signal, "Documentation ingest was cancelled.");
      }
      if (scope.timedOut) {
        throw new Error(`Documentation request timed out after ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      scope.dispose();
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

function createDocumentationRequestAbortScope(external?: AbortSignal): {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  abortForTimeout(): void;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(external?.reason);
  if (external?.aborted) {
    abortFromExternal();
  } else {
    external?.addEventListener("abort", abortFromExternal, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    abortForTimeout() {
      timedOut = true;
      controller.abort();
    },
    dispose() {
      external?.removeEventListener("abort", abortFromExternal);
    }
  };
}

function abortReason(signal: AbortSignal, message: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(message);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes));
}

function parseArchiveExportJob(value: Record<string, unknown>): DocumentationArchiveExportJob {
  if (typeof value.id !== "string" || !value.id || typeof value.stage !== "string"
      || typeof value.status !== "string" || !["running", "complete", "failed"].includes(value.status)
      || (value.progress !== undefined && (typeof value.progress !== "number" || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100))
      || (value.filename !== undefined && typeof value.filename !== "string")
      || (value.error !== undefined && typeof value.error !== "string")) {
    throw new Error("Documentation archive export response was invalid.");
  }
  return value as unknown as DocumentationArchiveExportJob;
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

function enrichmentRunPath(runId: string): string {
  return `/enrichment-runs/${encodeURIComponent(requireString(runId, "runId"))}`;
}

function enrichmentBatchIndex(index: number): number {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Enrichment batch index must be a non-negative integer.");
  return index;
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

function appendOptionalQueryBoolean(params: URLSearchParams, name: string, value: unknown): void {
  if (typeof value === "boolean") {
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

function isEnrichmentBatchOutput(value: unknown): value is DocumentationEnrichmentBatchOutput {
  if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string") || !isRecord(value.metadata) || !Array.isArray(value.spans)) return false;
  if (Object.values(value.metadata).some((entry) => entry !== null && typeof entry !== "string" && typeof entry !== "boolean" && !(typeof entry === "number" && Number.isFinite(entry)))) return false;
  return value.spans.every((span) => isRecord(span) && typeof span.locator === "string" && Boolean(span.locator.trim()) && typeof span.text === "string" && Boolean(span.text.trim()) && (typeof span.kind === "string" && ["content", "diagnostic"].includes(span.kind)) && Array.isArray(span.supportAnchors) && (span.kind !== "content" || span.supportAnchors.length > 0) && span.supportAnchors.every((anchor: unknown) => {
    if (!isRecord(anchor) || typeof anchor.documentId !== "string" || !anchor.documentId || typeof anchor.extractionRevision !== "string" || !/^[0-9a-f]{32}$/u.test(anchor.extractionRevision) || typeof anchor.locator !== "string" || !anchor.locator) return false;
    return anchor.artifactId === undefined && Number.isSafeInteger(anchor.chunkId) && Number(anchor.chunkId) > 0 || anchor.chunkId === undefined && typeof anchor.artifactId === "string" && Boolean(anchor.artifactId);
  }));
}

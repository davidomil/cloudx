import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { AlertTriangle, Archive, Bot, BookOpen, FilePlus, RefreshCw, Search, Trash2, Wrench } from "lucide-react";

import type { UiContributionRenderContext } from "./uiContributions.js";
import { ControlButton } from "./Control.js";
import { uploadDocumentationFile, type DocumentationUploadProgress, type DocumentationUploadResponse } from "../api.js";
import { documentationIngestController } from "./documentationPanelQueue.js";

interface DocumentationPanelProps {
  callHook: UiContributionRenderContext["callHook"];
  uploadFile?: typeof uploadDocumentationFile;
  config?: Record<string, unknown>;
  globalConfig?: Record<string, unknown>;
  stateKey?: string;
  state?: DocumentationPanelState;
  onStateChange?: (updater: DocumentationPanelStateUpdater) => void;
}

export interface DocumentationSearchResult {
  chunkId: number;
  documentId: string;
  title: string;
  sourceType: string;
  uri?: string;
  state: string;
  locator: string;
  snippet: string;
  score?: number;
}

export interface DocumentationRecord {
  document_id?: string;
  documentId?: string;
  title?: string;
  source_type?: string;
  sourceType?: string;
  uri?: string;
  state?: string;
  chunk_count?: number;
  chunkCount?: number;
}

export interface DocumentationChunk {
  chunk_id?: number;
  chunkId?: number;
  locator?: string;
  text?: string;
  state?: string;
  chunk_origin?: string;
  chunkOrigin?: string;
}

export interface DocumentationDetail extends DocumentationRecord {
  chunks?: DocumentationChunk[];
}

export interface DocumentationAnswerCitation {
  documentId?: string;
  title?: string;
  locator?: string;
}

export interface DocumentationAnswer {
  answer?: string;
  answerHtml?: string;
  citations?: DocumentationAnswerCitation[];
  warnings?: string[];
  results?: DocumentationSearchResult[];
  model?: string;
}

interface DocumentationIngestResponse extends Record<string, unknown> {
  enrichment?: {
    results?: DocumentationEnrichmentResult[];
  };
}

interface DocumentationEnrichmentResult {
  documentId?: string;
  status?: string;
  error?: string;
  reason?: string;
  warnings?: string[];
}

interface DocumentationEnrichmentNotice {
  stage: string;
  notice: string;
  status: string;
}

export type IngestMode = "upload" | "path" | "url" | "text";
export type SearchPresentationMode = "answer" | "manual";
export type SearchMode = "hybrid" | "dense" | "lexical";
export type DocumentationIngestJobStatus = "queued" | "running" | "complete" | "failed";

export type DocumentationIngestRequest =
  | { mode: "upload"; file: File; title?: string; sourceType?: string; collection?: string }
  | { mode: "path"; path: string; title?: string; sourceType?: string; collection?: string }
  | { mode: "url"; url: string; title?: string; sourceType?: string; collection?: string; transcript?: string }
  | { mode: "text"; title?: string; text: string; uri?: string; sourceType?: string; collection?: string };

export interface DocumentationIngestJob {
  id: string;
  label: string;
  detail: string;
  request: DocumentationIngestRequest;
  progress: number;
  status: DocumentationIngestJobStatus;
  stage: string;
  error?: string;
  notice?: string;
}

export interface DocumentationPanelState {
  query: string;
  results: DocumentationSearchResult[];
  answer: DocumentationAnswer | undefined;
  selectedDocument: DocumentationDetail | undefined;
  documents: DocumentationRecord[];
  stats: Record<string, unknown>;
  status: string;
  busy: boolean;
  searchBusy: boolean;
  documentBusy: boolean;
  searchPresentationMode: SearchPresentationMode;
  searchMode: SearchMode;
  searchSourceType: string;
  searchState: string;
  searchCollection: string;
  mode: IngestMode;
  sourceType: string;
  uploadValue: File | undefined;
  pathValue: string;
  urlValue: string;
  title: string;
  textValue: string;
  transcriptValue: string;
  collection: string;
  uploadInputKey: number;
  portableFiles: Array<{ path?: string; bytes?: number }>;
  ingestJobs: DocumentationIngestJob[];
}

export type DocumentationPanelStateUpdater = (state: DocumentationPanelState | undefined) => DocumentationPanelState;

const SEARCH_MODES: SearchMode[] = ["hybrid", "dense", "lexical"];
const SOURCE_TYPES = ["datasheet", "book", "website", "repo_code", "readme", "media", "image", "text"];
const INGEST_SOURCE_TYPES = ["auto", ...SOURCE_TYPES];
const INVALIDATION_STATES = ["stale", "revoked", "superseded", "quarantined", "deleted"];
const SEARCH_STATES = ["active", ...INVALIDATION_STATES];
const DOCUMENTATION_ANSWER_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["div", "section", "h4", "h5", "p", "ol", "ul", "li", "strong", "em", "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td"],
  ALLOWED_ATTR: []
} satisfies DOMPurifyConfig;
const DEFAULT_DOCUMENTATION_PANEL_STATE_KEY = "documentation-panel-default";
let documentationIngestJobCounter = 0;

export function createInitialDocumentationPanelState(): DocumentationPanelState {
  return {
    query: "",
    results: [],
    answer: undefined,
    selectedDocument: undefined,
    documents: [],
    stats: {},
    status: "Documentation archive not loaded.",
    busy: false,
    searchBusy: false,
    documentBusy: false,
    searchPresentationMode: "answer",
    searchMode: "hybrid",
    searchSourceType: "",
    searchState: "active",
    searchCollection: "",
    mode: "upload",
    sourceType: "auto",
    uploadValue: undefined,
    pathValue: "",
    urlValue: "",
    title: "",
    textValue: "",
    transcriptValue: "",
    collection: "",
    uploadInputKey: 0,
    portableFiles: [],
    ingestJobs: []
  };
}

function useDocumentationStateField<K extends keyof DocumentationPanelState>(
  key: K,
  state: DocumentationPanelState | undefined,
  onStateChange: ((updater: DocumentationPanelStateUpdater) => void) | undefined
): [DocumentationPanelState[K], Dispatch<SetStateAction<DocumentationPanelState[K]>>] {
  const [localValue, setLocalValue] = useState<DocumentationPanelState[K]>(() => createInitialDocumentationPanelState()[key]);
  const value = state ? state[key] : localValue;
  const setValue = useCallback<Dispatch<SetStateAction<DocumentationPanelState[K]>>>((nextValue) => {
    if (!onStateChange) {
      setLocalValue(nextValue);
      return;
    }
    onStateChange((previous) => {
      const base = { ...createInitialDocumentationPanelState(), ...previous };
      const currentValue = base[key];
      const resolvedValue = typeof nextValue === "function" ? (nextValue as (current: DocumentationPanelState[K]) => DocumentationPanelState[K])(currentValue) : nextValue;
      return { ...base, [key]: resolvedValue };
    });
  }, [key, onStateChange]);
  return [value, setValue];
}

export function DocumentationPanel({ callHook, uploadFile = uploadDocumentationFile, config = {}, globalConfig = {}, stateKey = DEFAULT_DOCUMENTATION_PANEL_STATE_KEY, state, onStateChange }: DocumentationPanelProps) {
  const [query, setQuery] = useDocumentationStateField("query", state, onStateChange);
  const [results, setResults] = useDocumentationStateField("results", state, onStateChange);
  const [answer, setAnswer] = useDocumentationStateField("answer", state, onStateChange);
  const [selectedDocument, setSelectedDocument] = useDocumentationStateField("selectedDocument", state, onStateChange);
  const [documents, setDocuments] = useDocumentationStateField("documents", state, onStateChange);
  const [stats, setStats] = useDocumentationStateField("stats", state, onStateChange);
  const [status, setStatus] = useDocumentationStateField("status", state, onStateChange);
  const [busy, setBusy] = useDocumentationStateField("busy", state, onStateChange);
  const [searchBusy, setSearchBusy] = useDocumentationStateField("searchBusy", state, onStateChange);
  const [documentBusy, setDocumentBusy] = useDocumentationStateField("documentBusy", state, onStateChange);
  const [searchPresentationMode, setSearchPresentationMode] = useDocumentationStateField("searchPresentationMode", state, onStateChange);
  const [searchMode, setSearchMode] = useDocumentationStateField("searchMode", state, onStateChange);
  const [searchSourceType, setSearchSourceType] = useDocumentationStateField("searchSourceType", state, onStateChange);
  const [searchState, setSearchState] = useDocumentationStateField("searchState", state, onStateChange);
  const [searchCollection, setSearchCollection] = useDocumentationStateField("searchCollection", state, onStateChange);
  const [mode, setMode] = useDocumentationStateField("mode", state, onStateChange);
  const [sourceType, setSourceType] = useDocumentationStateField("sourceType", state, onStateChange);
  const [uploadValue, setUploadValue] = useDocumentationStateField("uploadValue", state, onStateChange);
  const [pathValue, setPathValue] = useDocumentationStateField("pathValue", state, onStateChange);
  const [urlValue, setUrlValue] = useDocumentationStateField("urlValue", state, onStateChange);
  const [title, setTitle] = useDocumentationStateField("title", state, onStateChange);
  const [textValue, setTextValue] = useDocumentationStateField("textValue", state, onStateChange);
  const [transcriptValue, setTranscriptValue] = useDocumentationStateField("transcriptValue", state, onStateChange);
  const [collection, setCollection] = useDocumentationStateField("collection", state, onStateChange);
  const [uploadInputKey, setUploadInputKey] = useDocumentationStateField("uploadInputKey", state, onStateChange);
  const [portableFiles, setPortableFiles] = useDocumentationStateField("portableFiles", state, onStateChange);
  const [ingestJobs, setIngestJobs] = useDocumentationStateField("ingestJobs", state, onStateChange);
  const sourceViewerRef = useRef<HTMLElement | null>(null);
  const ingestController = useMemo(() => documentationIngestController(stateKey), [stateKey]);

  const canCall = Boolean(callHook);
  const activeCount = numberStat(stats.activeDocumentCount);
  const chunkCount = numberStat(stats.activeChunkCount);
  const aiAssistanceEnabled = globalConfig.aiControlEnabled !== false && config.aiEnrichmentEnabled !== false;

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!aiAssistanceEnabled && searchPresentationMode === "answer") {
      setSearchPresentationMode("manual");
    }
  }, [aiAssistanceEnabled, searchPresentationMode]);

  useEffect(() => {
    if (selectedDocument && typeof sourceViewerRef.current?.scrollIntoView === "function") {
      sourceViewerRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, [selectedDocument]);

  async function call<T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}): Promise<T> {
    if (!callHook) {
      throw new Error("Documentation hook bridge is not available.");
    }
    return callHook<T>(hookId, input);
  }

  async function refresh() {
    await run("Documentation archive refreshed.", async () => {
      await loadArchiveSummary();
    });
  }

  async function loadArchiveSummary() {
    const [statsResult, docsResult] = await Promise.all([
      call<Record<string, unknown>>("documentation.stats"),
      call<{ documents: DocumentationRecord[] }>("documentation.documents.list")
    ]);
    setStats(statsResult);
    setDocuments(docsResult.documents ?? []);
  }

  async function search(event?: FormEvent) {
    event?.preventDefault();
    if (!query.trim()) {
      setResults([]);
      setAnswer(undefined);
      setSearchBusy(false);
      setStatus("Enter a search query.");
      return;
    }
    setAnswer(undefined);
    setResults([]);
    setSearchBusy(true);
    setStatus(searchRunningStatus(searchPresentationMode, aiAssistanceEnabled));
    try {
      await run("Search completed.", async () => {
        if (searchPresentationMode === "answer" && aiAssistanceEnabled) {
          const result = await call<Record<string, unknown>>("documentation.answer", searchInput({ includeQuestion: true }));
          const answerResult = result as unknown as DocumentationAnswer;
          setAnswer(answerResult);
          setResults(answerResult.results ?? []);
          return;
        }
        if (searchPresentationMode === "answer" && !aiAssistanceEnabled) {
          setStatus("AI assistance is disabled. Manual search is available for source text only.");
        }
        const result = await call<{ results: DocumentationSearchResult[] }>("documentation.search", searchInput());
        setResults(result.results ?? []);
      });
    } finally {
      setSearchBusy(false);
    }
  }

  function searchInput({ includeQuestion = false }: { includeQuestion?: boolean } = {}) {
    return compactInput({
      query: query.trim(),
      question: includeQuestion ? query.trim() : undefined,
      limit: 12,
      mode: searchMode,
      sourceTypes: searchSourceType ? [searchSourceType] : undefined,
      states: searchState ? [searchState] : undefined,
      collection: searchCollection.trim()
    });
  }

  async function ingest(event: FormEvent) {
    event.preventDefault();
    if (!canCall) {
      setStatus("Documentation hook bridge is not available.");
      return;
    }
    try {
      const job = createIngestJob({
        mode,
        sourceType,
        uploadValue,
        pathValue,
        urlValue,
        title,
        textValue,
        transcriptValue,
        collection
      });
      ingestController.queue.push(job);
      setIngestJobs((current) => [...current, job]);
      resetIngestForm();
      setStatus(`Queued ${job.label}.`);
      void processIngestQueue();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function resetIngestForm() {
    setUploadValue(undefined);
    setPathValue("");
    setUrlValue("");
    setTitle("");
    setTextValue("");
    setTranscriptValue("");
    setUploadInputKey((current) => current + 1);
  }

  async function processIngestQueue() {
    if (ingestController.processing || ingestController.disposed) {
      return;
    }
    ingestController.processing = true;
    try {
      while (!ingestController.disposed && ingestController.queue.length > 0) {
        const job = ingestController.queue.shift()!;
        await processIngestJob(job);
      }
    } finally {
      ingestController.processing = false;
    }
  }

  async function processIngestJob(job: DocumentationIngestJob) {
    updateIngestJob(job.id, { status: "running", progress: 5, stage: initialIngestStage(job.request) });
    if (!ingestController.disposed) {
      setStatus(`Importing ${job.label}.`);
    }
    try {
      const ingestResponse = await runIngestRequest(job);
      if (ingestController.disposed) {
        return;
      }
      const enrichmentNotice = documentationEnrichmentNotice(ingestResponse);
      updateIngestJob(job.id, { progress: 90, stage: "Refreshing archive list." });
      await loadArchiveSummary();
      if (ingestController.disposed) {
        return;
      }
      updateIngestJob(job.id, {
        status: "complete",
        progress: 100,
        stage: enrichmentNotice?.stage ?? "Import complete.",
        notice: enrichmentNotice?.notice
      });
      setStatus(enrichmentNotice?.status ?? `Imported ${job.label}.`);
    } catch (error) {
      if (ingestController.disposed) {
        return;
      }
      updateIngestJob(job.id, {
        status: "failed",
        progress: 100,
        stage: "Import failed.",
        error: error instanceof Error ? error.message : String(error)
      });
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function runIngestRequest(job: DocumentationIngestJob): Promise<DocumentationIngestResponse | undefined> {
    const request = job.request;
    if (request.mode === "path") {
      updateIngestJob(job.id, { progress: 25, stage: "Reading local path and extracting source evidence." });
      return call<DocumentationIngestResponse>("documentation.ingest.path", compactInput({ path: request.path, title: request.title, sourceType: request.sourceType, collection: request.collection }));
    } else if (request.mode === "upload") {
      updateIngestJob(job.id, { progress: 10, stage: "Uploading file bytes." });
      const response = await uploadFile({
        file: request.file,
        title: request.title,
        sourceType: request.sourceType,
        collection: request.collection,
        onProgress: (progress) => updateUploadIngestProgress(job.id, progress)
      });
      updateIngestJob(job.id, { progress: 82, stage: "Indexer finished extraction and enrichment." });
      return response as DocumentationIngestResponse;
    } else if (request.mode === "url") {
      updateIngestJob(job.id, { progress: 30, stage: urlIngestStage(request) });
      return call<DocumentationIngestResponse>("documentation.ingest.url", compactInput({ url: request.url, title: request.title, sourceType: request.sourceType, collection: request.collection, transcript: request.transcript }));
    } else {
      updateIngestJob(job.id, { progress: 35, stage: "Writing text into the archive." });
      return call<DocumentationIngestResponse>("documentation.ingest.text", compactInput({ title: request.title, text: request.text, uri: request.uri, sourceType: request.sourceType, collection: request.collection }));
    }
  }

  function updateIngestJob(jobId: string, patch: Partial<DocumentationIngestJob>) {
    if (ingestController.disposed) {
      return;
    }
    setIngestJobs((current) => current.map((job) => job.id === jobId ? { ...job, ...patch } : job));
  }

  function updateUploadIngestProgress(jobId: string, progress: DocumentationUploadProgress) {
    const uploadPercent = progress.lengthComputable && progress.totalBytes ? progress.loadedBytes / progress.totalBytes : progress.loadedBytes > 0 ? 1 : 0;
    const percent = Math.max(10, Math.min(55, Math.round(10 + uploadPercent * 45)));
    updateIngestJob(jobId, {
      progress: percent,
      stage: percent >= 55 ? "Upload complete. Indexer is extracting, transcribing, keyframing, and enriching." : `Uploading file bytes (${formatUploadBytes(progress.loadedBytes, progress.totalBytes)}).`
    });
  }

  function clearFinishedIngestJobs() {
    setIngestJobs((current) => current.filter((job) => job.status === "queued" || job.status === "running"));
  }

  async function invalidate(documentId: string, state: string) {
    await run(`Document marked ${state}.`, async () => {
      await call("documentation.invalidate", { documentId, state, reason: `Marked ${state} from the CloudX Documentation panel.` });
      await search();
      await refresh();
    });
  }

  async function remove(documentId: string) {
    await run("Document removed from active search.", async () => {
      await call("documentation.remove", { documentId });
      await search();
      await refresh();
    });
  }

  async function viewDocument(id: string) {
    if (!id) {
      return;
    }
    if (!canCall) {
      setStatus("Documentation hook bridge is not available.");
      return;
    }
    setDocumentBusy(true);
    try {
      const result = await call<{ document?: DocumentationDetail }>("documentation.documents.get", { documentId: id });
      setSelectedDocument(result.document);
      setStatus("Source loaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDocumentBusy(false);
    }
  }

  async function loadPortableManifest() {
    await run("Portable manifest loaded.", async () => {
      const manifest = await call<{ files?: Array<{ path?: string; bytes?: number }> }>("documentation.portableManifest");
      setPortableFiles(manifest.files ?? []);
    });
  }

  async function rebuildIndex() {
    await run("Turbovec index rebuilt.", async () => {
      await call("documentation.rebuildIndex");
      await refresh();
    });
  }

  async function run(message: string, operation: () => Promise<void>) {
    if (!canCall) {
      setStatus("Documentation hook bridge is not available.");
      return;
    }
    setBusy(true);
    try {
      await operation();
      setStatus(message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const visibleDocuments = useMemo(() => documents, [documents]);
  const aiNotice = aiAssistanceEnabled
    ? "AI assistance is enabled. Assisted search can synthesize source-grounded answers."
    : "AI assistance is disabled. Manual mode searches source text only; use View Source to inspect chunks, transcript text, tables, and metadata manually.";
  const sanitizedAnswerHtml = useMemo(() => answer ? sanitizeDocumentationAnswerHtml(answer.answerHtml ?? "") : "", [answer]);
  const runningIngestCount = ingestJobs.filter((job) => job.status === "running").length;
  const queuedIngestCount = ingestJobs.filter((job) => job.status === "queued").length;
  const finishedIngestCount = ingestJobs.filter((job) => job.status === "complete" || job.status === "failed").length;

  return (
    <div className="documentation-panel">
      <header className="documentation-panel-header">
        <div>
          <h2>Documentation Archive</h2>
          <p>{activeCount} active documents, {chunkCount} active chunks</p>
        </div>
        <div className="documentation-toolbar">
          <ControlButton size="compact" onClick={() => void refresh()} disabled={busy} title="Refresh archive">
            <RefreshCw size={14} /> Refresh
          </ControlButton>
          <ControlButton size="compact" onClick={() => void loadPortableManifest()} disabled={busy} title="Show portable archive files">
            <Archive size={14} /> Manifest
          </ControlButton>
          <ControlButton size="compact" onClick={() => void rebuildIndex()} disabled={busy} title="Rebuild Turbovec index">
            <Wrench size={14} /> Rebuild
          </ControlButton>
        </div>
      </header>

      <div className={aiAssistanceEnabled ? "documentation-ai-notice" : "documentation-ai-notice documentation-ai-notice-warning"}>
        {aiAssistanceEnabled ? <Bot size={14} /> : <AlertTriangle size={14} />}
        <span>{aiNotice}</span>
      </div>

      <form className="documentation-search" onSubmit={(event) => void search(event)}>
        <label>
          <span>{searchPresentationMode === "answer" ? "Question" : "Search"}</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPresentationMode === "answer" ? "ask a question about the archive" : "recipe, register, transcript topic"} />
        </label>
        <div className="documentation-search-filters">
          <div className="documentation-search-mode-toggle" role="group" aria-label="Search assistance mode">
            <ControlButton selected={searchPresentationMode === "answer"} disabled={!aiAssistanceEnabled} onClick={() => setSearchPresentationMode("answer")} size="compact">
              <Bot size={13} /> Answer
            </ControlButton>
            <ControlButton selected={searchPresentationMode === "manual"} onClick={() => setSearchPresentationMode("manual")} size="compact">
              <BookOpen size={13} /> Manual
            </ControlButton>
          </div>
          <label><span>Mode</span><select value={searchMode} onChange={(event) => setSearchMode(event.target.value as SearchMode)}>{SEARCH_MODES.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label>
          <label><span>Source</span><select value={searchSourceType} onChange={(event) => setSearchSourceType(event.target.value)}><option value="">all sources</option>{SOURCE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <label><span>State</span><select value={searchState} onChange={(event) => setSearchState(event.target.value)}><option value="">all states</option>{SEARCH_STATES.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
          <label><span>Search Collection</span><input value={searchCollection} onChange={(event) => setSearchCollection(event.target.value)} placeholder="optional" /></label>
        </div>
        <ControlButton type="submit" tone="primary" disabled={busy || !query.trim()}>
          <Search size={15} /> Search
        </ControlButton>
      </form>

      {selectedDocument ? (
        <section ref={sourceViewerRef} className="documentation-section documentation-source-viewer">
          <div className="documentation-source-header">
            <div>
              <h3>Source Viewer</h3>
              <p>{selectedDocument.title ?? documentId(selectedDocument)} · {selectedDocument.source_type ?? selectedDocument.sourceType} · {selectedDocument.chunks?.length ?? 0} chunks</p>
              {selectedDocument.uri ? <p>{selectedDocument.uri}</p> : null}
            </div>
            <ControlButton size="compact" onClick={() => setSelectedDocument(undefined)}>Close</ControlButton>
          </div>
          <div className="documentation-chunk-list">
            {(selectedDocument.chunks ?? []).map((chunk) => (
              <article className="documentation-chunk" key={`${chunkId(chunk)}:${chunk.locator ?? "chunk"}`}>
                <strong>{chunk.locator ?? "chunk"} · {chunk.chunk_origin ?? chunk.chunkOrigin ?? "source"}</strong>
                <p>{chunk.text ?? ""}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <div className="documentation-grid">
        <section className="documentation-section">
          <h3>{searchPresentationMode === "answer" ? "Answer And Sources" : "Results"}</h3>
          <div className="documentation-results">
            {searchBusy ? (
              <article className="documentation-answer-loading" role="status" aria-live="polite">
                <span className="documentation-answer-spinner" aria-hidden="true" />
                <div>
                  <strong>{searchPresentationMode === "answer" && aiAssistanceEnabled ? "AI assisted search is running" : "Search is running"}</strong>
                  <span>{searchPresentationMode === "answer" && aiAssistanceEnabled ? "Searching the archive, opening source chunks, and preparing the answer." : "Searching indexed source chunks."}</span>
                </div>
              </article>
            ) : null}
            {answer ? (
              <article className="documentation-answer">
                <div className="documentation-result-meta">
                  <strong>AI answer</strong>
                  <span>{answer.model ? `model ${answer.model}` : "source-grounded answer"}</span>
                </div>
                {sanitizedAnswerHtml ? (
                  <div className="documentation-answer-body" dangerouslySetInnerHTML={{ __html: sanitizedAnswerHtml }} />
                ) : (
                  <p>No formatted answer returned.</p>
                )}
                {answer.citations?.length ? (
                  <div className="documentation-answer-citations">
                    <h4>Citations</h4>
                    <div>
                      {answer.citations.map((citation) => (
                        <ControlButton key={`${citation.documentId ?? ""}:${citation.locator ?? ""}`} size="compact" disabled={documentBusy || !citation.documentId} onClick={() => void viewDocument(citation.documentId ?? "")}>
                          <BookOpen size={13} /> {citation.title ?? "Source"} · {citation.locator ?? "locator"}
                        </ControlButton>
                      ))}
                    </div>
                  </div>
                ) : null}
                {answer.warnings?.length ? (
                  <ul className="documentation-answer-warnings">
                    {answer.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                ) : null}
              </article>
            ) : null}
            {results.length > 0 ? results.map((result) => (
              <article className="documentation-result" key={result.chunkId}>
                <div className="documentation-result-meta">
                  <strong>{result.title}</strong>
                  <span>{result.sourceType} · {result.locator} · {result.state}</span>
                </div>
                <p>{result.snippet}</p>
                <div className="documentation-result-actions">
                  <ControlButton size="compact" disabled={busy || documentBusy} onClick={() => void viewDocument(result.documentId)}>
                    <BookOpen size={13} /> View Source
                  </ControlButton>
                  {INVALIDATION_STATES.filter((state) => state !== "deleted").map((state) => (
                    <ControlButton key={state} size="compact" disabled={busy} onClick={() => void invalidate(result.documentId, state)}>
                      {state}
                    </ControlButton>
                  ))}
                  <ControlButton size="compact" tone="danger" disabled={busy} onClick={() => void remove(result.documentId)} title="Remove document">
                    <Trash2 size={13} /> Remove
                  </ControlButton>
                </div>
              </article>
            )) : searchBusy ? null : <p className="documentation-empty">No results.</p>}
          </div>
        </section>

        <section className="documentation-section">
          <h3>Add Knowledge</h3>
          <form className="documentation-ingest" onSubmit={(event) => void ingest(event)}>
            <div className="documentation-mode-row" role="group" aria-label="Ingest mode">
              {(["upload", "path", "url", "text"] as const).map((candidate) => (
                <ControlButton key={candidate} selected={mode === candidate} onClick={() => setMode(candidate)} size="compact">
                  {candidate}
                </ControlButton>
              ))}
            </div>
            {mode === "upload" ? (
              <label>
                <span>Upload</span>
                <input key={uploadInputKey} type="file" onChange={(event) => setUploadValue(event.target.files?.[0])} />
              </label>
            ) : null}
            {mode === "upload" && uploadValue ? <p className="documentation-selected-file">{uploadValue.name} · {formatBytes(uploadValue.size)}</p> : null}
            {mode === "path" ? <label><span>Path</span><input value={pathValue} onChange={(event) => setPathValue(event.target.value)} placeholder="/path/to/datasheet.pdf or docs/" /></label> : null}
            {mode === "url" || mode === "text" ? <label><span>URL or URI</span><input value={urlValue} onChange={(event) => setUrlValue(event.target.value)} placeholder="https://vendor.example/doc, youtube playlist, or optional manual URI" /></label> : null}
            <label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="auto from source" /></label>
            <label><span>Type</span><select value={sourceType} onChange={(event) => setSourceType(event.target.value)}>{INGEST_SOURCE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
            <label><span>Collection</span><input value={collection} onChange={(event) => setCollection(event.target.value)} placeholder="auto from folder, domain, playlist, or upload" /></label>
            {mode === "text" ? <label><span>Text</span><textarea value={textValue} onChange={(event) => setTextValue(event.target.value)} rows={5} /></label> : null}
            {mode === "url" && sourceType === "media" ? <label><span>Transcript</span><textarea value={transcriptValue} onChange={(event) => setTranscriptValue(event.target.value)} rows={4} placeholder="Optional transcript text. Leave empty to let the indexer try transcript fetching." /></label> : null}
            <ControlButton type="submit" tone="primary" disabled={!canCall || !ingestReady(mode, uploadValue, pathValue, urlValue, textValue)}>
              <FilePlus size={15} /> Queue
            </ControlButton>
          </form>
          {ingestJobs.length > 0 ? (
            <div className="documentation-ingest-queue" aria-label="Documentation ingest queue">
              <div className="documentation-ingest-queue-header">
                <div>
                  <h4>Import Queue</h4>
                  <span>{runningIngestCount ? "1 running" : "idle"} · {queuedIngestCount} queued</span>
                </div>
                {finishedIngestCount > 0 ? (
                  <ControlButton size="compact" onClick={clearFinishedIngestJobs}>Clear Finished</ControlButton>
                ) : null}
              </div>
              <div className="documentation-ingest-queue-list">
                {ingestJobs.map((job, index) => <IngestQueueJob key={job.id} job={job} index={index} />)}
              </div>
            </div>
          ) : null}
        </section>

        <section className="documentation-section documentation-documents">
          <h3>Active Documents</h3>
          {visibleDocuments.length > 0 ? (
            <div className="documentation-document-list">
              {visibleDocuments.map((document) => (
                <div className="documentation-document-row" key={documentId(document)}>
                  <span>{document.title ?? documentId(document)}</span>
                  <small>{document.source_type ?? document.sourceType} · {document.chunk_count ?? document.chunkCount ?? 0} chunks</small>
                  <ControlButton size="compact" disabled={documentBusy} onClick={() => void viewDocument(documentId(document))}>
                    <BookOpen size={13} /> View
                  </ControlButton>
                </div>
              ))}
            </div>
          ) : <p className="documentation-empty">No active documents.</p>}
        </section>
      </div>

      {portableFiles.length > 0 ? (
        <section className="documentation-section documentation-manifest">
          <h3>Portable Files</h3>
          <div className="documentation-document-list">
            {portableFiles.slice(0, 12).map((file) => (
              <div className="documentation-document-row" key={file.path}>
                <span>{file.path}</span>
                <small>{file.bytes ?? 0} bytes</small>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <footer className="documentation-status" aria-live="polite">{status}</footer>
    </div>
  );
}

function IngestQueueJob({ job, index }: { job: DocumentationIngestJob; index: number }) {
  return (
    <article className={`documentation-ingest-job documentation-ingest-job-${job.status}`}>
      <div className="documentation-ingest-job-main">
        <strong>{index + 1}. {job.label}</strong>
        <span>{job.detail}</span>
      </div>
      <div className="documentation-ingest-job-state">
        <span>{ingestJobStatusLabel(job.status)}</span>
        <small>{job.stage}</small>
      </div>
      <div className="documentation-ingest-progress" role="progressbar" aria-label={`${job.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
        <span style={{ width: `${job.progress}%` }} />
      </div>
      {job.error ? <p>{job.error}</p> : null}
      {job.notice ? <p>{job.notice}</p> : null}
    </article>
  );
}

function createIngestJob(input: {
  mode: IngestMode;
  sourceType: string;
  uploadValue: File | undefined;
  pathValue: string;
  urlValue: string;
  title: string;
  textValue: string;
  transcriptValue: string;
  collection: string;
}): DocumentationIngestJob {
  const selectedSourceType = input.sourceType === "auto" ? undefined : input.sourceType;
  const title = optionalTrimmedString(input.title);
  const collection = optionalTrimmedString(input.collection);
  let request: DocumentationIngestRequest;
  if (input.mode === "upload") {
    if (!input.uploadValue) {
      throw new Error("Choose a file to upload.");
    }
    request = { mode: "upload", file: input.uploadValue, title, sourceType: selectedSourceType, collection };
  } else if (input.mode === "path") {
    const path = input.pathValue.trim();
    if (!path) {
      throw new Error("Path is required.");
    }
    request = { mode: "path", path, title, sourceType: selectedSourceType, collection };
  } else if (input.mode === "url") {
    const url = input.urlValue.trim();
    if (!url) {
      throw new Error("URL is required.");
    }
    request = { mode: "url", url, title, sourceType: selectedSourceType, collection, transcript: optionalTrimmedString(input.transcriptValue) };
  } else {
    const text = input.textValue.trim();
    if (!text) {
      throw new Error("Text is required.");
    }
    request = { mode: "text", title, text, uri: optionalTrimmedString(input.urlValue), sourceType: selectedSourceType, collection };
  }
  return {
    id: nextDocumentationIngestJobId(),
    label: ingestRequestLabel(request),
    detail: ingestRequestDetail(request),
    request,
    progress: 0,
    status: "queued",
    stage: "Queued. Waiting for earlier imports to finish."
  };
}

function nextDocumentationIngestJobId(): string {
  documentationIngestJobCounter += 1;
  return `documentation-ingest-${Date.now()}-${documentationIngestJobCounter}`;
}

function ingestRequestLabel(request: DocumentationIngestRequest): string {
  if (request.mode === "upload") {
    return request.title ?? request.file.name;
  }
  if (request.mode === "path") {
    return request.title ?? request.path.split(/[\\/]/u).filter(Boolean).pop() ?? request.path;
  }
  if (request.mode === "url") {
    return request.title ?? request.url;
  }
  return request.title ?? firstTextLine(request.text) ?? "Text import";
}

function ingestRequestDetail(request: DocumentationIngestRequest): string {
  const parts = [request.mode, request.sourceType ?? "auto"];
  if ("collection" in request && request.collection) {
    parts.push(`collection ${request.collection}`);
  }
  if (request.mode === "upload") {
    parts.push(formatBytes(request.file.size));
  } else if (request.mode === "url" && request.transcript) {
    parts.push("manual transcript");
  }
  return parts.join(" · ");
}

function initialIngestStage(request: DocumentationIngestRequest): string {
  if (request.mode === "upload") {
    return "Waiting to upload file bytes.";
  }
  if (request.mode === "url") {
    return urlIngestStage(request);
  }
  if (request.mode === "path") {
    return "Waiting to read local source path.";
  }
  return "Waiting to write copied text.";
}

function urlIngestStage(request: Extract<DocumentationIngestRequest, { mode: "url" }>): string {
  if (request.sourceType === "media" || /(?:youtube\.com|youtu\.be)/iu.test(request.url)) {
    return "Fetching media metadata, transcript, keyframes, and enrichment evidence.";
  }
  return "Downloading URL and extracting source evidence.";
}

function ingestJobStatusLabel(status: DocumentationIngestJobStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "complete":
      return "Complete";
    case "failed":
      return "Failed";
  }
}

function documentationEnrichmentNotice(response: DocumentationIngestResponse | undefined): DocumentationEnrichmentNotice | undefined {
  const results = documentationEnrichmentResults(response);
  if (results.length === 0) {
    return undefined;
  }
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    const detail = resultDetails(failed, "error");
    const notice = `AI enrichment failed for ${failed.length} ${pluralize("document", failed.length)}${detail ? `: ${detail}` : "."}`;
    return {
      stage: "Import complete. AI enrichment failed.",
      notice,
      status: notice
    };
  }
  const skipped = results.filter((result) => result.status === "skipped");
  if (skipped.length > 0) {
    const detail = resultDetails(skipped, "reason");
    const notice = `AI enrichment wrote no derived spans for ${skipped.length} ${pluralize("document", skipped.length)}${detail ? `: ${detail}` : "."}`;
    return {
      stage: "Import complete. AI enrichment skipped.",
      notice,
      status: notice
    };
  }
  const warnings = results.flatMap((result) => result.warnings ?? []);
  if (warnings.length > 0) {
    const notice = `AI enrichment completed with ${warnings.length} ${pluralize("warning", warnings.length)}: ${warnings.slice(0, 3).join("; ")}`;
    return {
      stage: "Import complete. AI enrichment warnings.",
      notice,
      status: notice
    };
  }
  return undefined;
}

function documentationEnrichmentResults(response: DocumentationIngestResponse | undefined): DocumentationEnrichmentResult[] {
  const enrichment = isRecord(response?.enrichment) ? response.enrichment : undefined;
  return Array.isArray(enrichment?.results) ? enrichment.results.filter(isDocumentationEnrichmentResult) : [];
}

function isDocumentationEnrichmentResult(value: unknown): value is DocumentationEnrichmentResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.documentId === undefined || typeof value.documentId === "string") &&
    (value.status === undefined || typeof value.status === "string") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.warnings === undefined || Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string"))
  );
}

function resultDetails(results: DocumentationEnrichmentResult[], field: "error" | "reason"): string {
  const details = results
    .map((result) => [result.documentId, result[field]].filter(Boolean).join(" "))
    .filter(Boolean);
  return details.slice(0, 3).join("; ");
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalTrimmedString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function firstTextLine(text: string): string | undefined {
  return text.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)?.slice(0, 80);
}

function compactInput(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== ""));
}

function numberStat(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function documentId(document: DocumentationRecord): string {
  return document.document_id ?? document.documentId ?? "";
}

function chunkId(chunk: DocumentationChunk): number {
  return chunk.chunk_id ?? chunk.chunkId ?? 0;
}

function sanitizeDocumentationAnswerHtml(html: string): string {
  return DOMPurify.sanitize(html, DOCUMENTATION_ANSWER_SANITIZE_CONFIG);
}

function searchRunningStatus(mode: SearchPresentationMode, aiAssistanceEnabled: boolean): string {
  return mode === "answer" && aiAssistanceEnabled ? "AI assisted search is running." : "Search is running.";
}

function ingestReady(mode: IngestMode, uploadValue: File | undefined, pathValue: string, urlValue: string, textValue: string): boolean {
  if (mode === "upload") {
    return Boolean(uploadValue);
  }
  if (mode === "path") {
    return Boolean(pathValue.trim());
  }
  if (mode === "url") {
    return Boolean(urlValue.trim());
  }
  return Boolean(textValue.trim());
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatUploadBytes(uploadedBytes: number, totalBytes: number | undefined): string {
  return totalBytes ? `${formatBytes(Math.min(uploadedBytes, totalBytes))} / ${formatBytes(totalBytes)}` : formatBytes(uploadedBytes);
}

export default DocumentationPanel;

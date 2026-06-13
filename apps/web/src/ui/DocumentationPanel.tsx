import { useCallback, useEffect, useId, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { AlertTriangle, Bot, BookOpen, ExternalLink, FileImage, FilePlus, Info, RefreshCw, Search, Table2, Trash2 } from "lucide-react";

import type { UiContributionRenderContext } from "./uiContributions.js";
import { ControlButton } from "./Control.js";
import { PluginPanelDock } from "./PluginPanelDock.js";
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
  textLength?: number;
  textTruncated?: boolean;
  state?: string;
  chunk_origin?: string;
  chunkOrigin?: string;
}

export interface DocumentationArtifactLink {
  kind?: string;
  path?: string;
  mimeType?: string;
  bytes?: number;
  available?: boolean;
}

export interface DocumentationArtifact extends DocumentationArtifactLink {
  id?: string;
  type?: string;
  locator?: string;
  page?: number;
  rows?: number;
  columns?: number;
  nonEmptyCells?: number;
  totalCells?: number;
  width?: number;
  height?: number;
  frames?: number;
  offsetSeconds?: number;
  alternatePaths?: DocumentationArtifactLink[];
}

export interface DocumentationDetail extends DocumentationRecord {
  chunks?: DocumentationChunk[];
  artifacts?: DocumentationArtifact[];
  chunkWindow?: DocumentationWindow;
  artifactWindow?: DocumentationWindow;
}

export interface DocumentationWindow {
  offset?: number;
  limit?: number;
  total?: number;
  hasMore?: boolean;
}

interface DocumentationDocumentListResponse extends Record<string, unknown> {
  documents?: DocumentationRecord[];
  window?: DocumentationWindow;
}

export interface DocumentationArchiveSize {
  fileCount?: number;
  logicalBytes?: number;
  allocatedBytes?: number;
  allocatedBytesAvailable?: boolean;
  databaseBytes?: number;
  snapshotBytes?: number;
  artifactBytes?: number;
  indexBytes?: number;
  denseIndexBytes?: number;
  runtimeEstimateBytes?: number;
  runtimeEstimateKind?: string;
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
export type DocumentationIngestJobStatus = "queued" | "running" | "complete" | "failed";

export interface DocumentationServerIngestJob {
  id: string;
  kind?: string;
  label?: string;
  detail?: string;
  status?: DocumentationIngestJobStatus;
  progress?: number;
  stage?: string;
  position?: number;
  error?: string;
  etaSeconds?: number;
  metrics?: Record<string, unknown>;
  progressChannels?: DocumentationIngestProgressChannel[];
}

export interface DocumentationIngestProgressChannel {
  id: string;
  label: string;
  progress?: number;
  stage?: string;
  etaSeconds?: number;
  metrics?: Record<string, unknown>;
}

export type DocumentationIngestRequest =
  | { mode: "upload"; file: File; title?: string; collection?: string; acceptGeneratedCodeDocumentation?: boolean }
  | { mode: "path"; path: string; title?: string; collection?: string; acceptGeneratedCodeDocumentation?: boolean }
  | { mode: "url"; url: string; title?: string; collection?: string; acceptGeneratedCodeDocumentation?: boolean }
  | { mode: "text"; title?: string; text: string; uri?: string; collection?: string };

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
  etaSeconds?: number;
  metrics?: Record<string, unknown>;
}

interface DocumentationIngestJobView {
  id: string;
  label: string;
  detail: string;
  progress: number;
  status: DocumentationIngestJobStatus;
  stage: string;
  error?: string;
  notice?: string;
  etaSeconds?: number;
  metrics?: Record<string, unknown>;
  progressChannels?: DocumentationIngestProgressChannel[];
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
  searchCollection: string;
  mode: IngestMode;
  uploadValue: File | undefined;
  pathValue: string;
  urlValue: string;
  title: string;
  textValue: string;
  collection: string;
  acceptGeneratedCodeDocumentation: boolean;
  uploadInputKey: number;
  ingestJobs: DocumentationIngestJob[];
  serverIngestJobs: DocumentationServerIngestJob[];
}

export type DocumentationPanelStateUpdater = (state: DocumentationPanelState | undefined) => DocumentationPanelState;

const INVALIDATION_STATES = ["stale", "revoked", "superseded", "quarantined", "deleted"];
const DOCUMENTATION_ANSWER_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["div", "section", "h4", "h5", "p", "ol", "ul", "li", "strong", "em", "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td"],
  ALLOWED_ATTR: []
} satisfies DOMPurifyConfig;
const DEFAULT_DOCUMENTATION_PANEL_STATE_KEY = "documentation-panel-default";
const DOCUMENT_LIST_PAGE_SIZE = 50;
const DOCUMENT_LIST_ROW_HEIGHT = 70;
const DOCUMENT_LIST_VISIBLE_ROWS = 18;
const DOCUMENT_LIST_OVERSCAN_ROWS = 4;
const SOURCE_CHUNK_PAGE_SIZE = 75;
const SOURCE_ARTIFACT_PAGE_SIZE = 100;
const SOURCE_CHUNK_TEXT_MAX_CHARS = 4_000;
const MAX_INLINE_ARTIFACT_PREVIEWS_PER_CHUNK = 6;
let documentationIngestJobCounter = 0;

export function createInitialDocumentationPanelState(): DocumentationPanelState {
  return {
    query: "",
    results: [],
    answer: undefined,
    selectedDocument: undefined,
    documents: [],
    stats: {},
    status: "",
    busy: false,
    searchBusy: false,
    documentBusy: false,
    searchPresentationMode: "answer",
    searchCollection: "",
    mode: "upload",
    uploadValue: undefined,
    pathValue: "",
    urlValue: "",
    title: "",
    textValue: "",
    collection: "",
    acceptGeneratedCodeDocumentation: false,
    uploadInputKey: 0,
    ingestJobs: [],
    serverIngestJobs: []
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
  const [searchCollection, setSearchCollection] = useDocumentationStateField("searchCollection", state, onStateChange);
  const [mode, setMode] = useDocumentationStateField("mode", state, onStateChange);
  const [uploadValue, setUploadValue] = useDocumentationStateField("uploadValue", state, onStateChange);
  const [pathValue, setPathValue] = useDocumentationStateField("pathValue", state, onStateChange);
  const [urlValue, setUrlValue] = useDocumentationStateField("urlValue", state, onStateChange);
  const [title, setTitle] = useDocumentationStateField("title", state, onStateChange);
  const [textValue, setTextValue] = useDocumentationStateField("textValue", state, onStateChange);
  const [collection, setCollection] = useDocumentationStateField("collection", state, onStateChange);
  const [acceptGeneratedCodeDocumentation, setAcceptGeneratedCodeDocumentation] = useDocumentationStateField("acceptGeneratedCodeDocumentation", state, onStateChange);
  const [uploadInputKey, setUploadInputKey] = useDocumentationStateField("uploadInputKey", state, onStateChange);
  const [ingestJobs, setIngestJobs] = useDocumentationStateField("ingestJobs", state, onStateChange);
  const [serverIngestJobs, setServerIngestJobs] = useDocumentationStateField("serverIngestJobs", state, onStateChange);
  const [documentListVisible, setDocumentListVisible] = useState(false);
  const [documentListLoaded, setDocumentListLoaded] = useState(false);
  const [documentListBusy, setDocumentListBusy] = useState(false);
  const [documentListScrollTop, setDocumentListScrollTop] = useState(0);
  const [documentListWindow, setDocumentListWindow] = useState<DocumentationWindow>({ offset: 0, limit: 0, total: 0, hasMore: false });
  const sourceViewerRef = useRef<HTMLElement | null>(null);
  const sourceChunkListRef = useRef<HTMLDivElement | null>(null);
  const sourceAutoLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const documentListRef = useRef<HTMLDivElement | null>(null);
  const documentListRequestIdRef = useRef(0);
  const sourceAutoLoadInFlightRef = useRef(false);
  const sourceViewerScrollDocumentIdRef = useRef("");
  const aiNoticeId = useId();
  const ingestController = useMemo(() => documentationIngestController(stateKey), [stateKey]);

  const canCall = Boolean(callHook);
  const activeCount = numberStat(stats.activeDocumentCount);
  const chunkCount = numberStat(stats.activeChunkCount);
  const archiveSizeLabel = archiveSizeSummaryLabel(archiveSizeStats(stats));
  const aiAssistanceEnabled = globalConfig.aiControlEnabled !== false && config.aiEnrichmentEnabled !== false;

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!canCall) {
      return undefined;
    }
    void loadIngestQueue();
    const interval = window.setInterval(() => void loadIngestQueue(), 1_500);
    return () => window.clearInterval(interval);
  }, [canCall]);

  useEffect(() => {
    if (!aiAssistanceEnabled && searchPresentationMode === "answer") {
      setSearchPresentationMode("manual");
    }
  }, [aiAssistanceEnabled, searchPresentationMode]);

  useEffect(() => {
    const currentDocumentId = selectedDocument ? documentId(selectedDocument) : "";
    if (!currentDocumentId) {
      sourceViewerScrollDocumentIdRef.current = "";
      return;
    }
    if (sourceViewerScrollDocumentIdRef.current !== currentDocumentId && typeof sourceViewerRef.current?.scrollIntoView === "function") {
      sourceViewerScrollDocumentIdRef.current = currentDocumentId;
      sourceViewerRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, [selectedDocument]);

  useEffect(() => {
    const target = sourceAutoLoadSentinelRef.current;
    const root = sourceChunkListRef.current;
    if (!target || !root || !selectedDocument || !sourceNeedsAutoLoad(selectedDocument) || documentBusy || !canCall || typeof window.IntersectionObserver !== "function") {
      return undefined;
    }
    const observer = new window.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadNextSourceWindow();
      }
    }, { root, rootMargin: "120px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [selectedDocument, documentBusy, canCall]);

  async function call<T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}): Promise<T> {
    if (!callHook) {
      throw new Error("Documentation hook bridge is not available.");
    }
    return callHook<T>(hookId, input);
  }

  async function refresh() {
    await run(async () => {
      await Promise.all([
        loadArchiveSummary(),
        loadIngestQueue(),
        documentListLoaded ? loadDocumentPage("replace") : Promise.resolve()
      ]);
    });
  }

  async function loadArchiveSummary() {
    const statsResult = await call<Record<string, unknown>>("documentation.stats");
    setStats(statsResult);
  }

  function showDocumentList(visible: boolean) {
    setDocumentListVisible(visible);
    if (visible) {
      void ensureDocumentListLoaded();
    }
  }

  function handleDocumentListOpenChange(open: boolean) {
    if (open) {
      void ensureDocumentListLoaded();
    }
  }

  async function ensureDocumentListLoaded() {
    if (documentListLoaded || documentListBusy) {
      return;
    }
    await loadDocumentPage("replace");
  }

  async function loadDocumentPage(mode: "replace" | "append") {
    if (!canCall) {
      setStatus("Documentation hook bridge is not available.");
      return;
    }
    if (documentListBusy) {
      return;
    }
    const offset = mode === "append" ? nextDocumentListOffset(documentListWindow, documents.length) : 0;
    const requestId = documentListRequestIdRef.current + 1;
    documentListRequestIdRef.current = requestId;
    setDocumentListBusy(true);
    setStatus("");
    try {
      const result = await call<DocumentationDocumentListResponse>("documentation.documents.list", {
        states: ["active"],
        limit: DOCUMENT_LIST_PAGE_SIZE,
        offset,
        sortDirection: "desc"
      });
      if (documentListRequestIdRef.current !== requestId) {
        return;
      }
      const nextDocuments = result.documents ?? [];
      setDocumentListLoaded(true);
      setDocumentListWindow(result.window ?? documentListWindowFromPage(offset, DOCUMENT_LIST_PAGE_SIZE, nextDocuments.length));
      setDocuments((current) => mode === "append" ? uniqueDocuments([...current, ...nextDocuments]) : nextDocuments);
      if (mode === "replace") {
        setDocumentListScrollTop(0);
        if (documentListRef.current) {
          documentListRef.current.scrollTop = 0;
        }
      }
    } catch (error) {
      if (documentListRequestIdRef.current === requestId) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (documentListRequestIdRef.current === requestId) {
        setDocumentListBusy(false);
      }
    }
  }

  async function loadIngestQueue() {
    if (!canCall) {
      return;
    }
    try {
      const result = await call<{ jobs?: DocumentationServerIngestJob[] }>("documentation.ingest.queue");
      setServerIngestJobs(result.jobs ?? []);
    } catch {
      setServerIngestJobs([]);
    }
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
    setStatus("");
    try {
      await run(async () => {
        if (searchPresentationMode === "answer" && aiAssistanceEnabled) {
          const result = await call<Record<string, unknown>>("documentation.answer", searchInput({ includeQuestion: true }));
          const answerResult = result as unknown as DocumentationAnswer;
          setAnswer(answerResult);
          setResults(answerResult.results ?? []);
          return;
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
      mode: "hybrid",
      states: ["active"],
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
        uploadValue,
        pathValue,
        urlValue,
        title,
        textValue,
        collection,
        acceptGeneratedCodeDocumentation
      });
      ingestController.queue.push(job);
      setIngestJobs((current) => [...current, job]);
      resetIngestForm();
      setStatus("");
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
    setAcceptGeneratedCodeDocumentation(false);
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
    try {
      const ingestResponse = await runIngestRequest(job);
      if (ingestController.disposed) {
        return;
      }
      const enrichmentNotice = documentationEnrichmentNotice(ingestResponse);
      updateIngestJob(job.id, { progress: 90, stage: "Refreshing archive stats." });
      await loadArchiveSummary();
      if (documentListLoaded) {
        await loadDocumentPage("replace");
      }
      if (ingestController.disposed) {
        return;
      }
      updateIngestJob(job.id, {
        status: "complete",
        progress: 100,
        stage: enrichmentNotice?.stage ?? "Import complete.",
        notice: enrichmentNotice?.notice
      });
      await loadIngestQueue();
      setStatus("");
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
      await loadIngestQueue();
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function runIngestRequest(job: DocumentationIngestJob): Promise<DocumentationIngestResponse | undefined> {
    const request = job.request;
    if (request.mode === "path") {
      updateIngestJob(job.id, { progress: 25, stage: "Reading local path and extracting source evidence." });
      return call<DocumentationIngestResponse>("documentation.ingest.path", compactInput({ path: request.path, title: request.title, collection: request.collection, acceptGeneratedCodeDocumentation: request.acceptGeneratedCodeDocumentation }));
    } else if (request.mode === "upload") {
      updateIngestJob(job.id, { progress: 10, stage: "Uploading file bytes." });
      const response = await uploadFile({
        file: request.file,
        title: request.title,
        collection: request.collection,
        acceptGeneratedCodeDocumentation: request.acceptGeneratedCodeDocumentation,
        onProgress: (progress) => updateUploadIngestProgress(job.id, progress)
      });
      updateIngestJob(job.id, { progress: 82, stage: "Indexer finished extraction and enrichment." });
      return response as DocumentationIngestResponse;
    } else if (request.mode === "url") {
      updateIngestJob(job.id, { progress: 30, stage: urlIngestStage(request) });
      return call<DocumentationIngestResponse>("documentation.ingest.url", compactInput({ url: request.url, title: request.title, collection: request.collection, acceptGeneratedCodeDocumentation: request.acceptGeneratedCodeDocumentation }));
    } else {
      updateIngestJob(job.id, { progress: 35, stage: "Writing text into the archive." });
      return call<DocumentationIngestResponse>("documentation.ingest.text", compactInput({ title: request.title, text: request.text, uri: request.uri, collection: request.collection }));
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
    if (canCall) {
      void call<Record<string, unknown>>("documentation.ingest.queue.clearFinished")
        .then((result) => setServerIngestJobs(Array.isArray(result.jobs) ? result.jobs as DocumentationServerIngestJob[] : []))
        .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
    }
  }

  async function invalidate(documentId: string, state: string) {
    await run(async () => {
      await call("documentation.invalidate", { documentId, state, reason: `Marked ${state} from the CloudX Documentation panel.` });
      removeDocumentFromLoadedList(documentId);
      await search();
      await refresh();
    });
  }

  async function remove(targetDocumentId: string) {
    await run(async () => {
      await call("documentation.remove", { documentId: targetDocumentId });
      setSelectedDocument((current) => current && documentId(current) === targetDocumentId ? undefined : current);
      removeDocumentFromLoadedList(targetDocumentId);
      await search();
      await refresh();
    });
  }

  function removeDocumentFromLoadedList(targetDocumentId: string) {
    setDocuments((current) => current.filter((document) => documentId(document) !== targetDocumentId));
    setDocumentListWindow((current) => ({
      ...current,
      total: typeof current.total === "number" ? Math.max(0, current.total - 1) : current.total
    }));
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
    setStatus("");
    try {
      const result = await call<{ document?: DocumentationDetail }>("documentation.documents.get", sourceDocumentWindowInput(id));
      setSelectedDocument(result.document);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDocumentBusy(false);
    }
  }

  async function loadNextSourceWindow() {
    const current = selectedDocument;
    const id = current ? documentId(current) : "";
    if (!current || !id || sourceAutoLoadInFlightRef.current) {
      return;
    }
    const currentChunks = current.chunks ?? [];
    const currentArtifacts = current.artifacts ?? [];
    const hasMoreChunks = current.chunkWindow?.hasMore === true;
    const targetChunkCount = hasMoreChunks ? currentChunks.length + SOURCE_CHUNK_PAGE_SIZE : currentChunks.length;
    const artifactLimit = sourceArtifactRequestLimit(current, targetChunkCount);
    if (!hasMoreChunks && artifactLimit <= 0) {
      return;
    }
    sourceAutoLoadInFlightRef.current = true;
    setDocumentBusy(true);
    setStatus("");
    try {
      const result = await call<{ document?: DocumentationDetail }>("documentation.documents.get", {
        documentId: id,
        chunkOffset: currentChunks.length,
        chunkLimit: hasMoreChunks ? SOURCE_CHUNK_PAGE_SIZE : 0,
        chunkTextMaxChars: SOURCE_CHUNK_TEXT_MAX_CHARS,
        artifactOffset: currentArtifacts.length,
        artifactLimit
      });
      setSelectedDocument((latest) => latest && documentId(latest) === id ? mergeSourceWindow(latest, result.document) : latest);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      sourceAutoLoadInFlightRef.current = false;
      setDocumentBusy(false);
    }
  }

  async function run(operation: () => Promise<void>) {
    if (!canCall) {
      setStatus("Documentation hook bridge is not available.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      await operation();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const virtualDocuments = useMemo(() => virtualDocumentRows(documents, documentListScrollTop), [documents, documentListScrollTop]);
  const documentListHasMore = documentListWindow.hasMore === true;
  const documentListSummary = documentListLoaded ? documentListLoadedLabel(documents.length, documentListWindow) : "";
  const aiNotice = aiAssistanceEnabled
    ? "AI assistance is enabled. Assisted search can synthesize source-grounded answers."
    : "AI assistance is disabled. Manual mode searches source text only; use View Source to inspect chunks, transcript text, tables, and metadata manually.";
  const sanitizedAnswerHtml = useMemo(() => answer ? sanitizeDocumentationAnswerHtml(answer.answerHtml ?? "") : "", [answer]);
  const visibleIngestJobs = useMemo(() => {
    return serverIngestJobs.length > 0 ? serverIngestJobs.map(serverIngestJobView) : ingestJobs;
  }, [serverIngestJobs, ingestJobs]);
  const runningIngestCount = visibleIngestJobs.filter((job) => job.status === "running").length;
  const queuedIngestCount = visibleIngestJobs.filter((job) => job.status === "queued").length;
  const finishedIngestCount = visibleIngestJobs.filter((job) => job.status === "complete" || job.status === "failed").length;
  const selectedDocumentId = selectedDocument ? documentId(selectedDocument) : "";

  return (
    <div className="documentation-panel">
      <header className="documentation-panel-header">
        <div>
          <h2>Documentation Archive</h2>
          <p>{activeCount} active documents, {chunkCount} active chunks</p>
          {archiveSizeLabel ? <p>{archiveSizeLabel}</p> : null}
        </div>
        <div className="documentation-toolbar">
          <span className={aiAssistanceEnabled ? "documentation-ai-status" : "documentation-ai-status documentation-ai-status-warning"}>
            <span className="documentation-ai-info" tabIndex={0} aria-label="AI assistance information" aria-describedby={aiNoticeId}>
              {aiAssistanceEnabled ? <Info size={14} /> : <AlertTriangle size={14} />}
            </span>
            <span id={aiNoticeId} role="tooltip" className="documentation-ai-tooltip">{aiNotice}</span>
          </span>
          <ControlButton size="compact" onClick={() => void refresh()} disabled={busy} title="Refresh archive">
            <RefreshCw size={14} /> Refresh
          </ControlButton>
        </div>
      </header>

      {status ? <div className="documentation-notice" role="alert">{status}</div> : null}

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
              <p>{selectedDocument.title ?? documentId(selectedDocument)} · {selectedDocument.source_type ?? selectedDocument.sourceType} · {sourceWindowLabel(selectedDocument.chunks?.length ?? 0, selectedDocument.chunkWindow, "chunks")}</p>
              {selectedDocument.uri ? <p>{selectedDocument.uri}</p> : null}
              {selectedDocument.artifacts?.length || selectedDocument.artifactWindow?.total ? <p>{sourceWindowLabel(selectedDocument.artifacts?.length ?? 0, selectedDocument.artifactWindow, "extracted artifacts")} available.</p> : null}
            </div>
            <div className="documentation-source-actions">
              <ControlButton size="compact" tone="danger" disabled={busy || !selectedDocumentId} onClick={() => void remove(selectedDocumentId)} title="Remove document">
                <Trash2 size={13} /> Remove
              </ControlButton>
              <ControlButton size="compact" onClick={() => setSelectedDocument(undefined)}>Close</ControlButton>
            </div>
          </div>
          <div ref={sourceChunkListRef} className="documentation-chunk-list">
            {(selectedDocument.chunks ?? []).map((chunk) => (
              <DocumentationChunkArticle key={`${chunkId(chunk)}:${chunk.locator ?? "chunk"}`} document={selectedDocument} chunk={chunk} />
            ))}
            {sourceNeedsAutoLoad(selectedDocument) ? (
              <div ref={sourceAutoLoadSentinelRef} className="documentation-source-autoload" aria-live="polite">
                <span>{documentBusy ? "Loading more source data." : sourceAutoLoadLabel(selectedDocument)}</span>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {!selectedDocument ? <div className="documentation-grid">
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

        <PluginPanelDock compactAt="wide" controls="compact-or-hidden" items={[
          {
            id: "ingest",
            label: "Add knowledge",
            icon: <FilePlus size={15} />,
            children: (
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
                  {mode === "path" ? <label><span>Path</span><input value={pathValue} onChange={(event) => setPathValue(event.target.value)} placeholder="/path/to/datasheet.pdf, workbook.xlsx, or docs/" /></label> : null}
                  {mode === "url" || mode === "text" ? <label><span>URL or URI</span><input value={urlValue} onChange={(event) => setUrlValue(event.target.value)} placeholder="https://vendor.example/doc, youtube playlist, or optional manual URI" /></label> : null}
                  <label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="auto from source" /></label>
                  <label><span>Collection</span><input value={collection} onChange={(event) => setCollection(event.target.value)} placeholder="auto from folder, domain, playlist, or upload" /></label>
                  {mode !== "text" ? (
                    <label className="checkbox-row">
                      <input type="checkbox" checked={acceptGeneratedCodeDocumentation} onChange={(event) => setAcceptGeneratedCodeDocumentation(event.currentTarget.checked)} />
                      <span>Accept generated code documentation</span>
                    </label>
                  ) : null}
                  {mode === "text" ? <label><span>Text</span><textarea value={textValue} onChange={(event) => setTextValue(event.target.value)} rows={5} /></label> : null}
                  <ControlButton type="submit" tone="primary" disabled={!canCall || !ingestReady(mode, uploadValue, pathValue, urlValue, textValue)}>
                    <FilePlus size={15} /> Queue
                  </ControlButton>
                </form>
                {visibleIngestJobs.length > 0 ? (
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
                      {visibleIngestJobs.map((job, index) => <IngestQueueJob key={job.id} job={job} index={index} />)}
                    </div>
                  </div>
                ) : null}
              </section>
            )
          },
          {
            id: "documents",
            label: "Active documents",
            icon: <BookOpen size={15} />,
            visible: documentListVisible,
            showLabel: "Show Active documents",
            hideLabel: "Hide Active documents",
            onVisibleChange: showDocumentList,
            onOpenChange: handleDocumentListOpenChange,
            children: (
              <section className="documentation-section documentation-documents">
                <h3>Active Documents</h3>
                {documentListBusy && !documentListLoaded ? <p className="documentation-empty" role="status">Loading active documents.</p> : null}
                {documentListLoaded && documents.length > 0 ? (
                  <>
                    <div
                      ref={documentListRef}
                      className="documentation-document-list"
                      onScroll={(event) => setDocumentListScrollTop(event.currentTarget.scrollTop)}
                    >
                      <div className="documentation-document-virtual-list" style={{ height: `${virtualDocuments.totalHeight}px` }}>
                        {virtualDocuments.rows.map(({ document, index, offset }) => (
                          <div className="documentation-document-row" key={documentId(document)} style={{ transform: `translateY(${offset}px)` }}>
                            <span>{document.title ?? documentId(document)}</span>
                            <small>{index + 1}. {document.source_type ?? document.sourceType} · {document.chunk_count ?? document.chunkCount ?? 0} chunks</small>
                            <ControlButton size="compact" disabled={documentBusy} onClick={() => void viewDocument(documentId(document))}>
                              <BookOpen size={13} /> View
                            </ControlButton>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="documentation-document-list-footer">
                      <span>{documentListSummary}</span>
                      {documentListHasMore ? (
                        <ControlButton size="compact" disabled={documentListBusy} onClick={() => void loadDocumentPage("append")}>
                          {documentListBusy ? "Loading" : "Load More"}
                        </ControlButton>
                      ) : null}
                    </div>
                  </>
                ) : documentListLoaded ? (
                  <p className="documentation-empty">No active documents.</p>
                ) : (
                  <p className="documentation-empty">Open the panel to load active documents.</p>
                )}
              </section>
            )
          }
        ]} />
      </div> : null}

    </div>
  );
}

function DocumentationChunkArticle({ document, chunk }: { document: DocumentationDetail; chunk: DocumentationChunk }) {
  const attachments = artifactsForChunk(document, chunk);
  const visibleAttachments = attachments.slice(0, MAX_INLINE_ARTIFACT_PREVIEWS_PER_CHUNK);
  const hiddenAttachmentCount = Math.max(0, attachments.length - visibleAttachments.length);
  return (
    <article className={attachments.length > 0 ? "documentation-chunk documentation-chunk-with-artifacts" : "documentation-chunk"}>
      <div className="documentation-chunk-body">
        <strong>{chunk.locator ?? "chunk"} · {chunk.chunk_origin ?? chunk.chunkOrigin ?? "source"}</strong>
        <p>{chunk.text ?? ""}</p>
        {chunk.textTruncated ? <small>Chunk preview truncated at {formatCount((chunk.text ?? "").length)} of {formatCount(chunk.textLength ?? 0)} characters.</small> : null}
      </div>
      {attachments.length > 0 ? (
        <div className="documentation-artifact-list">
          {visibleAttachments.map((artifact) => <DocumentationArtifactPreview key={`${artifact.id ?? artifact.path}:${artifact.path}`} document={document} artifact={artifact} />)}
          {hiddenAttachmentCount > 0 ? <p className="documentation-artifact-more">{hiddenAttachmentCount} more loaded artifacts for this chunk. Use Open on a specific artifact or load more artifacts in the source header.</p> : null}
        </div>
      ) : null}
    </article>
  );
}

function DocumentationArtifactPreview({ document, artifact }: { document: DocumentationDetail; artifact: DocumentationArtifact }) {
  const href = artifact.path ? documentationArtifactUrl(documentId(document), artifact.path) : undefined;
  const label = artifactLabel(artifact);
  if (href && isPreviewableImageArtifact(artifact)) {
    return (
      <figure className="documentation-artifact documentation-artifact-image">
        <img src={href} alt={label} loading="lazy" decoding="async" />
        <figcaption>
          <FileImage size={13} />
          <span>{label}</span>
          <a href={href} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Open</a>
        </figcaption>
      </figure>
    );
  }
  return (
    <div className="documentation-artifact documentation-artifact-file">
      <div>
        {artifact.type === "table" ? <Table2 size={14} /> : <FileImage size={14} />}
        <span>{label}</span>
      </div>
      <div>
        {artifact.alternatePaths?.filter((path) => path.path && path.available !== false).map((path) => (
          <a key={`${path.kind}:${path.path}`} href={documentationArtifactUrl(documentId(document), path.path!)} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> {path.kind ?? "file"}
          </a>
        ))}
        {href && !artifact.alternatePaths?.length ? <a href={href} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Open</a> : null}
      </div>
    </div>
  );
}

function IngestQueueJob({ job, index }: { job: DocumentationIngestJobView; index: number }) {
  const progressChannels = job.progressChannels ?? [];
  const hasProgressChannels = progressChannels.length > 0;
  return (
    <article className={`documentation-ingest-job documentation-ingest-job-${job.status}`}>
      <div className="documentation-ingest-job-main">
        <strong>{index + 1}. {job.label}</strong>
        <span>{job.detail}</span>
      </div>
      <div className="documentation-ingest-job-state">
        <span>{ingestJobStatusLabel(job.status)}</span>
        {!hasProgressChannels ? <small>{job.stage}</small> : null}
        {!hasProgressChannels && job.etaSeconds !== undefined ? <small>ETA {formatDuration(job.etaSeconds)}</small> : null}
        {!hasProgressChannels && job.metrics ? <small>{formatIngestMetrics(job.metrics)}</small> : null}
      </div>
      {hasProgressChannels ? (
        <div className="documentation-ingest-channels" aria-label={`${job.label} parallel progress`}>
          {progressChannels.map((channel) => <IngestProgressChannel key={channel.id} channel={channel} />)}
        </div>
      ) : null}
      <div className="documentation-ingest-progress" role="progressbar" aria-label={`${job.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
        <span style={{ width: `${job.progress}%` }} />
      </div>
      {job.error ? <p>{job.error}</p> : null}
      {job.notice ? <p>{job.notice}</p> : null}
    </article>
  );
}

function IngestProgressChannel({ channel }: { channel: DocumentationIngestProgressChannel }) {
  const metrics = channel.metrics ? formatIngestMetrics(channel.metrics) : "";
  return (
    <div className="documentation-ingest-channel">
      <span>{channel.label}</span>
      <small>{channel.stage || "Waiting for progress."}</small>
      {channel.etaSeconds !== undefined ? <small>ETA {formatDuration(channel.etaSeconds)}</small> : null}
      {metrics ? <small>{metrics}</small> : null}
      {channel.progress !== undefined ? (
        <div className="documentation-ingest-channel-progress" role="progressbar" aria-label={`${channel.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={channel.progress}>
          <span style={{ width: `${channel.progress}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function createIngestJob(input: {
  mode: IngestMode;
  uploadValue: File | undefined;
  pathValue: string;
  urlValue: string;
  title: string;
  textValue: string;
  collection: string;
  acceptGeneratedCodeDocumentation: boolean;
}): DocumentationIngestJob {
  const title = optionalTrimmedString(input.title);
  const collection = optionalTrimmedString(input.collection);
  const acceptGeneratedCodeDocumentation = input.acceptGeneratedCodeDocumentation ? true : undefined;
  let request: DocumentationIngestRequest;
  if (input.mode === "upload") {
    if (!input.uploadValue) {
      throw new Error("Choose a file to upload.");
    }
    request = { mode: "upload", file: input.uploadValue, title, collection, acceptGeneratedCodeDocumentation };
  } else if (input.mode === "path") {
    const path = input.pathValue.trim();
    if (!path) {
      throw new Error("Path is required.");
    }
    request = { mode: "path", path, title, collection, acceptGeneratedCodeDocumentation };
  } else if (input.mode === "url") {
    const url = input.urlValue.trim();
    if (!url) {
      throw new Error("URL is required.");
    }
    request = { mode: "url", url, title, collection, acceptGeneratedCodeDocumentation };
  } else {
    const text = input.textValue.trim();
    if (!text) {
      throw new Error("Text is required.");
    }
    request = { mode: "text", title, text, uri: optionalTrimmedString(input.urlValue), collection };
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
  const parts: string[] = [request.mode];
  if ("collection" in request && request.collection) {
    parts.push(`collection ${request.collection}`);
  }
  if (request.mode === "upload") {
    parts.push(formatBytes(request.file.size));
  }
  return parts.join(" · ");
}

function serverIngestJobView(job: DocumentationServerIngestJob): DocumentationIngestJobView {
  const detailParts = [job.detail, job.position && job.position > 0 ? `queue position ${job.position}` : undefined].filter((part): part is string => Boolean(part));
  return {
    id: job.id,
    label: job.label?.trim() || `${job.kind ?? "documentation"} import`,
    detail: detailParts.join(" · ") || job.kind || "server queue",
    progress: Math.max(0, Math.min(100, Math.round(job.progress ?? 0))),
    status: job.status ?? "queued",
    stage: job.stage?.trim() || "Waiting for documentation import.",
    error: job.error,
    etaSeconds: typeof job.etaSeconds === "number" ? job.etaSeconds : undefined,
    metrics: job.metrics && typeof job.metrics === "object" ? job.metrics : undefined,
    progressChannels: normalizeProgressChannels(job.progressChannels)
  };
}

function normalizeProgressChannels(value: unknown): DocumentationIngestProgressChannel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const channels = value.flatMap((item): DocumentationIngestProgressChannel[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
    if (!id) {
      return [];
    }
    return [{
      id,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : id,
      progress: typeof record.progress === "number" ? Math.max(0, Math.min(100, Math.round(record.progress))) : undefined,
      stage: typeof record.stage === "string" && record.stage.trim() ? record.stage.trim() : undefined,
      etaSeconds: typeof record.etaSeconds === "number" ? record.etaSeconds : undefined,
      metrics: record.metrics && typeof record.metrics === "object" ? record.metrics as Record<string, unknown> : undefined
    }];
  });
  return channels.length ? channels : undefined;
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
  if (/(?:youtube\.com|youtu\.be)/iu.test(request.url)) {
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

function sourceDocumentWindowInput(documentIdValue: string): Record<string, unknown> {
  return {
    documentId: documentIdValue,
    chunkOffset: 0,
    chunkLimit: SOURCE_CHUNK_PAGE_SIZE,
    chunkTextMaxChars: SOURCE_CHUNK_TEXT_MAX_CHARS,
    artifactOffset: 0,
    artifactLimit: SOURCE_ARTIFACT_PAGE_SIZE
  };
}

function nextDocumentListOffset(window: DocumentationWindow, fallback: number): number {
  if (typeof window.offset === "number" && typeof window.limit === "number") {
    return Math.max(0, window.offset + window.limit);
  }
  return Math.max(0, fallback);
}

function documentListWindowFromPage(offset: number, limit: number, count: number): DocumentationWindow {
  return {
    offset,
    limit,
    total: offset + count,
    hasMore: false
  };
}

function documentListLoadedLabel(loaded: number, window: DocumentationWindow): string {
  return typeof window.total === "number" ? `${formatCount(loaded)} of ${formatCount(window.total)} loaded` : `${formatCount(loaded)} loaded`;
}

function uniqueDocuments(documents: DocumentationRecord[]): DocumentationRecord[] {
  const seen = new Set<string>();
  return documents.filter((document) => {
    const key = documentId(document);
    if (!key) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function virtualDocumentRows(documents: DocumentationRecord[], scrollTop: number): {
  rows: Array<{ document: DocumentationRecord; index: number; offset: number }>;
  totalHeight: number;
} {
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / DOCUMENT_LIST_ROW_HEIGHT) - DOCUMENT_LIST_OVERSCAN_ROWS);
  const end = Math.min(documents.length, start + DOCUMENT_LIST_VISIBLE_ROWS + DOCUMENT_LIST_OVERSCAN_ROWS * 2);
  return {
    rows: documents.slice(start, end).map((document, index) => ({
      document,
      index: start + index,
      offset: (start + index) * DOCUMENT_LIST_ROW_HEIGHT
    })),
    totalHeight: documents.length * DOCUMENT_LIST_ROW_HEIGHT
  };
}

function mergeSourceWindow(current: DocumentationDetail, next: DocumentationDetail | undefined): DocumentationDetail {
  if (!next) {
    return current;
  }
  return {
    ...current,
    chunks: uniqueChunks([...(current.chunks ?? []), ...(next.chunks ?? [])]),
    artifacts: uniqueArtifacts([...(current.artifacts ?? []), ...(next.artifacts ?? [])]),
    chunkWindow: next.chunkWindow ?? current.chunkWindow,
    artifactWindow: next.artifactWindow ?? current.artifactWindow
  };
}

function uniqueChunks(chunks: DocumentationChunk[]): DocumentationChunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    const key = `${chunkId(chunk)}:${chunk.locator ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sourceWindowLabel(loaded: number, window: DocumentationWindow | undefined, label: string): string {
  return typeof window?.total === "number" ? `${formatCount(loaded)} of ${formatCount(window.total)} ${label}` : `${formatCount(loaded)} ${label}`;
}

function sourceNeedsAutoLoad(document: DocumentationDetail): boolean {
  return document.chunkWindow?.hasMore === true || sourceArtifactRequestLimit(document, document.chunks?.length ?? 0) > 0;
}

function sourceArtifactRequestLimit(document: DocumentationDetail, targetChunkCount: number): number {
  if (document.artifactWindow?.hasMore !== true) {
    return 0;
  }
  const loadedArtifacts = document.artifacts?.length ?? 0;
  const totalArtifacts = document.artifactWindow.total;
  const targetArtifacts = typeof totalArtifacts === "number" ? Math.min(Math.max(0, targetChunkCount), totalArtifacts) : Math.max(0, targetChunkCount);
  return Math.max(0, targetArtifacts - loadedArtifacts);
}

function sourceAutoLoadLabel(document: DocumentationDetail): string {
  if (document.chunkWindow?.hasMore === true) {
    return "More source chunks load automatically here.";
  }
  return "More extracted artifacts load automatically here.";
}

function numberStat(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function archiveSizeStats(stats: Record<string, unknown>): DocumentationArchiveSize | undefined {
  if (!isRecord(stats.archiveSize)) {
    return undefined;
  }
  const archiveSize = stats.archiveSize;
  return {
    fileCount: optionalNumber(archiveSize.fileCount),
    logicalBytes: optionalNumber(archiveSize.logicalBytes),
    allocatedBytes: optionalNumber(archiveSize.allocatedBytes),
    allocatedBytesAvailable: typeof archiveSize.allocatedBytesAvailable === "boolean" ? archiveSize.allocatedBytesAvailable : undefined,
    databaseBytes: optionalNumber(archiveSize.databaseBytes),
    snapshotBytes: optionalNumber(archiveSize.snapshotBytes),
    artifactBytes: optionalNumber(archiveSize.artifactBytes),
    indexBytes: optionalNumber(archiveSize.indexBytes),
    denseIndexBytes: optionalNumber(archiveSize.denseIndexBytes),
    runtimeEstimateBytes: optionalNumber(archiveSize.runtimeEstimateBytes),
    runtimeEstimateKind: typeof archiveSize.runtimeEstimateKind === "string" ? archiveSize.runtimeEstimateKind : undefined
  };
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function archiveSizeSummaryLabel(size: DocumentationArchiveSize | undefined): string {
  if (!size || size.logicalBytes === undefined) {
    return "";
  }
  const summary = [`Archive ${formatBytes(size.logicalBytes)} logical`];
  if (size.allocatedBytes !== undefined && size.allocatedBytesAvailable !== false) {
    summary.push(`${formatBytes(size.allocatedBytes)} on disk`);
  }
  if (size.fileCount !== undefined) {
    summary.push(`${formatCount(size.fileCount)} files`);
  }
  const breakdown = [
    archiveSizePart("database", size.databaseBytes),
    archiveSizePart("snapshots", size.snapshotBytes),
    archiveSizePart("artifacts", size.artifactBytes),
    archiveSizePart("index", size.indexBytes),
  ].filter(Boolean).join(", ");
  const runtime = size.runtimeEstimateBytes !== undefined
    ? `runtime estimate ${formatBytes(size.runtimeEstimateBytes)} ${runtimeEstimateKindLabel(size.runtimeEstimateKind)}`
    : "";
  return [summary.join(", "), breakdown, runtime].filter(Boolean).join(" · ");
}

function archiveSizePart(label: string, bytes: number | undefined): string {
  return bytes === undefined ? "" : `${label} ${formatBytes(bytes)}`;
}

function runtimeEstimateKindLabel(kind: string | undefined): string {
  return kind === "dense-index-file" ? "dense index" : "estimate";
}

function documentId(document: DocumentationRecord): string {
  return document.document_id ?? document.documentId ?? "";
}

function chunkId(chunk: DocumentationChunk): number {
  return chunk.chunk_id ?? chunk.chunkId ?? 0;
}

function artifactsForChunk(document: DocumentationDetail, chunk: DocumentationChunk): DocumentationArtifact[] {
  const locator = (chunk.locator ?? "").toLowerCase();
  if (!locator) {
    return [];
  }
  const page = pageNumberFromLocator(locator);
  const artifacts = document.artifacts ?? [];
  return uniqueArtifacts(artifacts.filter((artifact) => {
    const artifactLocator = (artifact.locator ?? "").toLowerCase();
    const artifactId = (artifact.id ?? "").toLowerCase();
    return artifact.available !== false && (artifactLocator === locator || Boolean(artifactId && locator.includes(artifactId)));
  }).concat(artifacts.filter((artifact) => {
    return artifact.available !== false && page !== undefined && artifact.page === page && artifact.kind === "page-render";
  })));
}

function uniqueArtifacts(artifacts: DocumentationArtifact[]): DocumentationArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = artifact.path ?? `${artifact.type ?? ""}:${artifact.id ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function pageNumberFromLocator(locator: string): number | undefined {
  const match = /^page\s+(\d+)(?:\s|$)/iu.exec(locator);
  if (!match) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function isPreviewableImageArtifact(artifact: DocumentationArtifact): boolean {
  return artifact.available !== false && typeof artifact.path === "string" && (artifact.mimeType?.startsWith("image/") ?? false);
}

function documentationArtifactUrl(documentIdValue: string, artifactPath: string): string {
  const params = new URLSearchParams({ path: artifactPath });
  return `/api/documentation/documents/${encodeURIComponent(documentIdValue)}/artifact?${params.toString()}`;
}

function artifactLabel(artifact: DocumentationArtifact): string {
  const parts = [artifact.id ?? artifact.type ?? "artifact"];
  if (artifact.page !== undefined) {
    parts.push(`page ${artifact.page}`);
  }
  if (artifact.rows !== undefined && artifact.columns !== undefined) {
    parts.push(`${artifact.rows}x${artifact.columns}`);
  } else if (artifact.width !== undefined && artifact.height !== undefined) {
    parts.push(`${artifact.width}x${artifact.height}`);
  } else if (artifact.offsetSeconds !== undefined) {
    parts.push(`${artifact.offsetSeconds}s`);
  }
  if (artifact.bytes !== undefined) {
    parts.push(formatBytes(artifact.bytes));
  }
  return parts.join(" · ");
}

function sanitizeDocumentationAnswerHtml(html: string): string {
  return DOMPurify.sanitize(html, DOCUMENTATION_ANSWER_SANITIZE_CONFIG);
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

function formatCount(value: number): string {
  return Math.max(0, value).toLocaleString("en-US");
}

function formatUploadBytes(uploadedBytes: number, totalBytes: number | undefined): string {
  return totalBytes ? `${formatBytes(Math.min(uploadedBytes, totalBytes))} / ${formatBytes(totalBytes)}` : formatBytes(uploadedBytes);
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  if (hours) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

function formatIngestMetrics(metrics: Record<string, unknown>): string {
  const parts = [
    downloadMetric(metrics),
    metricPart(metrics, "transcribedSeconds", "transcribed", formatDuration),
    metricPart(metrics, "framesScanned", "scanned", formatCount),
    metricPart(metrics, "candidateFrames", "candidates", formatCount),
    metricPart(metrics, "selectedFrames", "slides", formatCount),
    playlistMetric(metrics)
  ].filter((part): part is string => Boolean(part));
  return parts.slice(0, 3).join(" · ");
}

function metricPart(metrics: Record<string, unknown>, key: string, label: string, format: (value: number) => string): string | undefined {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? `${label} ${format(value)}` : undefined;
}

function playlistMetric(metrics: Record<string, unknown>): string | undefined {
  const index = metrics.playlistIndex;
  const total = metrics.playlistTotal;
  return typeof index === "number" && typeof total === "number" ? `playlist ${index}/${total}` : undefined;
}

function downloadMetric(metrics: Record<string, unknown>): string | undefined {
  const downloaded = metrics.downloadedBytes;
  const total = metrics.totalBytes;
  if (typeof downloaded !== "number" || !Number.isFinite(downloaded)) {
    return undefined;
  }
  return typeof total === "number" && Number.isFinite(total)
    ? `downloaded ${formatBytes(Math.min(downloaded, total))} / ${formatBytes(total)}`
    : `downloaded ${formatBytes(downloaded)}`;
}

export default DocumentationPanel;

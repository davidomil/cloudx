import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Archive, FilePlus, RefreshCw, Search, Trash2, Wrench } from "lucide-react";

import type { UiContributionRenderContext } from "./uiContributions.js";
import { ControlButton } from "./Control.js";
import { uploadDocumentationFile } from "../api.js";

interface DocumentationPanelProps {
  callHook: UiContributionRenderContext["callHook"];
  uploadFile?: typeof uploadDocumentationFile;
}

interface DocumentationSearchResult {
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

interface DocumentationRecord {
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

type IngestMode = "upload" | "path" | "url" | "text";
type SearchMode = "hybrid" | "dense" | "lexical";

const SEARCH_MODES: SearchMode[] = ["hybrid", "dense", "lexical"];
const SOURCE_TYPES = ["datasheet", "book", "website", "repo_code", "readme", "media", "image", "text"];
const INGEST_SOURCE_TYPES = ["auto", ...SOURCE_TYPES];
const INVALIDATION_STATES = ["stale", "revoked", "superseded", "quarantined", "deleted"];
const SEARCH_STATES = ["active", ...INVALIDATION_STATES];

export function DocumentationPanel({ callHook, uploadFile = uploadDocumentationFile }: DocumentationPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentationSearchResult[]>([]);
  const [documents, setDocuments] = useState<DocumentationRecord[]>([]);
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState("Documentation archive not loaded.");
  const [busy, setBusy] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid");
  const [searchSourceType, setSearchSourceType] = useState("");
  const [searchState, setSearchState] = useState("active");
  const [searchCollection, setSearchCollection] = useState("");
  const [mode, setMode] = useState<IngestMode>("upload");
  const [sourceType, setSourceType] = useState("auto");
  const [uploadValue, setUploadValue] = useState<File | undefined>(undefined);
  const [pathValue, setPathValue] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [title, setTitle] = useState("");
  const [textValue, setTextValue] = useState("");
  const [transcriptValue, setTranscriptValue] = useState("");
  const [collection, setCollection] = useState("");
  const [portableFiles, setPortableFiles] = useState<Array<{ path?: string; bytes?: number }>>([]);

  const canCall = Boolean(callHook);
  const activeCount = numberStat(stats.activeDocumentCount);
  const chunkCount = numberStat(stats.activeChunkCount);

  useEffect(() => {
    void refresh();
  }, []);

  async function call<T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}): Promise<T> {
    if (!callHook) {
      throw new Error("Documentation hook bridge is not available.");
    }
    return callHook<T>(hookId, input);
  }

  async function refresh() {
    await run("Documentation archive refreshed.", async () => {
      const [statsResult, docsResult] = await Promise.all([
        call<Record<string, unknown>>("documentation.stats"),
        call<{ documents: DocumentationRecord[] }>("documentation.documents.list")
      ]);
      setStats(statsResult);
      setDocuments(docsResult.documents ?? []);
    });
  }

  async function search(event?: FormEvent) {
    event?.preventDefault();
    if (!query.trim()) {
      setResults([]);
      setStatus("Enter a search query.");
      return;
    }
    await run("Search completed.", async () => {
      const result = await call<{ results: DocumentationSearchResult[] }>(
        "documentation.search",
        compactInput({
          query: query.trim(),
          limit: 12,
          mode: searchMode,
          sourceTypes: searchSourceType ? [searchSourceType] : undefined,
          states: searchState ? [searchState] : undefined,
          collection: searchCollection.trim()
        })
      );
      setResults(result.results ?? []);
    });
  }

  async function ingest(event: FormEvent) {
    event.preventDefault();
    await run("Documentation ingested.", async () => {
      const selectedSourceType = sourceType === "auto" ? undefined : sourceType;
      if (mode === "path") {
        await call("documentation.ingest.path", compactInput({ path: pathValue, title, sourceType: selectedSourceType, collection }));
      } else if (mode === "upload") {
        if (!uploadValue) {
          throw new Error("Choose a file to upload.");
        }
        await uploadFile({ file: uploadValue, title, sourceType: selectedSourceType, collection });
      } else if (mode === "url") {
        await call("documentation.ingest.url", compactInput({ url: urlValue, title, sourceType: selectedSourceType, collection, transcript: transcriptValue }));
      } else {
        await call("documentation.ingest.text", compactInput({ title, text: textValue, uri: urlValue || `manual://${slug(title)}`, sourceType: selectedSourceType ?? "text", collection }));
      }
      setUploadValue(undefined);
      setPathValue("");
      setUrlValue("");
      setTitle("");
      setTextValue("");
      setTranscriptValue("");
      await refresh();
    });
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

  const visibleDocuments = useMemo(() => documents.slice(0, 10), [documents]);

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

      <form className="documentation-search" onSubmit={(event) => void search(event)}>
        <label>
          <span>Search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="register, vendor term, transcript topic" />
        </label>
        <div className="documentation-search-filters">
          <label><span>Mode</span><select value={searchMode} onChange={(event) => setSearchMode(event.target.value as SearchMode)}>{SEARCH_MODES.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label>
          <label><span>Source</span><select value={searchSourceType} onChange={(event) => setSearchSourceType(event.target.value)}><option value="">all sources</option>{SOURCE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <label><span>State</span><select value={searchState} onChange={(event) => setSearchState(event.target.value)}><option value="">all states</option>{SEARCH_STATES.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
          <label><span>Search Collection</span><input value={searchCollection} onChange={(event) => setSearchCollection(event.target.value)} placeholder="optional" /></label>
        </div>
        <ControlButton type="submit" tone="primary" disabled={busy || !query.trim()}>
          <Search size={15} /> Search
        </ControlButton>
      </form>

      <div className="documentation-grid">
        <section className="documentation-section">
          <h3>Results</h3>
          <div className="documentation-results">
            {results.length > 0 ? results.map((result) => (
              <article className="documentation-result" key={result.chunkId}>
                <div className="documentation-result-meta">
                  <strong>{result.title}</strong>
                  <span>{result.sourceType} · {result.locator} · {result.state}</span>
                </div>
                <p>{result.snippet}</p>
                <div className="documentation-result-actions">
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
            )) : <p className="documentation-empty">No results.</p>}
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
                <input type="file" onChange={(event) => setUploadValue(event.target.files?.[0])} />
              </label>
            ) : null}
            {mode === "upload" && uploadValue ? <p className="documentation-selected-file">{uploadValue.name} · {formatBytes(uploadValue.size)}</p> : null}
            {mode === "path" ? <label><span>Path</span><input value={pathValue} onChange={(event) => setPathValue(event.target.value)} placeholder="/path/to/datasheet.pdf or docs/" /></label> : null}
            {mode !== "path" ? <label><span>URL or URI</span><input value={urlValue} onChange={(event) => setUrlValue(event.target.value)} placeholder="https://vendor.example/doc or https://youtube.com/watch?v=..." /></label> : null}
            <label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional title" /></label>
            <label><span>Type</span><select value={sourceType} onChange={(event) => setSourceType(event.target.value)}>{INGEST_SOURCE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
            <label><span>Collection</span><input value={collection} onChange={(event) => setCollection(event.target.value)} placeholder="project, vendor, board" /></label>
            {mode === "text" ? <label><span>Text</span><textarea value={textValue} onChange={(event) => setTextValue(event.target.value)} rows={5} /></label> : null}
            {mode === "url" && sourceType === "media" ? <label><span>Transcript</span><textarea value={transcriptValue} onChange={(event) => setTranscriptValue(event.target.value)} rows={4} placeholder="Optional transcript text. Leave empty to let the indexer try transcript fetching." /></label> : null}
            <ControlButton type="submit" tone="primary" disabled={busy || !ingestReady(mode, uploadValue, pathValue, urlValue, textValue)}>
              <FilePlus size={15} /> Add
            </ControlButton>
          </form>
        </section>
      </div>

      <section className="documentation-section documentation-documents">
        <h3>Active Documents</h3>
        {visibleDocuments.length > 0 ? (
          <div className="documentation-document-list">
            {visibleDocuments.map((document) => (
              <div className="documentation-document-row" key={documentId(document)}>
                <span>{document.title ?? documentId(document)}</span>
                <small>{document.source_type ?? document.sourceType} · {document.chunk_count ?? document.chunkCount ?? 0} chunks</small>
              </div>
            ))}
          </div>
        ) : <p className="documentation-empty">No active documents.</p>}
      </section>

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

function compactInput(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== ""));
}

function numberStat(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function documentId(document: DocumentationRecord): string {
  return document.document_id ?? document.documentId ?? "";
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "source";
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

export default DocumentationPanel;

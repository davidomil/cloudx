import type { DocumentationClient, DocumentationPendingEnrichment } from "./DocumentationClient.js";
import type { DocumentationEnrichmentService } from "./DocumentationEnrichmentService.js";

const POLL_INTERVAL_MS = 30_000;

export class DocumentationBackgroundEnrichment {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly controller = new AbortController();
  private paused = false;

  constructor(
    private readonly client: DocumentationClient,
    private readonly enrichment: DocumentationEnrichmentService,
    private readonly reportError: (error: unknown) => void
  ) {}

  start(): void {
    if (!this.timer && !this.running && !this.controller.signal.aborted && !this.paused) {
      this.schedule(0);
    }
  }

  async dispose(): Promise<void> {
    this.controller.abort(new Error("Documentation background enrichment was stopped."));
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.drain().catch((error) => {
        if (!this.controller.signal.aborted) this.reportError(error);
      }).finally(() => {
        this.running = undefined;
        if (!this.controller.signal.aborted && !this.paused) this.schedule(POLL_INTERVAL_MS);
      });
    }, delay);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    const signal = this.controller.signal;
    const active = new Map<string, Promise<void>>();
    let stopped = false;
    const canAdmit = () => !stopped && !this.paused && !signal.aborted && this.enrichment.isEnabled();
    try {
      while (canAdmit()) {
        const alreadyAdmitted = new Set(active.keys());
        const documents = await this.client.pendingEnrichments(this.enrichment.concurrency, { signal });
        for (const document of documents) {
          if (!canAdmit() || active.size >= this.enrichment.concurrency) break;
          if (alreadyAdmitted.has(document.documentId) || active.has(document.documentId)) continue;
          const task = this.enrichDocument(document).then((outcome) => {
            if (outcome === "unchanged") stopped = true;
          }).catch((error) => {
            stopped = true;
            if (!signal.aborted) this.reportError(error);
          }).finally(() => active.delete(document.documentId));
          active.set(document.documentId, task);
        }
        if (!active.size) return;
        await Promise.race(active.values());
      }
    } finally {
      await Promise.all(active.values());
    }
  }

  private async enrichDocument(document: DocumentationPendingEnrichment): Promise<"terminal" | "unchanged"> {
    const signal = this.controller.signal;
    const response = await this.enrichment.enrichIngestResponse({ document }, {}, { signal, onlyPending: true });
    signal.throwIfAborted();
    const result = enrichmentResult(response);
    if (!result || result.status === "unchanged") return "unchanged";
    if (result.status === "written") return "terminal";
    if (result.status !== "failed" && result.status !== "skipped") {
      throw new Error("Unexpected background enrichment outcome.");
    }
    const error = String(result.error ?? result.reason ?? "No enrichment was written.").slice(0, 4_000);
    try {
      await this.client.recordEnrichmentOutcome(document.documentId, {
        extractionRevision: document.extractionRevision, status: result.status, error
      }, { signal });
    } catch (failure) {
      this.paused = true;
      throw failure;
    }
    this.reportError(new Error(`Background enrichment ${result.status} for ${document.documentId}: ${error}`));
    return "terminal";
  }
}

function enrichmentResult(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const enrichment = response.enrichment;
  if (!enrichment || typeof enrichment !== "object" || !("results" in enrichment) || !Array.isArray(enrichment.results)) return undefined;
  const result: unknown = enrichment.results[0];
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
}

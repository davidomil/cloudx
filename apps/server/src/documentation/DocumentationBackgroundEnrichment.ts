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
    const unchanged = new Map<string, string>();
    let stopped = false;
    const canAdmit = () => !stopped && !this.paused && !signal.aborted && this.enrichment.isEnabled();
    try {
      while (canAdmit()) {
        const alreadyAdmitted = new Set(active.keys());
        const limit = Math.min(100, this.enrichment.concurrency + unchanged.size);
        const documents = await this.client.pendingEnrichments(limit, { signal });
        for (const document of documents) {
          if (!canAdmit() || active.size >= this.enrichment.concurrency) break;
          if (alreadyAdmitted.has(document.documentId) || active.has(document.documentId)) continue;
          if (unchanged.get(document.documentId) === document.extractionRevision) continue;
          const task = this.enrichDocument(document).then((outcome) => {
            if (outcome === "unchanged") unchanged.set(document.documentId, document.extractionRevision);
          }).catch((error) => {
            stopped = true;
            if (!signal.aborted) this.reportError(error);
          }).finally(() => active.delete(document.documentId));
          active.set(document.documentId, task);
        }
        if (!active.size || !canAdmit()) return;
        await this.waitForCompletionOrDiscovery(active);
      }
    } finally {
      await Promise.all(active.values());
    }
  }

  private async waitForCompletionOrDiscovery(active: Map<string, Promise<void>>): Promise<void> {
    if (active.size >= this.enrichment.concurrency) {
      await Promise.race(active.values());
      return;
    }
    const signal = this.controller.signal;
    let wake!: () => void;
    const poll = new Promise<void>((resolve) => {
      wake = resolve;
      this.timer = setTimeout(resolve, POLL_INTERVAL_MS);
      this.timer.unref();
      signal.addEventListener("abort", wake, { once: true });
    });
    try {
      await Promise.race([...active.values(), poll]);
    } finally {
      clearTimeout(this.timer);
      this.timer = undefined;
      signal.removeEventListener("abort", wake);
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

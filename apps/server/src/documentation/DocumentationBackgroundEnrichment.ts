import type { DocumentationClient } from "./DocumentationClient.js";
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
    while (!signal.aborted && this.enrichment.isEnabled()) {
      const document = await this.client.nextPendingEnrichment({ signal });
      if (!document || !this.enrichment.isEnabled()) return;
      signal.throwIfAborted();
      const response = await this.enrichment.enrichIngestResponse({ document }, {}, { signal, onlyPending: true });
      signal.throwIfAborted();
      const result = enrichmentResult(response);
      if (!result || result.status === "unchanged") return;
      if (result.status === "written") continue;
      if (result.status !== "failed" && result.status !== "skipped") {
        throw new Error("Unexpected background enrichment outcome.");
      }
      const error = String(result.error ?? result.reason ?? "No enrichment was written.").slice(0, 4_000);
      // If recording fails, stop admission so the model is not run again without a durable outcome.
      this.paused = true;
      await this.client.recordEnrichmentOutcome(document.documentId, {
        extractionRevision: document.extractionRevision, status: result.status, error
      }, { signal });
      this.paused = false;
      this.reportError(new Error(`Background enrichment ${result.status} for ${document.documentId}: ${error}`));
    }
  }
}

function enrichmentResult(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const enrichment = response.enrichment;
  if (!enrichment || typeof enrichment !== "object" || !("results" in enrichment) || !Array.isArray(enrichment.results)) return undefined;
  const result: unknown = enrichment.results[0];
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
}

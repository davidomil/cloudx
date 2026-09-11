import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentationBackgroundEnrichment } from "./DocumentationBackgroundEnrichment.js";
import type { DocumentationClient } from "./DocumentationClient.js";
import type { DocumentationEnrichmentService } from "./DocumentationEnrichmentService.js";

describe("DocumentationBackgroundEnrichment", () => {
  const workers: DocumentationBackgroundEnrichment[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.dispose()));
    vi.useRealTimers();
  });

  it("drains existing pending documents in order without overlapping enrichment", async () => {
    const { worker, client, enrichment, reportError } = fixture();
    const first = deferred<Record<string, unknown>>();
    client.nextPendingEnrichment
      .mockResolvedValueOnce(document("first"))
      .mockResolvedValueOnce(document("second"));
    enrichment.enrichIngestResponse.mockReturnValueOnce(first.promise);

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(1);
    expect(enrichment.enrichIngestResponse).toHaveBeenCalledExactlyOnceWith(
      { document: document("first") }, {}, { signal: expect.any(AbortSignal), onlyPending: true }
    );
    await vi.advanceTimersByTimeAsync(90_000);
    expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(1);

    first.resolve(outcome("written"));
    await vi.advanceTimersByTimeAsync(0);

    expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(3);
    expect(enrichment.enrichIngestResponse.mock.calls.map(([input]) => input.document)).toEqual([
      document("first"), document("second")
    ]);
    expect(client.recordEnrichmentOutcome).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("discovers imports added after the startup drain on the next poll", async () => {
    const { worker, client, enrichment } = fixture();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(enrichment.enrichIngestResponse).not.toHaveBeenCalled();

    client.nextPendingEnrichment.mockResolvedValueOnce(document("new-import"));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(enrichment.enrichIngestResponse).toHaveBeenCalledExactlyOnceWith(
      { document: document("new-import") }, {}, { signal: expect.any(AbortSignal), onlyPending: true }
    );
    expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(3);
  });

  it("does no archive or model work while disabled and discovers pending work when enabled", async () => {
    const { worker, client, enrichment } = fixture();
    enrichment.isEnabled.mockReturnValue(false);
    client.nextPendingEnrichment.mockResolvedValueOnce(document("pending"));
    worker.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.nextPendingEnrichment).not.toHaveBeenCalled();
    expect(enrichment.enrichIngestResponse).not.toHaveBeenCalled();

    enrichment.isEnabled.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(1);
    expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(2);
  });

  it("checks whether enrichment was disabled while discovery was running", async () => {
    const { worker, client, enrichment } = fixture();
    const pending = deferred<Awaited<ReturnType<DocumentationClient["nextPendingEnrichment"]>>>();
    client.nextPendingEnrichment.mockReturnValueOnce(pending.promise);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    enrichment.isEnabled.mockReturnValue(false);
    pending.resolve(document("pending"));
    await vi.advanceTimersByTimeAsync(0);

    expect(enrichment.enrichIngestResponse).not.toHaveBeenCalled();
  });

  it("keeps one scheduled poll and one drain when start is called repeatedly", async () => {
    const { worker, client, enrichment } = fixture();
    const first = deferred<Record<string, unknown>>();
    client.nextPendingEnrichment.mockResolvedValueOnce(document("pending"));
    enrichment.enrichIngestResponse.mockReturnValueOnce(first.promise);

    worker.start();
    worker.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    worker.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(1);
    expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(1);

    first.resolve(outcome("written"));
    await vi.advanceTimersByTimeAsync(0);
    worker.start();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    { status: "failed", detail: { error: "Model request failed." }, error: "Model request failed." },
    { status: "skipped", detail: { reason: "No usable source evidence." }, error: "No usable source evidence." }
  ])("records a terminal $status outcome before admitting another document", async ({ status, detail, error }) => {
    const { worker, client, enrichment, reportError } = fixture();
    const recorded = deferred<Record<string, unknown>>();
    client.nextPendingEnrichment
      .mockResolvedValueOnce(document("unavailable"))
      .mockResolvedValueOnce(document("next"));
    enrichment.enrichIngestResponse.mockResolvedValueOnce(outcome(status, detail));
    client.recordEnrichmentOutcome.mockReturnValueOnce(recorded.promise);

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.recordEnrichmentOutcome).toHaveBeenCalledExactlyOnceWith(
      "unavailable", { extractionRevision: document("unavailable").extractionRevision, status, error }, { signal: expect.any(AbortSignal) }
    );
    expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();

    recorded.resolve({});
    await vi.advanceTimersByTimeAsync(0);

    expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: `Background enrichment ${status} for unavailable: ${error}`
    }));
  });

  it("bounds a stored failure and stops admitting work when the outcome cannot be persisted", async () => {
    const { worker, client, enrichment, reportError } = fixture();
    const failure = new Error("Archive write failed.");
    client.nextPendingEnrichment.mockResolvedValue(document("pending"));
    enrichment.enrichIngestResponse.mockResolvedValue(outcome("failed", { error: "x".repeat(5_000) }));
    client.recordEnrichmentOutcome.mockRejectedValue(failure);

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    worker.start();
    await vi.advanceTimersByTimeAsync(90_000);

    expect(client.recordEnrichmentOutcome).toHaveBeenCalledExactlyOnceWith(
      "pending", { extractionRevision: document("pending").extractionRevision, status: "failed", error: "x".repeat(4_000) }, { signal: expect.any(AbortSignal) }
    );
    expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(1);
    expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a discovery failure and discovers pending work on a later poll", async () => {
    const { worker, client, enrichment, reportError } = fixture();
    const failure = new Error("Documentation service is unavailable.");
    client.nextPendingEnrichment
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(document("pending"));

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(enrichment.enrichIngestResponse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { enrichment: { results: [] } }, outcome("unchanged")])(
    "ends the drain when a document produces no new terminal outcome: %j",
    async (response) => {
      const { worker, client, enrichment } = fixture();
      client.nextPendingEnrichment.mockResolvedValue(document("pending"));
      enrichment.enrichIngestResponse.mockResolvedValue(response);
      worker.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(1);
      expect(client.recordEnrichmentOutcome).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    }
  );

  it.each(["discovery", "enrichment", "outcome"] as const)(
    "aborts active %s and waits for its cleanup before disposal finishes",
    async (stage) => {
      const { worker, client, enrichment, reportError } = fixture();
      const cleanup = deferred<void>();
      let activeSignal: AbortSignal | undefined;
      function holdUntilCleanup(signal: AbortSignal | undefined): Promise<never> {
        activeSignal = signal;
        return new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => {
            void cleanup.promise.then(() => reject(signal!.reason));
          }, { once: true });
        });
      }
      client.nextPendingEnrichment.mockResolvedValue(document("pending"));
      if (stage === "discovery") {
        client.nextPendingEnrichment.mockImplementationOnce((options) => holdUntilCleanup(options?.signal));
      } else if (stage === "enrichment") {
        enrichment.enrichIngestResponse.mockImplementationOnce((_input, _source, options) => holdUntilCleanup(options?.signal));
      } else {
        enrichment.enrichIngestResponse.mockResolvedValueOnce(outcome("failed", { error: "Model failed." }));
        client.recordEnrichmentOutcome.mockImplementationOnce((_id, _outcome, options) => holdUntilCleanup(options?.signal));
      }

      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      let disposed = false;
      const disposal = worker.dispose().then(() => { disposed = true; });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(activeSignal?.aborted).toBe(true);
        expect(disposed).toBe(false);
      } finally {
        cleanup.resolve();
        await disposal;
      }

      worker.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(disposed).toBe(true);
      expect(client.nextPendingEnrichment).toHaveBeenCalledTimes(1);
      expect(reportError).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("cancels startup before it begins and never restarts a disposed worker", async () => {
    const { worker, client } = fixture();
    worker.start();
    await worker.dispose();
    worker.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.nextPendingEnrichment).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  function fixture() {
    const client = {
      nextPendingEnrichment: vi.fn<DocumentationClient["nextPendingEnrichment"]>().mockResolvedValue(undefined),
      recordEnrichmentOutcome: vi.fn<DocumentationClient["recordEnrichmentOutcome"]>().mockResolvedValue({})
    };
    const enrichment = {
      isEnabled: vi.fn(() => true),
      enrichIngestResponse: vi.fn<DocumentationEnrichmentService["enrichIngestResponse"]>().mockResolvedValue(outcome("written"))
    };
    const reportError = vi.fn();
    const worker = new DocumentationBackgroundEnrichment(
      client as unknown as DocumentationClient,
      enrichment as unknown as DocumentationEnrichmentService,
      reportError
    );
    workers.push(worker);
    return { worker, client, enrichment, reportError };
  }
});

function document(documentId: string) {
  return { documentId, title: `${documentId} source`, extractionRevision: "e".repeat(32) };
}

function outcome(status: string, details: Record<string, unknown> = {}) {
  return { enrichment: { results: [{ status, ...details }] } };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

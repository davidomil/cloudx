import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentationBackgroundEnrichment } from "./DocumentationBackgroundEnrichment.js";
import type { DocumentationClient } from "./DocumentationClient.js";
import { DocumentationEnrichmentService, type DocumentationEnrichmentRunner } from "./DocumentationEnrichmentService.js";

describe("DocumentationBackgroundEnrichment", () => {
  const workers: DocumentationBackgroundEnrichment[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.dispose()));
    vi.useRealTimers();
  });

  it("enriches a bounded number of documents and refills when a later document finishes first", async () => {
    const { worker, client, enrichment, reportError } = fixture();
    const first = deferred<Record<string, unknown>>();
    const second = deferred<Record<string, unknown>>();
    const third = deferred<Record<string, unknown>>();
    client.pendingEnrichments
      .mockResolvedValueOnce([document("first"), document("second")])
      .mockResolvedValueOnce([document("first"), document("third")])
      .mockResolvedValueOnce([document("first")]);
    enrichment.enrichIngestResponse
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(enrichedIds(enrichment)).toEqual(["first", "second"]);
      expect(client.pendingEnrichments).toHaveBeenCalledExactlyOnceWith(2, { signal: expect.any(AbortSignal) });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(1);

      second.resolve(outcome("written"));
      await vi.advanceTimersByTimeAsync(0);
      expect(enrichedIds(enrichment)).toEqual(["first", "second", "third"]);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(2);

      third.resolve(outcome("written"));
      await vi.advanceTimersByTimeAsync(0);
      expect(enrichedIds(enrichment)).toEqual(["first", "second", "third"]);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(3);
    } finally {
      first.resolve(outcome("written"));
      second.resolve(outcome("written"));
      third.resolve(outcome("written"));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(client.pendingEnrichments).toHaveBeenCalledTimes(4);
    expect(client.recordEnrichmentOutcome).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not reschedule an active document whose completion overlaps discovery", async () => {
    const { worker, client, enrichment } = fixture();
    const first = deferred<Record<string, unknown>>();
    const discovery = deferred<Awaited<ReturnType<DocumentationClient["pendingEnrichments"]>>>();
    client.pendingEnrichments
      .mockResolvedValueOnce([document("first"), document("second")])
      .mockReturnValueOnce(discovery.promise);
    enrichment.enrichIngestResponse.mockReturnValueOnce(first.promise);

    worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(2);
      first.resolve(outcome("written"));
      await vi.advanceTimersByTimeAsync(0);
      discovery.resolve([document("first"), document("third")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(enrichedIds(enrichment)).toEqual(["first", "second", "third"]);
    } finally {
      first.resolve(outcome("written"));
      discovery.resolve([]);
    }
  });

  it("starts a newly imported document on the next poll while an earlier document remains active", async () => {
    const { worker, client, started, importDocument, finish } = productionFixture();
    importDocument("slow");
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["slow"]);

    importDocument("new");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(started).toEqual(["slow"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(["slow", "new"]);
    expect(client.enrichDocument).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    finish("new");
    await vi.advanceTimersByTimeAsync(0);
    expect(client.enrichDocument).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ documentId: "new" }), { signal: expect.any(AbortSignal) });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("starts the next document after a foreground duplicate becomes unchanged while its sibling remains active", async () => {
    const { worker, client, enrichment, started, importDocument, finish, reportError } = productionFixture();
    for (const id of ["duplicate", "slow", "next"]) importDocument(id);
    const foreground = enrichment.enrichIngestResponse({ document: document("duplicate") });
    await vi.advanceTimersByTimeAsync(0);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["duplicate", "slow"]);

    finish("duplicate");
    await foreground;
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["duplicate", "slow", "next"]);
    expect(client.enrichDocument).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ documentId: "duplicate" }));
    expect(reportError).not.toHaveBeenCalled();
  });

  it("cancels the spare-capacity discovery timer and active enrichment when disposed", async () => {
    const { worker, client, started, importDocument, reportError } = productionFixture();
    importDocument("slow");
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["slow"]);
    expect(vi.getTimerCount()).toBe(1);

    await worker.dispose();
    importDocument("new");
    worker.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(started).toEqual(["slow"]);
    expect(client.pendingEnrichments).toHaveBeenCalledTimes(1);
    expect(client.enrichDocument).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discovers imports added after the startup drain on the next poll", async () => {
    const { worker, client, enrichment } = fixture();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(enrichment.enrichIngestResponse).not.toHaveBeenCalled();

    client.pendingEnrichments.mockResolvedValueOnce([document("new-import")]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.pendingEnrichments).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(enrichment.enrichIngestResponse).toHaveBeenCalledExactlyOnceWith(
      { document: document("new-import") }, {}, { signal: expect.any(AbortSignal), onlyPending: true }
    );
    expect(client.pendingEnrichments).toHaveBeenCalledTimes(3);
  });

  it("does no archive or model work while disabled and discovers pending work when enabled", async () => {
    const { worker, client, enrichment } = fixture();
    enrichment.isEnabled.mockReturnValue(false);
    client.pendingEnrichments.mockResolvedValueOnce([document("pending")]);
    worker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.pendingEnrichments).not.toHaveBeenCalled();
    expect(enrichment.enrichIngestResponse).not.toHaveBeenCalled();

    enrichment.isEnabled.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(1);
    expect(client.pendingEnrichments).toHaveBeenCalledTimes(2);
  });

  it("checks whether enrichment was disabled while discovery was running", async () => {
    const { worker, client, enrichment } = fixture();
    const pending = deferred<Awaited<ReturnType<DocumentationClient["pendingEnrichments"]>>>();
    client.pendingEnrichments.mockReturnValueOnce(pending.promise);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    enrichment.isEnabled.mockReturnValue(false);
    pending.resolve([document("first"), document("second")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(enrichment.enrichIngestResponse).not.toHaveBeenCalled();
  });

  it("checks enabled state before every admission in a discovered batch", async () => {
    const { worker, client, enrichment } = fixture();
    client.pendingEnrichments.mockResolvedValueOnce([document("first"), document("second")]);
    enrichment.enrichIngestResponse.mockImplementationOnce(async () => {
      enrichment.isEnabled.mockReturnValue(false);
      return outcome("written");
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(enrichedIds(enrichment)).toEqual(["first"]);
  });

  it("keeps one scheduled poll and one drain when start is called repeatedly", async () => {
    const { worker, client, enrichment } = fixture();
    const first = deferred<Record<string, unknown>>();
    client.pendingEnrichments.mockResolvedValueOnce([document("pending")]);
    enrichment.enrichIngestResponse.mockReturnValueOnce(first.promise);
    worker.start();
    worker.start();
    try {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      worker.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(3);
      expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      first.resolve(outcome("written"));
    }
    await vi.advanceTimersByTimeAsync(0);
    worker.start();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    { status: "failed", detail: { error: "Model request failed." }, error: "Model request failed." },
    { status: "skipped", detail: { reason: "No usable source evidence." }, error: "No usable source evidence." }
  ])("holds a $status document's slot until its outcome is recorded while other work continues", async ({ status, detail, error }) => {
    const { worker, client, enrichment, reportError } = fixture();
    const recorded = deferred<Record<string, unknown>>();
    const healthy = deferred<Record<string, unknown>>();
    client.pendingEnrichments
      .mockResolvedValueOnce([document("unavailable"), document("healthy")])
      .mockResolvedValueOnce([document("healthy"), document("next")]);
    enrichment.enrichIngestResponse
      .mockResolvedValueOnce(outcome(status, detail))
      .mockReturnValueOnce(healthy.promise);
    client.recordEnrichmentOutcome.mockReturnValueOnce(recorded.promise);
    worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(enrichedIds(enrichment)).toEqual(["unavailable", "healthy"]);
      expect(client.recordEnrichmentOutcome).toHaveBeenCalledExactlyOnceWith(
        "unavailable", { extractionRevision: document("unavailable").extractionRevision, status, error }, { signal: expect.any(AbortSignal) }
      );
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(1);
      expect(reportError).not.toHaveBeenCalled();

      recorded.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      expect(enrichedIds(enrichment)).toEqual(["unavailable", "healthy", "next"]);
      expect(reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        message: `Background enrichment ${status} for unavailable: ${error}`
      }));
    } finally {
      recorded.resolve({});
      healthy.resolve(outcome("written"));
    }
  });

  it("permanently pauses after an outcome write fails even when another outcome is later stored", async () => {
    const { worker, client, enrichment, reportError } = fixture();
    const recorded = deferred<Record<string, unknown>>();
    const failure = new Error("Archive write failed.");
    client.pendingEnrichments.mockResolvedValueOnce([document("first"), document("second")]);
    enrichment.enrichIngestResponse.mockResolvedValue(outcome("failed", { error: "x".repeat(5_000) }));
    client.recordEnrichmentOutcome.mockRejectedValueOnce(failure).mockReturnValueOnce(recorded.promise);
    worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(client.recordEnrichmentOutcome).toHaveBeenNthCalledWith(1,
        "first", { extractionRevision: document("first").extractionRevision, status: "failed", error: "x".repeat(4_000) }, { signal: expect.any(AbortSignal) }
      );
      expect(reportError).toHaveBeenCalledWith(failure);
      recorded.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      worker.start();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(1);
      expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      recorded.resolve({});
    }
  });

  it("reports a discovery failure and discovers pending work on a later poll", async () => {
    const { worker, client, enrichment, reportError } = fixture();
    const failure = new Error("Documentation service is unavailable.");
    client.pendingEnrichments.mockRejectedValueOnce(failure).mockResolvedValueOnce([document("pending")]);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(enrichment.enrichIngestResponse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(1);
  });

  it.each(["discovery", "unexpected outcome"] as const)("waits for active documents before scheduling after a %s failure", async (stage) => {
    const { worker, client, enrichment, reportError } = fixture();
    const active = deferred<Record<string, unknown>>();
    client.pendingEnrichments.mockResolvedValueOnce([document("active"), document("finishing")]);
    enrichment.enrichIngestResponse.mockReturnValueOnce(active.promise);
    if (stage === "discovery") {
      client.pendingEnrichments.mockRejectedValueOnce(new Error("Discovery failed."));
    } else {
      enrichment.enrichIngestResponse.mockResolvedValueOnce(outcome("unexpected"));
    }
    worker.start();
    try {
      await vi.advanceTimersByTimeAsync(90_000);
      worker.start();
      expect(enrichedIds(enrichment)).toEqual(["active", "finishing"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      active.resolve(outcome("written"));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([{}, { enrichment: { results: [] } }, outcome("unchanged")])(
    "does not repeat a candidate that produces no new terminal outcome in the same drain: %j",
    async (response) => {
      const { worker, client, enrichment } = fixture();
      client.pendingEnrichments.mockResolvedValue([document("pending")]);
      enrichment.enrichIngestResponse.mockResolvedValue(response);
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(2);
      expect(enrichment.enrichIngestResponse).toHaveBeenCalledTimes(1);
      expect(client.recordEnrichmentOutcome).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    }
  );

  it("discovers siblings beyond an unchanged candidate without repeatedly enriching it", async () => {
    const { worker, client, enrichment } = fixture();
    const slow = deferred<Record<string, unknown>>();
    const next = deferred<Record<string, unknown>>();
    client.pendingEnrichments.mockImplementation(async (limit) => [document("unchanged"), document("slow"), document("next")].slice(0, limit));
    enrichment.enrichIngestResponse
      .mockResolvedValueOnce(outcome("unchanged"))
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(next.promise);
    worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(enrichedIds(enrichment)).toEqual(["unchanged", "slow", "next"]);
      expect(client.pendingEnrichments).toHaveBeenNthCalledWith(2, 3, { signal: expect.any(AbortSignal) });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(2);
      expect(enrichedIds(enrichment)).toEqual(["unchanged", "slow", "next"]);
    } finally {
      client.pendingEnrichments.mockResolvedValue([]);
      slow.resolve(outcome("written"));
      next.resolve(outcome("written"));
    }
  });

  it("admits a replacement extraction for an unchanged candidate while another document remains active", async () => {
    const { worker, client, enrichment } = fixture();
    const slow = deferred<Record<string, unknown>>();
    let candidate = document("pending");
    client.pendingEnrichments.mockImplementation(async () => [candidate, document("slow")]);
    enrichment.enrichIngestResponse
      .mockResolvedValue(outcome("unchanged"))
      .mockResolvedValueOnce(outcome("unchanged"))
      .mockReturnValueOnce(slow.promise);
    worker.start();
    try {
      await vi.advanceTimersByTimeAsync(90_000);
      expect(enrichedIds(enrichment)).toEqual(["pending", "slow"]);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(5);

      candidate = { ...candidate, extractionRevision: "f".repeat(32) };
      await vi.advanceTimersByTimeAsync(30_000);
      expect(enrichedIds(enrichment)).toEqual(["pending", "slow", "pending"]);
      expect(enrichment.enrichIngestResponse).toHaveBeenLastCalledWith({ document: candidate }, {}, { signal: expect.any(AbortSignal), onlyPending: true });
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      client.pendingEnrichments.mockResolvedValue([]);
      slow.resolve(outcome("written"));
    }
  });

  it.each(["discovery", "enrichment", "outcome"] as const)(
    "aborts all active %s work and awaits every cleanup before disposal finishes",
    async (stage) => {
      const { worker, client, enrichment, reportError } = fixture();
      const cleanups = [deferred<void>(), deferred<void>()];
      const activeSignals: AbortSignal[] = [];
      function holdUntilCleanup(signal: AbortSignal | undefined): Promise<never> {
        const cleanup = cleanups[activeSignals.length]!;
        activeSignals.push(signal!);
        return new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => {
            void cleanup.promise.then(() => reject(signal!.reason));
          }, { once: true });
        });
      }
      client.pendingEnrichments.mockResolvedValueOnce([document("first"), document("second")]);
      if (stage === "discovery") {
        client.pendingEnrichments.mockReset().mockImplementationOnce((_limit, options) => holdUntilCleanup(options?.signal));
      } else if (stage === "enrichment") {
        enrichment.enrichIngestResponse.mockImplementation((_input, _source, options) => holdUntilCleanup(options?.signal));
      } else {
        enrichment.enrichIngestResponse.mockResolvedValue(outcome("failed", { error: "Model failed." }));
        client.recordEnrichmentOutcome.mockImplementation((_id, _outcome, options) => holdUntilCleanup(options?.signal));
      }
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      let disposed = false;
      const disposal = worker.dispose().then(() => { disposed = true; });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(activeSignals).toHaveLength(stage === "discovery" ? 1 : 2);
        expect(activeSignals.every((signal) => signal.aborted)).toBe(true);
        expect(disposed).toBe(false);
        if (stage !== "discovery") {
          cleanups[0]!.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(disposed).toBe(false);
        }
      } finally {
        for (const cleanup of cleanups) cleanup.resolve();
        await disposal;
      }
      worker.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(disposed).toBe(true);
      expect(client.pendingEnrichments).toHaveBeenCalledTimes(1);
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
    expect(client.pendingEnrichments).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  function fixture() {
    const client = {
      pendingEnrichments: vi.fn<DocumentationClient["pendingEnrichments"]>().mockResolvedValue([]),
      recordEnrichmentOutcome: vi.fn<DocumentationClient["recordEnrichmentOutcome"]>().mockResolvedValue({})
    };
    const enrichment = {
      concurrency: 2,
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

  function productionFixture() {
    const documents = new Map<string, ReturnType<typeof document>>();
    const written = new Set<string>();
    const completions = new Map<string, (output: unknown) => void>();
    const started: string[] = [];
    const client = {
      health: vi.fn<DocumentationClient["health"]>().mockResolvedValue({}),
      pendingEnrichments: vi.fn<DocumentationClient["pendingEnrichments"]>(async (limit) =>
        [...documents.values()].filter(({ documentId }) => !written.has(documentId)).slice(0, limit)),
      getDocument: vi.fn<DocumentationClient["getDocument"]>(async (input) => {
        const documentId = String(input.documentId);
        return { document: {
          document_id: documentId,
          state: "active",
          extraction_revision: document(documentId).extractionRevision,
          chunks: [{ chunk_origin: written.has(documentId) ? "ai" : "source", locator: "text", text: `Evidence for ${documentId}.` }]
        } };
      }),
      enrichDocument: vi.fn<DocumentationClient["enrichDocument"]>(async ({ documentId }) => {
        written.add(documentId);
        return {};
      })
    };
    const runner: DocumentationEnrichmentRunner = {
      model: "test-model",
      run(prompt, { signal } = {}) {
        const id = /Evidence for (\w+)\./u.exec(prompt)?.[1];
        if (!id) throw new Error("Missing document evidence in model prompt.");
        started.push(id);
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal!.reason);
          signal?.addEventListener("abort", abort, { once: true });
          completions.set(id, (output) => {
            signal?.removeEventListener("abort", abort);
            resolve(output);
          });
        });
      }
    };
    const enrichment = new DocumentationEnrichmentService({
      client: client as unknown as DocumentationClient,
      config: { isAiControlEnabled: () => true, getPluginConfig: () => ({ aiEnrichmentEnabled: true, aiEnrichmentSkillIds: "test-skill" }) } as never,
      rulesSkills: { list: async () => ({ skills: [{ id: "test-skill", instructions: "Summarize source evidence." }], systemSkills: [] }) } as never,
      runner
    });
    const reportError = vi.fn();
    const worker = new DocumentationBackgroundEnrichment(client as unknown as DocumentationClient, enrichment, reportError);
    workers.push(worker);
    return {
      worker, client, enrichment, started, reportError,
      importDocument(id: string) { documents.set(id, document(id)); },
      finish(id: string) { completions.get(id)!({ summary: "Source summary", spans: [{ locator: "ai:metadata", text: `Enriched ${id}.` }], metadata: [], warnings: [] }); }
    };
  }

  function enrichedIds(enrichment: ReturnType<typeof fixture>["enrichment"]) {
    return enrichment.enrichIngestResponse.mock.calls.map(([input]) => (input.document as { documentId: string }).documentId);
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

import { describe, expect, it } from "vitest";

import { DocumentationIngestQueue, type DocumentationIngestQueueOperationContext } from "./DocumentationIngestQueue.js";

describe("DocumentationIngestQueue scheduling", () => {
  it("starts two imports by default and keeps their progress independent", async () => {
    const queue = new DocumentationIngestQueue();
    const imports = [deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>()];
    const contexts: DocumentationIngestQueueOperationContext[] = [];
    const executions = imports.map((imported, index) => queue.enqueue({
      ...job(1),
      label: `Import ${index + 1}`,
      operation: (context) => {
        contexts.push(context);
        return imported.promise;
      }
    }));
    await flushPromises();

    expect(contexts).toHaveLength(2);
    contexts[0]!.update({ progress: 20, stage: "Reading first import" });
    contexts[1]!.update({ progress: 60, stage: "Extracting second import" });
    expect(queue.list().jobs).toMatchObject([
      { label: "Import 1", status: "running", position: 0, progress: 20, stage: "Reading first import" },
      { label: "Import 2", status: "running", position: 0, progress: 60, stage: "Extracting second import" }
    ]);

    imports.forEach((imported, index) => imported.resolve({ index }));
    await expect(Promise.all(executions)).resolves.toEqual([{ index: 0 }, { index: 1 }]);
  });

  it("refills each free slot in waiting order without exceeding configured concurrency", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 5, maxBytes: 100, concurrency: 3 });
    const imports = Array.from({ length: 5 }, () => deferred<Record<string, unknown>>());
    const started: number[] = [];
    const executions = imports.map((imported, index) => queue.enqueue({
      ...job(1),
      label: `Import ${index + 1}`,
      operation: () => {
        started.push(index);
        return imported.promise;
      }
    }));
    await flushPromises();

    expect(started).toEqual([0, 1, 2]);
    expect(queue.list().jobs.map(({ status, position }) => ({ status, position }))).toEqual([
      { status: "running", position: 0 },
      { status: "running", position: 0 },
      { status: "running", position: 0 },
      { status: "queued", position: 1 },
      { status: "queued", position: 2 }
    ]);

    imports[1]!.resolve({});
    await executions[1];
    await flushPromises();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(queue.list().jobs.filter(({ status }) => status === "running")).toHaveLength(3);
    expect(queue.list().jobs[4]).toMatchObject({ status: "queued", position: 1 });

    imports[3]!.resolve({});
    await executions[3];
    await flushPromises();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(queue.list().jobs.filter(({ status }) => status === "running")).toHaveLength(3);

    imports.forEach((imported) => imported.resolve({}));
    await Promise.all(executions);
  });

  it("allows one active import when concurrency is one", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 2, maxBytes: 100, concurrency: 1 });
    const imported = deferred<Record<string, unknown>>();
    const first = queue.enqueue(job(1, () => imported.promise));
    const second = queue.enqueue(job(1));
    await flushPromises();

    expect(queue.list().jobs.map(({ status }) => status)).toEqual(["running", "queued"]);
    imported.resolve({});
    await Promise.all([first, second]);
  });

  it("starts the next waiting import after a failure while a sibling stays active", async () => {
    const queue = new DocumentationIngestQueue();
    const fail = deferred<void>();
    const sibling = deferred<Record<string, unknown>>();
    const next = deferred<Record<string, unknown>>();
    const failed = queue.enqueue(job(1, async () => {
      await fail.promise;
      throw new Error("Unreadable document");
    }));
    const failedImport = expect(failed).rejects.toThrow("Unreadable document");
    const running = queue.enqueue(job(1, () => sibling.promise));
    const waiting = queue.enqueue(job(1, () => next.promise));
    await flushPromises();

    fail.resolve();
    await failedImport;
    await flushPromises();
    expect(queue.list().jobs).toMatchObject([
      { status: "failed", error: "Unreadable document" },
      { status: "running" },
      { status: "running" }
    ]);

    sibling.resolve({ sibling: true });
    next.resolve({ next: true });
    await expect(Promise.all([running, waiting])).resolves.toEqual([{ sibling: true }, { next: true }]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid concurrency %s", (concurrency) => {
    expect(() => new DocumentationIngestQueue({ maxJobs: 8, maxBytes: 100, concurrency }))
      .toThrow("concurrency must be a positive safe integer");
  });
});

describe("DocumentationIngestQueue admission", () => {
  it("retains capacity for active, waiting, and reserved imports until each settles", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 4, maxBytes: 20 });
    const imports = Array.from({ length: 3 }, () => deferred<Record<string, unknown>>());
    const executions = imports.map((imported) => queue.enqueue(job(5, () => imported.promise)));
    const reserved = queue.reserve(5);
    await flushPromises();

    expect(queue.list().capacity).toMatchObject({ admittedJobs: 4, admittedBytes: 20, reservedJobs: 1 });
    expect(queue.list().jobs.map(({ status }) => status)).toEqual(["running", "running", "queued"]);
    expect(() => queue.reserve(1)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_INGEST_JOB_CAPACITY" }));

    imports[1]!.resolve({});
    await executions[1];
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 3, admittedBytes: 15, reservedJobs: 1 });
    expect(() => queue.reserve(6)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_INGEST_BYTE_CAPACITY" }));

    reserved.release();
    imports.forEach((imported) => imported.resolve({}));
    await Promise.all(executions);
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 0, admittedBytes: 0, reservedJobs: 0 });
  });

  it("rejects excess admitted jobs with a stable 429 contract", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 1, maxBytes: 100 });
    const running = deferred<Record<string, unknown>>();
    const first = queue.enqueue(job(10, () => running.promise));
    await flushPromises();

    await expect(Promise.resolve().then(() => queue.enqueue(job(10)))).rejects.toMatchObject({
      code: "DOCUMENTATION_INGEST_JOB_CAPACITY",
      statusCode: 429
    });
    expect(queue.list().jobs).toHaveLength(1);

    running.resolve({ first: true });
    await first;
    await expect(queue.enqueue(job(10))).resolves.toEqual({ ok: true });
  });

  it("rejects excess retained bytes with a stable 503 contract and releases bytes after completion", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 2, maxBytes: 5 });
    const running = deferred<Record<string, unknown>>();
    const first = queue.enqueue(job(4, () => running.promise));
    await flushPromises();

    await expect(Promise.resolve().then(() => queue.enqueue(job(2)))).rejects.toMatchObject({
      code: "DOCUMENTATION_INGEST_BYTE_CAPACITY",
      statusCode: 503
    });
    expect(queue.list().jobs).toHaveLength(1);

    running.resolve({ first: true });
    await first;
    await expect(queue.enqueue(job(5))).resolves.toEqual({ ok: true });
  });

  it("reserves capacity before request spooling and releases an abandoned reservation", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 1, maxBytes: 5 });
    const admission = queue.reserve(5);

    expect(queue.list().capacity).toEqual({
      admittedJobs: 1,
      admittedBytes: 5,
      reservedJobs: 1,
      maxJobs: 1,
      maxBytes: 5
    });

    expect(() => queue.reserve(1)).toThrow(expect.objectContaining({
      code: "DOCUMENTATION_INGEST_JOB_CAPACITY",
      statusCode: 429
    }));

    admission.release();
    const next = queue.reserve(5);
    next.release();
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 0, admittedBytes: 0, reservedJobs: 0 });
  });

  it("consumes one reservation for one exact-size queued operation", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 1, maxBytes: 5 });
    const admission = queue.reserve(5);

    await expect(queue.enqueueReserved(job(5), admission)).resolves.toEqual({ ok: true });
    expect(() => queue.enqueueReserved(job(5), admission)).toThrow(/already used/i);
    await expect(queue.enqueue(job(5))).resolves.toEqual({ ok: true });
  });

  it("aborts and awaits running work, releases reservations, and closes admission during disposal", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 2, maxBytes: 20 });
    const started = deferred<void>();
    const aborted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const running = queue.enqueue({
      ...job(8),
      operation: ({ signal }) => {
        started.resolve();
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted.resolve();
            void releaseCleanup.promise.then(() => reject(new Error("ingest stopped")));
          }, { once: true });
        });
      }
    });
    const runningRejection = expect(running).rejects.toThrow("ingest stopped");
    await started.promise;
    queue.reserve(7);

    let disposalSettled = false;
    const disposal = queue.dispose().then(() => {
      disposalSettled = true;
    });
    await aborted.promise;
    await flushPromises();

    expect(disposalSettled).toBe(false);
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 1, admittedBytes: 8, reservedJobs: 0 });

    releaseCleanup.resolve();
    await Promise.all([disposal, runningRejection]);
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 0, admittedBytes: 0, reservedJobs: 0 });
    expect(() => queue.reserve(1)).toThrow(/stopped/i);
  });

  it("owns and settles reserved pre-enqueue work before releasing capacity during disposal", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 1, maxBytes: 5 });
    const admission = queue.reserve(5);
    const started = deferred<void>();
    const cleanup = deferred<void>();
    let admissionSignal: AbortSignal | undefined;
    const preEnqueue = admission.runBeforeEnqueue(async (signal) => {
      admissionSignal = signal;
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", async () => {
          await cleanup.promise;
          reject(signal.reason);
        }, { once: true });
      });
      return "unreachable";
    });
    const preEnqueueRejection = expect(preEnqueue).rejects.toThrow("stopped");
    await started.promise;

    let disposalSettled = false;
    const disposal = queue.dispose().then(() => {
      disposalSettled = true;
    });
    await Promise.resolve();

    expect(admissionSignal?.aborted).toBe(true);
    expect(disposalSettled).toBe(false);
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 1, admittedBytes: 5, reservedJobs: 1 });

    cleanup.resolve();
    await Promise.all([preEnqueueRejection, disposal]);
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 0, admittedBytes: 0, reservedJobs: 0 });
    admission.release();
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 0, admittedBytes: 0, reservedJobs: 0 });
    expect(() => queue.enqueueReserved(job(5), admission)).toThrow(/already used|stopped/i);
  });

  it("aborts every active import, cancels waiting imports, and waits for all active cleanup", async () => {
    const queue = new DocumentationIngestQueue({ maxJobs: 4, maxBytes: 20 });
    const cleanup = [deferred<void>(), deferred<void>()];
    const signals: AbortSignal[] = [];
    const active = cleanup.map((releaseCleanup) => queue.enqueue({
      ...job(5),
      operation: ({ signal }) => {
        signals.push(signal);
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            void releaseCleanup.promise.then(() => reject(signal.reason));
          }, { once: true });
        });
      }
    }));
    let waitingStarted = false;
    const waiting = queue.enqueue(job(5, async () => {
      waitingStarted = true;
      return {};
    }));
    const rejections = [...active, waiting].map((execution) => expect(execution).rejects.toThrow("stopped"));
    queue.reserve(5);
    await flushPromises();
    expect(signals).toHaveLength(2);

    let disposed = false;
    const disposal = queue.dispose();
    void disposal.then(() => { disposed = true; });
    expect(queue.dispose()).toBe(disposal);
    await rejections[2];
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(waitingStarted).toBe(false);
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 2, admittedBytes: 10, reservedJobs: 0 });
    expect(() => queue.enqueue(job(1))).toThrow(/stopped/i);

    cleanup[0]!.resolve();
    await rejections[0];
    expect(disposed).toBe(false);
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 1, admittedBytes: 5 });

    cleanup[1]!.resolve();
    await Promise.all([disposal, ...rejections]);
    expect(queue.list().jobs.every(({ status }) => status === "failed")).toBe(true);
    expect(queue.list().capacity).toMatchObject({ admittedJobs: 0, admittedBytes: 0, reservedJobs: 0 });
  });
});

function job(admissionBytes: number, operation: () => Promise<Record<string, unknown>> = async () => ({ ok: true })) {
  return {
    kind: "text" as const,
    label: "Test import",
    admissionBytes,
    operation: () => operation()
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve as (value?: T) => void;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

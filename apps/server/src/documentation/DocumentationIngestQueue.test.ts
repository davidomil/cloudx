import { describe, expect, it } from "vitest";

import { DocumentationIngestQueue } from "./DocumentationIngestQueue.js";

describe("DocumentationIngestQueue admission", () => {
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

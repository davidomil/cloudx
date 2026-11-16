import type { UsageSnapshot } from "./usageRecord.js";

interface Discovery {
  controller: AbortController;
  consumers: Set<object>;
  result: Promise<UsageSnapshot>;
}

// Coalesces metadata discovery. The last consumer stops further discovery;
// transcript slices already submitted to the indexer have their own lifecycle.
export class UsageReadRequests {
  private readonly requests = new Map<string, Discovery>();
  private readonly discoveries = new Set<Discovery>();
  private disposed = false;

  read(key: string, discover: (signal: AbortSignal) => Promise<UsageSnapshot>, signal?: AbortSignal): Promise<UsageSnapshot> {
    if (this.disposed) return Promise.reject(new Error("Usage reader is disposed."));
    if (signal?.aborted) return Promise.reject(signal.reason);
    let request = this.requests.get(key);
    if (!request) {
      const controller = new AbortController();
      request = { controller, consumers: new Set(), result: discover(controller.signal) };
      this.requests.set(key, request);
      const completed = request;
      this.discoveries.add(completed);
      const release = () => {
        this.discoveries.delete(completed);
        if (this.requests.get(key) === completed) this.requests.delete(key);
      };
      void request.result.then(release, release);
    }
    const shared = request;
    const consumer = {};
    shared.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      const finish = (settle: () => void) => {
        if (!shared.consumers.delete(consumer)) return;
        signal?.removeEventListener("abort", abort);
        settle();
        if (!shared.consumers.size && this.requests.get(key) === shared) {
          this.requests.delete(key);
          shared.controller.abort();
        }
      };
      const abort = () => finish(() => reject(signal!.reason));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void shared.result.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.discoveries].map(request => request.result));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const request of this.discoveries) request.controller.abort();
    await this.idle();
  }
}

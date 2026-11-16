export interface UsageScanSchedulerOptions {
  sliceBytes?: number;
  intervalMs?: number;
}

interface Scan {
  owner: object;
  key: string;
  run: (byteBudget: number) => Promise<boolean>;
  cancelled: boolean;
  requested: boolean;
}

// One service owns this queue. A file receives one bounded slice before it
// rejoins the queue, so large rollouts cannot monopolize history indexing.
export class UsageScanScheduler {
  private readonly sliceBytes: number;
  private readonly intervalMs: number;
  private readonly scans: Scan[] = [];
  private active?: Scan;
  private timer?: ReturnType<typeof setTimeout>;
  private nextSliceAt = 0;
  private disposed = false;
  private readonly waiters: { owner?: object; resolve: () => void }[] = [];

  constructor(options: UsageScanSchedulerOptions = {}) {
    this.sliceBytes = options.sliceBytes ?? 256 * 1024;
    this.intervalMs = options.intervalMs ?? 100;
    if (!Number.isSafeInteger(this.sliceBytes) || this.sliceBytes <= 0 ||
        !Number.isFinite(this.intervalMs) || this.intervalMs < 0)
      throw new Error("Usage indexing requires a positive byte budget and a nonnegative interval.");
  }

  schedule(owner: object, key: string, run: Scan["run"]): void {
    if (this.disposed) return;
    if (this.active?.owner === owner && this.active.key === key) {
      this.active.requested = true;
      return;
    }
    if (this.scans.some(scan => scan.owner === owner && scan.key === key)) return;
    this.scans.push({ owner, key, run, cancelled: false, requested: false });
    this.start();
  }

  async cancel(owner: object): Promise<void> {
    for (let index = this.scans.length - 1; index >= 0; index--)
      if (this.scans[index].owner === owner) this.scans.splice(index, 1);
    if (this.active?.owner === owner) this.active.cancelled = true;
    this.settle();
    await this.idle(owner);
  }

  idle(owner?: object): Promise<void> {
    if (!this.hasWork(owner)) return Promise.resolve();
    return new Promise(resolve => this.waiters.push({ owner, resolve }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.scans.length = 0;
    if (this.active) this.active.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.settle();
    await this.idle();
  }

  private start(): void {
    if (this.disposed || this.active || this.timer || !this.scans.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runNext();
    }, Math.max(0, this.nextSliceAt - Date.now()));
    this.timer.unref();
  }

  private async runNext(): Promise<void> {
    const scan = this.scans.shift();
    if (!scan || this.disposed) return;
    this.active = scan;
    try {
      scan.requested = false;
      const more = await scan.run(this.sliceBytes);
      if ((more || scan.requested) && !scan.cancelled && !this.disposed) this.scans.push(scan);
    } finally {
      this.active = undefined;
      this.nextSliceAt = Date.now() + this.intervalMs;
      this.settle();
      this.start();
    }
  }

  private hasWork(owner?: object): boolean {
    return Boolean(this.active && (!owner || this.active.owner === owner)) ||
      this.scans.some(scan => !owner || scan.owner === owner);
  }

  private settle(): void {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index];
      if (!this.hasWork(waiter.owner)) {
        this.waiters.splice(index, 1);
        waiter.resolve();
      }
    }
    if (!this.scans.length && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

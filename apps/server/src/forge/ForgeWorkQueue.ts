import { AsyncLocalStorage } from "node:async_hooks";

interface WorkLease {
  active: boolean;
  release?: () => void;
}

/** Serializes state changes while allowing owned I/O to wait outside the queue. */
export class ForgeWorkQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<WorkLease>();
  private readonly pending = new Set<Promise<unknown>>();

  run<T>(operation: () => Promise<T>, cleanup?: () => void | Promise<void>): Promise<T> {
    const lease: WorkLease = { active: true };
    const result = this.context.run(lease, async () => {
      lease.release = await this.acquire();
      try {
        return await operation();
      } finally {
        try {
          await cleanup?.();
        } finally {
          lease.active = false;
          lease.release?.();
          lease.release = undefined;
        }
      }
    });
    this.pending.add(result);
    void result.then(() => this.pending.delete(result), () => this.pending.delete(result));
    return result;
  }

  current(): object | undefined {
    const lease = this.context.getStore();
    return lease?.active ? lease : undefined;
  }

  async yieldFor<T>(operation: () => Promise<T>): Promise<T> {
    const lease = this.context.getStore();
    if (!lease?.active || !lease.release)
      throw new Error("Forge I/O can only yield from an active state operation.");
    const release = lease.release;
    lease.release = undefined;
    release();
    try {
      return await operation();
    } finally {
      lease.release = await this.acquire();
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
}

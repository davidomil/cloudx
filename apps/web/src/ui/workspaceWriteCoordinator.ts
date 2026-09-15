import type { TabLayoutState } from "@cloudx/shared";

interface PendingLayoutWrite {
  windowId: string;
  layout: TabLayoutState;
}

export class WorkspaceWriteCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private outstanding = new Set<Promise<unknown>>();
  private pendingLayout: PendingLayoutWrite | undefined;
  private activeLayout: PendingLayoutWrite | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly persistLayout: (windowId: string, layout: TabLayoutState) => Promise<void>,
    private readonly debounceMs: number,
    private readonly reportError: (error: unknown) => void = () => undefined
  ) {}

  scheduleLayout(windowId: string, layout: TabLayoutState): void {
    this.pendingLayout = { windowId, layout };
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    this.clearTimer();
    while (this.outstanding.size || this.pendingLayout) {
      if (this.outstanding.size) await Promise.all(this.outstanding);
      else await this.enqueue(() => this.flushPendingLayouts());
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.clearTimer();
    return this.enqueue(async () => {
      await this.flushPendingLayouts();
      return operation();
    });
  }

  cancelPending(): void {
    this.clearTimer();
    this.pendingLayout = undefined;
  }

  dispose(): void {
    this.cancelPending();
  }

  hasUnsettledLayoutWrite(): boolean {
    return this.pendingLayout !== undefined || this.activeLayout !== undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation);
    this.outstanding.add(run);
    const settled = () => { this.outstanding.delete(run); };
    this.tail = run.then(settled, settled);
    return run;
  }

  private async flushPendingLayouts(): Promise<void> {
    while (this.pendingLayout) {
      this.clearTimer();
      const pending = this.pendingLayout;
      this.pendingLayout = undefined;
      this.activeLayout = pending;
      try {
        await this.persistLayout(pending.windowId, pending.layout);
      } catch (error) {
        this.pendingLayout ??= pending;
        this.reportError(error);
        throw error;
      } finally {
        if (this.activeLayout === pending) {
          this.activeLayout = undefined;
        }
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

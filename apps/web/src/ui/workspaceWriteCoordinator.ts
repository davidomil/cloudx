import type { TabLayoutState } from "@cloudx/shared";

interface PendingLayoutWrite {
  windowId: string;
  layout: TabLayoutState;
}

export class WorkspaceWriteCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private pendingLayout: PendingLayoutWrite | undefined;
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
      void this.flush().catch(this.reportError);
    }, this.debounceMs);
  }

  flush(): Promise<void> {
    this.clearTimer();
    return this.pendingLayout ? this.enqueue(() => this.flushPendingLayouts()) : this.tail;
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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async flushPendingLayouts(): Promise<void> {
    while (this.pendingLayout) {
      this.clearTimer();
      const pending = this.pendingLayout;
      this.pendingLayout = undefined;
      await this.persistLayout(pending.windowId, pending.layout);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

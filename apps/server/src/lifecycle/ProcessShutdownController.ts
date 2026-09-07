export interface ProcessSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export class ProcessShutdownController {
  private closing: Promise<void> | undefined;
  private started = false;
  private signalShutdownStarted = false;

  private readonly handleSignal = (): void => {
    if (this.signalShutdownStarted) {
      return;
    }
    this.signalShutdownStarted = true;
    void this.shutdown().catch(this.reportError);
  };

  constructor(
    private readonly close: () => Promise<void>,
    private readonly signals: ProcessSignalSource,
    private readonly reportError: (error: unknown) => void
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.signals.on("SIGINT", this.handleSignal);
    this.signals.on("SIGTERM", this.handleSignal);
  }

  shutdown(): Promise<void> {
    if (!this.closing) {
      try {
        this.closing = this.close().finally(() => this.dispose());
      } catch (error) {
        this.closing = Promise.reject(error).finally(() => this.dispose());
      }
    }
    return this.closing;
  }

  dispose(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.signals.off("SIGINT", this.handleSignal);
    this.signals.off("SIGTERM", this.handleSignal);
  }
}

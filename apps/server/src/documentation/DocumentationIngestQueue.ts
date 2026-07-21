import { randomUUID } from "node:crypto";

export type DocumentationIngestKind = "path" | "url" | "text" | "upload";
export type DocumentationIngestJobStatus = "queued" | "running" | "complete" | "failed";

export interface DocumentationIngestJobSnapshot {
  id: string;
  kind: DocumentationIngestKind;
  label: string;
  detail: string;
  status: DocumentationIngestJobStatus;
  progress: number;
  stage: string;
  position: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  etaSeconds?: number;
  metrics?: Record<string, unknown>;
  progressChannels?: DocumentationIngestProgressChannel[];
}

export interface DocumentationIngestProgressChannel {
  id: string;
  label: string;
  progress: number;
  stage: string;
  etaSeconds?: number;
  metrics?: Record<string, unknown>;
  updatedAt: string;
}

export interface DocumentationIngestQueueJobInput {
  kind: DocumentationIngestKind;
  label: string;
  admissionBytes: number;
  detail?: string;
  queuedStage?: string;
  runningStage?: string;
  operation(context: DocumentationIngestQueueOperationContext): Promise<Record<string, unknown>>;
}

export interface DocumentationIngestQueueOperationContext {
  readonly signal: AbortSignal;
  update(patch: DocumentationIngestQueueUpdate): void;
}

export type DocumentationIngestProgressReporter = (snapshot: DocumentationIngestJobSnapshot) => void;

interface DocumentationIngestJobState extends DocumentationIngestJobSnapshot {
  progressChannelsById?: Map<string, DocumentationIngestProgressChannel>;
}

export type DocumentationIngestQueueUpdate = Pick<Partial<DocumentationIngestJobSnapshot>, "progress" | "stage" | "etaSeconds" | "metrics"> & {
  channelId?: string;
  channelLabel?: string;
  channelStage?: string;
  channelProgress?: number;
};

const MAX_RETAINED_JOBS = 30;
const PROGRESS_HEARTBEAT_MS = 5_000;
export const DEFAULT_DOCUMENTATION_INGEST_QUEUE_MAX_JOBS = 8;
export const DEFAULT_DOCUMENTATION_INGEST_QUEUE_MAX_BYTES = 512 * 1024 * 1024;

export interface DocumentationIngestQueueOptions {
  maxJobs: number;
  maxBytes: number;
}

export interface DocumentationIngestQueueCapacitySnapshot {
  admittedJobs: number;
  admittedBytes: number;
  reservedJobs: number;
  maxJobs: number;
  maxBytes: number;
}

export class DocumentationIngestQueueCapacityError extends Error {
  constructor(
    readonly code: "DOCUMENTATION_INGEST_JOB_CAPACITY" | "DOCUMENTATION_INGEST_BYTE_CAPACITY",
    readonly statusCode: 429 | 503,
    message: string
  ) {
    super(message);
    this.name = "DocumentationIngestQueueCapacityError";
  }
}

export class DocumentationIngestQueueStoppedError extends Error {
  readonly code = "DOCUMENTATION_INGEST_QUEUE_STOPPED";
  readonly statusCode = 503;

  constructor() {
    super("Documentation ingest queue was stopped.");
    this.name = "DocumentationIngestQueueStoppedError";
  }
}

export class DocumentationIngestAdmission {
  private state: "reserved" | "consumed" | "released" = "reserved";

  constructor(
    private readonly owner: DocumentationIngestQueue,
    readonly bytes: number,
    private readonly releaseCapacity: () => void
  ) {}

  get reserved(): boolean {
    return this.state === "reserved";
  }

  release(): void {
    if (this.state !== "reserved") {
      return;
    }
    this.state = "released";
    this.releaseCapacity();
  }

  consume(owner: DocumentationIngestQueue, bytes: number): void {
    if (owner !== this.owner || bytes !== this.bytes) {
      throw new Error("Documentation ingest admission does not match this queue operation.");
    }
    if (this.state !== "reserved") {
      throw new Error("Documentation ingest admission was already used.");
    }
    this.state = "consumed";
  }

  settle(owner: DocumentationIngestQueue): void {
    if (owner !== this.owner || this.state !== "consumed") {
      return;
    }
    this.state = "released";
    this.releaseCapacity();
  }
}

export class DocumentationIngestQueue {
  private readonly jobs = new Map<string, DocumentationIngestJobState>();
  private readonly order: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly admissions = new Set<DocumentationIngestAdmission>();
  private readonly jobControllers = new Map<string, AbortController>();
  private admittedJobs = 0;
  private admittedBytes = 0;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: DocumentationIngestQueueOptions = {
    maxJobs: DEFAULT_DOCUMENTATION_INGEST_QUEUE_MAX_JOBS,
    maxBytes: DEFAULT_DOCUMENTATION_INGEST_QUEUE_MAX_BYTES
  }) {
    requirePositiveCapacity(options.maxJobs, "maxJobs");
    requirePositiveCapacity(options.maxBytes, "maxBytes");
  }

  enqueue(input: DocumentationIngestQueueJobInput, reportProgress?: DocumentationIngestProgressReporter): Promise<Record<string, unknown>> {
    const admission = this.reserve(input.admissionBytes);
    try {
      return this.enqueueReserved(input, admission, reportProgress);
    } catch (error) {
      admission.release();
      throw error;
    }
  }

  reserve(requestedBytes: number): DocumentationIngestAdmission {
    this.requireRunning();
    const admissionBytes = requireAdmissionBytes(requestedBytes);
    this.admit(admissionBytes);
    let admission!: DocumentationIngestAdmission;
    admission = new DocumentationIngestAdmission(this, admissionBytes, () => {
      this.admissions.delete(admission);
      this.release(admissionBytes);
    });
    this.admissions.add(admission);
    return admission;
  }

  enqueueReserved(input: DocumentationIngestQueueJobInput, admission: DocumentationIngestAdmission, reportProgress?: DocumentationIngestProgressReporter): Promise<Record<string, unknown>> {
    this.requireRunning();
    const admissionBytes = requireAdmissionBytes(input.admissionBytes);
    admission.consume(this, admissionBytes);
    const job: DocumentationIngestJobState = {
      id: randomUUID(),
      kind: input.kind,
      label: input.label,
      detail: input.detail ?? input.kind,
      status: "queued",
      progress: 0,
      stage: input.queuedStage ?? "Waiting for prior documentation imports.",
      position: 0,
      createdAt: new Date().toISOString()
    };
    try {
      this.jobs.set(job.id, job);
      this.order.push(job.id);
      this.trimRetainedJobs();
      this.report(job, reportProgress);
    } catch (error) {
      this.jobs.delete(job.id);
      this.order.splice(this.order.indexOf(job.id), 1);
      admission.settle(this);
      throw error;
    }

    let heartbeat: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    this.jobControllers.set(job.id, controller);
    if (reportProgress) {
      heartbeat = setInterval(() => this.report(job, reportProgress), PROGRESS_HEARTBEAT_MS);
      heartbeat.unref?.();
    }

    const run = this.tail.then(() => this.runJob(job, input, controller.signal, reportProgress));
    const settled = run.finally(() => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      this.jobControllers.delete(job.id);
      admission.settle(this);
    });
    this.tail = settled.then(() => undefined, () => undefined);
    return settled;
  }

  list(): { jobs: DocumentationIngestJobSnapshot[]; capacity: DocumentationIngestQueueCapacitySnapshot } {
    return {
      jobs: this.snapshots(),
      capacity: {
        admittedJobs: this.admittedJobs,
        admittedBytes: this.admittedBytes,
        reservedJobs: Array.from(this.admissions).filter((admission) => admission.reserved).length,
        maxJobs: this.options.maxJobs,
        maxBytes: this.options.maxBytes
      }
    };
  }

  clearFinished(): { jobs: DocumentationIngestJobSnapshot[]; capacity: DocumentationIngestQueueCapacitySnapshot } {
    for (const id of [...this.order]) {
      const job = this.jobs.get(id);
      if (job?.status === "complete" || job?.status === "failed") {
        this.jobs.delete(id);
        this.order.splice(this.order.indexOf(id), 1);
      }
    }
    return this.list();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    for (const admission of [...this.admissions]) {
      admission.release();
    }
    for (const controller of this.jobControllers.values()) {
      controller.abort(new DocumentationIngestQueueStoppedError());
    }
    this.disposePromise = this.tail.then(() => undefined);
    return this.disposePromise;
  }

  private async runJob(job: DocumentationIngestJobState, input: DocumentationIngestQueueJobInput, signal: AbortSignal, reportProgress?: DocumentationIngestProgressReporter): Promise<Record<string, unknown>> {
    Object.assign(job, {
      status: "running" satisfies DocumentationIngestJobStatus,
      progress: Math.max(job.progress, 5),
      stage: input.runningStage ?? "Import is running.",
      startedAt: new Date().toISOString()
    });
    this.report(job, reportProgress);
    try {
      if (signal.aborted) {
        throw signal.reason;
      }
      const result = await input.operation({
        signal,
        update: (patch) => {
          if (patch.progress !== undefined) {
            job.progress = boundedProgress(patch.progress);
          }
          if (patch.stage !== undefined) {
            job.stage = patch.stage;
          }
          if (patch.etaSeconds !== undefined) {
            job.etaSeconds = boundedEtaSeconds(patch.etaSeconds);
          }
          if (patch.metrics !== undefined) {
            job.metrics = patch.metrics;
          }
          this.updateProgressChannel(job, patch);
          this.report(job, reportProgress);
        }
      });
      Object.assign(job, {
        status: "complete" satisfies DocumentationIngestJobStatus,
        progress: 100,
        stage: "Import complete.",
        finishedAt: new Date().toISOString()
      });
      this.report(job, reportProgress);
      return result;
    } catch (error) {
      Object.assign(job, {
        status: "failed" satisfies DocumentationIngestJobStatus,
        progress: 100,
        stage: "Import failed.",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      this.report(job, reportProgress);
      throw error;
    }
  }

  private snapshots(): DocumentationIngestJobSnapshot[] {
    return this.order.map((id) => this.jobs.get(id)).filter(isJob).map((job) => this.snapshot(job));
  }

  private snapshot(job: DocumentationIngestJobState): DocumentationIngestJobSnapshot {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      detail: job.detail,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      position: this.position(job),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      etaSeconds: job.etaSeconds,
      metrics: job.metrics,
      progressChannels: job.progressChannelsById ? Array.from(job.progressChannelsById.values()) : undefined
    };
  }

  private updateProgressChannel(job: DocumentationIngestJobState, patch: DocumentationIngestQueueUpdate): void {
    if (!patch.channelId) {
      return;
    }
    const id = normalizeProgressChannelId(patch.channelId);
    if (!id) {
      return;
    }
    const existing = job.progressChannelsById?.get(id);
    job.progressChannelsById ??= new Map();
    job.progressChannelsById.set(id, {
      id,
      label: patch.channelLabel?.trim() || existing?.label || id,
      progress: patch.channelProgress !== undefined ? boundedProgress(patch.channelProgress) : patch.progress !== undefined ? boundedProgress(patch.progress) : existing?.progress ?? job.progress,
      stage: patch.channelStage?.trim() || patch.stage?.trim() || existing?.stage || job.stage,
      etaSeconds: patch.etaSeconds !== undefined ? boundedEtaSeconds(patch.etaSeconds) : existing?.etaSeconds,
      metrics: patch.metrics !== undefined ? patch.metrics : existing?.metrics,
      updatedAt: new Date().toISOString()
    });
  }

  private position(job: DocumentationIngestJobState): number {
    if (job.status === "running") {
      return 0;
    }
    if (job.status !== "queued") {
      return -1;
    }
    return this.order.slice(0, this.order.indexOf(job.id) + 1).filter((id) => this.jobs.get(id)?.status === "queued").length;
  }

  private report(job: DocumentationIngestJobState, reportProgress?: DocumentationIngestProgressReporter): void {
    reportProgress?.(this.snapshot(job));
  }

  private trimRetainedJobs(): void {
    while (this.order.length > MAX_RETAINED_JOBS) {
      const firstRetainedFinished = this.order.find((id) => {
        const status = this.jobs.get(id)?.status;
        return status === "complete" || status === "failed";
      });
      if (!firstRetainedFinished) {
        return;
      }
      this.jobs.delete(firstRetainedFinished);
      this.order.splice(this.order.indexOf(firstRetainedFinished), 1);
    }
  }

  private admit(bytes: number): void {
    if (this.admittedJobs >= this.options.maxJobs) {
      throw new DocumentationIngestQueueCapacityError(
        "DOCUMENTATION_INGEST_JOB_CAPACITY",
        429,
        `Documentation ingest capacity is full (${this.options.maxJobs} admitted jobs).`
      );
    }
    if (bytes > this.options.maxBytes - this.admittedBytes) {
      throw new DocumentationIngestQueueCapacityError(
        "DOCUMENTATION_INGEST_BYTE_CAPACITY",
        503,
        `Documentation ingest byte capacity is unavailable (${this.options.maxBytes} bytes).`
      );
    }
    this.admittedJobs += 1;
    this.admittedBytes += bytes;
  }

  private release(bytes: number): void {
    this.admittedJobs -= 1;
    this.admittedBytes -= bytes;
  }

  private requireRunning(): void {
    if (this.disposed) {
      throw new DocumentationIngestQueueStoppedError();
    }
  }
}

function boundedProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function boundedEtaSeconds(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

function normalizeProgressChannelId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function isJob(value: DocumentationIngestJobState | undefined): value is DocumentationIngestJobState {
  return Boolean(value);
}

function requirePositiveCapacity(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Documentation ingest queue ${name} must be a positive safe integer.`);
  }
}

function requireAdmissionBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Documentation ingest admissionBytes must be a non-negative safe integer.");
  }
  return value;
}

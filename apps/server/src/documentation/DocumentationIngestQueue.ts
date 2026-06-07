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
}

export interface DocumentationIngestQueueJobInput {
  kind: DocumentationIngestKind;
  label: string;
  detail?: string;
  queuedStage?: string;
  runningStage?: string;
  operation(context: DocumentationIngestQueueOperationContext): Promise<Record<string, unknown>>;
}

export interface DocumentationIngestQueueOperationContext {
  update(patch: Pick<Partial<DocumentationIngestJobSnapshot>, "progress" | "stage">): void;
}

export type DocumentationIngestProgressReporter = (snapshot: DocumentationIngestJobSnapshot) => void;

interface DocumentationIngestJobState extends DocumentationIngestJobSnapshot {
  result?: Record<string, unknown>;
}

const MAX_RETAINED_JOBS = 30;
const PROGRESS_HEARTBEAT_MS = 5_000;

export class DocumentationIngestQueue {
  private readonly jobs = new Map<string, DocumentationIngestJobState>();
  private readonly order: string[] = [];
  private tail: Promise<void> = Promise.resolve();

  enqueue(input: DocumentationIngestQueueJobInput, reportProgress?: DocumentationIngestProgressReporter): Promise<Record<string, unknown>> {
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
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.trimRetainedJobs();
    this.report(job, reportProgress);

    let heartbeat: NodeJS.Timeout | undefined;
    if (reportProgress) {
      heartbeat = setInterval(() => this.report(job, reportProgress), PROGRESS_HEARTBEAT_MS);
      heartbeat.unref?.();
    }

    const run = this.tail.then(() => this.runJob(job, input, reportProgress));
    this.tail = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    });
  }

  list(): { jobs: DocumentationIngestJobSnapshot[] } {
    return { jobs: this.snapshots() };
  }

  clearFinished(): { jobs: DocumentationIngestJobSnapshot[] } {
    for (const id of [...this.order]) {
      const job = this.jobs.get(id);
      if (job?.status === "complete" || job?.status === "failed") {
        this.jobs.delete(id);
        this.order.splice(this.order.indexOf(id), 1);
      }
    }
    return this.list();
  }

  private async runJob(job: DocumentationIngestJobState, input: DocumentationIngestQueueJobInput, reportProgress?: DocumentationIngestProgressReporter): Promise<Record<string, unknown>> {
    Object.assign(job, {
      status: "running" satisfies DocumentationIngestJobStatus,
      progress: Math.max(job.progress, 5),
      stage: input.runningStage ?? "Import is running.",
      startedAt: new Date().toISOString()
    });
    this.report(job, reportProgress);
    try {
      const result = await input.operation({
        update: (patch) => {
          if (patch.progress !== undefined) {
            job.progress = boundedProgress(patch.progress);
          }
          if (patch.stage !== undefined) {
            job.stage = patch.stage;
          }
          this.report(job, reportProgress);
        }
      });
      Object.assign(job, {
        status: "complete" satisfies DocumentationIngestJobStatus,
        progress: 100,
        stage: "Import complete.",
        finishedAt: new Date().toISOString(),
        result
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
      error: job.error
    };
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
}

function boundedProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isJob(value: DocumentationIngestJobState | undefined): value is DocumentationIngestJobState {
  return Boolean(value);
}

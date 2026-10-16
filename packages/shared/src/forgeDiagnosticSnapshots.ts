export interface ForgeDiagnosticSnapshotInput {
  kind: "source-only" | "repository";
  commitSha: string;
}

export interface ForgeDiagnosticSnapshotResult {
  path: string;
  kind: ForgeDiagnosticSnapshotInput["kind"];
  retentionPolicy: "disposable" | "recover";
}

export interface ForgeDiagnosticSnapshotStatus extends ForgeDiagnosticSnapshotResult {
  workerId: string;
  attemptId: string;
  state: "creating" | "ready" | "removing" | "removed";
  hold?: string;
  recovery?: { state: "archiving" | "verified"; archivePath: string };
}

export function validateForgeDiagnosticSnapshotInput(value: unknown): asserts value is ForgeDiagnosticSnapshotInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A diagnostic snapshot kind and source commit are required.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "kind" && key !== "commitSha"))
    throw new Error("Diagnostic snapshots use server-allocated paths; only kind and commitSha are accepted.");
  if (input.kind !== "source-only" && input.kind !== "repository")
    throw new Error("Diagnostic snapshot kind must be source-only or repository.");
  if (typeof input.commitSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.commitSha))
    throw new Error("Diagnostic snapshots require the full source commit SHA.");
}

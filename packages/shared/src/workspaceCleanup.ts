export interface WorkspaceCleanupCandidate {
  id: string;
  path: string;
  repository: string;
  kind: "forge" | "worktree" | "checkout" | "trash";
  workerId?: string;
  changeUrl?: string;
  state: string;
  lastActivity: string;
  allocatedBytes: number;
  sizeUnavailable?: true;
  eligible: boolean;
  reason: string;
  sourceChanges: string[];
  unpublishedCommits: number;
  requiresDiscard: boolean;
}
export interface WorkspaceCleanupPreview {
  id: string;
  createdAt: string;
  candidates: WorkspaceCleanupCandidate[];
  reclaimableBytes: number;
  reclaimGroups: Array<{ bytes: number; candidateIds: string[] }>;
  availableBytes: number;
  warnings: string[];
}
export interface WorkspaceCleanupRequest {
  previewId: string;
  candidateIds: string[];
  discardCandidateIds: string[];
  emptyTrash: boolean;
  confirmation: "Delete permanently";
}
export interface WorkspaceCleanupResult {
  id: string;
  path: string;
  status: "waiting" | "deleting" | "deleted" | "skipped" | "failed";
  reason: string;
}
export interface WorkspaceCleanupJob {
  id: string;
  state: "running" | "completed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  availableBytesBefore: number;
  availableBytesAfter?: number;
  results: WorkspaceCleanupResult[];
}
export function parseWorkspaceCleanupRequest(value: unknown): WorkspaceCleanupRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A reviewed cleanup selection is required.");
  const input = value as Record<string, unknown>;
  const identifiers = (list: unknown): list is string[] => Array.isArray(list) && list.length <= 1000 && list.every(id => typeof id === "string" && /^[a-f0-9-]{36}$/u.test(id)) && new Set(list).size === list.length;
  if (Object.keys(input).some(key => !["previewId", "candidateIds", "discardCandidateIds", "emptyTrash", "confirmation"].includes(key)) ||
      typeof input.previewId !== "string" || !/^[a-f0-9-]{36}$/u.test(input.previewId) ||
      !identifiers(input.candidateIds) || !input.candidateIds.length || !identifiers(input.discardCandidateIds) ||
      input.discardCandidateIds.some(id => !(input.candidateIds as string[]).includes(id)) ||
      typeof input.emptyTrash !== "boolean" || input.confirmation !== "Delete permanently")
    throw new Error("Select reviewed workspaces and confirm permanent deletion.");
  return input as unknown as WorkspaceCleanupRequest;
}

export function workspaceCleanupReclaimableBytes(preview: WorkspaceCleanupPreview, candidateIds: string[]): number {
  const selected = new Set(candidateIds);
  return preview.reclaimGroups.reduce((total, group) => total + (group.candidateIds.every(id => selected.has(id)) ? group.bytes : 0), 0);
}

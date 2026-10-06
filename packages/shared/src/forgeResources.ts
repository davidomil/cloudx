export interface ForgeResourceConsumer { workerId: string; attemptId: string }

export interface DisposableContainerInput {
  image: string;
  name: string;
  command: string[];
  consumers?: ForgeResourceConsumer[];
  retentionReason?: string;
  evidencePaths?: string[];
  commitSha?: string;
}

export interface ForgeEvidenceFile {
  /** Container-root-relative path, used only as an archive key. */
  path: string;
  bytes: number;
  sha256: string;
  /** Link target preserved as inert JSON content, never followed or recreated. */
  symbolicLink?: string;
}

export interface ForgeEvidenceBatch { files: ForgeEvidenceFile[]; bytes: number }

export interface ForgeResourceEvidence {
  state: "pending" | "exporting" | "verified" | "kept" | "discarded" | "missing";
  paths: string[];
  commitSha?: string;
  commitSource?: "worker" | "declared";
  archivePath?: string;
  manifestSha256?: string;
  files?: ForgeEvidenceFile[];
  bytes?: number;
  exportedAt?: string;
}

export interface EvidenceDecision {
  action: "keep" | "export" | "discard";
  evidencePaths?: string[];
  commitSha?: string;
  confirmation?: "Discard evidence";
}

export interface DisposableResource {
  id: string;
  kind: "container";
  engineId: string;
  containerId?: string;
  created?: string;
  creationRejected?: true;
  name: string;
  owner: ForgeResourceConsumer;
  consumers: ForgeResourceConsumer[];
  retentionReason?: string;
  evidence?: ForgeResourceEvidence;
  state: "creating" | "owned" | "deleting" | "deleted" | "blocked" | "failed";
  reason: string;
  /** Primary failure without secondary Docker stream-cancellation diagnostics. */
  cleanupFailure?: string;
  allocatedBytes?: number;
  reclaimedBytes: number;
  removalStartedAt?: string;
  updatedAt: string;
}

export interface ForgeEvidenceManifest {
  resourceId: string;
  owner: ForgeResourceConsumer;
  consumers: ForgeResourceConsumer[];
  engineId: string;
  containerId: string;
  created: string;
  reason?: string;
  paths: string[];
  commitSha?: string;
  commitSource?: "worker" | "declared";
  exportedAt: string;
  files: ForgeEvidenceFile[];
  bytes: number;
  batches?: ForgeEvidenceBatch[];
}

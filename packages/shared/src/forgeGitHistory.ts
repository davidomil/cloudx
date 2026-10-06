import type { ForgeEvidenceFile } from "./forgeResources.js";

export interface ForgeGitHistoryRef {
  name: string;
  commitSha: string;
}

export interface ForgeGitHistoryManifest {
  archiveId: string;
  workerId: string;
  attemptId: string;
  commitSha: string;
  checkoutIdentity: { dev: string; ino: string };
  refs: ForgeGitHistoryRef[];
  exportedAt: string;
  files: ForgeEvidenceFile[];
  bytes: number;
}

export interface ForgeGitHistoryReceipt {
  archiveId: string;
  manifestSha256: string;
  publication: "pending" | "complete";
  attemptId: string;
  commitSha: string;
  refs: ForgeGitHistoryRef[];
}

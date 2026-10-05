import type { ForgeEvidenceFile } from "./forgeResources.js";

export interface ForgeCheckoutEvidenceManifest {
  archiveId: string;
  workerId: string;
  attemptId: string;
  commitSha: string;
  checkoutIdentity: { dev: string; ino: string };
  paths: string[];
  exportedAt: string;
  files: ForgeEvidenceFile[];
  bytes: number;
}

export interface ForgeCheckoutEvidenceReceipt {
  archiveId: string;
  manifestSha256?: string;
  attemptId: string;
  commitSha: string;
  paths: string[];
}

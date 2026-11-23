export interface CodexStorageBytes {
  logicalBytes: number;
  allocatedBytes: number;
  files: number;
}

export type CodexStorageCategory = "sessionHistory" | "nativeDatabases" | "userData" | "rebuildableCaches";
export type CodexStorageCategories = Record<CodexStorageCategory, CodexStorageBytes>;

export interface CodexStorageInventory {
  measuredAt: string;
  sourceHomes: string[];
  sqliteHomes: string[];
  native: CodexStorageCategories;
  launches: CodexStorageCategories;
  total: CodexStorageBytes;
  warnings: string[];
  measurementNote: string;
  maintenance: {
    selectedVersion: string | null;
    ownedHistoryDeletion: "supported" | "unavailable";
    reason: string;
    projectionReclamation: string;
    retainedHistory: Array<{ ownerId: string; threadId: string; state: "retained" | "removing"; reason: string }>;
  };
}

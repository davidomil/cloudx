import fs from "node:fs/promises";
import path from "node:path";
import type { ForgeDiagnosticSnapshotStatus } from "@cloudx/shared";
import type { DirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile, requireSafeDirectory } from "../jsonStateFile.js";
import { isOwnedDiagnosticSnapshot, type OwnedDiagnosticSnapshot } from "./ForgeDiagnosticSnapshots.js";

export function diagnosticSnapshotStatus(snapshot: OwnedDiagnosticSnapshot): ForgeDiagnosticSnapshotStatus {
  return { path: snapshot.path, kind: snapshot.kind, retentionPolicy: snapshot.retentionPolicy,
    workerId: snapshot.workerId, attemptId: snapshot.attemptId, state: snapshot.state,
    ...(snapshot.hold ? { hold: snapshot.hold } : {}),
    ...(snapshot.recovery ? { recovery: { state: snapshot.recovery.state, archivePath: snapshot.recovery.archivePath } } : {}) };
}

/** Ownership receipts outlive worker cards and keep preserved copies discoverable. */
export class ForgeDiagnosticSnapshotInventory {
  constructor(private readonly dataDir: string) {}

  async list(): Promise<{ snapshots: ForgeDiagnosticSnapshotStatus[]; errors: string[] }> {
    const snapshots: ForgeDiagnosticSnapshotStatus[] = [], errors: string[] = [];
    const directory = path.join(this.dataDir, "forge-workers/workspaces");
    if (!await requireSafeDirectory(this.dataDir, directory, { create: false, label: "Snapshot ownership inventory" })) return { snapshots, errors };
    for (const name of (await fs.readdir(directory)).sort()) {
      if (!/^[a-zA-Z0-9_-]{1,100}\.json$/u.test(name)) continue;
      try {
        const owned = await new JsonStateFile(this.dataDir, `forge-workers/workspaces/${name}`, "Snapshot ownership").read<{
          id: string; worktree: DirectoryIdentity; diagnosticSnapshots?: OwnedDiagnosticSnapshot[];
        }>();
        if (!owned || owned.id !== name.slice(0, -5)) throw new Error("Invalid workspace ownership receipt.");
        if (owned.diagnosticSnapshots !== undefined && (!Array.isArray(owned.diagnosticSnapshots) || owned.diagnosticSnapshots.length > 100))
          throw new Error("Invalid diagnostic snapshot inventory.");
        for (const snapshot of owned.diagnosticSnapshots ?? []) {
          if (!isOwnedDiagnosticSnapshot(snapshot, owned.id, owned.worktree)) {
            errors.push(`${owned.id}: invalid snapshot ownership; the copy remains protected.`);
            continue;
          }
          snapshots.push(diagnosticSnapshotStatus(snapshot));
        }
      } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { snapshots, errors };
  }
}

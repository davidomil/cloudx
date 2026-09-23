import { createHash } from "node:crypto";
import type { DirectoryOwnershipPreview, DirectoryOwnershipReconciliation } from "@cloudx/shared";
import { assertDirectoryIdentity, readDirectoryIdentity, sameDirectoryIdentity, type DirectoryIdentity } from "./directoryIdentity.js";

/** A reviewed legacy-device mapping never overrides existing durable evidence. */
export class DirectoryOwnershipReconciler {
  readonly identities: Array<{ saved: DirectoryIdentity; current: DirectoryIdentity }> = [];

  async add(saved: DirectoryIdentity): Promise<DirectoryIdentity> {
    const current = await readDirectoryIdentity(saved.path, "Filesystem reconciliation directory");
    if (saved.path !== current.path || saved.ino !== current.ino || saved.durable && !sameDirectoryIdentity(saved, current))
      assertDirectoryIdentity(saved, current, "Filesystem reconciliation directory");
    this.identities.push({ saved: { ...saved }, current });
    return current;
  }

  preview(records: unknown): DirectoryOwnershipPreview {
    return {
      fingerprint: createHash("sha256").update(JSON.stringify({ records, identities: this.identities })).digest("hex"),
      directories: [...new Map(this.identities.filter(({ saved, current }) => !sameDirectoryIdentity(saved, current)).map(({ saved, current }) => [JSON.stringify([saved.path, saved.dev, current.dev]), {
        path: saved.path, device: saved.dev, currentDevice: current.dev,
        filesystemId: current.durable!.filesystemId, filesystemType: current.durable!.filesystemType,
      }])).values()],
    };
  }

  validate(preview: DirectoryOwnershipPreview, input: DirectoryOwnershipReconciliation): void {
    if (input.fingerprint !== preview.fingerprint) throw new Error("Filesystem ownership changed after inspection. Inspect it again before reconciling.");
    const mappings = new Map<string, string>();
    for (const attestation of input.attestations) {
      const filesystem = `${attestation.filesystemType}:${attestation.filesystemId}`;
      const prior = mappings.get(attestation.device);
      if (prior && prior !== filesystem) throw new Error(`Saved device ${attestation.device} maps to conflicting filesystems. Device reassignment cannot change the original filesystem.`);
      mappings.set(attestation.device, filesystem);
    }
    for (const { saved, current } of this.identities) {
      if (sameDirectoryIdentity(saved, current)) continue;
      if (!current.durable || !["ef53", "9123683e"].includes(current.durable.filesystemType) || current.durable.birthtimeNs === "0")
        throw new Error("This filesystem cannot establish durable ownership after device reassignment. Restore the original mount before Resume.");
      if (!input.attestations.some(value => value.device === saved.dev && value.filesystemId === current.durable!.filesystemId && value.filesystemType === current.durable!.filesystemType))
        throw new Error(`Confirm that saved device ${saved.dev} is the original filesystem ${current.durable.filesystemId} before reconciling.`);
    }
  }

  async assertCurrent(): Promise<void> {
    for (const { current } of this.identities)
      assertDirectoryIdentity(current, await readDirectoryIdentity(current.path), "Filesystem reconciliation directory");
  }
}

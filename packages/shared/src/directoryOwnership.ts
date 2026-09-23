export interface DirectoryOwnershipAttestation {
  device: string;
  filesystemId: string;
  filesystemType: string;
}

export interface DirectoryOwnershipPreview {
  fingerprint: string;
  directories: Array<DirectoryOwnershipAttestation & { path: string; currentDevice: string }>;
}

export interface DirectoryOwnershipReconciliation {
  fingerprint: string;
  attestations: DirectoryOwnershipAttestation[];
}

export function isDirectoryOwnershipReconciliation(value: unknown): value is DirectoryOwnershipReconciliation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => key === "fingerprint" || key === "attestations") &&
    typeof input.fingerprint === "string" && /^[a-f0-9]{64}$/.test(input.fingerprint) &&
    Array.isArray(input.attestations) && input.attestations.length > 0 && input.attestations.length <= 128 &&
    input.attestations.every(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const attestation = value as Record<string, unknown>;
      return Object.keys(attestation).length === 3 &&
        ["device", "filesystemId", "filesystemType"].every(key => typeof attestation[key] === "string" &&
          attestation[key].length > 0 && attestation[key].length <= 256 && !/\s|\0/.test(attestation[key]));
    });
}

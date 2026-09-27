export class CodexUpdateError extends Error {
  code: string;
  usableVersion: string | null;
  installedVersion: string | null;
  constructor(code: string, message: string, usableVersion?: string | null);
}
export interface CodexInstallation {
  assistantBin: string;
  prefix: string;
}
export interface CodexSelection {
  schemaVersion: 1;
  active: { version: string; assistantBin: string };
  previous: { version: string; assistantBin: string } | null;
}
export function readCodexSelection(options: { assistantBin?: string; prefix: string }): CodexSelection | null;
export function resolveSelectedCodexBinary(options: { assistantBin?: string; prefix: string }): string;
export function discoverCodexReleases(options?: CodexProcessOptions & { prefix?: string }): Promise<{ latestStable: string; versions: string[] }>;
export interface CodexProcessOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (text: string) => void;
}
export function resolveCodexInstallation(options: {
  assistantBin?: string;
  prefix: string;
}): CodexInstallation;
export function acquireCodexInstallationLock(prefix: string): () => void;
export function readCodexVersion(
  assistantBin: string,
  options?: CodexProcessOptions,
): Promise<string>;
export function updateCodexInstallation(
  options: CodexProcessOptions & {
    assistantBin?: string;
    prefix: string;
    targetVersion?: string;
    acknowledgeDowngrade?: boolean;
    onTarget?: (version: string) => void;
    onInstalled?: (version: string) => void;
    onProgress?: (stage: "checking" | "updating" | "verifying") => void;
  },
): Promise<{
  outcome: "updated" | "current";
  installedVersion: string;
  previousVersion: string | null;
  activeVersion: string;
  previousVerifiedVersion: string | null;
}>;

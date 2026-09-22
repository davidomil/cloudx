export class CodexUpdateError extends Error {
  code: string;
  usableVersion: string | null;
  constructor(code: string, message: string, usableVersion?: string | null);
}
export interface CodexInstallation {
  assistantBin: string;
  prefix: string;
}
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
    onProgress?: (stage: "checking" | "updating" | "verifying") => void;
  },
): Promise<{
  outcome: "updated" | "current";
  installedVersion: string;
  previousVersion: string | null;
}>;

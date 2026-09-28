export interface CodexSelectionEntry {
  version: string;
  assistantBin: string;
}
export interface CodexSelection {
  schemaVersion: 1;
  active: CodexSelectionEntry;
  previous: CodexSelectionEntry | null;
}
export function isExactCodexVersion(value: unknown): value is string;
export function readCodexSelection(prefix: string): CodexSelection | null;
export function resolveSelectedCodexCommand(configuredBin: string): string;

import type { Stats } from 'node:fs';

export function parseSystemdPaths(value: string | string[]): string[];
export function assertTerminalMemoryUnit(file: string, options: { systemdDir: string; uid?: number }): Stats;
interface TerminalMemoryPolicyOptions {
  systemdDir: string;
  home?: string;
  configHome?: string;
  runtimeDir?: string;
  unitName?: string;
  uid?: number;
}
export function assertTerminalMemoryDropIns(dropInPaths: string | string[], options: TerminalMemoryPolicyOptions): string[];
export function assertTerminalMemoryDestination(options: TerminalMemoryPolicyOptions): void;
export function assertTerminalMemoryPersistence(dropInPaths: string | string[], limits: {
  memoryHigh: string;
  memoryMax: string;
}, options: TerminalMemoryPolicyOptions): void;

export interface TerminalMemoryLimits {
  memoryHigh: string;
  memoryMax: string;
}

export interface TerminalMemoryStatus {
  service: string;
  manageable: boolean;
  reason?: string;
  limits: { memoryHigh: string | null; memoryMax: string | null };
  effective: { memoryHigh: string | null; memoryMax: string | null };
  usageBytes: number | null;
  pressure: { someAvg10: number; fullAvg10: number } | null;
  events: { high: number; oom: number; oomKill: number } | null;
  fragmentPath: string | null;
  dropInPaths: string[];
  controlGroup: string | null;
  activeState: string | null;
}

const UNIT_BYTES = { B: 1n, KiB: 1024n, MiB: 1024n ** 2n, GiB: 1024n ** 3n, TiB: 1024n ** 4n };
const MAX_FINITE_BYTES = 2n ** 64n - 2n;

export function parseTerminalMemoryLimit(value: unknown, label = "Memory limit"): string {
  return parseMemorySize(value, label, false);
}

function parseMemorySize(value: unknown, label: string, allowZero: boolean): string {
  if (value === "infinity") return value;
  if (typeof value !== "string" || value.length > 128) throw new Error(`${label} must be a memory size or infinity.`);
  const match = /^(\d+)(?:\.(\d+))?\s*(B|KiB|MiB|GiB|TiB)?$/.exec(value.trim());
  if (!match) throw new Error(`${label} must use B, KiB, MiB, GiB, TiB, or infinity.`);
  const scale = 10n ** BigInt(match[2]?.length ?? 0);
  const bytes = BigInt(match[1]! + (match[2] ?? "")) * UNIT_BYTES[(match[3] ?? "B") as keyof typeof UNIT_BYTES];
  if (bytes % scale !== 0n || bytes / scale < (allowZero ? 0n : 1n) || bytes / scale > MAX_FINITE_BYTES) {
    throw new Error(`${label} must be a positive whole number of bytes below 18446744073709551615.`);
  }
  return String(bytes / scale);
}

export function parseTerminalMemoryLimits(value: unknown): TerminalMemoryLimits {
  if (!isRecord(value) || Object.keys(value).some(key => key !== "memoryHigh" && key !== "memoryMax")) throw new Error("Set both MemoryHigh and MemoryMax.");
  const memoryHigh = parseTerminalMemoryLimit(value.memoryHigh, "MemoryHigh");
  const memoryMax = parseTerminalMemoryLimit(value.memoryMax, "MemoryMax");
  if (memoryHigh !== "infinity" && memoryMax !== "infinity" && BigInt(memoryHigh) > BigInt(memoryMax)) {
    throw new Error("MemoryHigh must not exceed MemoryMax when both limits are finite.");
  }
  return { memoryHigh, memoryMax };
}

export function parseTerminalMemoryStatus(value: unknown): TerminalMemoryStatus {
  const invalid = () => { throw new Error("Invalid terminal memory status."); };
  if (!isRecord(value)) return invalid();
  const limits = (input: unknown) => {
    if (!isRecord(input)) return invalid();
    return { memoryHigh: limit(input.memoryHigh), memoryMax: limit(input.memoryMax) };
  };
  const limit = (input: unknown): string | null => input === null ? null : parseMemorySize(input, "Observed memory limit", true);
  const nullableText = (input: unknown): string | null => input === null ? null : typeof input === "string" ? input : invalid();
  const metric = (input: unknown): number => typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : invalid();
  const counter = (input: unknown): number => Number.isSafeInteger(input) ? metric(input) : invalid();
  const percentage = (input: unknown): number => metric(input) <= 100 ? input as number : invalid();
  if (typeof value.service !== "string" || !value.service || typeof value.manageable !== "boolean" || value.reason !== undefined && typeof value.reason !== "string") return invalid();
  if (!Array.isArray(value.dropInPaths) || value.dropInPaths.some(path => typeof path !== "string")) return invalid();
  const pressure = value.pressure === null ? null : isRecord(value.pressure)
    ? { someAvg10: percentage(value.pressure.someAvg10), fullAvg10: percentage(value.pressure.fullAvg10) } : invalid();
  const events = value.events === null ? null : isRecord(value.events)
    ? { high: counter(value.events.high), oom: counter(value.events.oom), oomKill: counter(value.events.oomKill) } : invalid();
  return {
    service: value.service, manageable: value.manageable,
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    limits: limits(value.limits), effective: limits(value.effective),
    usageBytes: value.usageBytes === null ? null : counter(value.usageBytes),
    pressure, events,
    fragmentPath: nullableText(value.fragmentPath), dropInPaths: value.dropInPaths as string[],
    controlGroup: nullableText(value.controlGroup), activeState: nullableText(value.activeState)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

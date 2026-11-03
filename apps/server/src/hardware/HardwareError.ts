export class HardwareError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "HardwareError";
  }
}

export function requireHardware(condition: unknown, code: string, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new HardwareError(code, message, details);
}

export function hardwareInput<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) { if (error instanceof HardwareError) throw error; throw new HardwareError("INVALID_INPUT", error instanceof Error ? error.message : "Invalid hardware input."); }
}

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { JsonObject, JsonSchema, ProviderOutcome } from "@cloudx/shared";

export const MAX_HARDWARE_BYTES = 1024 * 1024;
export const MAX_HARDWARE_TIMEOUT_MS = 3_600_000;

export class HardwareProviderError extends Error {
  constructor(readonly code: string, message: string, readonly details?: JsonObject) {
    super(message);
    this.name = "HardwareProviderError";
  }
}

export function boundedJson(value: unknown, label: string, maxBytes = MAX_HARDWARE_BYTES * 2): void {
  const seen = new Set<object>();
  function visit(current: unknown, depth: number): void {
    if (depth > 32) throw new HardwareProviderError("INVALID_INPUT", `${label} exceeds maximum nesting depth.`);
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number" && Number.isFinite(current)) return;
    if (typeof current !== "object" || seen.has(current)) throw new HardwareProviderError("INVALID_INPUT", `${label} must be finite JSON.`);
    seen.add(current);
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new HardwareProviderError("INVALID_INPUT", `${label} must contain plain JSON objects.`);
    }
    for (const child of Object.values(current)) visit(child, depth + 1);
    seen.delete(current);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new HardwareProviderError("INVALID_INPUT", `${label} is too large.`);
}

export function compileHardwareSchema(schema: JsonSchema, label: string): ValidateFunction {
  boundedJson(schema, label, 64 * 1024);
  function inspect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["$ref", "$dynamicRef", "$recursiveRef"].includes(key) && (typeof child !== "string" || !child.startsWith("#"))) {
        throw new HardwareProviderError("INVALID_SCHEMA", `${label} permits local schema references only.`);
      }
      if (key === "$id") throw new HardwareProviderError("INVALID_SCHEMA", `${label} cannot define schema resource IDs.`);
      inspect(child);
    }
  }
  inspect(schema);
  if (schema.type !== "object") throw new HardwareProviderError("INVALID_SCHEMA", `${label} must describe a JSON object.`);
  try {
    return new Ajv2020({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  } catch (error) {
    throw new HardwareProviderError("INVALID_SCHEMA", `${label}: ${error instanceof Error ? error.message : "invalid schema"}`);
  }
}

export function validateHardwareValue(validate: ValidateFunction, value: unknown, label: string): asserts value is JsonObject {
  boundedJson(value, label);
  if (validate(value)) return;
  const errors = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  throw new HardwareProviderError("INVALID_INPUT", `${label}: ${errors}`);
}

export function completed<T>(value: T): ProviderOutcome<T> { return { state: "completed", value }; }
export function failed<T>(code: string, message: string, effects: "none" | "settled" = "none"): ProviderOutcome<T> {
  return { state: "failed", effects, error: { code, message } };
}
export function unknown<T>(code: string, message: string, diagnostics?: JsonObject): ProviderOutcome<T> {
  return { state: "unknown", error: { code, message }, ...(diagnostics ? { diagnostics } : {}) };
}

export const deadlineSchema = { type: "integer", minimum: 1, maximum: MAX_HARDWARE_TIMEOUT_MS } as const;
export const byteLimitSchema = { type: "integer", minimum: 1, maximum: MAX_HARDWARE_BYTES } as const;
export function objectSchema(properties: JsonObject, required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

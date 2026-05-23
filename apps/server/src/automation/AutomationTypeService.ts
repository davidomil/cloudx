import { automationTypeAssignable, type AutomationType } from "@cloudx/shared";

export const EXEC_TYPE: AutomationType = { kind: "exec" };
export const UNKNOWN_TYPE: AutomationType = { kind: "unknown" };
export const STRING_TYPE: AutomationType = { kind: "string" };
export const NUMBER_TYPE: AutomationType = { kind: "number" };
export const BOOLEAN_TYPE: AutomationType = { kind: "boolean" };
export const OBJECT_TYPE: AutomationType = { kind: "object", properties: {}, required: [] };
export const ARRAY_TYPE: AutomationType = { kind: "array", items: UNKNOWN_TYPE };

export class AutomationTypeService {
  schemaToType(schema: Record<string, unknown> | undefined): AutomationType {
    if (!schema) {
      return UNKNOWN_TYPE;
    }
    if (Object.prototype.hasOwnProperty.call(schema, "const")) {
      return this.valueToType(schema.const);
    }
    const rawType = schema.type;
    if (Array.isArray(rawType)) {
      return { kind: "union", options: rawType.map((type) => this.schemaToType({ ...schema, type })) };
    }
    if (rawType === "string" || rawType === "number" || rawType === "boolean" || rawType === "null") {
      return { kind: rawType };
    }
    if (rawType === "integer") {
      return NUMBER_TYPE;
    }
    if (rawType === "array") {
      return { kind: "array", items: this.schemaToType(recordOrUndefined(schema.items)) };
    }
    if (rawType === "object") {
      const properties = recordOfRecords(schema.properties);
      const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
      return {
        kind: "object",
        properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, this.schemaToType(value)])),
        required
      };
    }
    if (Array.isArray(schema.enum)) {
      return unionType(schema.enum.map((value) => this.valueToType(value)));
    }
    return UNKNOWN_TYPE;
  }

  valueToType(value: unknown): AutomationType {
    if (value === null) {
      return { kind: "null" };
    }
    if (value === undefined) {
      return UNKNOWN_TYPE;
    }
    if (typeof value === "string") {
      return STRING_TYPE;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? NUMBER_TYPE : UNKNOWN_TYPE;
    }
    if (typeof value === "boolean") {
      return BOOLEAN_TYPE;
    }
    if (Array.isArray(value)) {
      return { kind: "array", items: unionType(value.map((item) => this.valueToType(item))) };
    }
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      return {
        kind: "object",
        properties: Object.fromEntries(entries.map(([key, child]) => [key, this.valueToType(child)])),
        required: entries.map(([key]) => key)
      };
    }
    return UNKNOWN_TYPE;
  }

  isAssignable(source: AutomationType, target: AutomationType): boolean {
    return automationTypeAssignable(source, target);
  }

  format(type: AutomationType): string {
    if (type.kind === "array") {
      return `array<${this.format(type.items ?? UNKNOWN_TYPE)}>`;
    }
    if (type.kind === "union") {
      return (type.options ?? []).map((option) => this.format(option)).join(" | ") || "unknown";
    }
    return type.kind;
  }
}

function unionType(types: AutomationType[]): AutomationType {
  const unique = Array.from(new Map(types.map((type) => [JSON.stringify(type), type])).values());
  if (unique.length === 0) {
    return { kind: "never" };
  }
  return unique.length === 1 ? unique[0]! : { kind: "union", options: unique };
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordOfRecords(value: unknown): Record<string, Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, Record<string, unknown>] => typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]))
  );
}

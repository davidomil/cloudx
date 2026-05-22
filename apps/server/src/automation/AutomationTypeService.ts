import type { AutomationType } from "@cloudx/shared";

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
      const primitive = schema.enum.find((value) => value !== null);
      if (typeof primitive === "string") {
        return STRING_TYPE;
      }
      if (typeof primitive === "number") {
        return NUMBER_TYPE;
      }
      if (typeof primitive === "boolean") {
        return BOOLEAN_TYPE;
      }
    }
    return UNKNOWN_TYPE;
  }

  isAssignable(source: AutomationType, target: AutomationType): boolean {
    if (target.kind === "unknown" || source.kind === "never") {
      return true;
    }
    if (source.kind === "unknown") {
      return false;
    }
    if (source.kind === "union") {
      return (source.options ?? []).every((option) => this.isAssignable(option, target));
    }
    if (target.kind === "union") {
      return (target.options ?? []).some((option) => this.isAssignable(source, option));
    }
    if (source.kind !== target.kind) {
      return false;
    }
    if (source.kind === "array" && target.kind === "array") {
      return this.isAssignable(source.items ?? UNKNOWN_TYPE, target.items ?? UNKNOWN_TYPE);
    }
    if (source.kind === "object" && target.kind === "object") {
      const sourceProperties = source.properties ?? {};
      const targetProperties = target.properties ?? {};
      for (const required of target.required ?? []) {
        if (!sourceProperties[required]) {
          return false;
        }
      }
      return Object.entries(targetProperties).every(([key, targetType]) => {
        const sourceType = sourceProperties[key];
        return !sourceType || this.isAssignable(sourceType, targetType);
      });
    }
    return true;
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

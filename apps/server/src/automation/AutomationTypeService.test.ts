import { describe, expect, it } from "vitest";

import type { JsonSchemaLike } from "@cloudx/plugin-api";

import { AutomationTypeService, NUMBER_TYPE, STRING_TYPE, UNKNOWN_TYPE } from "./AutomationTypeService.js";

describe("AutomationTypeService", () => {
  it("converts JSON schema objects to automation types", () => {
    const service = new AutomationTypeService();

    expect(
      service.schemaToType({
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "integer" }
        },
        required: ["name"]
      })
    ).toEqual({
      kind: "object",
      properties: {
        name: { kind: "string" },
        count: { kind: "number" }
      },
      required: ["name"]
    });
  });

  it("preserves mixed JSON Schema enum value types as unions", () => {
    const service = new AutomationTypeService();

    const schema: JsonSchemaLike = { enum: ["off", null, 42, true] };

    expect(service.schemaToType(schema)).toEqual({
      kind: "union",
      options: [STRING_TYPE, { kind: "null" }, NUMBER_TYPE, { kind: "boolean" }]
    });
  });

  it("supports JSON Schema type arrays and const values exposed through the plugin API", () => {
    const service = new AutomationTypeService();

    const nullableString: JsonSchemaLike = { type: ["string", "null"] };
    const literalNumber: JsonSchemaLike = { const: 42 };

    expect(service.schemaToType(nullableString)).toEqual({
      kind: "union",
      options: [STRING_TYPE, { kind: "null" }]
    });
    expect(service.schemaToType(literalNumber)).toEqual(NUMBER_TYPE);
  });

  it("allows exact, subtype, and unknown-target assignments only", () => {
    const service = new AutomationTypeService();

    expect(service.isAssignable(STRING_TYPE, STRING_TYPE)).toBe(true);
    expect(service.isAssignable(STRING_TYPE, UNKNOWN_TYPE)).toBe(true);
    expect(service.isAssignable(UNKNOWN_TYPE, STRING_TYPE)).toBe(false);
    expect(service.isAssignable(STRING_TYPE, NUMBER_TYPE)).toBe(false);
    expect(
      service.isAssignable(
        { kind: "object", properties: { name: STRING_TYPE, count: NUMBER_TYPE }, required: ["name", "count"] },
        { kind: "object", properties: { name: STRING_TYPE }, required: ["name"] }
      )
    ).toBe(true);
    expect(
      service.isAssignable(
        { kind: "object", properties: { name: STRING_TYPE }, required: [] },
        { kind: "object", properties: { name: STRING_TYPE }, required: ["name"] }
      )
    ).toBe(false);
  });

  it("infers concrete value types for configured node defaults", () => {
    const service = new AutomationTypeService();

    expect(service.valueToType(["a", "b"])).toEqual({ kind: "array", items: STRING_TYPE });
    expect(service.valueToType([])).toEqual({ kind: "array", items: { kind: "never" } });
    expect(service.valueToType({ name: "build", count: 2 })).toEqual({
      kind: "object",
      properties: { name: STRING_TYPE, count: NUMBER_TYPE },
      required: ["name", "count"]
    });
  });
});

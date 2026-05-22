import { describe, expect, it } from "vitest";

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
  });
});

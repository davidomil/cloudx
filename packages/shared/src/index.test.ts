import { describe, expect, it } from "vitest";
import { parseVoiceActionPlan } from "./index.js";

describe("parseVoiceActionPlan", () => {
  it("accepts a valid structured plan", () => {
    const plan = parseVoiceActionPlan({
      transcript: "type hello",
      summary: "Enter text in the active tab.",
      actions: [{ action: "enter_text", input: { text: "hello" } }]
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.action).toBe("enter_text");
  });

  it("rejects malformed actions", () => {
    expect(() =>
      parseVoiceActionPlan({
        transcript: "switch",
        summary: "",
        actions: [{ input: {} }]
      })
    ).toThrow(/action name/);
  });
});

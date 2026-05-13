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

  it("strips null optional input fields emitted by strict structured output schemas", () => {
    const plan = parseVoiceActionPlan({
      transcript: "list folder",
      summary: "List files.",
      actions: [
        {
          id: null,
          targetTabId: null,
          pluginId: null,
          action: "enter_text",
          input: { text: "ls", submit: true, key: null, tabId: null, title: null, relativePath: null, url: null },
          reason: null
        }
      ]
    });

    expect(plan.actions[0]).toEqual({
      action: "enter_text",
      input: { text: "ls", submit: true }
    });
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

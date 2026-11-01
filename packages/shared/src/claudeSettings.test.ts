import { describe, expect, it } from "vitest";

import { CLAUDE_UPDATE_CHANNELS, claudeModelEffort } from "./claudeSettings.js";

describe("reviewed Claude settings contract", () => {
  it("offers only the native latest and stable update channels", () => {
    expect(CLAUDE_UPDATE_CHANNELS).toEqual(["latest", "stable"]);
  });

  it("keeps model-dependent reference defaults and supported effort levels distinct", () => {
    expect(claudeModelEffort("claude-opus-5-5")).toMatchObject({ referenceDefault: "medium", levels: ["low", "medium", "high", "xhigh"] });
    expect(claudeModelEffort("claude-sonnet-5-5")).toMatchObject({ referenceDefault: "medium" });
    expect(claudeModelEffort("claude-haiku-5-5")).toMatchObject({ referenceDefault: "medium" });
    expect(claudeModelEffort("claude-opus-4-7")).toMatchObject({ referenceDefault: "xhigh" });
    expect(claudeModelEffort("claude-opus-4-6")).toMatchObject({ referenceDefault: "high", levels: ["low", "medium", "high"] });
    expect(claudeModelEffort("claude-fable-5-1")).toMatchObject({ referenceDefault: "high" });
  });

  it("normalizes native dated and context model names without guessing aliases or future capabilities", () => {
    expect(claudeModelEffort("claude-opus-4-6-20260205[1m]")?.model).toBe("claude-opus-4-6");
    for (const model of ["opus", "default", "claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-opus-9", "gateway-opus"])
      expect(claudeModelEffort(model)).toBeUndefined();
  });
});

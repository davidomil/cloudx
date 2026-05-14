import { describe, expect, it } from "vitest";

import { normalizeUiScale, scaledTerminalFontSize, uiScaleFactor } from "./uiScale.js";

describe("uiScale", () => {
  it("normalizes missing and out-of-range scale values", () => {
    expect(normalizeUiScale(undefined)).toBe(100);
    expect(normalizeUiScale("large")).toBe(100);
    expect(normalizeUiScale(50)).toBe(75);
    expect(normalizeUiScale(175)).toBe(150);
  });

  it("formats CSS scale factors", () => {
    expect(uiScaleFactor(100)).toBe("1");
    expect(uiScaleFactor(125)).toBe("1.25");
  });

  it("scales terminal font sizes from the same percentage", () => {
    expect(scaledTerminalFontSize(13, 100)).toBe(13);
    expect(scaledTerminalFontSize(13, 125)).toBe(16);
  });
});

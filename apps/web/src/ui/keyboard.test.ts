import { describe, expect, it } from "vitest";

import { shouldSubmitVoiceConsoleKey } from "./keyboard.js";

describe("shouldSubmitVoiceConsoleKey", () => {
  it("submits on plain Enter", () => {
    expect(shouldSubmitVoiceConsoleKey({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("keeps Shift+Enter for multiline input", () => {
    expect(shouldSubmitVoiceConsoleKey({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("ignores IME composition Enter", () => {
    expect(shouldSubmitVoiceConsoleKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });
});

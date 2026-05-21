import { describe, expect, it } from "vitest";

import { bottomRevealScrollDelta, rowsFittingTerminalViewport, shouldFocusTerminalAfterFit, visualViewportBottomInset } from "./terminalSizing.js";

describe("terminal sizing", () => {
  it("keeps rows unchanged when the rendered terminal screen fits the viewport", () => {
    expect(rowsFittingTerminalViewport(21, 357, 357)).toBe(21);
  });

  it("removes enough rows to keep the rendered terminal screen inside the viewport", () => {
    expect(rowsFittingTerminalViewport(21, 350, 357)).toBe(20);
  });

  it("never returns fewer than one row", () => {
    expect(rowsFittingTerminalViewport(1, 1, 100)).toBe(1);
  });

  it("focuses the terminal after activation fits but not viewport change fits", () => {
    expect(shouldFocusTerminalAfterFit({ active: true, trigger: "activation" })).toBe(true);
    expect(shouldFocusTerminalAfterFit({ active: true, trigger: "viewport-change" })).toBe(false);
    expect(shouldFocusTerminalAfterFit({ active: false, trigger: "activation" })).toBe(false);
  });

  it("computes bottom space covered below the visual viewport", () => {
    expect(visualViewportBottomInset({ layoutViewportHeight: 800, visualViewportHeight: 500, visualViewportOffsetTop: 0 })).toBe(300);
    expect(visualViewportBottomInset({ layoutViewportHeight: 800, visualViewportHeight: 620, visualViewportOffsetTop: 80 })).toBe(100);
  });

  it("clamps visual viewport inset when the visual viewport fills or exceeds the layout viewport", () => {
    expect(visualViewportBottomInset({ layoutViewportHeight: 800, visualViewportHeight: 800, visualViewportOffsetTop: 0 })).toBe(0);
    expect(visualViewportBottomInset({ layoutViewportHeight: 800, visualViewportHeight: 820, visualViewportOffsetTop: 0 })).toBe(0);
    expect(visualViewportBottomInset({ layoutViewportHeight: 800 })).toBe(0);
  });

  it("computes how far to scroll to reveal a bottom edge above a visible bottom", () => {
    expect(bottomRevealScrollDelta({ targetBottom: 720, visibleBottom: 800, margin: 12 })).toBe(0);
    expect(bottomRevealScrollDelta({ targetBottom: 810, visibleBottom: 800, margin: 12 })).toBe(22);
    expect(bottomRevealScrollDelta({ targetBottom: Number.NaN, visibleBottom: 800, margin: 12 })).toBe(0);
  });
});

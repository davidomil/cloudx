import { describe, expect, it } from "vitest";

import { rowsFittingTerminalViewport } from "./terminalSizing.js";

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
});

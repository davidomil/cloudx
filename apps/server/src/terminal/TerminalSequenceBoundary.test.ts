import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

import { TerminalSequenceBoundary } from "./TerminalSequenceBoundary.js";

describe("incomplete terminal sequences", () => {
  it("bounds retained UTF-8 bytes across chunks while allowing complete output beyond the bound", () => {
    const terminal = new Terminal();
    const boundary = new TerminalSequenceBoundary(terminal, 12);
    expect(boundary.takeComplete("x".repeat(100))).toBe("x".repeat(100));
    expect(boundary.takeComplete("\x1b]2;漢")).toBe("");
    expect(boundary.takeComplete("漢")).toBe("");
    expect(boundary.pending).toBe("\x1b]2;漢漢");
    expect(() => boundary.takeComplete("漢")).toThrow("byte limit");
    terminal.dispose();
  });

  it("releases pending fragments when the sequence completes and frames the next sequence", () => {
    const terminal = new Terminal();
    const boundary = new TerminalSequenceBoundary(terminal, 12);
    expect(boundary.takeComplete("before\x1b]2;漢")).toBe("before");
    expect(boundary.takeComplete("漢\x07after\x1b[31")).toBe("\x1b]2;漢漢\x07after");
    expect(boundary.pending).toBe("\x1b[31");
    expect(boundary.takeComplete("mRED")).toBe("\x1b[31mRED");
    expect(boundary.pending).toBe("");
    terminal.dispose();
  });
});

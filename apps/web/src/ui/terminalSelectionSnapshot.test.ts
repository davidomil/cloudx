// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalSelectionSnapshot } from "./terminalSelectionSnapshot.js";

const terminals: Terminal[] = [];
afterEach(() => {
  terminals.splice(0).forEach(terminal => terminal.dispose());
  vi.unstubAllGlobals();
});

async function buffer(text: string, cols = 12) {
  const terminal = new Terminal({ cols, rows: 6, allowProposedApi: true });
  terminals.push(terminal);
  await new Promise<void>(resolve => terminal.write(text, resolve));
  return terminal;
}

describe("terminal selection snapshot", () => {
  it("extends the original range after source cells are replaced", async () => {
    const terminal = await buffer("beginning\r\n  middle\r\nend");
    const snapshot = new TerminalSelectionSnapshot(terminal.buffer.active, terminal.cols);
    expect(snapshot.selection({ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } })).toBe("begin");
    await new Promise<void>(resolve => terminal.write("\x1bcreplacement", resolve));
    expect(snapshot.selection({ start: { x: 0, y: 0 }, end: { x: 3, y: 2 } })).toBe("beginning\n  middle\nend");
  });

  it("keeps wrapped text, indentation, wide and combining characters and explicit trailing spaces", async () => {
    const terminal = await buffer("  界e\u0301 café  \r\n    wrapped-text-and-end");
    const snapshot = new TerminalSelectionSnapshot(terminal.buffer.active, terminal.cols);
    expect(snapshot.selection({ start: { x: 0, y: 0 }, end: { x: 12, y: 2 } })).toBe("  界e\u0301 café  \n    wrapped-text-and-end");
    expect(snapshot.selection({ start: { x: 2, y: 0 }, end: { x: 5, y: 0 } })).toBe("界e\u0301");
  });

  it("copies UTF-16 characters by terminal cells and normalizes nonbreaking spaces", async () => {
    const terminal = await buffer("🙂\u00a0end");
    const snapshot = new TerminalSelectionSnapshot(terminal.buffer.active, terminal.cols);
    expect(snapshot.selection({ start: { x: 0, y: 0 }, end: { x: 12, y: 0 } })).toBe("🙂 end");
    expect(snapshot.selection({ start: { x: 2, y: 0 }, end: { x: 5, y: 0 } })).toBe("end");
  });

  it("uses Windows line endings and ignores rows beyond the saved buffer", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const terminal = await buffer("first\r\nsecond");
    const snapshot = new TerminalSelectionSnapshot(terminal.buffer.active, terminal.cols);
    expect(snapshot.selection({ start: { x: 0, y: 0 }, end: { x: 6, y: 1 } })).toBe("first\r\nsecond");
    expect(snapshot.selection({ start: { x: 0, y: 6 }, end: { x: 6, y: 9 } })).toBe("");
  });

  it("keeps rectangular selections separate even when rows are wrapped", async () => {
    const terminal = await buffer("aaaa1111bbbb2222cccc3333");
    const snapshot = new TerminalSelectionSnapshot(terminal.buffer.active, terminal.cols);
    expect(snapshot.selection({ start: { x: 8, y: 0 }, end: { x: 4, y: 1 } }, true)).toBe("1111\ncccc");
  });

  it("expands words using terminal separators across wrapped Unicode cells", async () => {
    const terminal = await buffer("firstword secondword 界café");
    const snapshot = new TerminalSelectionSnapshot(terminal.buffer.active, terminal.cols);
    const word = snapshot.wordAt({ x: 2, y: 1 }, " ")!;
    expect(snapshot.selection(word)).toBe("secondword");
    const unicode = snapshot.wordAt({ x: 11, y: 1 }, " ")!;
    expect(snapshot.selection(unicode)).toBe("界café");
    expect(snapshot.wordAt({ x: 12, y: 0 }, " ")).toBeUndefined();
    expect(snapshot.wordAt({ x: 0, y: 9 }, " ")).toBeUndefined();
  });

  it("keeps whitespace groups distinct and respects custom separators", async () => {
    const terminal = await buffer("one   two/end");
    const snapshot = new TerminalSelectionSnapshot(terminal.buffer.active, terminal.cols);
    expect(snapshot.selection(snapshot.wordAt({ x: 4, y: 0 }, " /")!)).toBe("   ");
    expect(snapshot.selection(snapshot.wordAt({ x: 7, y: 0 }, " /")!)).toBe("two");
  });
});

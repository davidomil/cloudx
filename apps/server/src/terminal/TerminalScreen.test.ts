import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

import { TerminalScreen } from "./TerminalScreen.js";

describe("terminal screen recovery", () => {
  it.each(["normal", "alternate", "origin"])("retains protected rows and the cursor in the %s scrolling region", async (mode) => {
    const screen = new TerminalScreen(20, 6);
    screen.write(`${mode === "alternate" ? "\x1b[?1049h" : ""}HEADER\r\nONE\r\nTWO\r\nTHREE\r\nFOOTER\x1b[2;4r`);
    screen.write(mode === "origin" ? "\x1b[?6h\x1b[3;1H" : "\x1b[4;1H");
    const restored = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    await writeTerminal(restored, (await screen.snapshot()).data);
    await writeTerminal(restored, "\r\nNEXT");
    expect(visibleRows(restored).slice(0, 5)).toEqual(["HEADER", "TWO", "THREE", "NEXT", "FOOTER"]);
    await screen.dispose();
    restored.dispose();
  });

  it.each(["\x1b[r", "\x1b[!p", "\x1bc"])("retains scrolling-region reset %j", async (reset) => {
    const screen = new TerminalScreen(20, 6);
    screen.write(`\x1b[2;4r${reset}\x1b[4;1HLAST`);
    const restored = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    await writeTerminal(restored, (await screen.snapshot()).data + "\r\nNEXT");
    expect(visibleRows(restored)[4]).toBe("NEXT");
    await screen.dispose();
    restored.dispose();
  });

  it.each(["normal", "alternate"])("retains pending wrap and cell styles with %s scroll margins", async (mode) => {
    const screen = new TerminalScreen(20, 6);
    const expected = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    const restored = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    const prefix = `${mode === "alternate" ? "\x1b[?1049h" : ""}\x1b[2;4r\x1b[3;1H123456789012345678\x1b[31m漢\x1b[32m`;
    screen.write(prefix);
    await writeTerminal(expected, prefix + "Z");
    await writeTerminal(restored, (await screen.snapshot()).data + "Z");
    expect(visibleRows(restored)).toEqual(visibleRows(expected));
    expect(restored.buffer.active.getLine(2)?.getCell(18)?.getFgColor()).toBe(1);
    expect(restored.buffer.active.getLine(3)?.getCell(0)?.getFgColor()).toBe(2);
    await screen.dispose();
    expected.dispose();
    restored.dispose();
  });

  it("restores the normal buffer's margins when returning from the alternate screen", async () => {
    const screen = new TerminalScreen(20, 6);
    screen.write("HEADER\r\nONE\r\nTWO\r\nTHREE\r\nFOOTER\x1b[2;4r\x1b[4;1H\x1b[?1049hALT");
    const restored = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    await writeTerminal(restored, (await screen.snapshot()).data + "\x1b[?1049l\r\nNEXT");
    expect(visibleRows(restored).slice(0, 5)).toEqual(["HEADER", "TWO", "THREE", "NEXT", "FOOTER"]);
    await screen.dispose();
    restored.dispose();
  });

  it("restores origin-mode cursor positioning with default scroll margins", async () => {
    const screen = new TerminalScreen(20, 6);
    screen.write("\x1b[?6h\x1b[4;1HHERE");
    const restored = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    await writeTerminal(restored, (await screen.snapshot()).data + "!");
    expect(visibleRows(restored)[3]).toBe("HERE!");
    await screen.dispose();
    restored.dispose();
  });

  it.each([
    ["CSI", "\x1b[31mRED"],
    ["CSI subparameters", "\x1b[38:2::12:34:56mRGB"],
    ["OSC BEL", "\x1b]2;window title\x07DONE"],
    ["OSC ST", "\x1b]2;window title\x1b\\DONE"],
    ["C1 OSC", "\x9d2;window title\x9cDONE"],
    ["DCS", "\x1bP$qm\x1b\\DONE"],
    ["cancelled CSI", "\x1b[31\x18DONE"],
    ["CSI containing a line feed", "\x1b[31\nmRED"],
    ["CSI containing an ignored BOM", "\x1b[31\ufeffmRED"],
    ["split Unicode", "🙂漢字"],
  ])("preserves every split of %s across snapshot and live output", async (_name, sequence) => {
    const expected = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    await writeTerminal(expected, `MARKER ${sequence}`);
    for (let split = 1; split < sequence!.length; split++) {
      const screen = new TerminalScreen(40, 6);
      const restored = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
      const replacement = new TerminalScreen();
      const titles: string[] = [];
      restored.onTitleChange((title) => titles.push(title));
      screen.write(`MARKER ${sequence!.slice(0, split)}`);
      const attached = await screen.attach((data) => restored.write(data));
      await writeTerminal(restored, attached.screen.data);
      replacement.restore(attached.screen);
      screen.write(sequence!.slice(split));
      replacement.write(sequence!.slice(split));
      await screen.flush();
      await writeTerminal(restored, "");
      expect(visibleRows(restored), `split ${split}`).toEqual(visibleRows(expected));
      expect(restored.buffer.active.getLine(0)?.getCell(7)?.getFgColor()).toBe(expected.buffer.active.getLine(0)?.getCell(7)?.getFgColor());
      const replaced = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
      await writeTerminal(replaced, (await replacement.snapshot()).data);
      expect(visibleRows(replaced), `replacement split ${split}`).toEqual(visibleRows(expected));
      if (_name!.includes("OSC") && split < sequence!.indexOf("DONE")) expect(titles).toEqual(["window title"]);
      await screen.dispose();
      await replacement.dispose();
      restored.dispose();
      replaced.dispose();
    }
    expected.dispose();
  });

  it("rejects excessive dimensions before changing the screen", async () => {
    expect(() => new TerminalScreen(10_000, 10_000)).toThrow("cell limit");
    const screen = new TerminalScreen();
    expect(() => screen.resize(10_000, 10_000)).toThrow("cell limit");
    expect(await screen.snapshot()).toMatchObject({ cols: 100, rows: 30 });
    screen.dispose();
  });

  it("marks an overflowing screen unrecoverable and releases its subscriptions", async () => {
    const screen = new TerminalScreen();
    await screen.attach(() => undefined);
    expect(() => screen.write("x".repeat(32 * 1024 * 1024 + 1))).toThrow("pending byte limit");
    await expect(screen.snapshot()).rejects.toThrow("pending byte limit");
    await expect(screen.attach(() => undefined)).rejects.toThrow("pending byte limit");
    screen.dispose();
    expect(() => screen.write("late process output")).not.toThrow();
    await expect(screen.attach(() => undefined)).rejects.toThrow("disposed");
  });

  it("reports listener failures through snapshot rejection instead of the xterm callback", async () => {
    const screen = new TerminalScreen();
    await screen.attach(() => { throw new Error("listener failed"); });
    screen.write("output");
    await expect(screen.snapshot()).rejects.toThrow("listener failed");
    screen.dispose();
  });

  it("drains final process output before disposing subscriptions", async () => {
    const screen = new TerminalScreen();
    const live: string[] = [];
    await screen.attach((data) => live.push(data));
    screen.write("final process output");
    await screen.dispose();
    expect(live).toEqual(["final process output"]);
  });

  it("retains alternate screen and input modes after their sequences leave the raw replay tail", async () => {
    const screen = new TerminalScreen(80, 24);
    screen.write("normal screen\r\n\x1b[?1049h\x1b[?1h\x1b[?2004h");
    screen.write("x".repeat(1024 * 1024 + 100));
    screen.write("\x1b[2J\x1b[Hcurrent application");
    const snapshot = await screen.snapshot();
    const restored = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((resolve) => restored.write(snapshot.data, resolve));

    expect(restored.buffer.active.type).toBe("alternate");
    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("current application");
    expect(restored.modes.applicationCursorKeysMode).toBe(true);
    expect(restored.modes.bracketedPasteMode).toBe(true);
    expect(restored.buffer.normal.getLine(0)?.translateToString(true)).toBe("normal screen");
    screen.dispose();
    restored.dispose();
  });

  it("cuts the snapshot and live subscription at the same parsed output position", async () => {
    const screen = new TerminalScreen();
    const live: string[] = [];
    screen.write("before");
    const attaching = screen.attach((data) => live.push(data));
    screen.write("after");
    const attached = await attaching;
    await screen.snapshot();

    expect(attached.screen.data).toBe("before");
    expect(live).toEqual(["after"]);
    attached.dispose();
    screen.write("unsubscribed");
    await screen.snapshot();
    expect(live).toEqual(["after"]);
    screen.dispose();
  });

  it("restores an authoritative screen at its original size before applying later output", async () => {
    const original = new TerminalScreen(60, 15);
    original.write("\x1b[?1h\x1b[?2004h\x1b[?1049hbefore");
    const replacement = new TerminalScreen();
    replacement.write("truncated raw tail");
    replacement.restore(await original.snapshot());
    replacement.write("after");
    replacement.resize(70, 20);
    const snapshot = await replacement.snapshot();

    expect(snapshot.cols).toBe(70);
    expect(snapshot.rows).toBe(20);
    expect(snapshot.data).toContain("beforeafter");
    expect(snapshot.data).not.toContain("truncated raw tail");
    expect(snapshot.data).toContain("\x1b[?1h");
    expect(snapshot.data).toContain("\x1b[?2004h");
    original.dispose();
    replacement.dispose();
  });
});

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function visibleRows(terminal: Terminal): string[] {
  return Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)?.translateToString(true) ?? "");
}

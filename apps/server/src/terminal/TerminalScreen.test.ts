import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

import { TerminalScreen } from "./TerminalScreen.js";

describe("terminal screen recovery", () => {
  it.each([
    ["SGR", "\x1b[?1006h", "SGR"],
    ["SGR pixels", "\x1b[?1016h", "SGR_PIXELS"],
    ["disabled SGR", "\x1b[?1006h\x1b[?1006l", "DEFAULT"],
    ["reset SGR", "\x1b[?1006h\x1bc", "DEFAULT"],
  ])("retains %s mouse encoding through repeated screen restoration", async (_name, setup, encoding) => {
    const screen = new TerminalScreen(20, 6);
    const replacement = new TerminalScreen();
    const restored = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    try {
      screen.write(`\x1b[?1000h${setup}READY`);
      replacement.restore(await screen.snapshot());
      await writeTerminal(restored, (await replacement.snapshot()).data);
      expect((restored as unknown as { _core: { coreMouseService: { activeEncoding: string } } })._core.coreMouseService.activeEncoding).toBe(encoding);
    } finally {
      await screen.dispose();
      await replacement.dispose();
      restored.dispose();
    }
  });

  it.each([
    ["normal DECSC", "", "\x1b7", "\x1b8"],
    ["alternate DECSC", "\x1b[?1049h", "\x1b7", "\x1b8"],
    ["ANSI cursor", "", "\x1b[s", "\x1b[u"],
    ["private cursor", "", "\x1b[?1048h", "\x1b[?1048l"],
  ])("retains %s position and attributes without moving the active cursor", async (_name, buffer, save, restore) => {
    const setup = `${buffer}HEADER\x1b[3;1HITEM: \x1b[1;3;4;31;44m${save}\x1b[0;32m\x1b[5;1HFOOTER`;
    await expectContinuedScreen(setup, `!${restore}DONE`);
  });

  it.each([
    ["saved normal cursor after alternate switch", "HEADER\x1b[3;1HITEM: \x1b[31m\x1b7\x1b[0m\x1b[5;1HFOOTER\x1b[?47hALT", "\x1b[?1049lDONE"],
    ["independent saved cursors in both buffers", "HEADER\x1b[3;1HITEM: \x1b[31m\x1b[?1049h\x1b[2;1HALT: \x1b[34m\x1b7\x1b[0m\x1b[5;1HFOOTER", "\x1b8DONE\x1b[?1049lDONE"],
    ["scroll margins and origin mode", "HEADER\x1b[5;1HFOOTER\x1b[2;4r\x1b[?6h\x1b[2;1HITEM: \x1b[31m\x1b7\x1b[32m\x1b[3;1HEND", "!\x1b8DONE"],
    ["saved cursor in scrollback", "\x1b[31m\x1b7" + "LINE\r\n".repeat(12) + "\x1b[0mFOOTER", "!\x1b8DONE"],
    ["pending wrap", "\x1b[3;1HITEM: \x1b7\x1b[5;1H123456789012345678\x1b[31m漢\x1b[32m", "!\x1b8DONE"],
    ["saved truecolor and indexed colors", "\x1b[3;1HITEM: \x1b[38;2;12;34;56;48;5;123;2;7;9;53m\x1b7\x1b[0m\x1b[5;1HFOOTER", "!\x1b8DONE"],
    ["saved blinking and invisible text", "\x1b[3;1HITEM: \x1b[38;5;123;48;2;12;34;56;5;8m\x1b7\x1b[0m\x1b[5;1HFOOTER", "!\x1b8DONE"],
    ["reset saved cursor", "\x1b[3;1H\x1b[31m\x1b7\x1bcHEADER\x1b[5;1HFOOTER", "!\x1b8DONE"],
  ])("preserves %s while continuing after restoration", async (_name, setup, continuation) => {
    await expectContinuedScreen(setup!, continuation!);
  });

  it.each([
    ["oldest saved row", 0, 100, 26, false],
    ["saved row revealed by growth", 7, 8, 16, false],
    ["saved row deep in history", 40, 100, 126, false],
    ["full scrollback", 0, 1100, 26, false],
    ["normal cursor while alternate buffer is active", 7, 8, 16, true],
  ] as const)("preserves %s when growing after repeated restoration", async (_name, savedRow, outputRows, rows, alternate) => {
    const screen = new TerminalScreen(20, 6);
    const replacement = new TerminalScreen();
    const expected = new Terminal({ cols: 20, rows: 6, scrollback: 1000, allowProposedApi: true });
    const restored = new Terminal({ cols: 20, rows: 6, scrollback: 1000, allowProposedApi: true });
    const setup = "BEFORE\r\n".repeat(savedRow) + "ITEM: \x1b[3;31m\x1b7\x1b[0m\r\n"
      + Array.from({ length: outputRows }, (_, row) => `LINE ${row}\r\n`).join("") + "FOOTER"
      + (alternate ? "\x1b[?47hALTERNATE" : "");
    const continuation = (alternate ? "\x1b[?47l" : "") + "\x1b8DONE";
    try {
      screen.write(setup);
      await writeTerminal(expected, setup);
      replacement.restore(await screen.snapshot());
      await writeTerminal(restored, (await replacement.snapshot()).data);
      expected.resize(20, rows);
      restored.resize(20, rows);
      replacement.resize(20, rows);
      await writeTerminal(expected, continuation);
      await writeTerminal(restored, continuation);
      replacement.write(continuation);
      expect(visibleRows(restored)).toEqual(visibleRows(expected));
      expect(restored.buffer.active.baseY).toBe(expected.buffer.active.baseY);
      expect(restored.buffer.active.cursorY).toBe(expected.buffer.active.cursorY);
      const doneRow = expected.buffer.active.baseY + expected.buffer.active.cursorY;
      for (const terminal of [expected, restored]) {
        const done = terminal.buffer.active.getLine(doneRow)?.getCell(6);
        expect(done?.getChars()).toBe("D");
        expect(done?.getFgColor()).toBe(1);
        expect(done?.isItalic()).toBeTruthy();
      }
      restored.reset();
      await writeTerminal(restored, (await replacement.snapshot()).data);
      expect(visibleRows(restored)).toEqual(visibleRows(expected));
    } finally {
      await screen.dispose();
      await replacement.dispose();
      expected.dispose();
      restored.dispose();
    }
  });

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

async function expectContinuedScreen(setup: string, continuation: string): Promise<void> {
  const screen = new TerminalScreen(20, 6);
  const replacement = new TerminalScreen();
  const expected = new Terminal({ cols: 20, rows: 6, scrollback: 1000, allowProposedApi: true });
  const restored = new Terminal({ cols: 20, rows: 6, scrollback: 1000, allowProposedApi: true });
  try {
    screen.write(setup);
    await writeTerminal(expected, setup + continuation);
    replacement.restore(await screen.snapshot());
    await writeTerminal(restored, (await replacement.snapshot()).data + continuation);
    for (const kind of ["normal", "alternate"] as const) {
      const expectedBuffer = expected.buffer[kind];
      const actualBuffer = restored.buffer[kind];
      for (let y = 0; y < expected.rows; y++) {
        const expectedLine = expectedBuffer.getLine(expectedBuffer.baseY + y);
        const actualLine = actualBuffer.getLine(actualBuffer.baseY + y);
        expect(actualLine?.translateToString(true), `${kind} row ${y}`).toBe(expectedLine?.translateToString(true));
        for (let x = 0; x < expected.cols; x++) {
          const expectedCell = expectedLine?.getCell(x);
          const actualCell = actualLine?.getCell(x);
          for (const attribute of ["getFgColor", "getBgColor", "isBold", "isItalic", "isUnderline", "isInverse", "isDim", "isBlink", "isInvisible", "isStrikethrough", "isOverline"] as const) {
            expect(actualCell?.[attribute](), `${kind} row ${y} col ${x} ${attribute}`).toBe(expectedCell?.[attribute]());
          }
        }
      }
    }
  } finally {
    await screen.dispose();
    await replacement.dispose();
    expected.dispose();
    restored.dispose();
  }
}

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function visibleRows(terminal: Terminal): string[] {
  return Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)?.translateToString(true) ?? "");
}

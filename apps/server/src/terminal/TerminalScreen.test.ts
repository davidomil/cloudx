import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

import { TerminalScreen } from "./TerminalScreen.js";

describe("terminal screen recovery", () => {
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

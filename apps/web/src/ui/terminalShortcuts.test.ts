import { describe, expect, it, vi } from "vitest";
import { sendTerminalShortcut, type TerminalShortcut } from "./terminalShortcuts.js";

function connectedTerminal() {
  return {
    active: true,
    connected: true,
    disposed: false,
    terminal: { input: vi.fn(), focus: vi.fn(), modes: { applicationCursorKeysMode: false }, options: { disableStdin: false } }
  };
}

describe("terminal shortcuts", () => {
  it.each<[TerminalShortcut, string]>([
    ["escape", "\x1b"], ["tab", "\t"], ["interrupt", "\x03"], ["enter", "\r"],
    ["left", "\x1b[D"], ["down", "\x1b[B"], ["up", "\x1b[A"], ["right", "\x1b[C"]
  ])("sends %s as native user input and restores terminal focus", (shortcut, sequence) => {
    const target = connectedTerminal();
    expect(sendTerminalShortcut(target, shortcut)).toBe(true);
    expect(target.terminal.input).toHaveBeenCalledExactlyOnceWith(sequence, true);
    expect(target.terminal.focus).toHaveBeenCalledOnce();
  });

  it.each<[TerminalShortcut, string]>([["left", "D"], ["down", "B"], ["up", "A"], ["right", "C"]])("uses the live application cursor mode for %s", (shortcut, suffix) => {
    const target = connectedTerminal();
    target.terminal.modes.applicationCursorKeysMode = true;
    sendTerminalShortcut(target, shortcut);
    expect(target.terminal.input).toHaveBeenLastCalledWith(`\x1bO${suffix}`, true);
    target.terminal.modes.applicationCursorKeysMode = false;
    sendTerminalShortcut(target, shortcut);
    expect(target.terminal.input).toHaveBeenLastCalledWith(`\x1b[${suffix}`, true);
  });

  it.each([[undefined, "\x1b[13;2u"], ["modified-enter", "\x1b[13;2u"], ["ctrl-j", "\n"]] as const)("uses the configured %s agent newline", (preference, sequence) => {
    const target = connectedTerminal();
    sendTerminalShortcut(target, "newline", preference);
    expect(target.terminal.input).toHaveBeenCalledExactlyOnceWith(sequence, true);
  });

  it.each(["inactive", "disconnected", "disposed", "read-only"])("does not send input or move focus when the terminal is %s", state => {
    const target = connectedTerminal();
    if (state === "inactive") target.active = false;
    if (state === "disconnected") target.connected = false;
    if (state === "disposed") target.disposed = true;
    if (state === "read-only") target.terminal.options.disableStdin = true;
    expect(sendTerminalShortcut(target, "interrupt")).toBe(false);
    expect(target.terminal.input).not.toHaveBeenCalled();
    expect(target.terminal.focus).not.toHaveBeenCalled();
  });

  it("does not send input when no terminal exists", () => {
    expect(sendTerminalShortcut(undefined, "enter")).toBe(false);
  });
});

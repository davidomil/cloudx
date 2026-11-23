import type { Terminal } from "@xterm/xterm";
import type { TerminalPreferences } from "./terminalPreferences.js";

export type TerminalShortcut = "escape" | "tab" | "interrupt" | "left" | "down" | "up" | "right" | "enter" | "newline";

export interface TerminalShortcutTarget {
  active: boolean;
  connected: boolean;
  disposed: boolean;
  terminal: Pick<Terminal, "input" | "focus"> & {
    modes: Pick<Terminal["modes"], "applicationCursorKeysMode">;
    options: Pick<Terminal["options"], "disableStdin">;
  };
}

export function sendTerminalShortcut(target: TerminalShortcutTarget | undefined, shortcut: TerminalShortcut, shiftEnter?: TerminalPreferences["shiftEnter"]): boolean {
  if (!target || !target.active || !target.connected || target.disposed || target.terminal.options.disableStdin) return false;
  const terminal = target.terminal;
  terminal.input(shortcutInput(shortcut, terminal.modes.applicationCursorKeysMode, shiftEnter), true);
  terminal.focus();
  return true;
}

function shortcutInput(shortcut: TerminalShortcut, applicationCursorKeys: boolean, shiftEnter?: TerminalPreferences["shiftEnter"]): string {
  switch (shortcut) {
    case "left":
    case "down":
    case "up":
    case "right":
      return `\x1b${applicationCursorKeys ? "O" : "["}${{ left: "D", down: "B", up: "A", right: "C" }[shortcut]}`;
    case "newline": return shiftEnter === "ctrl-j" ? "\n" : "\x1b[13;2u";
    default: return { escape: "\x1b", tab: "\t", interrupt: "\x03", enter: "\r" }[shortcut];
  }
}

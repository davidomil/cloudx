import type { TerminalShortcut } from "./terminalShortcuts.js";
import "./terminal-shortcuts.css";

const shortcuts: Array<{ key: TerminalShortcut; label: string; description: string }> = [
  { key: "escape", label: "Esc", description: "Send Escape" },
  { key: "tab", label: "Tab", description: "Send Tab" },
  { key: "interrupt", label: "Ctrl+C", description: "Send Ctrl+C to interrupt" },
  { key: "left", label: "←", description: "Send left arrow" },
  { key: "down", label: "↓", description: "Send down arrow" },
  { key: "up", label: "↑", description: "Send up arrow" },
  { key: "right", label: "→", description: "Send right arrow" },
  { key: "enter", label: "Enter", description: "Send Enter" },
  { key: "newline", label: "Newline", description: "Send configured Shift+Enter newline" }
];

export function TerminalShortcutBar({ agent, disabled, onShortcut }: {
  agent: boolean;
  disabled: boolean;
  onShortcut: (shortcut: TerminalShortcut) => void;
}) {
  return <div className="terminal-shortcut-bar" role="group" aria-label="Terminal keyboard shortcuts">
    {shortcuts.filter(shortcut => agent || shortcut.key !== "newline").map(shortcut => <button
      key={shortcut.key}
      type="button"
      aria-label={shortcut.description}
      title={shortcut.description}
      disabled={disabled}
      onPointerDown={event => event.preventDefault()}
      onClick={() => onShortcut(shortcut.key)}
    >{shortcut.label}</button>)}
  </div>;
}

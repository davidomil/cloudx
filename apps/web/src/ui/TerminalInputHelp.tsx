import { useEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { agentProviderLabel, type AgentProviderId } from "@cloudx/shared";
import { copyTextToClipboard } from "./clipboard.js";
import { onTerminalPreferencesChanged, terminalPreferenceState } from "./terminalPreferences.js";

export function TerminalInputHelp({ provider, terminal }: { provider?: AgentProviderId; terminal: () => Terminal | undefined }) {
  const [preferences, setPreferences] = useState(terminalPreferenceState);
  useEffect(() => onTerminalPreferencesChanged(() => setPreferences(terminalPreferenceState())), []);
  const [selection, setSelection] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [selectedText, setSelectedText] = useState("");
  const label = provider ? agentProviderLabel(provider) : "Agent";
  return <div className="terminal-input-help">
    {preferences.error && <p role="alert">Saved terminal preferences could not be used. Open Settings → Terminal to inspect and reset them; host defaults are active.</p>}
    <details><summary>{label} shortcuts</summary>
      <p>CloudX host: Shift+Enter sends {preferences.preferences.shiftEnter === "ctrl-j" ? "Ctrl+J" : "modified Enter (CSI-u)"}; Enter and Ctrl+J keep their native meanings. Native custom bindings and focused dialogs can change the action.</p>
      <p>Hold {/Mac/u.test(navigator.platform) ? "Option" : "Shift"} and drag to save a selection. Ctrl/Cmd+C copies saved text; Escape clears it. Without a saved selection, Ctrl+C reaches the application to cancel. Cmd+C and browser shortcuts may be reserved by the OS/browser.</p>
      {provider === "codex" ? <p>Codex 0.160.0 native defaults: Ctrl+O requests copy, Ctrl+T opens the transcript, Ctrl+R searches history, Ctrl+G requests the native external editor. Other versions and configured context bindings may differ.</p> : provider === "claude" ? <p>Claude native defaults: Ctrl+O opens the transcript, Ctrl+R searches history, Ctrl+G requests the native external editor. Inspect /keybindings for current overrides.</p> : <p>Provider shortcuts are unresolved until CloudX reads the current session capability.</p>}
      <p>Native external-editor actions run on the server in the provider environment (VISUAL/EDITOR), not this browser. CloudX has not observed their target or successful execution for this session. Links use the CloudX destination preview instead.</p>
      <p>Native copy requests, including copy-on-select, remain staged until you approve Copy in CloudX. Browser clipboard permission may still deny the write.</p>
    </details>
    <button type="button" onClick={() => {
      const current = terminal();
      if (!current) return;
      const buffer = current.buffer.active;
      const lines: string[] = [];
      for (let row = buffer.viewportY; row < Math.min(buffer.length, buffer.viewportY + current.rows); row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
      const text = lines.join("\n");
      setSelection(text);
      setSelectedText(text);
      setStatus("Visible terminal text saved. Select text below, then copy. Scroll the terminal first to select older output.");
    }}>Select visible terminal text</button>
    {selection !== undefined && <aside className="terminal-touch-selection" aria-label="Terminal text selection mode">
      <p role="status">{status}</p>
      <textarea aria-label="Visible terminal text" readOnly value={selection} onSelect={event => { const text = event.currentTarget; setSelectedText(text.value.slice(text.selectionStart, text.selectionEnd)); }} />
      <button type="button" onClick={() => { void copyTextToClipboard(selectedText).then(() => setStatus("Selected text copied."), () => setStatus("Clipboard permission denied. Select text and use the browser Copy action.")); }}>Copy selected visible text</button>
      <button type="button" onClick={() => { setSelection(undefined); setSelectedText(""); }}>Close text selection</button>
    </aside>}
  </div>;
}

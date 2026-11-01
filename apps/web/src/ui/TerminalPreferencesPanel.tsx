import { useEffect, useState } from "react";
import { onTerminalPreferencesChanged, terminalPreferenceState, saveTerminalPreferences, TERMINAL_DEFAULTS, type TerminalPreferences } from "./terminalPreferences.js";

export function TerminalPreferencesPanel() {
  const [initial] = useState(terminalPreferenceState);
  const [preferences, setPreferences] = useState(initial.preferences);
  const [error, setError] = useState<string | undefined>(initial.error);
  useEffect(() => onTerminalPreferencesChanged(() => { const next = terminalPreferenceState(); setPreferences(next.preferences); setError(next.error); }), []);
  function change(key: keyof TerminalPreferences, value: unknown) {
    const next = { ...preferences, [key]: value };
    if (value === undefined) delete next[key];
    try { saveTerminalPreferences(next); setPreferences(next); setError(undefined); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <section aria-label="CloudX terminal preferences">
    <p>Browser host preferences apply immediately to terminals in this browser and origin, including reconnects and provider switches. They do not edit native settings or restart clients. Unset inherits the CloudX default shown below.</p>
    <label>Option as Meta on macOS <select value={preferences.macOptionIsMeta === undefined ? "" : String(preferences.macOptionIsMeta)} onChange={e => change("macOptionIsMeta", e.target.value === "" ? undefined : e.target.value === "true")}>
      <option value="">Inherit — off</option><option value="true">On</option><option value="false">Off</option>
    </select></label>
    <p>Option-drag still selects text. Option-key shortcuts require Meta; physical keyboard behavior depends on the browser and OS.</p>
    <label>Terminal font family <input defaultValue={preferences.fontFamily ?? ""} placeholder={TERMINAL_DEFAULTS.fontFamily} onBlur={e => change("fontFamily", e.target.value || undefined)} /></label>
    <p>Effective font: {preferences.fontFamily ?? TERMINAL_DEFAULTS.fontFamily}. Font size follows CloudX UI scale.</p>
    <label>Scrollback lines <input type="number" min={0} max={100000} defaultValue={preferences.scrollback ?? ""} placeholder="1000" onBlur={e => change("scrollback", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
    <p>Effective scrollback: {preferences.scrollback ?? TERMINAL_DEFAULTS.scrollback} lines. Reducing it discards older output from the browser view.</p>
    <label>Link activation <select value={preferences.links ?? ""} onChange={e => change("links", e.target.value || undefined)}>
      <option value="">Inherit — confirm destination</option><option value="confirm">Confirm destination</option><option value="disabled">Disabled</option>
    </select></label>
    <p>HTTP(S) links open in your browser after confirmation. File, VS Code and Cursor citations open a guarded file preview in the originating workspace. CloudX does not launch an editor process from terminal output.</p>
    <label>Attachments <select value={preferences.attachments ?? ""} onChange={e => change("attachments", e.target.value || undefined)}>
      <option value="">Inherit — review before insertion</option><option value="review">Review before insertion</option><option value="disabled">Disabled</option>
    </select></label>
    <p>Paste/drop uploads are staged outside the native prompt. Remove staged files before insertion. After insertion, use the native prompt to check and remove its attachments; upload success does not confirm native acceptance.</p>
    <label>Shift+Enter encoding <select value={preferences.shiftEnter ?? ""} onChange={e => change("shiftEnter", e.target.value || undefined)}>
      <option value="">Inherit — native modified Enter</option><option value="modified-enter">Native modified Enter (CSI-u)</option><option value="ctrl-j">Ctrl+J newline action</option>
    </select></label>
    <p>Native modified Enter preserves Shift for native keybindings. Ctrl+J sends the native Ctrl+J action instead; custom native keybindings can change either action.</p>
    <p>Application clipboard requests always need your explicit Copy approval in CloudX, including native copy-on-select. Saving a native clipboard preference does not grant browser clipboard access.</p>
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => { try { saveTerminalPreferences({}); setPreferences({}); setError(undefined); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } }}>Reset saved terminal preferences</button></div>}
  </section>;
}

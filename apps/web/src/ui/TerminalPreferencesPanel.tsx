import { useEffect, useState } from "react";
import { onTerminalPreferencesChanged, terminalPreferenceState, saveTerminalPreferences, TERMINAL_DEFAULTS, type TerminalPreferences } from "./terminalPreferences.js";

export function TerminalPreferencesPanel() {
  const [initial] = useState(terminalPreferenceState);
  const [preferences, setPreferences] = useState(initial.preferences);
  const [error, setError] = useState<string | undefined>(initial.error);
  const [fontFamily, setFontFamily] = useState(initial.preferences.fontFamily ?? "");
  const [scrollback, setScrollback] = useState(String(initial.preferences.scrollback ?? ""));
  useEffect(() => onTerminalPreferencesChanged(() => {
    const next = terminalPreferenceState();
    setPreferences(next.preferences);
    setFontFamily(next.preferences.fontFamily ?? "");
    setScrollback(String(next.preferences.scrollback ?? ""));
    setError(next.error);
  }), []);
  function change(key: keyof TerminalPreferences, value: unknown) {
    const next = { ...terminalPreferenceState().preferences, [key]: value };
    if (value === undefined) delete next[key];
    try { saveTerminalPreferences(next); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <section aria-label="CloudX terminal preferences">
    <p>Browser host preferences apply immediately to terminals in this browser and origin, including reconnects and provider switches. They do not edit native settings or restart clients. Unset inherits the CloudX default shown below.</p>
    <label>Option as Meta on macOS <select value={preferences.macOptionIsMeta === undefined ? "" : String(preferences.macOptionIsMeta)} onChange={e => change("macOptionIsMeta", e.target.value === "" ? undefined : e.target.value === "true")}>
      <option value="">Inherit — off</option><option value="true">On</option><option value="false">Off</option>
    </select></label>
    <p>Option-drag still selects text. Option-key shortcuts require Meta; physical keyboard behavior depends on the browser and OS.</p>
    <label>Terminal font family <input value={fontFamily} onChange={e => setFontFamily(e.target.value)} placeholder={TERMINAL_DEFAULTS.fontFamily} onBlur={() => { if (fontFamily !== (preferences.fontFamily ?? "")) change("fontFamily", fontFamily || undefined); }} /></label>
    <p>Effective font: {preferences.fontFamily ?? TERMINAL_DEFAULTS.fontFamily}. Font size follows CloudX UI scale.</p>
    <label>Scrollback lines <input type="number" min={0} max={100000} value={scrollback} onChange={e => setScrollback(e.target.value)} placeholder="1000" onBlur={() => { if (scrollback !== String(preferences.scrollback ?? "")) change("scrollback", scrollback === "" ? undefined : Number(scrollback)); }} /></label>
    <p>Effective scrollback: {preferences.scrollback ?? TERMINAL_DEFAULTS.scrollback} lines. Reducing it discards older output from the browser view.</p>
    <label>Link activation <select value={preferences.links ?? ""} onChange={e => change("links", e.target.value || undefined)}>
      <option value="">Inherit — confirm destination</option><option value="confirm">Confirm destination</option><option value="disabled">Disabled</option>
    </select></label>
    <p>HTTP(S) links open in your browser after confirmation. File, VS Code and Cursor citations open a guarded file preview in the originating workspace. CloudX does not launch an editor process from terminal output.</p>
    <label>Attachments <select value={preferences.attachments ?? ""} onChange={e => change("attachments", e.target.value || undefined)}>
      <option value="">Inherit — review before insertion</option><option value="review">Review before insertion</option><option value="disabled">Disabled</option>
    </select></label>
    <p>Paste/drop uploads are staged outside the native prompt. Images, text/code files, PDF and notebooks up to 20 MiB are supported; native inclusion limits still apply. Confirm that the native prompt is ready before insertion, then check its image or editable file reference. Native acceptance is confirmed only when you select “I can see” after checking the prompt. Remove staged files in the tray; after insertion, remove native items in the native prompt. Dismissing a status does not remove a native item.</p>
    <label>Shift+Enter encoding <select value={preferences.shiftEnter ?? ""} onChange={e => change("shiftEnter", e.target.value || undefined)}>
      <option value="">Inherit — native modified Enter</option><option value="modified-enter">Native modified Enter (CSI-u)</option><option value="ctrl-j">Ctrl+J newline action</option>
    </select></label>
    <p>Native modified Enter preserves Shift for native keybindings. Ctrl+J sends the native Ctrl+J action instead; custom native keybindings can change either action.</p>
    <p>Application clipboard requests always need your explicit Copy approval in CloudX, including native copy-on-select. Saving a native clipboard preference does not grant browser clipboard access.</p>
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => { try { saveTerminalPreferences({}); setPreferences({}); setError(undefined); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } }}>Reset saved terminal preferences</button></div>}
  </section>;
}

import { useEffect, useSyncExternalStore } from "react";
import { RefreshCw, Save, Settings2 } from "lucide-react";

import { ControlButton } from "./Control.js";
import { CodexSettingsEditor, serviceTiers } from "./CodexSettingsEditor.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

export function CodexSettingsPanel({ editor, callHook }: { editor: CodexSettingsEditor; callHook: NonNullable<UiContributionRenderContext["callHook"]> }) {
  const { settings, model, serviceTier, modeSelected, busy, error, saved } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  useEffect(() => { editor.load(callHook); }, [editor, callHook]);
  const { selectedTier, validModel, canSave } = editor;

  return <section className="codex-settings-panel" aria-label="Global Codex settings" aria-busy={busy !== null}>
    <header className="codex-settings-header">
      <h2><Settings2 size={18} aria-hidden="true" /> Global Codex settings</h2>
      <p>Shared by CloudX instances using the same Codex home.</p>
      <p>Changes apply to new sessions. Profiles, project settings, and session overrides may take precedence. Running sessions keep their current settings.</p>
    </header>
    {error ? <p className="codex-settings-notice" role="alert">{error}</p> : null}
    {busy === "loading" ? <p role="status">Loading global Codex settings…</p> : null}
    {settings ? <form className="codex-settings-form" onSubmit={event => { event.preventDefault(); void editor.save(); }}>
      <label>
        Default model
        <input aria-label="Default model" value={model} maxLength={128} disabled={busy !== null} aria-invalid={!validModel} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => { editor.setModel(event.target.value); }} />
        <small>Leave blank to remove the global model override.</small>
      </label>
      {!validModel ? <p className="codex-settings-notice" role="alert">Enter a model identifier of at most 128 letters, numbers, dots, underscores, colons, slashes, or hyphens, starting with a letter or number.</p> : null}
      <label>
        Fast mode
        <select aria-label="Fast mode" value={serviceTier} disabled={busy !== null} onChange={event => { editor.selectMode(event.target.value); }}>
          <option value="">Model default</option>
          {serviceTiers.map(tier => <option key={tier.value} value={tier.value}>{tier.label}</option>)}
          {settings.serviceTier && !serviceTiers.some(tier => tier.value === settings.serviceTier) ? <option value={settings.serviceTier}>Saved value: {settings.serviceTier}</option> : null}
        </select>
        <small>On uses priority service; Off uses standard service. Flex selects flexible service. Model default removes the global service tier override.</small>
      </label>
      {settings.fastModeEnabled === false ? <div className="codex-settings-notice">
        {modeSelected && selectedTier ? <p>Fast mode support will be enabled when you save.</p> : <>
          <p>Fast mode support is disabled in Codex settings. Select On, Off, or Flex and save to enable it.</p>
          {selectedTier ? <ControlButton disabled={busy !== null} onClick={() => { editor.enableFastMode(); }}>Enable fast mode support</ControlButton> : null}
        </>}
      </div> : null}
      {saved ? <p role="status">Global Codex settings saved.</p> : null}
      <div className="codex-settings-actions">
        <ControlButton type="submit" tone="primary" disabled={!canSave}><Save size={16} aria-hidden="true" /> {busy === "saving" ? "Saving…" : "Save"}</ControlButton>
        <ControlButton onClick={() => void editor.reload()} disabled={busy !== null}><RefreshCw size={16} aria-hidden="true" /> Reload</ControlButton>
      </div>
      <small>Reload reads the shared settings and discards unsaved edits.</small>
    </form> : busy !== "loading" ? <ControlButton onClick={() => void editor.reload()}><RefreshCw size={16} aria-hidden="true" /> Reload</ControlButton> : null}
  </section>;
}

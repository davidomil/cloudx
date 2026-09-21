import { useEffect, useSyncExternalStore } from "react";
import { RefreshCw, Save, Settings2 } from "lucide-react";

import { ControlButton } from "./Control.js";
import { CodexSettingsEditor, personalities, reasoningEfforts, serviceTiers, webSearchModes } from "./CodexSettingsEditor.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

export function CodexSettingsPanel({ editor, callHook }: { editor: CodexSettingsEditor; callHook: NonNullable<UiContributionRenderContext["callHook"]> }) {
  const { settings, model, serviceTier, modeSelected, yoloMode, autoTrustWorkspace, defaultSkills, reasoningEffort, webSearch, personality, busy, error, saved } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
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
      <fieldset className="codex-settings-group" disabled={busy !== null}>
        <legend>Model and behavior</legend>
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
        <NativeSettingSelect label="Reasoning effort" value={reasoningEffort} savedValue={settings.reasoningEffort} options={reasoningEfforts} disabled={busy !== null} onChange={value => editor.selectNativeSetting("reasoningEffort", value)}>
          Choose an effort supported by your model. Codex default removes the global override.
        </NativeSettingSelect>
        <NativeSettingSelect label="Web search" value={webSearch} savedValue={settings.webSearch} options={webSearchModes} disabled={busy !== null} onChange={value => editor.selectNativeSetting("webSearch", value)}>
          Disabled turns search off; cached uses stored results; live fetches current results; indexed selects indexed search when supported by Codex.
        </NativeSettingSelect>
        <NativeSettingSelect label="Personality" value={personality} savedValue={settings.personality} options={personalities} disabled={busy !== null} onChange={value => editor.selectNativeSetting("personality", value)}>
          Set the default communication style for models that support personalities.
        </NativeSettingSelect>
      </fieldset>
      <fieldset className="codex-settings-group" disabled={busy !== null}>
        <legend>Session permissions</legend>
        <label className="codex-settings-toggle">
          <input type="checkbox" aria-label="YOLO mode" checked={yoloMode} disabled={busy !== null} onChange={event => editor.setYoloMode(event.target.checked)} />
          <span>YOLO mode<small>Bypasses the sandbox and approval prompts. Turn off to use your Codex user and project permission settings for new CloudX sessions.</small></span>
        </label>
        <label className="codex-settings-toggle">
          <input type="checkbox" aria-label="Automatically trust workspace" checked={autoTrustWorkspace} disabled={busy !== null} onChange={event => editor.setAutoTrustWorkspace(event.target.checked)} />
          <span>Automatically trust workspace<small>Trusts only the current workspace in the new session’s configuration. Explicitly untrusted workspaces are rejected; your shared trust settings are unchanged.</small></span>
        </label>
      </fieldset>
      <fieldset className="codex-settings-group" disabled={busy !== null}>
        <legend>Default Codex skills</legend>
        <small>Skills provided by the installed Codex version. Only imagegen is enabled by default; choose which skills new CloudX sessions can use.</small>
        {defaultSkills.map(skill => <label className="codex-settings-toggle" key={skill.id}>
          <input type="checkbox" aria-label={`Enable ${skill.id}`} checked={skill.enabled} disabled={busy !== null || (!skill.available && !skill.enabled)} onChange={event => editor.setDefaultSkill(skill.id, event.target.checked)} />
          <span>{skill.id}{!skill.available ? <small>Not installed.{skill.enabled ? " Disable this skill to allow new sessions to start." : ""}</small> : null}</span>
        </label>)}
        {!defaultSkills.length ? <p>No default skills are provided by this Codex installation.</p> : null}
      </fieldset>
      <div className="codex-settings-save">
        {saved ? <p role="status">Global Codex settings saved.</p> : null}
        <div className="codex-settings-actions">
          <ControlButton type="submit" tone="primary" disabled={!canSave}><Save size={16} aria-hidden="true" /> {busy === "saving" ? "Saving…" : "Save Codex settings"}</ControlButton>
          <ControlButton onClick={() => void editor.reload()} disabled={busy !== null}><RefreshCw size={16} aria-hidden="true" /> Reload</ControlButton>
        </div>
        <small>Reload reads the shared settings and discards unsaved edits.</small>
      </div>
    </form> : busy !== "loading" ? <ControlButton onClick={() => void editor.reload()}><RefreshCw size={16} aria-hidden="true" /> Reload</ControlButton> : null}
  </section>;
}

function NativeSettingSelect({ label, value, savedValue, options, disabled, onChange, children }: {
  label: string;
  value: string;
  savedValue: string | null;
  options: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
  children: string;
}) {
  return <label>
    {label}
    <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">Codex default</option>
      {options.map(option => <option key={option} value={option}>{option}</option>)}
      {savedValue && !options.includes(savedValue) ? <option value={savedValue}>Saved value: {savedValue}</option> : null}
    </select>
    <small>{children}</small>
  </label>;
}

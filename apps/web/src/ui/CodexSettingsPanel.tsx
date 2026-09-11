import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Save, Settings2 } from "lucide-react";
import type { CodexGlobalSettings, CodexGlobalSettingsUpdate } from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

type ServiceTier = NonNullable<CodexGlobalSettingsUpdate["serviceTier"]>;
const serviceTiers: { value: ServiceTier; label: string }[] = [
  { value: "priority", label: "On" },
  { value: "default", label: "Off" },
  { value: "flex", label: "Flex" }
];

export function CodexSettingsPanel({ callHook }: { callHook: NonNullable<UiContributionRenderContext["callHook"]> }) {
  const bridge = useRef(callHook);
  useEffect(() => { bridge.current = callHook; }, [callHook]);
  const requestVersion = useRef(0);
  const saving = useRef(false);
  const [settings, setSettings] = useState<CodexGlobalSettings>();
  const [model, setModel] = useState("");
  const [serviceTier, setServiceTier] = useState("");
  const [modeSelected, setModeSelected] = useState(false);
  const [busy, setBusy] = useState<"loading" | "saving" | null>("loading");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  function acceptSettings(next: CodexGlobalSettings) {
    setSettings(next);
    setModel(next.model ?? "");
    setServiceTier(next.serviceTier ?? "");
    setModeSelected(false);
  }

  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    setBusy("loading");
    setError(undefined);
    setSaved(false);
    try {
      const result = await bridge.current<{ settings: CodexGlobalSettings }>("codex-settings.read", {});
      if (version === requestVersion.current) acceptSettings(result.settings);
    } catch (error) {
      if (version === requestVersion.current) setError(errorMessage(error));
    } finally {
      if (version === requestVersion.current) setBusy(null);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => { requestVersion.current += 1; };
  }, [reload]);

  const selectedTier = serviceTiers.find(tier => tier.value === serviceTier)?.value;
  const validModel = !model || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model);
  const modelChanged = Boolean(settings && model !== (settings.model ?? ""));
  const modeChanged = Boolean(settings && (serviceTier !== (settings.serviceTier ?? "") || (modeSelected && selectedTier && settings.fastModeEnabled === false)));

  async function save() {
    if (!settings || busy || saving.current || !validModel || (!modelChanged && !modeChanged)) return;
    const update: CodexGlobalSettingsUpdate = { expectedRevision: settings.revision };
    if (modelChanged) update.model = model || null;
    if (modeChanged) update.serviceTier = selectedTier ?? null;
    const version = ++requestVersion.current;
    saving.current = true;
    setBusy("saving");
    setError(undefined);
    setSaved(false);
    try {
      const result = await bridge.current<{ settings: CodexGlobalSettings }>("codex-settings.update", { ...update });
      if (version === requestVersion.current) {
        acceptSettings(result.settings);
        setSaved(true);
      }
    } catch (error) {
      if (version === requestVersion.current) setError(errorMessage(error));
    } finally {
      saving.current = false;
      if (version === requestVersion.current) setBusy(null);
    }
  }

  return <section className="codex-settings-panel" aria-label="Global Codex settings" aria-busy={busy !== null}>
    <header className="codex-settings-header">
      <h2><Settings2 size={18} aria-hidden="true" /> Global Codex settings</h2>
      <p>Shared by CloudX instances using the same Codex home.</p>
      <p>Changes apply to new sessions. Profiles, project settings, and session overrides may take precedence. Running sessions keep their current settings.</p>
    </header>
    {error ? <p className="codex-settings-notice" role="alert">{error}</p> : null}
    {busy === "loading" ? <p role="status">Loading global Codex settings…</p> : null}
    {settings ? <form className="codex-settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>
        Default model
        <input aria-label="Default model" value={model} maxLength={128} disabled={busy !== null} aria-invalid={!validModel} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => { setModel(event.target.value); setSaved(false); }} />
        <small>Leave blank to remove the global model override.</small>
      </label>
      {!validModel ? <p className="codex-settings-notice" role="alert">Enter a model identifier of at most 128 letters, numbers, dots, underscores, colons, slashes, or hyphens, starting with a letter or number.</p> : null}
      <label>
        Fast mode
        <select aria-label="Fast mode" value={serviceTier} disabled={busy !== null} onChange={event => { setServiceTier(event.target.value); setModeSelected(true); setSaved(false); }}>
          <option value="">Model default</option>
          {serviceTiers.map(tier => <option key={tier.value} value={tier.value}>{tier.label}</option>)}
          {settings.serviceTier && !serviceTiers.some(tier => tier.value === settings.serviceTier) ? <option value={settings.serviceTier}>Saved value: {settings.serviceTier}</option> : null}
        </select>
        <small>On uses priority service; Off uses standard service. Flex selects flexible service. Model default removes the global service tier override.</small>
      </label>
      {settings.fastModeEnabled === false ? <div className="codex-settings-notice">
        {modeSelected && selectedTier ? <p>Fast mode support will be enabled when you save.</p> : <>
          <p>Fast mode support is disabled in Codex settings. Select On, Off, or Flex and save to enable it.</p>
          {selectedTier ? <ControlButton disabled={busy !== null} onClick={() => { setModeSelected(true); setSaved(false); }}>Enable fast mode support</ControlButton> : null}
        </>}
      </div> : null}
      {saved ? <p role="status">Global Codex settings saved.</p> : null}
      <div className="codex-settings-actions">
        <ControlButton type="submit" tone="primary" disabled={busy !== null || !validModel || (!modelChanged && !modeChanged)}><Save size={16} aria-hidden="true" /> {busy === "saving" ? "Saving…" : "Save"}</ControlButton>
        <ControlButton onClick={() => void reload()} disabled={busy !== null}><RefreshCw size={16} aria-hidden="true" /> Reload</ControlButton>
      </div>
      <small>Reload reads the shared settings and discards unsaved edits.</small>
    </form> : busy !== "loading" ? <ControlButton onClick={() => void reload()}><RefreshCw size={16} aria-hidden="true" /> Reload</ControlButton> : null}
  </section>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

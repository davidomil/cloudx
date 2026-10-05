import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Save, Settings2 } from "lucide-react";
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_SETTINGS_HOOKS,
  CLAUDE_MODEL_ID_PATTERN,
  CLAUDE_TEXT_SETTING_PATTERN,
  CLAUDE_UPDATE_CHANNELS,
  type ClaudeCliStatus,
  type ClaudeGlobalSettings,
  type ClaudeGlobalSettingsUpdate,
  type ClaudeLaunchPermissionMode
} from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

const MODEL_SUGGESTIONS = ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"];
const PERMISSION_MODES: { value: ClaudeLaunchPermissionMode; label: string; description: string }[] = [
  { value: "bypassPermissions", label: "Bypass permissions (YOLO)", description: "Runs tools without asking, like Codex YOLO mode." },
  { value: "acceptEdits", label: "Accept edits", description: "Applies file edits and asks before commands." },
  { value: "auto", label: "Auto", description: "Claude Code decides which actions need approval." },
  { value: "manual", label: "Ask every time", description: "Asks before every tool use." },
  { value: "plan", label: "Plan only", description: "Plans without changing files or running commands." }
];

// Text and select fields hold "" for "not set"; booleans use "", "true", "false".
interface Draft {
  model: string;
  effortLevel: string;
  alwaysThinkingEnabled: string;
  fastMode: string;
  outputStyle: string;
  language: string;
  autoUpdatesChannel: string;
  permissionMode: ClaudeLaunchPermissionMode;
  autoTrustWorkspace: boolean;
}

function draftFrom(settings: ClaudeGlobalSettings): Draft {
  const flag = (value: boolean | null) => value === null ? "" : String(value);
  return {
    model: settings.model ?? "", effortLevel: settings.effortLevel ?? "", alwaysThinkingEnabled: flag(settings.alwaysThinkingEnabled),
    fastMode: flag(settings.fastMode), outputStyle: settings.outputStyle ?? "", language: settings.language ?? "",
    autoUpdatesChannel: settings.autoUpdatesChannel ?? "", permissionMode: settings.permissionMode, autoTrustWorkspace: settings.autoTrustWorkspace
  };
}

function changes(settings: ClaudeGlobalSettings, draft: Draft): Omit<ClaudeGlobalSettingsUpdate, "expectedRevision"> {
  const saved = draftFrom(settings);
  const update: Record<string, unknown> = {};
  for (const key of ["model", "effortLevel", "outputStyle", "language", "autoUpdatesChannel"] as const)
    if (draft[key].trim() !== saved[key]) update[key] = draft[key].trim() || null;
  for (const key of ["alwaysThinkingEnabled", "fastMode"] as const)
    if (draft[key] !== saved[key]) update[key] = draft[key] === "" ? null : draft[key] === "true";
  if (draft.permissionMode !== saved.permissionMode) update.permissionMode = draft.permissionMode;
  if (draft.autoTrustWorkspace !== saved.autoTrustWorkspace) update.autoTrustWorkspace = draft.autoTrustWorkspace;
  return update;
}

export function ClaudeSettingsPanel({ callHook }: { callHook: CallHook }) {
  const [settings, setSettings] = useState<ClaudeGlobalSettings>();
  const [cli, setCli] = useState<ClaudeCliStatus>();
  const [warning, setWarning] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState<"loading" | "saving" | "accepting" | "updating" | null>("loading");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reviewingBypass, setReviewingBypass] = useState(false);

  const accept = useCallback((next: ClaudeGlobalSettings) => { setSettings(next); setDraft(draftFrom(next)); }, []);

  const run = useCallback(async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(kind);
    setError(undefined);
    setNotice(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }, []);

  const reload = useCallback(() => run("loading", async () => {
    const result = await callHook<{ settings: ClaudeGlobalSettings; cli: ClaudeCliStatus; bypassWarning: string }>(CLAUDE_SETTINGS_HOOKS.read, {});
    accept(result.settings);
    setCli(result.cli);
    setWarning(result.bypassWarning);
  }), [accept, callHook, run]);

  useEffect(() => { void reload(); }, [reload]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => current ? { ...current, [key]: value } : current);
  const validModel = !draft?.model.trim() || CLAUDE_MODEL_ID_PATTERN.test(draft.model.trim());
  const validText = (value: string | undefined) => !value?.trim() || CLAUDE_TEXT_SETTING_PATTERN.test(value.trim());
  const pending = settings && draft ? changes(settings, draft) : {};
  const canSave = busy === null && validModel && validText(draft?.outputStyle) && validText(draft?.language) && Object.keys(pending).length > 0;

  return <section className="codex-settings-panel" aria-label="Claude settings" aria-busy={busy !== null}>
    <header className="codex-settings-header">
      <h2><Settings2 size={18} aria-hidden="true" /> Claude settings</h2>
      <p>Model and behavior defaults are saved in {settings ? <code>{settings.settingsPath}</code> : "your Claude settings file"} and also apply to <code>claude</code> outside CloudX. Session permissions apply to CloudX tabs only.</p>
      <p>Changes apply to new sessions. Project settings and a model chosen for a run, such as in Forge settings, take precedence.</p>
    </header>

    <section className="codex-update-control" aria-label="Claude Code CLI">
      <h3>Claude Code CLI</h3>
      {cli ? cli.installed
        ? <p>Installed: <strong>{cli.version}</strong> at <code>{cli.command}</code></p>
        : <p>Claude Code is not installed or not on <code>PATH</code> (<code>{cli.command}</code>). Install it, or set <code>CLOUDX_CLAUDE_BIN</code>.</p>
        : null}
      {cli?.output ? <pre className="claude-update-output">{cli.output}</pre> : null}
      <div className="codex-settings-actions">
        <ControlButton disabled={busy !== null || !cli?.installed} onClick={() => void run("updating", async () => {
          const result = await callHook<{ cli: ClaudeCliStatus }>(CLAUDE_SETTINGS_HOOKS.updateCli, {});
          setCli(result.cli);
          setNotice("Claude Code update finished. Running Claude tabs keep their current version.");
        })}><Download size={16} aria-hidden="true" /> {busy === "updating" ? "Updating…" : "Update Claude Code"}</ControlButton>
      </div>
      <small>Runs <code>claude update</code> on the release channel selected below.</small>
    </section>

    {error ? <p className="codex-settings-notice" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {busy === "loading" && !settings ? <p role="status">Loading Claude settings…</p> : null}

    {settings && draft ? <form className="codex-settings-form" onSubmit={event => {
      event.preventDefault();
      if (canSave) void run("saving", async () => {
        const result = await callHook<{ settings: ClaudeGlobalSettings }>(CLAUDE_SETTINGS_HOOKS.update, { expectedRevision: settings.revision, ...pending });
        accept(result.settings);
        setNotice("Claude settings saved.");
      });
    }}>
      <fieldset className="codex-settings-group" disabled={busy !== null}>
        <legend>Model and behavior</legend>
        <label>
          Default model
          <input aria-label="Default model" value={draft.model} list="claude-model-suggestions" placeholder="Claude Code default" maxLength={128} aria-invalid={!validModel} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => set("model", event.target.value)} />
          <datalist id="claude-model-suggestions">{MODEL_SUGGESTIONS.map(model => <option key={model} value={model} />)}</datalist>
          <small>An alias such as opus or sonnet, or a full model id. Leave blank to let Claude Code choose for the signed-in account.</small>
        </label>
        {!validModel ? <p className="codex-settings-notice" role="alert">Enter a Claude model alias (opus, sonnet, haiku) or an id starting with claude-.</p> : null}
        <ChoiceSelect label="Effort" value={draft.effortLevel} saved={settings.effortLevel} options={CLAUDE_EFFORT_LEVELS} onChange={value => set("effortLevel", value)}>
          Persisted effort for models that support it. A run can still choose its own, for example from Forge settings.
        </ChoiceSelect>
        <FlagSelect label="Extended thinking" value={draft.alwaysThinkingEnabled} onChange={value => set("alwaysThinkingEnabled", value)}>
          Off disables thinking. Claude Code default enables it automatically for supported models.
        </FlagSelect>
        <FlagSelect label="Fast mode" value={draft.fastMode} onChange={value => set("fastMode", value)}>
          On keeps Claude Code's fast mode enabled across sessions where the account supports it.
        </FlagSelect>
        <label>
          Output style
          <input aria-label="Output style" value={draft.outputStyle} placeholder="Claude Code default" maxLength={64} aria-invalid={!validText(draft.outputStyle)} onChange={event => set("outputStyle", event.target.value)} />
          <small>Name of a built-in or custom output style, such as Explanatory or Learning.</small>
        </label>
        <label>
          Response language
          <input aria-label="Response language" value={draft.language} placeholder="Claude Code default" maxLength={64} aria-invalid={!validText(draft.language)} onChange={event => set("language", event.target.value)} />
          <small>Preferred language for responses, for example english or japanese.</small>
        </label>
        <ChoiceSelect label="Update channel" value={draft.autoUpdatesChannel} saved={settings.autoUpdatesChannel} options={CLAUDE_UPDATE_CHANNELS} onChange={value => set("autoUpdatesChannel", value)}>
          Release channel for Claude Code updates.
        </ChoiceSelect>
      </fieldset>

      <fieldset className="codex-settings-group" disabled={busy !== null}>
        <legend>Session permissions</legend>
        <label>
          Permission mode for CloudX tabs
          <select aria-label="Permission mode for CloudX tabs" value={draft.permissionMode} onChange={event => set("permissionMode", event.target.value as ClaudeLaunchPermissionMode)}>
            {PERMISSION_MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
          <small>{PERMISSION_MODES.find(mode => mode.value === draft.permissionMode)?.description} Forge workers on Claude always use bypass permissions.</small>
        </label>
        {settings.bypassDisabled ? <p className="codex-settings-notice" role="alert">Your Claude settings disable bypass permissions mode. Bypass tabs and Forge workers on Claude will not start until that policy changes.</p> : null}
        <label className="codex-settings-toggle">
          <input type="checkbox" aria-label="Automatically trust workspace" checked={draft.autoTrustWorkspace} onChange={event => set("autoTrustWorkspace", event.target.checked)} />
          <span>Automatically trust workspace<small>Trusts the tab's working directory in its own Claude state. Folders you already trusted in Claude Code stay trusted either way.</small></span>
        </label>
      </fieldset>

      <div className="codex-settings-save">
        <div className="codex-settings-actions">
          <ControlButton type="submit" tone="primary" disabled={!canSave}><Save size={16} aria-hidden="true" /> {busy === "saving" ? "Saving…" : "Save Claude settings"}</ControlButton>
          <ControlButton onClick={() => void reload()} disabled={busy !== null}><RefreshCw size={16} aria-hidden="true" /> Reload</ControlButton>
        </div>
        <small>Reload reads the saved settings and discards unsaved edits.</small>
      </div>
    </form> : null}

    {settings ? <section className="codex-update-control agent-bypass" aria-label="Claude bypass permissions">
      <h3>Bypass permissions warning</h3>
      {settings.bypassAccepted
        ? <p>Accepted. Claude tabs in bypass mode start without the warning, and Forge workers can run on Claude.</p>
        : <>
          <p>Not accepted. A Claude tab in bypass mode shows Claude Code's warning on its first start, and accepting it there is remembered. Forge workers on Claude need it accepted first.</p>
          {reviewingBypass ? <>
            <p className="agent-warning">{warning}</p>
            <div className="codex-settings-actions">
              <ControlButton tone="danger" disabled={busy !== null} onClick={() => void run("accepting", async () => {
                const result = await callHook<{ settings: ClaudeGlobalSettings }>(CLAUDE_SETTINGS_HOOKS.acceptBypass, { accepted: true });
                setReviewingBypass(false);
                accept(result.settings);
              })}>I accept</ControlButton>
              <ControlButton disabled={busy !== null} onClick={() => setReviewingBypass(false)}>Cancel</ControlButton>
            </div>
          </> : <ControlButton disabled={busy !== null} onClick={() => setReviewingBypass(true)}>Review warning…</ControlButton>}
        </>}
    </section> : null}
  </section>;
}

function ChoiceSelect({ label, value, saved, options, onChange, children }: {
  label: string; value: string; saved: string | null; options: readonly string[]; onChange: (value: string) => void; children: string;
}) {
  return <label>
    {label}
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">Claude Code default</option>
      {options.map(option => <option key={option} value={option}>{option}</option>)}
      {saved && !options.includes(saved) ? <option value={saved}>Saved value: {saved}</option> : null}
    </select>
    <small>{children}</small>
  </label>;
}

function FlagSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: string }) {
  return <label>
    {label}
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">Claude Code default</option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
    <small>{children}</small>
  </label>;
}

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Save, Settings2 } from "lucide-react";
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_BOOLEAN_SETTINGS,
  CLAUDE_SETTINGS_HOOKS,
  CLAUDE_MODEL_ID_PATTERN,
  CLAUDE_TEXT_SETTING_PATTERN,
  CLAUDE_UPDATE_CHANNELS,
  claudeModelEffort,
  type ClaudeCliStatus,
  type ClaudeGlobalSettings,
  type ClaudeGlobalSettingsUpdate,
  type ClaudeLaunchPermissionMode
} from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import { ClaudeConfigurationCatalog } from "./ClaudeConfigurationCatalog.js";
import { ClaudeLaunchInspection } from "./ClaudeLaunchInspection.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

const MODEL_SUGGESTIONS = ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"];
const PERMISSION_MODES: { value: ClaudeLaunchPermissionMode; label: string; description: string }[] = [
  { value: "bypassPermissions", label: "Bypass permissions (YOLO)", description: "Runs tools without asking, like Codex YOLO mode." },
  { value: "acceptEdits", label: "Accept edits", description: "Allows file edits and common filesystem commands; other actions follow permission rules." },
  { value: "auto", label: "Auto", description: "Uses native safety classification for actions such as shell commands and network requests; availability depends on the native version, model and account." },
  { value: "manual", label: "Default (manual)", description: "Allows reads and pre-approved operations; asks for actions that need approval under native permission rules." },
  { value: "plan", label: "Plan", description: "Reads and plans, including permitted read-only shell commands; blocks edits until a plan is approved." }
];

// Text and select fields hold "" for "not set"; booleans use "", "true", "false".
interface Draft {
  model: string;
  effortLevel: string;
  effortModel: string;
  alwaysThinkingEnabled: string;
  fastMode: string;
  outputStyle: string;
  language: string;
  autoUpdatesChannel: string;
  permissionMode: ClaudeLaunchPermissionMode;
  autoTrustWorkspace: boolean;
  allowedSkills: string[];
  nativeOptions: NonNullable<ClaudeGlobalSettings["nativeOptions"]>;
}

function draftFrom(settings: ClaudeGlobalSettings): Draft {
  const flag = (value: boolean | null) => value === null ? "" : String(value);
  return {
    model: settings.model ?? "", effortLevel: settings.effortLevel ?? "", effortModel: settings.model?.startsWith("claude-") ? settings.model : "", alwaysThinkingEnabled: flag(settings.alwaysThinkingEnabled),
    fastMode: flag(settings.fastMode), outputStyle: settings.outputStyle ?? "", language: settings.language ?? "",
    autoUpdatesChannel: settings.autoUpdatesChannel ?? "", permissionMode: settings.permissionMode, autoTrustWorkspace: settings.autoTrustWorkspace,
    allowedSkills: settings.skills.filter(skill => skill.allowed).map(skill => skill.name).sort(),
    nativeOptions: settings.nativeOptions ?? {}
  };
}

function changes(settings: ClaudeGlobalSettings, draft: Draft): Omit<ClaudeGlobalSettingsUpdate, "expectedRevision"> {
  const saved = draftFrom(settings);
  const update: Record<string, unknown> = {};
  for (const key of ["model", "outputStyle", "language", "autoUpdatesChannel"] as const)
    if (draft[key].trim() !== saved[key]) update[key] = draft[key].trim() || null;
  const effortModel = claudeModelEffort(draft.effortModel)?.model ?? draft.effortModel;
  const savedEffort = settings.modelEffortLevels?.[effortModel] ?? (draft.effortModel === saved.effortModel ? saved.effortLevel : "");
  if (draft.effortLevel !== savedEffort) {
    update.effortModel = draft.effortModel;
    update.effortLevel = draft.effortLevel || null;
  }
  for (const key of ["alwaysThinkingEnabled", "fastMode"] as const)
    if (draft[key] !== saved[key]) update[key] = draft[key] === "" ? null : draft[key] === "true";
  if (draft.permissionMode !== saved.permissionMode) update.permissionMode = draft.permissionMode;
  if (draft.autoTrustWorkspace !== saved.autoTrustWorkspace) update.autoTrustWorkspace = draft.autoTrustWorkspace;
  if (draft.allowedSkills.join("\n") !== saved.allowedSkills.join("\n")) update.allowedSkills = draft.allowedSkills;
  const nativeOptions = Object.fromEntries(CLAUDE_BOOLEAN_SETTINGS.filter(key => (draft.nativeOptions[key] ?? null) !== (saved.nativeOptions[key] ?? null)).map(key => [key, draft.nativeOptions[key] ?? null]));
  if (Object.keys(nativeOptions).length) update.nativeOptions = nativeOptions;
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

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => {
    if (!current) return current;
    if (key === "model" || key === "effortModel") {
      const model = typeof value === "string" && value.startsWith("claude-") ? value : "";
      return { ...current, [key]: value, effortModel: model, effortLevel: settings?.modelEffortLevels?.[claudeModelEffort(model)?.model ?? model] ?? "" };
    }
    return { ...current, [key]: value };
  });
  const validModel = !draft?.model.trim() || CLAUDE_MODEL_ID_PATTERN.test(draft.model.trim());
  const validText = (value: string | undefined) => !value?.trim() || CLAUDE_TEXT_SETTING_PATTERN.test(value.trim());
  const pending = settings && draft ? changes(settings, draft) : {};
  const effortCapability = draft ? claudeModelEffort(draft.effortModel) : undefined;
  const validEffort = pending.effortLevel === undefined || (pending.effortLevel === null
    ? Boolean(draft?.effortModel.startsWith("claude-") && CLAUDE_MODEL_ID_PATTERN.test(draft.effortModel))
    : Boolean(effortCapability?.levels.includes(pending.effortLevel)));
  const unsupportedChannel = settings?.autoUpdatesChannel && !CLAUDE_UPDATE_CHANNELS.some(channel => channel === settings.autoUpdatesChannel);
  const canSave = busy === null && validModel && validEffort && validText(draft?.outputStyle) && validText(draft?.language) && Object.keys(pending).length > 0;

  return <section className="codex-settings-panel" aria-label="Claude settings" aria-busy={busy !== null}>
    <header className="codex-settings-header">
      <h2><Settings2 size={18} aria-hidden="true" /> Claude settings</h2>
      <p>Model and behavior defaults are saved in {settings ? <code>{settings.settingsPath}</code> : "your Claude settings file"} and also apply to <code>claude</code> outside CloudX. Session permissions apply to CloudX tabs only.</p>
      <p>These are saved user values, not observed values for an open tab. Unset removes the user override. Project, managed policy, environment, per-model values and launch flags can change the result; effective session values remain unresolved here.</p>
      <p>Model and saved effort apply at the next launch; use native /model or /effort for a running session. Other native settings can reload when supported by the installed version. CloudX permissions, trust and skill choices apply at the next launch. Saving never restarts a client or replays work.</p>
    </header>

    <section className="codex-update-control" aria-label="Claude Code CLI">
      <h3>Claude Code CLI</h3>
      {cli ? cli.installed
        ? <p>Installed: <strong>{cli.version}</strong> at <code>{cli.command}</code></p>
        : <p>Claude Code is not installed or not on <code>PATH</code> (<code>{cli.command}</code>). Install it, or set <code>CLOUDX_CLAUDE_BIN</code>.</p>
        : null}
      {cli?.output ? <pre className="claude-update-output">{cli.output}</pre> : null}
      <div className="codex-settings-actions">
        <ControlButton disabled={busy !== null || !cli?.installed || Boolean(unsupportedChannel)} onClick={() => void run("updating", async () => {
          const result = await callHook<{ cli: ClaudeCliStatus }>(CLAUDE_SETTINGS_HOOKS.updateCli, {});
          setCli(result.cli);
          setNotice("Claude Code update finished. Running Claude tabs keep their current version.");
        })}><Download size={16} aria-hidden="true" /> {busy === "updating" ? "Updating…" : "Update Claude Code"}</ControlButton>
      </div>
      <small>Runs <code>claude update</code> on the release channel selected below.</small>
      <small>Help follows the official reference reviewed 1 November 2026. Native capabilities and effective values are not verified by reading this panel. No provider is installed or updated automatically.</small>
    </section>

    {error ? <p className="codex-settings-notice" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {busy === "loading" && !settings ? <p role="status">Loading Claude settings…</p> : null}

    {settings && draft ? <form className="codex-settings-form" onSubmit={event => {
      event.preventDefault();
      if (canSave) void run("saving", async () => {
        const result = await callHook<{ settings: ClaudeGlobalSettings }>(CLAUDE_SETTINGS_HOOKS.update, { expectedRevision: settings.revision, ...pending });
        accept(result.settings);
        setNotice("Claude settings saved. Native runtime behavior remains unverified here; running clients were not restarted.");
      });
    }}>
      <fieldset className="codex-settings-group" disabled={busy !== null}>
        <legend>Model and behavior</legend>
        <label>
          Default model
          <input aria-label="Default model" value={draft.model} list="claude-model-suggestions" placeholder="Claude Code default" maxLength={128} aria-invalid={!validModel} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => set("model", event.target.value)} />
          <datalist id="claude-model-suggestions">{MODEL_SUGGESTIONS.map(model => <option key={model} value={model} />)}</datalist>
          <small>Saved user model for new launches. Aliases and the unset default resolve by native version and account; an explicit run or managed model can override it.</small>
        </label>
        {!validModel ? <p className="codex-settings-notice" role="alert">Enter a Claude model alias (opus, sonnet, haiku) or an id starting with claude-.</p> : null}
        <label>
          Effort model
          <input aria-label="Effort model" value={draft.effortModel} placeholder="Full model ID, for example claude-opus-5-5" maxLength={128} onChange={event => set("effortModel", event.target.value)} />
          <small>Choose the exact model receiving this preference. Changing an alias does not establish its resolved model.</small>
        </label>
        <ChoiceSelect label="Effort" value={draft.effortLevel} saved={settings.effortLevel} options={effortCapability?.levels ?? CLAUDE_EFFORT_LEVELS} onChange={value => set("effortLevel", value)}>
          Saves modelSettings for this model (Claude Code 2.1.251+); unset leaves the model-dependent native default unresolved. Applies at next launch; use /effort mid-session. Forge --effort, environment and managed values can override it.
        </ChoiceSelect>
        {effortCapability ? <small>Reference native default for {effortCapability.model}: {effortCapability.referenceDefault} (official current model reference). Account, provider, managed policy and installed-version effects remain unresolved.</small> : null}
        {effortCapability && settings.modelEffortLimits?.[effortCapability.model] ? <p>Saved user effort cap for this model: <code>{settings.modelEffortLimits[effortCapability.model]}</code>. The native cap can lower the effort actually used; this editor preserves it.</p> : null}
        {settings.effortEnvironmentOverride ? <p><code>CLAUDE_CODE_EFFORT_LEVEL</code> is set in the CloudX service environment and can override saved effort. Its value is not displayed.</p> : null}
        {!validEffort ? <p role="alert">Choose a full Claude model ID before saving effort.</p> : null}
        {settings.legacyEffortLevel ? <p>Legacy user effortLevel: <code>{settings.legacyEffortLevel}</code>. This separate value is preserved; Opus 5.5 and later models ignore it in user settings.</p> : null}
        <FlagSelect label="Extended thinking" value={draft.alwaysThinkingEnabled} onChange={value => set("alwaysThinkingEnabled", value)}>
          Unset enables thinking where supported. Off has no effect on always-thinking models (including Opus/Sonnet/Haiku 5.5 and Fable); third-party adaptive models may still think. MAX_THINKING_TOKENS can override this saved value. Native reload applies where supported.
        </FlagSelect>
        <FlagSelect label="Fast mode" value={draft.fastMode} onChange={value => set("fastMode", value)}>
          Saved user fast-mode preference; native reload and availability depend on model, account and version. This panel does not establish an effective speed or cost.
        </FlagSelect>
        <label>
          Output style
          <input aria-label="Output style" value={draft.outputStyle} placeholder="Claude Code default" maxLength={64} aria-invalid={!validText(draft.outputStyle)} onChange={event => set("outputStyle", event.target.value)} />
          <small>Saved user output style, such as Explanatory or Learning. Native settings reload where supported; higher-priority sources can override it.</small>
        </label>
        <label>
          Response language
          <input aria-label="Response language" value={draft.language} placeholder="Claude Code default" maxLength={64} aria-invalid={!validText(draft.language)} onChange={event => set("language", event.target.value)} />
          <small>Saved user response language, such as english or japanese. Native settings reload where supported; higher-priority sources can override it.</small>
        </label>
        <ChoiceSelect label="Update channel" value={draft.autoUpdatesChannel} saved={settings.autoUpdatesChannel} options={CLAUDE_UPDATE_CHANNELS} onChange={value => set("autoUpdatesChannel", value)}>
          Unset follows the native latest channel. Saved latest or stable controls subsequent native updates; it does not update or restart the current binary. Homebrew follows its cask instead.
        </ChoiceSelect>
        {unsupportedChannel ? <p role="alert">Unsupported saved update channel: <code>{settings.autoUpdatesChannel}</code>. Choose latest, stable or unset, then save. Unrelated edits preserve this value; updating is blocked until corrected.</p> : null}
      </fieldset>

      <fieldset className="codex-settings-group" disabled={busy !== null}>
        <legend>Session permissions</legend>
        <label>
          Permission mode for CloudX tabs
          <select aria-label="Permission mode for CloudX tabs" value={draft.permissionMode} onChange={event => set("permissionMode", event.target.value as ClaudeLaunchPermissionMode)}>
            {PERMISSION_MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
          <small>{PERMISSION_MODES.find(mode => mode.value === draft.permissionMode)?.description} This CloudX launch flag overrides the native starting mode; native deny rules and managed restrictions still apply. Forge workers on Claude always use bypass permissions.</small>
        </label>
        {settings.bypassDisabled ? <p className="codex-settings-notice" role="alert">Your Claude settings disable bypass permissions mode. Bypass tabs and Forge workers on Claude will not start until that policy changes.</p> : null}
        <label className="codex-settings-toggle">
          <input type="checkbox" aria-label="Automatically trust workspace" checked={draft.autoTrustWorkspace} onChange={event => set("autoTrustWorkspace", event.target.checked)} />
          <span>Automatically trust workspace<small>Trusts the tab's working directory in its own Claude state. Folders you already trusted in Claude Code stay trusted either way.</small></span>
        </label>
      </fieldset>

      <fieldset className="codex-settings-group" disabled={busy !== null}>
        <legend>Claude skills outside CloudX</legend>
        <small>CloudX adds system and selected-template skills. Personal choices apply at the next launch; revoking a choice does not restart open tabs. Selected synced skills and conflicting source names block a new launch because native controls cannot enforce that selection. Saved choices remain unchanged. Bundled skills, known enabled plugins, known project names and auto-memory receive launch exclusions. New project skills discovered later remain an unresolved native policy gap.</small>
        {settings.skills.map(skill => <label className="codex-settings-toggle" key={skill.name}>
          <input
            type="checkbox"
            aria-label={`Allow ${skill.name}`}
            checked={draft.allowedSkills.includes(skill.name)}
            disabled={!skill.available && !draft.allowedSkills.includes(skill.name)}
            onChange={event => set("allowedSkills", event.target.checked
              ? [...draft.allowedSkills, skill.name].sort()
              : draft.allowedSkills.filter(name => name !== skill.name))}
          />
          <span>{skill.name}<small>{skill.available ? skill.origin === "synced" ? "Synced from claude.ai. Selecting this skill blocks new Claude launches: native background sync cannot enforce this selection." : "Personal skill." : "Not installed."}</small></span>
        </label>)}
        {!settings.skills.length ? <p>No personal or synced Claude skills are installed.</p> : null}
      </fieldset>

      <details className="codex-settings-group">
        <summary>Defaults and launch policy</summary>
        <p>Fresh CloudX defaults: bypass permissions, automatic workspace trust, no personal or synced names selected. Saved choices remain unchanged. Native permission defaults depend on the surface, and native skills and memory normally have their own defaults; CloudX overrides these only for its launches.</p>
        <p>Skill sources are separate: CloudX system catalog and selected template are supplied by CloudX; personal and claude.ai synced rows show filesystem availability and saved selection. Bundled, plugin and known project sources receive launch exclusions. Managed skills and dynamically added directories are not verified here. A cached synced skill is not proof of its selected-account or selected-version provenance.</p>
        <p>Clipboard/editor preferences start from the personal .claude.json. Native /config changes to copyOnSelect, copyFullResponse and externalEditorContext are retained separately for future CloudX tabs; existing tabs keep their own values. If several tabs change a choice, the latest native configuration file wins at the next launch. Account credentials and trust state stay isolated, and the personal file is unchanged. Personal keybindings and rules are shared from the native home. Personal instruction imports retain their original relative directory and depth budget; original-root exclusion patterns still need native identity support. Use /keybindings and native --debug diagnostics for invalid bindings. Browser clipboard and external-editor delivery require separate host support.</p>
        <p>CloudX receipts require compatible native hooks. File-backed restrictions stop launch with a diagnostic. Forge waits for its actual execution-bound startup receipt before submitting work; a missing receipt stops the worker. Interactive tabs report unavailable tracking when startup receipts are missing. The selected account and service routing are checked against native authentication status without a model turn. This checks native provider/account selection at launch; later managed policy or cloud credential refresh still belongs to the native client. Credential values are never shown here.</p>
        <p>Native agent view, background agents and native worktrees have no established CloudX ownership, status, recovery or cleanup contract. They are unsupported as managed CloudX sessions.</p>
        <p><a href="https://code.claude.com/docs/en/settings-reference" target="_blank" rel="noreferrer">Official native settings and defaults</a> · <a href="https://code.claude.com/docs/en/settings" target="_blank" rel="noreferrer">Scope, precedence and reload behavior</a>. The catalog below inventories the retained references; runtime certification and additional native editors remain explicitly unverified or unavailable.</p>
      </details>

      <ClaudeConfigurationCatalog settings={settings} version={cli?.version} nativeOptions={draft.nativeOptions} disabled={busy !== null} onChange={(key, value) => set("nativeOptions", { ...draft.nativeOptions, [key]: value })} />
      <ClaudeLaunchInspection callHook={callHook} disabled={busy !== null} />

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

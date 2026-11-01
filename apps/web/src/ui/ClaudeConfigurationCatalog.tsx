import { useState } from "react";
import {
  CLAUDE_BOOLEAN_SETTINGS, CLAUDE_CONFIGURATION_REFERENCE,
  claudeConfigurationAvailability, claudeConfigurationCatalog, claudeConfigurationDisposition, claudeConfigurationRequiresNewerVersion,
  type ClaudeBooleanSetting, type ClaudeConfigurationEntry, type ClaudeConfigurationFamily, type ClaudeGlobalSettings
} from "@cloudx/shared";

const PAGE_SIZE = 40;
const LABELS: Record<ClaudeBooleanSetting, string> = {
  autoCompactEnabled: "Automatic compaction", autoScrollEnabled: "Follow new output",
  syntaxHighlightingDisabled: "Disable syntax highlighting", terminalProgressBarEnabled: "Terminal progress bar",
  showTurnDuration: "Show turn duration", showThinkingSummaries: "Show thinking summaries",
  respectGitignore: "Respect Git ignore rules", includeGitInstructions: "Include Git instructions",
  spinnerTipsEnabled: "Spinner tips", prefersReducedMotion: "Prefer reduced motion", bashEditDiffEnabled: "Show Bash edit diffs"
};

export function ClaudeConfigurationCatalog({ settings, version, nativeOptions, onChange, disabled }: {
  settings: ClaudeGlobalSettings;
  version?: string;
  nativeOptions: NonNullable<ClaudeGlobalSettings["nativeOptions"]>;
  onChange: (key: ClaudeBooleanSetting, value: boolean | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<ClaudeConfigurationFamily>("settings");
  const [topic, setTopic] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const entries = claudeConfigurationCatalog(query, family).filter(entry => !topic || entry.topic === topic);
  const counts = CLAUDE_CONFIGURATION_REFERENCE.entries.reduce((result, entry) => ({ ...result, [entry.family]: (result[entry.family] ?? 0) + entry.referenceRows }), {} as Record<string, number>);
  const topics = [...new Set(claudeConfigurationCatalog("", family).map(entry => entry.topic))].sort();
  return <details className="codex-settings-group">
    <summary>Search native Claude configuration</summary>
    <p>Checked reference inventory: {counts.settings} settings rows, {counts.environment} environment rows, {counts.cli} CLI rows (including repeated flag summaries). Original official reference snapshots: {CLAUDE_CONFIGURATION_REFERENCE.referenceSnapshotDate}; review: {CLAUDE_CONFIGURATION_REFERENCE.reviewedAt}.</p>
    <p>No native versions are certified by this documentation inventory. {version ? `Selected executable reports ${version}.` : "No native version is established."} Version changes require a catalog review; an absent minimum version means unknown availability. Reference defaults are separate from saved values and observed effective state. CloudX does not probe a model, install a provider or restart sessions to show this catalog.</p>
    <p>Typed options below save only user values through the same settings owner as the curated controls. Unset removes that key; it preserves unrelated values. Native reload depends on the option and version; project, managed, environment and launch overrides remain applicable. Secrets are classified by name and never read into this catalog.</p>
    <label>Search configuration<input aria-label="Search Claude configuration" value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} /></label>
    <label>Configuration family<select aria-label="Claude configuration family" value={family} onChange={event => { setFamily(event.target.value as ClaudeConfigurationFamily); setTopic(""); setLimit(PAGE_SIZE); }}>
      <option value="settings">Native settings and global config</option><option value="environment">Environment variables</option><option value="cli">CLI commands and flags</option>
    </select></label>
    <label>Configuration group<select aria-label="Claude configuration group" value={topic} onChange={event => { setTopic(event.target.value); setLimit(PAGE_SIZE); }}>
      <option value="">All groups</option>{topics.map(group => <option key={group} value={group}>{group}</option>)}
    </select></label>
    <p role="status">{entries.length} matching entries. Showing {Math.min(limit, entries.length)}.</p>
    {entries.slice(0, limit).map(entry => {
      const disposition = claudeConfigurationDisposition(entry);
      const boolean = entry.family === "settings" ? CLAUDE_BOOLEAN_SETTINGS.find(key => key === entry.name) : undefined;
      return <section key={`${entry.family}:${entry.name}`} aria-label={`Claude configuration ${entry.name}`}>
        <h4><code>{entry.name}</code></h4>
        <p>{entry.topic} · {entry.scope} · {entry.type} · {entry.lifecycle}</p>
        <p>Native reference default: {referenceDefault(entry)}. Saved user value: {savedValue(entry, settings)}. Effective session value: unresolved.</p>
        <p>{claudeConfigurationAvailability(entry, version)}</p>
        {entry.versionMentions.length ? <p>Reference version mentions: {entry.versionMentions.join(", ")}. These can describe individual subfeatures rather than the setting’s introduction.</p> : null}
        <p>{disposition.kind}: {disposition.reason}</p>
        {boolean ? <label>{LABELS[boolean]}<select disabled={disabled} aria-label={`Claude native ${boolean}`} value={nativeOptions[boolean] === null || nativeOptions[boolean] === undefined ? "" : String(nativeOptions[boolean])} onChange={event => onChange(boolean, event.target.value === "" ? null : event.target.value === "true")}>
          <option value="">Unset / inherit native default</option><option value="true" disabled={claudeConfigurationRequiresNewerVersion(entry, version)}>True</option><option value="false" disabled={claudeConfigurationRequiresNewerVersion(entry, version)}>False</option>
        </select></label> : null}
        <small>Source: <a href={`${CLAUDE_CONFIGURATION_REFERENCE.sources[entry.source]!.url}#${entry.anchor}`} target="_blank" rel="noreferrer">official reference</a> · SHA-256 <code>{CLAUDE_CONFIGURATION_REFERENCE.sources[entry.source]!.sha256}</code></small>
      </section>;
    })}
    {!entries.length ? <p>No matching native configuration entries.</p> : null}
    {entries.length > limit ? <button type="button" onClick={() => setLimit(current => current + PAGE_SIZE)}>Show more Claude entries</button> : null}
  </details>;
}

function referenceDefault(entry: ClaudeConfigurationEntry): string {
  if (entry.defaultKind === "literal") return JSON.stringify(entry.nativeDefault);
  if (entry.family === "settings" && entry.name === "autoUpdatesChannel") return "latest when unset; Homebrew follows its cask";
  if (entry.defaultKind === "unset") return "unset; resolved behavior depends on the key and native context";
  return entry.defaultKind === "conditional" ? "conditional; inspect the official reference" : "unresolved; inspect the official reference";
}

function savedValue(entry: ClaudeConfigurationEntry, settings: ClaudeGlobalSettings): string {
  if (entry.family !== "settings") return "not inspected";
  if (CLAUDE_BOOLEAN_SETTINGS.some(key => key === entry.name)) return settings.nativeOptions?.[entry.name as ClaudeBooleanSetting] == null ? "unset" : JSON.stringify(settings.nativeOptions[entry.name as ClaudeBooleanSetting]);
  if (["model", "alwaysThinkingEnabled", "fastMode", "outputStyle", "language", "autoUpdatesChannel"].includes(entry.name))
    return settings[entry.name as "model"] === null ? "unset" : JSON.stringify(settings[entry.name as "model"]);
  if (entry.name === "effortLevel") return settings.legacyEffortLevel == null ? "unset" : JSON.stringify(settings.legacyEffortLevel);
  if (entry.name === "modelSettings") return "per-model effort shown above; unrelated model fields preserved";
  return "not inspected; native owner retains this value";
}

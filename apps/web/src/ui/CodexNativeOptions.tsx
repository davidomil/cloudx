import { useState } from "react";
import { codexConfigurationCatalog, CODEX_CONFIGURATION_BASELINE_VERSION, codexConfigurationCliCatalog } from "@cloudx/shared";
import { ControlButton } from "./Control.js";
import type { CodexSettingsEditor } from "./CodexSettingsEditor.js";

export function CodexNativeOptions({ editor }: { editor: CodexSettingsEditor }) {
  const { settings, nativeDrafts, busy } = editor.getSnapshot();
  const [search, setSearch] = useState("");
  const [newProfile, setNewProfile] = useState("");
  const configuration = settings?.configuration;
  if (!configuration) return null;
  const supported = configuration.blockedReason ? [] : codexConfigurationCatalog(configuration.selectedVersion);
  const inventory = new Map(codexConfigurationCatalog(CODEX_CONFIGURATION_BASELINE_VERSION).map(entry => [entry.path, entry]));
  for (const entry of supported) inventory.set(entry.path, entry);
  const catalog = [...inventory.values()].sort((a, b) => a.path.localeCompare(b.path));
  const query = search.toLowerCase().trim();
  const matches = catalog.filter(entry => !query || `${entry.path} ${entry.group} ${entry.description} ${entry.reason ?? ""}`.toLowerCase().includes(query));
  const groups = [...new Set(matches.map(entry => entry.group))];

  return <section className="codex-native-options" aria-label="Native Codex configuration">
    <h3>Native Codex options</h3>
    <p>Selected executable: {configuration.selectedCommand} · {configuration.selectedVersion}. Coverage baseline: {configuration.baselineVersion}.</p>
    <p>Editing user configuration: {configuration.sourcePath}. Leave an option unset to inherit its native default. Structured values use JSON; nested paths and enum choices are listed with each family. Authentication values are hidden and preserved when editing an entry. Unset removes the whole selected family, including its stored credentials.</p>
    <label>Configuration target<select aria-label="Configuration target" value={editor.getSnapshot().targetProfile ?? ""} disabled={busy !== null} onChange={event => void editor.selectTargetProfile(event.target.value || undefined)}>
      <option value="">Base user config.toml</option>
      {[...new Set([...(configuration.profileFiles ?? []), ...(editor.getSnapshot().targetProfile ? [editor.getSnapshot().targetProfile!] : [])])].map(name => <option key={name} value={name}>{name}.config.toml</option>)}
    </select></label>
    <div><label>New profile name<input aria-label="New profile name" value={newProfile} disabled={busy !== null} onChange={event => setNewProfile(event.target.value)} /></label>
      <ControlButton disabled={busy !== null || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(newProfile)} onClick={() => void editor.selectTargetProfile(newProfile)}>Edit profile</ControlButton>
      <small>Changing targets discards unsaved edits. Saving an option creates the separate native profile file.</small>
    </div>
    {!editor.getSnapshot().targetProfile ? <label>Launch configuration profile<select aria-label="Launch configuration profile" disabled={busy !== null} value={editor.getSnapshot().configProfile} onChange={event => editor.selectLaunchProfile(event.target.value)}><option value="">Base user defaults</option>{(configuration.profileFiles ?? []).map(name => <option key={name} value={name}>{name}</option>)}</select><small>CloudX layers this file into the generated backend configuration and passes --profile to the terminal for new tabs and workers. It does not write the rejected legacy profile key.</small></label> : null}
    {configuration.blockedReason ? <p role="alert">{configuration.blockedReason}</p> : null}
    <details><summary>Configuration layers and overrides</summary>
      <ol>{configuration.layers.map(layer => <li key={layer}>{layer}</li>)}</ol>
      <ul>{configuration.overrides.map(override => <li key={override}>{override}</li>)}</ul>
      <p>Project and administrator policy are evaluated by Codex for each launch. Enforced requirements cannot be changed here. Existing sessions retain their launch configuration.</p>
    </details>
    <label>Search Codex options<input aria-label="Search Codex options" type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
    {editor.nativeError ? <p role="alert">{editor.nativeError}</p> : null}
    {!matches.length ? <p>No matching native options.</p> : null}
    {groups.map(group => <details key={`${group}-${Boolean(query)}`} open={Boolean(query)} className="codex-settings-group">
      <summary>{group}</summary>
      {[...new Set(matches.filter(entry => entry.group === group).map(entry => entry.family))].map(family => {
        const entry = catalog.find(entry => entry.path === family)!;
        const selected = supported.find(entry => entry.path === family);
        const editable = Boolean(selected?.editable) && !configuration.blockedReason;
        const value = configuration.values[family];
        const draft = nativeDrafts[family] ?? (value === undefined ? "" : JSON.stringify(value, null, 2));
        return <fieldset key={family} disabled={busy !== null || !editable}>
          <legend>{family} · {entry.status} · {entry.platform}</legend>
          <p>{entry.description || "Native structured configuration."}</p>
          <small>Type: {entry.type}. Scope: {entry.scope}. Native default: {entry.defaultDescription}{entry.enum ? ` Choices: ${entry.enum.map(value => JSON.stringify(value)).join(", ")}.` : ""}</small>
          {!editable ? <p>{selected?.reason ?? (selected ? entry.reason : `Unavailable in selected Codex ${configuration.selectedVersion}.`)}</p> : <>
            <label>{family}<textarea aria-label={`Native ${family}`} value={draft} rows={typeof value === "object" ? 6 : 2} spellCheck={false} onChange={event => editor.setNativeOption(family, event.target.value)} /></label>
            <ControlButton onClick={() => editor.setNativeOption(family, "")}>Unset {family}</ControlButton>
            <small>Blank means unset/inherit. Strings need JSON quotes; tables use objects and lists use arrays.</small>
            {JSON.stringify(configuration.effectiveValues[family]) !== JSON.stringify(value) ? <p>Effective user/profile value: {JSON.stringify(configuration.effectiveValues[family])}</p> : null}
          </>}
          {catalog.some(child => child.family === family && child.path !== family) ? <details><summary>Nested options for {family}</summary><ul>
            {catalog.filter(child => child.family === family && child.path !== family).map(child => <li key={child.path}><code>{child.path}</code>: {child.description} Type: {child.type}. {child.enum ? `Choices: ${child.enum.map(value => JSON.stringify(value)).join(", ")}. ` : ""}{child.defaultDescription} · {child.status} · {child.platform}{child.reason ? ` · ${child.reason}` : ""}</li>)}
          </ul></details> : null}
        </fieldset>;
      })}
    </details>)}
    <details><summary>CLI launch options</summary><p>These affect a launch rather than persistent defaults.</p><ul>{codexConfigurationCliCatalog(configuration.blockedReason ? configuration.baselineVersion : configuration.selectedVersion).map(option => <li key={option.path}><code>{option.path}</code>: {option.reason}</li>)}</ul></details>
  </section>;
}

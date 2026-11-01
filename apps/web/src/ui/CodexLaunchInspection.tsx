import { useEffect, useRef, useState } from "react";
import type { CodexLaunchPolicyInspection } from "@cloudx/shared";
import type { UiContributionRenderContext } from "./uiContributions.js";
import { ControlButton } from "./Control.js";
import { AgentLaunchRecordView } from "./AgentLaunchRecordView.js";

export function CodexLaunchInspection({ callHook, disabled = false }: { callHook: NonNullable<UiContributionRenderContext["callHook"]>; disabled?: boolean }) {
  const [tabId, setTabId] = useState("");
  const [inspection, setInspection] = useState<CodexLaunchPolicyInspection>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(() => () => { revision.current += 1; }, []);
  async function inspect() {
    const current = ++revision.current;
    setPending(true); setError(""); setInspection(undefined);
    try {
      const result = await callHook<{ inspection: CodexLaunchPolicyInspection }>("codex-settings.inspect-launch", { tabId });
      if (current === revision.current) setInspection(result.inspection);
    } catch {
      if (current === revision.current) setError("Generated launch inspection is unavailable. Check the tab or worker ID and its source ownership; no client was started or changed.");
    } finally { if (current === revision.current) setPending(false); }
  }
  return <details><summary>Inspect a generated Codex launch</summary>
    <p>Enter an existing Codex tab or Forge worker tab ID. This reads its owned generated configuration on disk. It does not measure live native state or substitute the currently selected CLI version.</p>
    <label>Codex tab or worker tab ID<input aria-label="Codex launch inspection tab ID" value={tabId} disabled={disabled} onChange={event => { revision.current += 1; setPending(false); setTabId(event.target.value); setInspection(undefined); setError(""); }} /></label>
    <ControlButton disabled={disabled || pending || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(tabId)} onClick={() => void inspect()}>{pending ? "Inspecting…" : "Inspect generated launch"}</ControlButton>
    {error ? <p role="alert">{error}</p> : null}
    {inspection ? <>
      <p>Observed generated file: {inspection.sourcePath}. Tab: {inspection.tabId}.</p>
      {inspection.launchRecord ? <AgentLaunchRecordView record={inspection.launchRecord} /> : <p>No launch-time record exists for this execution. Its historical version, account and arguments remain unobserved.</p>}
      <table><thead><tr><th>Skill path and source</th><th>Availability</th><th>Fresh default</th><th>Recorded launch selection</th><th>Provenance</th></tr></thead><tbody>
        {inspection.skills.map((skill, index) => <tr key={`${index}-${skill.path}`}><th>{skill.path}<small>{skill.source}</small></th><td>{skill.available ? "SKILL.md present" : "Missing"}</td><td>{skill.freshDefault}</td><td>{skill.enabled ? "Enabled" : "Disabled"}</td><td>{skill.provenance}</td></tr>)}
      </tbody></table>
      {!inspection.skills.length ? <p>No explicit path-based skill selections are recorded in this generated file. Name-based or later native discovery is unresolved.</p> : null}
      <details><summary>Redacted generated configuration</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(inspection.values, null, 2)}</pre><p>Known authentication fields and native-managed state are hidden.</p></details>
      <p>Current server environment variable names: {inspection.serverEnvironmentKeys.join(", ") || "None from the reviewed provider/proxy prefixes"}. Values are hidden.</p>
      <ul>{inspection.unresolvedLayers.map(layer => <li key={layer}>{layer}</li>)}</ul>
    </> : null}
  </details>;
}

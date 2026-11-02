import type { AgentLaunchRecord } from "@cloudx/shared";

export function AgentLaunchRecordView({ record }: { record: AgentLaunchRecord }) {
  return <section aria-label="Recorded agent launch">
    <h4>Launch-time observations</h4>
    <p>{record.providerId} · Tab {record.tabId} · Execution {record.executionId} · Recorded {record.recordedAt}</p>
    <p>Command: <code>{record.command}</code>. Pre-launch version probe: {record.version ?? "unobserved"}. Selected account: {record.accountId ?? "native/default account; identity unrecorded"}. Workspace: {record.cwd}.</p>
    <p>These facts describe this launch. A later account or executable selection does not change this record. Login-shell command resolution, project trust decisions, remote policy changes and later skill discovery remain native-owned and unobserved here.</p>
    {record.providerId === "claude" && (record.claudeLaunchPolicy ? <section aria-label="Recorded Claude source policy">
      <h4>Claude source policy for this execution</h4>
      <p>Mode: {record.claudeLaunchPolicy.mode === "cloudx-managed" ? "CloudX-managed" : "Native project"}. Choice source: {record.claudeLaunchModeSource}. Native contract: {record.claudeLaunchPolicy.nativeVersion}. Changes apply at the next launch.</p>
      <p>{record.claudeLaunchPolicy.exclusiveSkills ? "Exclusive skill selection uses the supplied snapshots and the recorded controlled source boundary." : "Native project discovery remains available. Supplied CloudX skill choices are additions, not an exclusive allowlist."}</p>
      <p>Native setting sources: {record.claudeLaunchPolicy.settingSources.join(", ")}. Included: {record.claudeLaunchPolicy.includedSources.join("; ")}. Excluded: {record.claudeLaunchPolicy.excludedSources.join("; ")}.</p>
      <p>This is the resolved launch contract and supplied source snapshot. File hashes do not establish later native settings, trust decisions or policy changes.</p>
      {record.historicalClaudeConversation && <p>The resumed conversation's earlier launch policy is historical and unverified; this record describes only this new execution.</p>}
      <table><thead><tr><th>Supplied skill</th><th>Original source</th><th>Native loader</th><th>Account origin</th><th>Source path</th><th>Snapshot SHA-256</th></tr></thead><tbody>
        {record.claudeLaunchPolicy.skills.map(skill => <tr key={skill.name}><th>{skill.name}</th><td>{skill.origin}</td><td>{skill.nativeSource ?? "unobserved"}</td><td>{skill.account ?? "Not account-scoped"}</td><td>{skill.sourcePath}</td><td>{skill.sha256}</td></tr>)}
      </tbody></table>
    </section> : <p>Historical Claude launch policy is unverified. Today's saved mode is not substituted for this execution.</p>)}
    <p>Arguments retain reviewed flags and values. Prompt text, remote connection targets, unknown arguments and configuration-override values are omitted.</p>
    <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(record.arguments)}</pre>
    <p>Pre-shell environment variable names: {record.environmentKeys.join(", ") || "None"}. Account/configuration keys enforced after the login shell: {record.enforcedEnvironmentKeys.join(", ") || "None"}. Values are never recorded.</p>
    <table><thead><tr><th>Configuration source</th><th>Observation at launch</th><th>SHA-256</th></tr></thead><tbody>
      {record.configurationSources.map(source => <tr key={source.path}><th>{source.path}</th><td>{source.state}</td><td>{source.sha256 ?? "unobserved"}</td></tr>)}
    </tbody></table>
    <p>A source fingerprint establishes which file bytes were present, not whether native trust or managed precedence applied them. A missing record is never filled with today's settings.</p>
    {record.skillSelections.length ? <>
      <h4>External skill choices at launch</h4>
      <table><thead><tr><th>Name</th><th>Source</th><th>Fresh CloudX default</th><th>Launch selection</th><th>File availability</th></tr></thead><tbody>
        {record.skillSelections.map((skill, index) => <tr key={`${index}-${skill.source}-${skill.name}`}><th>{skill.name}</th><td>{skill.source}</td><td>Not selected</td><td>{skill.selected ? "Allowed" : "Not selected"}</td><td>{skill.available ? "Present" : "Missing"}</td></tr>)}
      </tbody></table>
      <p>These are saved external choices observed at launch. CloudX/system template skills have their separate source policy. Native loading, later arrivals and name collisions require the native skill-policy contract; selection alone does not prove containment.</p>
    </> : null}
  </section>;
}

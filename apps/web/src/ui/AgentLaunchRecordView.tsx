import type { AgentLaunchRecord } from "@cloudx/shared";

export function AgentLaunchRecordView({ record }: { record: AgentLaunchRecord }) {
  return <section aria-label="Recorded agent launch">
    <h4>Launch-time observations</h4>
    <p>{record.providerId} · Tab {record.tabId} · Execution {record.executionId} · Recorded {record.recordedAt}</p>
    <p>Command: <code>{record.command}</code>. Pre-launch version probe: {record.version ?? "unobserved"}. Selected account: {record.accountId ?? "native/default account; identity unrecorded"}. Workspace: {record.cwd}.</p>
    <p>These facts describe this launch. A later account or executable selection does not change this record. Login-shell command resolution, project trust decisions, remote policy changes and later skill discovery remain native-owned and unobserved here.</p>
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

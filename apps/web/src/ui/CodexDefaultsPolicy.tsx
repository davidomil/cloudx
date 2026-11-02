import type { CodexGlobalSettings } from "@cloudx/shared";

export function CodexDefaultsPolicy({ settings }: { settings: CodexGlobalSettings }) {
  return <details className="codex-settings-group"><summary>Defaults and launch policy</summary>
    <p>This view shows saved global choices and the policy for future launches. It does not observe a running native session. Saving preserves existing clients; Reload only rereads saved settings and discards drafts.</p>
    <table><thead><tr><th>Choice</th><th>Fresh CloudX default</th><th>Saved selection</th><th>Launch effect</th></tr></thead><tbody>
      <tr><th>Permission bypass</th><td>Enabled</td><td>{settings.yoloMode ? "Enabled" : "Disabled"}</td><td>When enabled, CloudX launch arguments bypass native sandbox and approval prompts. When disabled, native user/project policy applies; administrator requirements remain authoritative.</td></tr>
      <tr><th>Workspace auto-trust</th><td>Disabled</td><td>{settings.autoTrustWorkspace ? "Enabled" : "Disabled"}</td><td>Only the launch workspace is trusted in the generated home. Explicit distrust is rejected.</td></tr>
      <tr><th>Native memory</th><td>Inherited from selected Codex version</td><td>See native memory and feature options</td><td>CloudX does not apply Claude's auto-memory suppression to Codex.</td></tr>
      <tr><th>Vendor skills</th><td>imagegen selected</td><td>{settings.defaultSkills.filter(skill => skill.enabled).map(skill => skill.id).join(", ") || "None"}</td><td>Selected cached skills are included for new launches. An enabled but missing skill blocks launch.</td></tr>
      <tr><th>Account and model</th><td>Selected account; CloudX default model when unset</td><td>{settings.model ?? "Unset/inherit"}</td><td>Explicit tab/Forge model and effort choices take precedence. Account changes affect new launches; existing processes retain their account environment.</td></tr>
    </tbody></table>
    <p>Native defaults are versioned in Native Codex options. Unset removes a saved override. The user/profile projection excludes project settings, administrator requirements, environment and launch arguments. Effective values for an individual open session are unresolved here; no credentials are read or displayed.</p>
    <table><thead><tr><th>Skill source</th><th>Availability and provenance</th><th>Launch selection</th></tr></thead><tbody>
      <tr><th>CloudX system catalog</th><td>Managed by the CloudX rules/skills catalog</td><td>System skills are included.</td></tr>
      <tr><th>Selected template</th><td>Chosen for each tab or Forge worker, not a global selection</td><td>The selected template's skills are included.</td></tr>
      <tr><th>Native vendor shared cache</th><td>Rows below report SKILL.md presence in skills/.system. Selected-version provenance is unverified.</td><td>Availability is separate from the saved selection; only selected available rows can launch.</td></tr>
      <tr><th>Personal</th><td>Native home sources; not enumerated by this global cache list</td><td>Selected catalog skills are materialized. Discovered .agents/skills paths are disabled unless explicitly configured in native skills.config.</td></tr>
      <tr><th>Synced</th><td>Not enumerated by this global cache list</td><td>Availability and native loading are not observed here.</td></tr>
      <tr><th>Project and nested project</th><td>Depends on the launch directory</td><td>Discovered .agents/skills and .codex/skills paths are disabled at launch unless explicitly configured in native skills.config. Later discovery is not observed here.</td></tr>
      <tr><th>Plugins</th><td>Native plugin layers</td><td>Subject to native configuration; presence and effective loading are not observed here. Native bundled skills are disabled by the overlay.</td></tr>
      <tr><th>Managed</th><td>Administrator policy; values are read-only</td><td>Discovered /etc/codex/skills paths are disabled unless explicitly configured. Enforced native requirements remain authoritative.</td></tr>
    </tbody></table>
    <p>Native agent views and descendant/background agents remain activity of their parent native process. CloudX does not provide separate tab status, recovery or cleanup for those native children. Native-created worktrees and standalone background sessions are unsupported as managed CloudX resources; use CloudX workspace and Forge controls for owned checkouts.</p>
    <p>Forge and automation can provide explicit launch settings. A native setting's presence in the catalog does not establish CloudX lifecycle support for a native mode.</p>
  </details>;
}

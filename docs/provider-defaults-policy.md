# Provider defaults and launch policy

Settings distinguishes saved user choices from native defaults and generated launch
policy. The Settings snapshot is not a measurement of an open client's effective
configuration. CloudX launch preferences apply to future launches. Native user
settings follow the selected client's documented reload or next-turn behavior;
model and effort defaults for future sessions do not replace native /model or
/effort commands for an existing session. Reload rereads shared state and
discards drafts; it does not restart a client or replay work.

| Fresh CloudX choice | Codex | Claude |
| --- | --- | --- |
| Permission bypass | YOLO enabled | bypassPermissions |
| Workspace auto-trust | Disabled | Enabled |
| Vendor/native skill selection | imagegen selected from shared cache | No personal/synced names selected |
| CloudX system skills | Included | Included |
| Selected template skills | Included for the launch | Included for the launch |
| Native bundled skills | Disabled by generated overlay | Disabled by generated settings |
| Native memory | Inherit selected Codex/native configuration | autoMemoryEnabled=false in generated settings |

These differences preserve the existing product policy. Existing saved permission,
trust, model, memory, account and skill choices are not reset by the visibility UI.
Permission bypass warning acceptance, allowed directories and selected-account
boundaries remain prerequisites in their existing owners.

Native defaults come from the selected release. A model-, provider-, terminal-, OS-
or policy-dependent value remains unresolved until that context is established.
Unset removes the stored override; it does not remove a CloudX launch argument or
an enforced administrator requirement. The saved user/profile projection does not
include every trusted project, environment, administrator or explicit launch layer.
Credential values remain hidden; managed settings remain read-only.

## Skills and provenance

| Source | Codex launch contract | Claude launch contract |
| --- | --- | --- |
| CloudX system catalog | Materialize system skills | Materialize system skills |
| Selected template | Materialize selected catalog skills | Materialize selected catalog skills |
| Native vendor cache/bundle | Shared skills/.system files are availability evidence only; selected-version provenance is unverified. Materialize selected available entries. Missing enabled entries block launch. Disable native bundled discovery. | Disable bundled discovery |
| Personal | Materialize selected catalog sources. Disable discovered .agents/skills paths unless an explicit native skills.config entry owns the path. | Link individually selected allowed skill names |
| Project/nested project | Disable discovered .agents/skills and .codex/skills files at launch unless explicitly configured; a later-discovered set is not measured by global Settings. | Launch-time discovered names are disabled; later-discovery containment requires independent native validation |
| Synced | Global vendor-cache view does not enumerate or verify synced loading | Selected synced sources and later arrival require containment validation; global Settings is not proof of the loaded set |
| Plugin | Native configuration remains a separate layer; loaded plugin skills are not observed in global Settings | Generated launch disables known enabled plugins and native plugin sync |
| Managed | Enforced administrator requirements win; discovered /etc/codex/skills paths are disabled unless explicitly configured | Managed policy remains authoritative and is not editable here |

Availability, a fresh default selection, a saved launch selection and observed
native loading are different facts. The global source matrix deliberately marks
unobserved sets rather than presenting them as empty or completely enforced.
Codex Settings also provides a generated-launch inspector by existing tab/worker
tab ID. It reads the source-bound generated config without launching a client,
redacts known authentication/native-managed fields, and lists recorded skill path
selections with source classification, local file presence and provenance. Server
environment variable names are shown without values. The generated file is an
on-disk observation, not proof of what an already-running process loaded.
An effective per-session layer and skill inventory is still required to establish
all project/environment/managed contributions for an individual client.

## Native activity and resource ownership

Native agent views and native descendant/background agents are activity inside
the parent native process. They are not independently managed CloudX tabs.
CloudX has no separate status, recovery or cleanup contract for those native
children. Native-created worktrees and standalone native background sessions are
unsupported as managed CloudX resources. Use CloudX workspace and Forge controls
for checkouts that CloudX owns and recovers. A schema setting or launch flag in a
catalog does not establish lifecycle support.

Explicit tab or Forge model/effort/account inputs can override global choices.
A running process retains its launch inputs and environment. Changing the selected
provider version or account is a future-launch operation, not a live migration.

## Versioned Codex evidence

On 1 November 2026 the official GitHub latest-release endpoint and release page
identified [0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0),
published 29 October 2026. This primary source is authoritative for the release,
not proof of compatibility with CloudX. Exact runtime checks remain separate.
The 0.160.0, 0.162.1 and 0.166.0 catalog entries retain schema hashes and pinned
loader, feature-registry, permission-map and CLI source references. CLI help for
the scoped interactive, exec, resume/fork/review and app-server launch commands
was read from the isolated 0.166.0 release executable without activating it.

Pinned keymap sources establish each action/context's built-in bindings. A saved
context wins over a reusable global binding, then the built-in default. Empty
lists unbind actions. Native conflict checks, chord prefixes and active surfaces
can shadow inherited bindings. Browser delivery remains a separate concern.
For example, voice mute is Ctrl+X in 0.160.0/0.162.1 and F9 in 0.166.0; 0.166.0
introduces the Ctrl+X leader with implicit selection/preset chords. Plain Enter
can be consumed by the composer before the editor newline action.

The source-derived defaults file records the native loader constants and keymap
tables inspected in each pinned tag. Other schema defaults and platform-dependent
feature defaults retain their own provenance. Values not established by this
review are labelled unestablished; that label does not assert they are dynamic.
The rolling [official configuration reference](https://developers.openai.com/codex/config-reference/)
is authoritative for general scope guidance, but does not substitute for tagged
evidence about an exact selected version.

Claude copyOnSelect, copyFullResponse and externalEditorContext seed from the
personal native file. At the next launch, differences from a known tab file are
captured into an allowlist-only CloudX preference file. Existing tabs retain
their local values; the newest changed native configuration file wins for future
tabs when edits compete. This does not copy credentials/trust or rewrite the
personal file. Personal rules retain their directory structure, and personal
instruction text keeps its existing inclusion without an extra native import hop.
Original source identity, relative imports outside the shared rules tree, broken
imports and trust/depth equivalence still need native acceptance under #237.

## Selected Claude accounts and service routing

The reviewed account-policy registry covers current credential, provider, endpoint,
refresh-token, federation/profile, config-directory and cloud-chain variables.
A resolved launch object supplies the process environment, the values reapplied
following login-shell initialization, and the private native settings overlay.
Login/status, terminal/Forge and one-shot/automation launches use that contract.
Native Anthropic profiles are scoped to a CloudX-owned launch or account directory,
so the SDK's active/default profile cannot select an unrelated home profile.

Explicit service AWS/GCP/Azure credentials remain available and are pinned after
shell initialization. A selected Anthropic API-key account with a native cloud
provider selector is rejected before launch; its key cannot authenticate that
cloud provider. Multiple provider selectors, including the native Bedrock/Mantle
dual route, are unsupported until their identity/accounting contract is defined.
Authentication/routing custom headers that conflict with an API-key account are
also rejected. No saved preference or running process is rewritten.

Generated native settings suppress apiKeyHelper, awsAuthRefresh,
awsCredentialExport and gcpAuthRefresh from lower user/project sources. Native
2.1.316 auth status confirmed that the api-key-helper selection changes to none
when the generated settings are applied, without a model request. Known
file-based managed routing, helper, provider-allowlist and login-identity conflicts
stop before a client is spawned. Managed fragments follow native file order;
matching service routing is retained rather than silently overridden. Diagnostics
name keys and policy sources and do not print credential values.

The [official environment reference](https://code.claude.com/docs/en/env-vars),
[settings reference](https://code.claude.com/docs/en/settings-reference) and
[WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference)
are primary evidence, reviewed on 1 November 2026. Native behavior was probed with
2.1.316; this does not establish every older or future release. CloudX does not
enable CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST implicitly because it also changes
native model-policy and feature behavior.

Remote/server-managed, MDM and registry policy, policy-helper results, late policy
updates and the complete cloud credential-chain behavior remain unestablished by
these file-backed checks. Unsupported known file-based combinations fail clearly;
full selected-account acceptance still requires effective native policy inspection
and version-matched fixtures for those other sources. No paid native turn or live
credential was used in this validation.

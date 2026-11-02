# Provider defaults and launch policy

Settings distinguishes saved user choices from native defaults and generated launch
policy. The Settings snapshot is not a measurement of an open client's effective
configuration. CloudX launch preferences apply to future launches. Native-project
Claude tabs share the original user settings file and follow the selected client's
documented reload or next-turn behavior. CloudX-managed Claude copies user settings
at launch; edits to the original file reach managed sessions only at the next launch.
Other providers retain their documented native reload behavior.
Model and effort defaults for future sessions do not replace native /model or
/effort commands for an existing session. Reload rereads shared state and
discards drafts; it does not restart a client or replay work.

| Fresh CloudX choice           | Codex                                       | Claude                                        |
| ----------------------------- | ------------------------------------------- | --------------------------------------------- |
| Permission bypass             | YOLO enabled                                | bypassPermissions                             |
| Workspace auto-trust          | Disabled                                    | Enabled                                       |
| Vendor/native skill selection | imagegen selected from shared cache         | No personal/synced names selected             |
| CloudX system skills          | Included                                    | Included                                      |
| Selected template skills      | Included for the launch                     | Included for the launch                       |
| Native bundled skills         | Disabled by generated overlay               | Disabled by generated settings                |
| Native memory                 | Inherit selected Codex/native configuration | autoMemoryEnabled=false in generated settings |

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

Native-project Claude tabs record native bypass-warning acceptance in the shared
user settings. A CloudX-managed tab records native acceptance only in its own
settings snapshot. Acknowledging the warning in Settings → Claude updates the
original user settings for future launches, including Forge; it does not update
an open managed snapshot. CloudX never accepts the warning automatically.

## Skills and provenance

| Source                     | Codex launch contract                                                                                                                                                                                                  | Claude launch contract                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CloudX system catalog      | Materialize system skills                                                                                                                                                                                              | Materialize system skills                                                                                                          |
| Selected template          | Materialize selected catalog skills                                                                                                                                                                                    | Materialize selected catalog skills                                                                                                |
| Native vendor cache/bundle | Shared skills/.system files are availability evidence only; selected-version provenance is unverified. Materialize selected available entries. Missing enabled entries block launch. Disable native bundled discovery. | Disable bundled discovery                                                                                                          |
| Personal                   | Materialize selected catalog sources. Disable discovered .agents/skills paths unless an explicit native skills.config entry owns the path.                                                                             | Copy selected skill snapshots; reject conflicting source/name ownership before launch                                              |
| Project/nested project     | Disable discovered .agents/skills and .codex/skills files at launch unless explicitly configured; a later-discovered set is not measured by global Settings.                                                           | Native discovery in Native project; excluded by the CloudX-managed source boundary                                                 |
| Synced                     | Global vendor-cache view does not enumerate or verify synced loading                                                                                                                                                   | Copy only selected skill snapshots with native names and original account provenance; no background sync or whole synced root link |
| Plugin                     | Native configuration remains a separate layer; loaded plugin skills are not observed in global Settings                                                                                                                | Generated launch disables known enabled plugins and native plugin sync                                                             |
| Managed                    | Enforced administrator requirements win; discovered /etc/codex/skills paths are disabled unless explicitly configured                                                                                                  | Managed policy remains authoritative and is not editable here                                                                      |

Claude launch mode is an explicit future-launch choice. An unset preference
keeps **Native project** as the fresh default; **CloudX-managed** is opt-in.
Settings, new Claude tabs, Forge coding/review roles and automation accept an
explicit choice or inherit the saved preference. Reading Settings never starts
a native client. Permission, trust, account and template choices are separate.

| Source contract                                  | Native project                                                   | CloudX-managed                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Native setting sources                           | user, project, local                                             | user only, verified on Linux with Claude 2.1.316                                  |
| Shared project settings, project CLAUDE.md/rules | Native behavior retained                                         | Omitted; not flattened or reimported                                              |
| Local settings and CLAUDE.local.md               | Native behavior retained                                         | Not supported in this configuration; existing local inputs reject before launch   |
| Personal instructions and rules                  | Native loader, original imports/trust                            | Native loader, original imports/trust                                             |
| Selected external and CloudX skills              | Supplied additions; native project discovery remains available   | Supplied skill snapshots form the controlled available set                        |
| Synced source                                    | Selected skill copied with original account/path/hash provenance | Selected skill copied with original account/path/hash provenance                  |
| Later project/nested/add-dir/directory discovery | Native behavior; selection is not an exclusive allowlist         | Excluded by the verified native source contract                                   |
| Plugin discovery                                 | Existing CloudX plugin policy and native project scope           | No plugin source directory; incompatible injection/settings/managed policy reject |

The tested `user,local` setting-source restriction also removes shared project
memory/rules, but leaves local settings able to introduce plugins later. It is
not the managed contract. The supported managed configuration uses `user` only,
a user-settings snapshot, selected skill snapshots and a tab-owned plugin-path
precondition. Original provider settings/skill/plugin arrivals cannot change
that supplied set. Native reload and directory-transition fixtures verify this
boundary; name enumeration, filesystem watchers and hook timing do not enforce it.
Existing local inputs or incompatible managed/native sources fail with their
source/key and a Native project alternative before prompt/model work. CloudX does
not bypass organization policy or pass the unrelated native restricted/safe-mode
flags. This release does not claim a managed contract for another version or OS.

Selections, revocation, template changes and source updates apply at the next
launch. Skill snapshots keep the native skill name and supporting files; original
personal/synced/account origins and content hashes are recorded separately from
the native loader's `user` category. No whole mutable synced directory is linked.
A running execution is not rematerialized when templates change.

Each execution records its resolved mode, source scope and supplied snapshots.
A bound conversation keeps its mode, account and workspace on CloudX resume or
recovery, even when the saved default changes. Native navigation is checked again
by the required prompt hook before model work. A new or cleared conversation can
bind the current policy; resumed history must match its recorded mode, account and
workspace. Use a new conversation to change those choices. Automatic interrupted-turn
continuation is unsupported: its environment flag is rejected in configuration
preflight and after login-profile setup rather than silently removed. Managed
launches pin the verified executable through login-profile PATH changes. Historical conversations without a recorded policy remain unverified
and can resume only under an explicit/non-managed Native project choice; current
Settings never supplies a historical managed claim. Select an exact conversation;
ambiguous picker/last startup cannot verify its policy before work.

Availability, a fresh default selection, a saved launch selection and observed
native loading are different facts. The global source matrix deliberately marks
unobserved sets rather than presenting them as empty or completely enforced.
Codex Settings also provides a generated-launch inspector by existing tab/worker
tab ID. It reads the source-bound generated config without launching a client,
redacts known authentication/native-managed fields, and lists recorded skill path
selections with source classification, local file presence and provenance. Server
environment variable names are shown without values. The generated file is an
on-disk observation, not proof of what an already-running process loaded.

Both provider panels can also inspect a launch-time record by tab or worker tab
ID. New launches record the execution ID, selected account ID, native command,
pre-launch version probe, reviewed arguments, environment variable names and
bounded configuration-file SHA-256 fingerprints. Claude records external skill
choices and file availability separately from actual native loading. Its inspector
shows the fresh external-skill default (not selected) beside the historical launch
choice; an allowed choice is not evidence that the native client loaded it. Prompt text,
environment values, remote connection targets, arbitrary arguments and inline
configuration values are omitted. Records use private files; inspection does not
start a native client. An older launch without a record stays unobserved rather
than inheriting today's settings or account selection.

The record identifies bytes present at launch; a project-file fingerprint does
not prove that native project trust accepted it. Shell command lookup, later
project/managed policy changes and later skill discovery remain explicitly
unobserved. Native effective settings can be inspected in isolated no-model
fixtures; that print-mode inspection runs SessionStart hooks, so CloudX does not
run it as an extra production preflight or replay user hooks merely to show
Settings.

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
personal file. Personal rules retain their directory structure. The overlay links
the original personal CLAUDE.md and appends CloudX-only instructions through the
native append-system-prompt-file flag. This retains the original source directory
without adding an import hop. Native 2.1.316 fixtures verify relative imports,
escaped spaces, the fourth/fifth import-depth boundary, nested/path-scoped rules,
and approved/denied external project imports. Native 2.1.316 applies
`claudeMdExcludes` to the overlay root alias before resolving its symlink. CloudX
therefore rejects a personal `CLAUDE.md` combined with nonempty file-based
`claudeMdExcludes` before creating overlay state or starting native work. The
diagnostic names the source/key and asks the user to choose a configuration
without this unsupported combination; it does not change their policy. The check
includes user, ancestor/project/local and file-based managed sources, including
the main checkout local settings for a linked worktree. No root file or no
exclusions retains normal native behavior. CloudX does not rewrite exclusions or
emulate the native glob matcher. The overlay inherits only the
current project's typed trust/import decisions, preserving subsequent per-tab
decisions without copying credentials, allowed tools or other projects.

The separate native settings review verifies all eleven typed Boolean controls,
language, channel, user/project/launch precedence and unset on 2.1.316 through
the production settings owner. Unrelated native values survive these edits.
This establishes the native merge contract, not full runtime behavior for every
reference entry or another native release. The searchable catalog keeps these
exact-version observations separate from reference defaults and unknown values.

## Selected Claude accounts and service routing

The account-policy registry is reviewed for Claude **2.1.316**. Terminal and
account login/status/automation paths check `--version` without starting a
session and reject an unreviewed or malformed version before native account or
model work. The error names the supported version and leaves saved accounts and
files intact; CloudX does not update or select another binary automatically.

The reviewed registry covers credential, provider, endpoint,
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

Before terminal launch, CloudX also runs native `auth status --json` with the
resolved environment and generated settings. It checks provider, configuration
directory and authentication method/source names without starting a model turn
or executing SessionStart hooks. Account status uses the same validator. Invalid
contracts, conflicting helpers, abnormal exits and an unsuccessful exit paired
with successful-looking login data fail explicitly. The native readback does not
reveal or compare credential bytes, endpoint values or every cloud-chain identity;
it is not full proof of account isolation under an unknown managed source.

Forge defers the initial prompt until the actual native process delivers its
execution-bound SessionStart receipt. The prompt is submitted once, and CloudX
requires a matching UserPromptSubmit receipt. Missing, invalid or wrong-session
receipts stop that launch. The hook helper blocks Forge prompt work if it cannot
write the owned receipt. Interactive tabs show tracking unavailable after a
missing startup receipt and recover their prior activity indicator if it arrives
later. These checks establish delivered receipts; they do not continuously
certify that a later policy change will permit Stop or StopFailure delivery.

The [official environment reference](https://code.claude.com/docs/en/env-vars),
[settings reference](https://code.claude.com/docs/en/settings-reference) and
[WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference)
are primary evidence, reviewed on 1 November 2026. Native behavior was probed with
2.1.316; this does not establish every older or future release. CloudX does not
enable CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST implicitly because it also changes
native model-policy and feature behavior.

Supported native lifecycle fixtures bind the real SessionStart receipt, observe
running and continued turns at a local synthetic Messages endpoint, and receive
Stop success and StopFailure failure receipts. Selected endpoint/header/key
fixtures cross process, login-shell and native user/project/local settings
boundaries with fake values. A persistent native process is used for failure
receipts: one-shot print can exit before its asynchronous StopFailure delivery.
These checks establish the supported contract; arbitrary future remote/MDM/registry
policy changes and real cloud credential chains remain unobserved, not certified.
Known incompatible managed combinations fail clearly before launch. No personal
credentials or paid requests were used.

Physical terminal sign-off remains **Not run** and is tracked independently in
[#253](https://github.com/davidomil/cloudx/issues/253), by the owner decision of
2 November 2026. Automated browser, PTY and exact-version Linux native evidence
remains separate; it does not establish physical macOS/Windows/iOS/Android, IME,
external-keyboard or platform-editor behavior.

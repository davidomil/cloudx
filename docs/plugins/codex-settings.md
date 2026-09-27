# Codex Settings

[All plugins](README.md)

## Purpose and access

Set shared defaults for future Codex sessions in **Settings \> Codex**.
This plugin does not create a workspace tab.

![Codex Settings showing a synthetic model default and fast mode controls.](../screenshots/cloudx-plugin-codex-settings.png)

The demo uses a synthetic settings response; it does not read or edit a real Codex configuration.

The defaults are shared by CloudX instances using the same Codex home.
Running sessions keep their current settings; profiles, project
settings, and session overrides may take precedence.

![Open Codex settings, edit and save defaults, then launch a new session.](diagrams/codex-settings.png)

Settings affect future launches.

## Update Codex CLI

Open **Settings → Codex** to see the active version for new tabs and
Forge workers. Search published releases or enter an exact version, such
as `0.155.1`. **Select latest stable** and **Return to previous
verified** fill the target for review. Compare the current and selected
versions, then choose **Apply selected version**. Prereleases are
labelled and require an explicit choice.

CloudX prepares a separate installation and checks its exact package and
executable versions. Before activation, real native launches must save
their selected conversation identity and complete ordinary and Forge
turns with an isolated local provider. An already selected version is
verified again and reported as already selected and verified.

The exact selection persists across browser reloads, service restarts,
and ordinary CloudX updates. Running tabs and workers keep their
original binaries and dependencies. Their saved conversations,
authentication, settings, and workspaces remain in place. Installations
are retained so running processes and the previous verified version
remain available.

Downgrades require acknowledgement of shared-state risk. When a previous
verified selection exists, verification also resumes a synthetic
conversation from that version and completes a turn in a still-running
previous session. This checks the integration between versions; it
cannot prove every existing conversation is compatible. Back up shared
Codex state before downgrading.

Settings distinguishes the requested version, installed candidate, and
active version. Failed downloads or verification leave the active
selection intact. Registry errors are visible; CloudX never substitutes
another release. The previous-version action is available only after an
earlier selection passed integration verification.

The server retains the operation and its result when Settings closes or
the browser disconnects. Closing the Settings dialog retains its
existing draft-discard behavior. Raw command output stays in the
private, bounded `codex-update/update.log` under the CloudX data
directory.

Selection requires an absolute npm-owned `CLOUDX_ASSISTANT_BIN` at
`prefix/bin/codex`. It uses only the fixed `@openai/codex` package in
that configured prefix. Other shell installations are unchanged. Custom
wrappers and PATH-only commands require their own installer. Settings
and installer writes share one lock and bounded Linux process
supervision with Python 3.9 or newer.

See [setup and troubleshooting](../SETUP.md#update-codex-from-settings) for
installation requirements and interrupted-selection recovery.

## Use it

1.  Open **Settings**, then **Codex**.
2.  Set **Default model**, or leave it blank to remove the global model
    override.
3.  Choose **Fast mode**: **On** for priority service, **Off** for
    standard service, **Flex** for flexible service, or **Model
    default** to remove that override.
4.  Optionally choose **Reasoning effort**, **Web search**, and
    **Personality**. **Codex default** removes the corresponding global
    override. Reasoning efforts and personality support depend on the model.
5.  Set the session permissions and default skills described below.
6.  Select **Save Codex settings**, then open a new [Codex
    Terminal](codex-terminal.md).

For example, select a different default model before opening the next
implementation session. The terminal already reviewing your change
continues with its current configuration.

## Session permissions

**YOLO mode** bypasses Codex's sandbox and approval prompts. It starts enabled,
matching CloudX's existing launch behavior. Turn it off to let Codex use its
user and project permission settings; turning it off does not rewrite those
settings.

**Automatically trust workspace** starts disabled. When enabled, CloudX marks
the canonical working directory as trusted only in the new session's generated
configuration. It refuses an explicit untrusted workspace or enclosing directory.
The shared project's trust entries stay unchanged. Forge's repository consent
checks still apply independently.

## Default Codex skills

The list comes from the installed Codex skills. Only **imagegen** starts enabled;
other bundled skills must be selected explicitly. Save a different selection to
include those skills in future CloudX sessions. CloudX system skills and template
skills remain managed by the rules and skills catalog.

A selected skill that is removed from the installation prevents a new launch
until it is restored or disabled. Settings marks missing skills as **Not installed**
and lets you disable them.

CloudX stores its launch preferences in a managed comment in the shared
`config.toml`, alongside native Codex defaults. Codex ignores the comment,
including in strict configuration mode. Saves preserve unrelated settings and
comments and reject changes made since the editor last loaded the file.

## If saving fails

If another editor changed the shared configuration, use **Reload**,
reapply your edit, and save. Reload discards unsaved edits. Invalid TOML
must be corrected before this editor can save.

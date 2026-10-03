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

The **Codex CLI** section distinguishes the version active for new tabs
and Forge workers, the requested exact target and the last checked
installed candidate. Search published releases or enter an exact
version, review the preview and select **Apply selected version**. You
can upgrade or downgrade; prereleases are labeled and require explicit
selection.

**Select latest stable** fills an exact version without applying it.
**Select previous verified** is offered after a verified selection has
been replaced; an installation discovered only with `--version` is not a
verified return target. Applying the active version re-verifies it
before reporting **already active and verified**.

CloudX prepares the candidate separately, verifies real native tab
initialization, saved conversation identity and a Forge turn, then
checks isolated snapshots of retained shared SQLite state and
transcripts. Incompatible candidates leave the active selection
unchanged. These snapshots test compatibility at that moment; later
writes by other Codex processes are outside that check.

When a verified active selection exists, CloudX also runs that
executable against the snapshots after any candidate migrations.

The exact selection persists through browser reloads, restarts, CloudX
updates and installer maintenance. New launches use it; running sessions
retain their original executable and dependencies. The operation
preserves authentication, preferences and conversation files.

Closing Settings or reconnecting keeps the server-owned job and its
retained result. Unsaved settings edits remain in the open editor;
closing the entire Settings dialog still discards its draft.

Selection requires an absolute npm-owned `CLOUDX_ASSISTANT_BIN`, Linux
and Python 3.9 or newer on the service PATH. Settings and the installer
share a lock, and failures retain an actionable result with requested,
installed and active versions shown separately. Raw output stays in the
private, bounded `codex-update/update.log`; see [setup and
troubleshooting](../SETUP.md#update-codex-from-settings) for
prerequisites, snapshot limits and interrupted-operation recovery.

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

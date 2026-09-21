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

## Use it

1.  Open **Settings**, then **Codex**.
2.  Set **Default model**, or leave it blank to remove the global model
    override.
3.  Choose **Fast mode**: **On** for priority service, **Off** for
    standard service, **Flex** for flexible service, or **Model
    default** to remove that override.
4.  Select **Save Codex settings**, then open a new [Codex
    Terminal](codex-terminal.md).

For example, select a different default model before opening the next
implementation session. The terminal already reviewing your change
continues with its current configuration.

## If saving fails

If another editor changed the shared configuration, use **Reload**,
reapply your edit, and save. Reload discards unsaved edits. Invalid TOML
must be corrected before this editor can save.

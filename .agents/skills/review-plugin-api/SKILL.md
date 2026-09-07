---
name: "review-plugin-api"
description: "Review CloudX plugin interfaces, metadata, configuration, hook, trigger, and UI contribution contracts."
---

# Review Plugin Contracts

Trace changes from `packages/plugin-api` through shared contracts, server
registries, built-in plugins, and browser consumers as relevant.

- Check typed, serializable metadata and runtime validation at ingestion.
- Keep contract definitions separate from concrete plugin behavior and persistence.
- Preserve configuration privacy and the distinction between public and secret
  settings.
- Installed third-party repositories currently contribute validated metadata,
  not executable plugin code; a metadata change must not silently cross that boundary.
- Identify contract breaks and consumer impact without inventing a compatibility
  layer the user did not request.

Report actionable findings supported by code and tests. Machine output, when
requested, follows `docs/AI_CHANGE_PROCESS.md`.

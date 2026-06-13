# Cloudx Roadmap And Known Gaps

This page tracks public follow-up work that is useful to readers evaluating or
extending Cloudx. It avoids review ledgers, local validation notes, and
developer-specific scratch items.

## Jira

- Add OAuth 2.0 3LO for distributable Jira integrations. The current Jira plugin
  is designed for local single-user API-token use.
- Add multi-site and multi-account Jira profiles. The current plugin has one
  configured Jira Cloud site and one account.
- Add direct Jira webhooks after the deployment and authentication model is
  designed. The current trigger path uses bounded polling and a manual panel
  trigger.
- Expand issue operations for attachments, watchers, worklogs, and richer field
  editing after the core dashboard, comments, transitions, links, and metadata
  flows are stable.

## Automation

- Add richer run history and replay tooling for automation graphs.
- Add more typed node contracts for plugin hook outputs so large object payloads
  stay visible but do not clutter connector wiring.
- Add template examples that combine Jira triggers with documentation search and
  workspace actions.

## Documentation Archive

- Add OCR for scanned PDFs and images. The current extractor preserves rendered
  visual artifacts, but scanned text is not searchable unless another extractor
  produces text.
- Add structured schematic analyzers for component detection, connectivity
  mapping, netlist export, and uncertainty scoring. The current schematic path
  stores Phase 1 classification, source chunks, rendered images, and metadata.
- Add remote embedding-provider options behind explicit configuration. The
  current dense retrieval path is local and deterministic.
- Add scheduled archive health checks and export reminders for long-lived
  installations.

## Security And Deployment

- Add identity-aware authentication for shared deployments.
- Add multi-user authorization boundaries before supporting untrusted users.
- Add stronger hosted reverse-proxy guidance once Cloudx has an authentication
  story beyond localhost, trusted LAN, and tailnet deployments.

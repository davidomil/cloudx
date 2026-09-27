# Installation and upgrade CI

## Required CI scenarios

The clean-install and upgrade jobs run on separate Ubuntu 24.04 virtual
machines. Both must succeed before the CI aggregate, isolated verifier,
and trusted merge identity can succeed. Missing systemd, failed setup,
failed assertions, and skipped lifecycle jobs fail the gate.

The controller creates a fresh Unix user and home, starts its systemd
user manager and bus, and runs that checkout’s own
`./install.sh --yes --answers <file>`. The answers select CPU int8 ASR,
two CPU threads, no optional whisper.cpp, standard user services,
service startup, and linger. The user starts with no CloudX profile,
builds, dependencies, service definitions, or runtime receipts.

Clean installation checks generated configuration, dependencies,
executable entry points, enabled services, HTTPS readiness, ASR and
documentation readiness, and supervised terminal creation and cleanup.
It compares frontend responses with the installed build and verifies the
server’s startup commit, artifact digest, process identity, and systemd
invocation.

The upgrade seeds settings, a split workspace, a live shell, a new
native Codex conversation through the production New tab view and source
binding, and tracked and untracked local work. A local Responses
provider supplies synthetic conversation and title responses. The
fixture uses the installer-selected Codex executable; the evidence
records its version.

The source application starts the update through Settings. The
controller observes its coordinator surviving the source web process. It
waits for durable succeeded status and completed readiness. It checks a
new target web invocation and compares frontend bytes against the
prepared target build. The browser must disconnect, reconnect, and
reload. Compatible terminals must remain attachable without a broker
restart; disclosed interruptions require explicit consent and recovery
without command or prompt replay. The next Settings preflight must still
work through the retained coordinator.

## Immutable revisions and release support

Revision selection runs once. Pull requests use the event’s base-main
SHA and exact tested merge SHA, with both merge parents verified. Main
pushes use the event’s previous tip and pushed SHA. Both revisions must
exist, the target must descend from the source, and the source must
descend from the oldest supported baseline
`3a3de3597402114e5587b5033068cd39b8b3622f`. Upgrade source and target
must differ.

The isolated application has a frozen local Git origin containing the
exact target. A Node preload fixtures only external GitHub catalog reads
so the source’s real catalog can select that target without consulting
moving remote main. It preserves the source UI, preview cache, routes,
updater, and coordinator scripts. Application HTTP, model-provider HTTP,
and Git operations remain real. Unexpected GitHub catalog requests fail
instead of consulting the network.

Release validation must choose the previous supported release at or
after the baseline. Until such a release exists, use the documented
supported main revision `3a3de3597402114e5587b5033068cd39b8b3622f`.
Resolve release tags to full SHAs before starting either scenario. Never
select an older tag solely because it is the latest release. The current
workflow triggers on main pushes and pull requests; it does not add a
release trigger or historical downgrade matrix.

## Running and interpreting evidence

Run the host controller only on a disposable Ubuntu VM with working
systemd PID 1, sudo, vacant ports 3001/7810/7820, and space for two
application builds, Python environments, and downloaded models. Install
controller dependencies with `npm ci` and Chromium with
`npx playwright install --with-deps chromium`. Run the command below,
then repeat in a fresh VM with `--scenario upgrade` and a separate
evidence directory.

```bash
sudo env PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" "$(command -v node)" scripts/lifecycle/host.mjs --disposable-host --scenario install --source <full-source-sha> --target <full-target-sha> --evidence "$PWD/test-results/lifecycle/install"
```

The host always records a source/target/result summary and attempts
evidence collection before deleting its isolated account and services.
Diagnostics include installer/updater logs, service state and journal,
runtime receipts, and readiness responses. Failed browser scenarios
retain a screenshot and trace. The fixture does not copy real
credentials or private conversation content; archived profile snapshots
and authentication files are excluded.

CI uploads evidence even when setup or activation fails and retains it
for 14 days. A selection record is created before dependency
provisioning, so early setup failures still identify the intended
scenario and immutable revisions.

`npm run test:lifecycle-contracts` checks the harness contracts,
including failure on installer errors, failed readiness, an unchanged
old web process, a mismatched running commit, stale frontend assets, and
accidental generated Git changes. These tests do not establish that
either full lifecycle ran. Only a passed disposable-host scenario
establishes its corresponding installation or upgrade result.

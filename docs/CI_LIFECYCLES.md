# Installation and upgrade CI

## Required scenarios

CloudX CI requires both Clean installation and Installed
previous-version upgrade. Each job runs on a disposable Ubuntu 24.04 VM.
Missing systemd or user-bus prerequisites fail the job. The CI aggregate
requires both lifecycle jobs and their revision-selection job to
succeed. The jobs record free disk space before and after removing the
runner’s unused Android and .NET SDK directories; the updater’s capacity
preflight remains authoritative.

The host harness creates a fresh application user, home and checkout,
then runs `./install.sh --answers` with `--yes`. The unattended answers
select CPU ASR, two CPU threads, standard service installation and
startup, and no interactive Codex login. Dependencies, configuration,
service definitions, executable entry points and runtime artifacts must
come from that installer. Controller npm dependencies and Chromium serve
only the browser harness. An isolated synthetic Codex login record
satisfies the installer’s authentication prerequisite; it is not a real
credential and is excluded from artifacts.

The runner home may be private. The host harness copies only its lifecycle
scripts, Playwright packages and installed browsers into a readable disposable
fixture. The application account writes evidence there; cleanup copies it back
to the runner's upload directory on success or failure. The runner's profile
and the application's clean installation remain separate.

Before starting the application user manager, the harness temporarily removes
the runner-specific `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR` assignments from
`/etc/environment`. A transient user service verifies its inherited home and
runtime directory and connects to its own user manager before installation.
The harness also replaces the global `PATH` with the controller Node directory
and standard executable directories, and verifies that path in the service.
Runner-private paths can turn lookup of an absent optional executable such as
`quota` into a permission error, causing the source updater's capacity check to
fail. The application caller and user services receive the same isolated path.
Cleanup restores the original environment file after stopping that manager.

Readiness includes HTTPS web, ASR, documentation and production
supervised terminal creation and cleanup. Runtime evidence must report
the pinned commit, verified artifact digest and live process identity.
The served frontend index and referenced assets must match the generated
files, and Chromium must render the workspace.

## Revision policy and real Settings handoff

The oldest supported revision is
3a3de3597402114e5587b5033068cd39b8b3622f. Pull requests install the
event’s pinned base SHA and update to `github.sha`, the tested merge
candidate. Main pushes install the event’s before SHA and update to the
pushed SHA. Revision selection happens once per run; both full SHAs must
exist, differ, and have supported forward ancestry.

For release validation, run CloudX CI manually on the intended release
candidate and provide `previous_supported_sha` as the full commit of the
previous supported release. Until such a release exists at or after the
baseline, use the documented main revision
cb70ffa1c4225c82fc408c21562f5b02094fd1f6. The workflow does not select a
latest tag or discover a moving remote target.

The source installation seeds settings, a split workspace, a real shell,
and a new native Codex conversation through production launch and
source-binding paths. The native binary comes from the source installer;
its selected version is recorded. A loopback Responses provider supplies
only synthetic conversation data without authentication. Untracked
application files and uncommitted work in a separate local Git project
must survive.

The source application’s real Settings UI starts the update and remains
open through its disconnect and reload. The source updater stages its
own coordinator and fetches the exact candidate from the fixture origin.
No target updater scripts are installed over the source. A private HTTPS
catalog serves only the pinned GitHub commit and comparison responses,
so GitHub main cannot substitute a target during the run. The test CA is
scoped to the disposable application environment.

The gate requires durable succeeded status after verification, a changed
web invocation, and observation of the coordinator after the old web
process exits. Compatible terminal sessions must keep the broker
invocation and remain attachable. A disclosed interruption requires UI
confirmation and recoverable saved identities without replaying commands
or prompts. Settings, layout, exact conversation evidence, local files,
Git status and the retained coordinator’s next-update preflight are
checked after activation.

## Running and diagnosing the gate

The host entry point below requires root, Ubuntu 24.04, systemd as PID
1, controller npm dependencies, a Chromium installation identified by
`PLAYWRIGHT_BROWSERS_PATH`, and explicit
`CLOUDX_LIFECYCLE_DISPOSABLE=1`. Run it only inside a disposable host:
it installs system packages and creates a test account with installer
sudo access. Application services and the controller occupy separate
service groups.

```text
scripts/ci/lifecycle-host.sh install|upgrade SOURCE_SHA TARGET_SHA EVIDENCE_DIR
```

Installation is bounded to 60 minutes, update observation to 40 minutes,
and web readiness to five minutes. Job limits are 90 minutes for
installation and 120 minutes for upgrade. Cleanup collects diagnostics,
stops only the isolated account’s services and processes, disables
lingering, removes its sudo authorization, and restores the catalog host
mapping. The disposable VM retains private fixture files until it is
destroyed.

Artifacts include source/target/result JSON, installer and updater logs,
service journal/state, runtime manifests and receipts, readiness
responses, Codex version, browser traces and profile hash evidence.
Evidence directories are initialized before checkout and uploaded even
on setup failure. Credentials, user configuration, model caches and raw
transcript files are not copied into the artifact directory; all browser
content is synthetic test data.

Focused tests exercise the same gate assertions used by the host runner.
They reject a real installer subprocess error, failed service readiness,
a stale frontend, unchanged web process/invocation, mismatched running
commit, incomplete update, missing coordinator-survival proof and an
unnecessary broker restart. These tests establish rejection behavior;
successful unit fixtures do not establish that either full lifecycle
ran.

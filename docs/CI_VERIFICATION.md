---
title: CloudX CI verification inventory
format:
  html:
    toc: true
    number-sections: true
  docx:
    toc: true
  gfm:
    variant: +yaml_metadata_block
---

## Verification ownership

CloudX runs independent isolated containers for four coverage shards,
two browser shards, static compilation, ASR and documentation-indexer
tests. Each container has two CPUs, 7 GiB of memory, no network, a
private writable workspace and read-only candidate source. The trusted
controller alone writes the attestation.

Repository policy owns policy validation, formatting, lint and the
networked dependency audit. The static isolated lane owns type checking
and the production build. Each test lane builds its own runtime when its
tests require compiled output.

The TypeScript check retains the real user-systemd tests on the host.
Generic TypeScript coverage, the two Python suites, and desktop/mobile
browser tests move from duplicated host executions to their isolated
lanes. Existing required check names remain aggregation gates. Dedicated
native Codex version checks and constrained terminal stress repetitions
remain unchanged in purpose.

## Complete coverage and isolation

Coverage shards 1 and 2 own installation, managed-update, integration
and measured long-running test files. Shards 3 and 4 own the remaining
unit tests. The sequencer places longer measured files first on the
least-loaded shard within each pair. The versioned duration manifest
records the measured environment; new files receive unit weight until
measured.

Every coverage shard exports its Vitest blob after candidate processes
stop. A separate isolated container merges all four blobs and enforces
70% statements, functions and lines and 60% branches. A per-shard
threshold is not the coverage acceptance gate.

The final aggregator requires every planned lane and the coverage merge.
It rejects missing, duplicate, failed, wrong-commit or source-mutating
evidence, incomplete command plans and altered report bytes. Cancelled
jobs cannot produce a successful aggregate. Candidate report data is
never executed by the trusted controller; Vitest parses blobs in the
candidate sandbox.

## Historical and systemd inventory

All seven historical target assertions remain: pinned base,
pre-readiness endpoint, pre-Settings channel selection, pre-execution
bindings, pre-persistent broker, pre-Codex settings (0.1.3), and native
retained-review selection. Each has its own test-file entry point so
file sharding can distribute the real build. No historical target is
retired by this change.

## Prepared inputs and runtime state

The five historical systemd cases share one suite-owned installation and
build of the current committed checkout. Each case copies that prepared
tree into an independent checkout and refreshes its Git index. Profiles,
ports, service units, sessions and recovery records remain fresh per
case. The copies preserve relative workspace symlinks and do not share
writable file inodes. Target transition builds, interruption, rollback,
saved-session recovery and subsequent updates still run for every
applicable case.

## Timings and cache boundaries

Attestations retain preparation, per-command and total execution
durations. Vitest and Playwright retain machine-readable file/test
timings; pytest retains JUnit timings. Fixture diagnostics separate
installation, build, exercise and cleanup costs. Bounded lifecycle
diagnostics retain process ownership and receipt outcomes without
command output or environments.

Docker uses the GitHub Actions build cache for immutable dependency
layers. Pinned base images, lockfiles and source COPY inputs determine
invalidation. npm and uv still perform locked preparation when inputs
change. Mutable workspaces, session state and trusted attestations are
created anew for each execution.

## Merge identity

The workflow reconciles the exact checked-out test merge against the
expected repository, main target ref, current pull-request head, ordered
merge parents and tree. A stale event base can be diagnostic when the
current target and tested first parent agree. Later target or head
movement produces a superseded result, not application repair work.
Forge pauses without retrying the unchanged identity; merge
authorization revalidates the current identity.

## GitHub App permissions

Forge worker and reviewer Apps require Checks: read to identify the
Superseded merge identity check. Existing installations must approve
this additional read permission. Registration retains an installation
missing the permission for Continue. A superseded result pauses Forge
before review feedback can restart implementation; refresh the test
merge for a new identity before resuming.

## Performance evidence still required

The batch issue records three successful GitHub workflows at
46m33s–48m10s. Local test durations are useful scheduling inputs but are
not a measured GitHub workflow speedup. After publication, compare
successful runs by exact commit, sample size, runner resources,
cold/warm cache status, workflow elapsed time, slowest job and summed
runner time. Retain the uploaded attestations and timing reports; do not
infer linear speedup from shard count.

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

The TypeScript check retains the real user-systemd tests and
broker-owned migration refusal on the host. The latter requires a
non-root unified cgroup, so
scripts/install-runtime-caller.integration.test.mjs must remain in the
host command even though its filename does not mention systemd. Generic
TypeScript coverage, the two Python suites, and desktop/mobile browser
tests move from duplicated host executions to their isolated lanes.
Existing required check names remain aggregation gates. Dedicated native
Codex version checks and constrained terminal stress repetitions remain
unchanged in purpose.

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

The workflow validates the exact checked-out test merge against the
expected repository, live main ref, current pull-request head, ordered
merge parents and tree. GitHub API version 2026-03-10 removed
`merge_commit_sha` from pull-request payloads. After confirmed
mergeability, the canonical resolver reads `refs/pull/<number>/merge`
through the Git ref endpoint and revalidates its commit against the live
target. CI artifact production and downstream merge authorization use
this same resolver. A stale event base is diagnostic only when the
current target and tested first parent agree. Moved target or head refs
produce superseded before pending merge metadata is inspected. If refs
still match and mergeability is `null`, the result is pending. Neither
state produces an authorization artifact; Forge pauses before
implementation or review can restart. See the [GitHub breaking-change
notice](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes?apiVersion=2026-03-10).

## GitHub App permissions

Forge worker and reviewer Apps require Checks: read to identify the
Superseded merge identity and Pending merge identity checks. Existing
installations must approve this additional read permission. Registration
retains an installation missing the permission for Continue. A
superseded result pauses Forge before review feedback can restart
implementation; refresh the test merge for a new identity before
resuming.

## Performance evidence still required

The batch issue records three successful GitHub workflows at
46m33s–48m10s. Local test durations are useful scheduling inputs but are
not a measured GitHub workflow speedup. After publication, compare
successful runs by exact commit, sample size, runner resources,
cold/warm cache status, workflow elapsed time, slowest job and summed
runner time. Retain the uploaded attestations and timing reports; do not
infer linear speedup from shard count.

## Provider observations before review fixes

GitHub acceptance remains pending. The three successful baseline
workflows are
[36336277366](https://github.com/davidomil/cloudx/actions/runs/36336277366)
(46m42s elapsed, 46m32s slowest job, 90m10s summed job time),
[36335167752](https://github.com/davidomil/cloudx/actions/runs/36335167752)
(48m10s, 47m40s, 96m02s), and
[36334734155](https://github.com/davidomil/cloudx/actions/runs/36334734155)
(46m33s, 46m26s, 90m33s). The isolated verifier is the slowest job in
each. These are three observations across different commits. Times come
from Actions run/job API timestamps; summed time includes every
non-skipped job.

Baseline main run 36336277366 tested
7d809426c56e7fe49a68f8678951ac01ba20fdf5, whose parent is
d8e620cf3c009cbb64fe925de24ae6d9daf0996c. PR run 36335167752 tested
merge 0ccad34bf96b7af1bae1b2c9cbdf5ed746a3504f with base
d8e620cf3c009cbb64fe925de24ae6d9daf0996c and head
b5330f72b79be95b55ef135b42ea0a5f1f0832c4. PR run 36334734155 tested
merge b21c69e46a7c03f48d91048e1b6fa3627a7de52b with the same base and
head b310866910190daa98aedc72799f9e13ff4ab369. The Git commit API
confirms these parents.

[PR \#154 run
36353377140](https://github.com/davidomil/cloudx/actions/runs/36353377140)
tested merge 95bd66b60ff9eef151e928fbb98e8817604a9b8f with base
630b42dced9c45951b6fb994b66ce3d69de67dde and head
71dff8513afc8ec3343a5ddfe92b036238c8b670. It finished in 14m37s; browser
shard 1 was slowest at 11m25s, and summed job time was 98m07s. Every
workload job passed, but Trusted merge identity and CI aggregate failed.
The identity log reports an invalid or missing test-merge SHA. A
subsequent public request with the production API version reproduced the
removed merge_commit_sha field despite mergeable:true; the corrected
production resolver accepted the exact merge ref in a read-only probe.
This failed workflow is excluded from successful performance acceptance.
There are no successful post-change acceptance samples yet.

These jobs use ubuntu-24.04 runners; the isolated workloads are bounded
to two CPUs and 7 GiB. Actual host CPU/RAM were not recorded in the
recovered job API metadata. Available baseline log excerpts end during
image construction, so baseline cold/warm state remains unclassified. In
run 36353377140 the browser shard 1 image build showed no cached steps
and coverage-merge reused 18 cached steps within that workflow. This
does not provide independent successful cold and warm workflow samples.

Before approval, merge or closing \#147, record representative
successful post-fix GitHub runs, classify cold/warm cache state, record
actual runner CPU/RAM, and compare exact base/head/merge identities,
sample size, workflow elapsed, slowest job and summed job time with the
baseline. Preserve the test/skip inventory and merged thresholds. The
implementation handoff to CloudX for publication and review does not
satisfy this acceptance gate.

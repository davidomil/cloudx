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

## GitHub performance comparison

Three successful baseline workflows took 46m33s–48m10s (mean 47m08s).
Two successful post-change measurements of the same test merge took
16m57s with a warm verifier image cache and 17m45s after clearing that
pull request’s verifier cache indexes. These observations reduce
workflow elapsed time by 64.0% and 62.3% against the baseline mean. The
sample size is three before and two after, with one observation per
post-change cache condition.

| Run / attempt                                                                                     | Cache condition                    | Workflow elapsed | Slowest job                            | Summed job time |
| ------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------- | -------------------------------------- | --------------- |
| [36336277366](https://github.com/davidomil/cloudx/actions/runs/36336277366)                       | Cold image; warm host dependencies | 46m42s           | 46m32s (isolated verifier)             | 90m10s          |
| [36335167752](https://github.com/davidomil/cloudx/actions/runs/36335167752)                       | Cold image; warm host dependencies | 48m10s           | 47m40s (isolated verifier)             | 96m02s          |
| [36334734155](https://github.com/davidomil/cloudx/actions/runs/36334734155)                       | Cold image; warm host dependencies | 46m33s           | 46m26s (isolated verifier)             | 90m33s          |
| [36356140399, attempt 1](https://github.com/davidomil/cloudx/actions/runs/36356140399/attempts/1) | Warm image; warm host dependencies | 16m57s           | 16m46s (host lifecycle)                | 85m15s          |
| [36356140399, attempt 2](https://github.com/davidomil/cloudx/actions/runs/36356140399/attempts/2) | Cold image; warm host dependencies | 17m45s           | 14m26s (Isolated verifier (browser-1)) | 104m15s         |

Successful workflows; elapsed time includes setup and image
construction.

The warm attempt’s slowest job was TypeScript (build, type-check, test);
the cold attempt’s was Isolated verifier (browser-1). The previous
critical path was the serial isolated verifier. Summed job time changed
from a baseline mean of 92m15s to 85m15s warm and 104m15s cold. Summed
time is 7.6% lower than the baseline mean when warm and 13.0% higher
when cold. Parallel lanes reduce latency; this separate resource cost
remains visible. These runs support a material reduction beyond the
roughly-halved target, but one sample per cache condition cannot
establish normal variance or attribute the difference between the two
new runs to caching alone.

Workflow elapsed time uses the attempt’s run_started_at and completion
updated_at timestamps. Job durations use started_at/completed_at; their
sum excludes skipped jobs and includes setup, image builds, diagnostics
and aggregation. This sum measures occupied job time rather than billed
minutes or CPU time. Different baseline commits contain different
feature tests, so this is an observed before/after comparison, not a
controlled attribution to one code change.

## Exact tested identities

Both post-change attempts tested merge
`2188781a997bcf91319bde4413f7e9b65d9cf5c8`, with base
`630b42dced9c45951b6fb994b66ce3d69de67dde`, head
`8477c2bed66af2b17da9e927da3930c62be593f4` and tree
`15c806653c64758c89a1d759c64bc703e8a917c4`. Trusted identity passed in
both attempts. The base/head/merge refs were checked again before the
cold measurement; no code or workflow changed between the samples.

Baseline main run 36336277366 tested
`7d809426c56e7fe49a68f8678951ac01ba20fdf5`, with parent
`d8e620cf3c009cbb64fe925de24ae6d9daf0996c`. PR run 36335167752 tested
merge `0ccad34bf96b7af1bae1b2c9cbdf5ed746a3504f`, base
`d8e620cf3c009cbb64fe925de24ae6d9daf0996c` and head
`b5330f72b79be95b55ef135b42ea0a5f1f0832c4`. PR run 36334734155 tested
merge `b21c69e46a7c03f48d91048e1b6fa3627a7de52b`, the same base and head
`b310866910190daa98aedc72799f9e13ff4ab369`. Git commit API responses
confirm the recorded parents.

## Resources and cache classification

All runs use public GitHub-hosted ubuntu-24.04 runners. Baseline host
artifacts measured four available CPUs; physical RAM was not recorded
and cannot be reconstructed from their unbounded memory-limit sentinel.
GitHub documents this runner class as four CPUs and 16 GB RAM. New
Buildx logs measured four CPUs and 15.61–15.62 GiB RAM. This
distinguishes measured resources from the historical runner contract.
Isolated verifier workloads retain two-CPU and 7-GiB limits; dedicated
stress artifacts also confirm zero swap. See the [GitHub runner
specification](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Complete baseline log archives show zero cached verifier image steps,
with image construction taking 105.200s, 101.673s and 98.687s. Separate
host npm/uv caches were restored. The warm post-change attempt restored
18 image steps in every lane. For the cold measurement, exactly 20
verifier manifest indexes were removed only from `refs/pull/154/merge`;
no default-branch index existed. Layer blobs and host dependency caches
were retained. All nine workload image builds then executed with zero
cached steps. Coverage merge reused the image built earlier in that same
cold attempt. Thus “cold” describes the verifier image build, not an
entirely cache-free workflow.

The failed earlier PR154 run 36353377140 (14m37s) remains excluded from
successful performance samples. Its identity failure was reproduced and
corrected before these measurements. Complete log ZIPs were used for the
baseline because the CLI text view ended before a long
diagnostics-fixture line; the ZIPs contain the final successful results.

## Preserved validation inventory

Both new attempts passed all ten isolated attestations, with 7,963
Vitest tests, 222 desktop/mobile browser tests, 137 ASR tests and 1,054
documentation tests. Browser reports contain no skipped, failed or flaky
cases. The host command passed all eight systemd/cgroup cases, and both
native Codex versions passed all 11 dedicated acceptance cases and their
production-verifier checks. Terminal stress passed three repetitions of
57 selected cases per attempt; its other 21 collected cases are outside
the stress selection and retain ordinary coverage ownership. All seven
ordinary historical targets remain, with cleanup receipts confirming
directory removal.

The 98 isolated Vitest skips remain explicitly owned: 86 optional
documentation-media environment cases, 11 native cases run by the
dedicated version jobs, and one cgroup case run on the host.
Documentation retains 12 environment skips. No historical target,
assertion or coverage threshold was removed for the timing comparison.

Merged warm coverage was 83.29% statements, 84.7% functions, 83.99%
lines and 76.91% branches. Cold coverage was 83.29%, 84.68%, 83.99% and
76.91% respectively. Both passed the unchanged 70%
statements/functions/lines and 60% branches thresholds. Independent
validation accepted every required lane and its exact candidate/source
identity.

Baseline main, PR136 and PR145 respectively reported 7,739/7,731,
7,863/7,855 and 7,805/7,797 passing Vitest tests in their duplicated
host/isolated executions. Their duplicated browser runs contained 220,
228 and 222 tests. Those counts reflect different feature contents and
execution environments. The ownership sections above explain the
relocation of generic coverage/browser/Python checks while retaining
distinct host, native and stress behavior; raw count differences are not
treated as evidence of removed coverage.

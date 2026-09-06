---
name: "change-orchestrator"
description: "Orchestrate a CloudX change through classification, isolated planning, implementation, verification, review, and an optional ship handoff."
---

# Change Orchestrator

## Responsibility

Route one non-trivial change through the repository state machine. Do not plan,
implement, verify, review, commit or mutate GitHub in this context.

Read the original task, trusted root/scoped instructions, current base/worktree,
`.agents/pr-review-policy.toml` and any typed artifacts or stable finding IDs.

## Workflow

1. Classify exact proposed paths and type through `scripts/ai-change/policy.mjs`.
2. Start a fresh `$plan-change` context; validate its plan schema.
3. Start a different fresh `$review-plan` context. A finding returns to fresh
   planning; a review ceiling transitions to `blocked`.
4. Dispatch `$implement-change` only from the independently clean plan.
5. Select Gate-B only under the conditional routing below. Every other change
   follows the normal flow.

<!-- CLOUDX-GATE-B-ROUTING-V1:BEGIN -->

Only when the accepted task explicitly enters the bounded Gate-B remediation
or publication flow, read the complete repository-relative source
`.agents/skills/change-orchestrator/references/gate-b/orchestrator.md` before acting.
It is operative only within that flow. Require its exact identities, ordered
gates, independent reviews and explicit authorization. If the source is absent,
unreadable or inconsistent with this routing, stop. Ordinary local or managed
work does not enter that flow or gain its authority; never use local clean
aggregation for Gate-B. This reference grants no new authorization.

<!-- CLOUDX-GATE-B-ROUTING-V1:END -->

## Normal Non-Publication Flow

1. Freeze source and accepted evidence outside the repository. For policy/skill
   self-changes, preserve accepted roles and human review. Final metadata
   rebinding preserves task, claims, scope and commands; obtain a fresh independent
   review of the new plan bytes and regenerate `implementation.plan_sha256`.
   Behavior, scope or proof changes return to planning.
2. Select the local route below and capture scope/index before verification.
   Dispatch `$verify-change` for the unchanged full verifier. Failed commands,
   missing environments or stale evidence block review admission.
3. Start a fresh context for every selected area reviewer. Supply only the
   original task, trusted/scoped instructions and conditional references,
   accepted plan/review, exact implementation/verification bytes, validated
   subject, observed diff and selected-role list. Each traces relevant claims,
   production seams, callers and discriminating tests. Never supply an author's
   conversation or retrofit old review JSON.
4. Follow the selected aggregate route. Findings require fresh `$review-change`
   judgment, then fresh implementation, full verification and all selected
   reviews. An iteration ceiling blocks the run. Managed changes retain their
   existing fresh aggregate dispatch and subject semantics.

<!-- CLOUDX-NORMAL-REVIEW-ROUTING-V1:BEGIN -->

Before local review dispatch, the orchestrator explicitly selects ordinary
independent review or the optional local shortcut. Ordinary independent review
does not invoke or require successful `--print-subject` or clean aggregation.
It directly validates the complete evidence and scope contract in
`docs/AI_CHANGE_PROCESS.md`.

Use `readLocalReviewScope` with guarded Git reads to observe the verified
HEAD/worktree and preserve normal staged entries. Capture the index snapshot
before verification/handoff and compare it at aggregate acceptance; different
index-only bytes remain an explicit verification gap.

The orchestrator independently computes SHA-256 of UTF-8
`cloudx-local-review-v1\n<sha256(raw implementation)>\n<sha256(raw verification)>\n`
from exact raw implementation and passed full verification bytes. Area and
aggregate outputs use `subject: implementation`,
`run_id: verification.run_id`, that composite digest and candidate
base/head/current policy. Require exact observed/declaration/literal allowed
scope and the union of current observed-path policy roles and accepted plan roles.

Start every selected area reviewer in a fresh context, then a different fresh
`$review-change` context for ordinary aggregate judgment. Recheck candidate,
scope/index, effective Git config/attributes and raw evidence before acceptance.
The optional shortcut requires explicit selection and index equal to HEAD;
rejection neither retries nor automatically switches routes. Both routes retain
full verification, raw evidence joins, human review and freshness. Managed and
Gate-B contracts remain separate.

<!-- CLOUDX-NORMAL-REVIEW-ROUTING-V1:END -->

Read the complete ordinary evidence and guarded-reader procedure in
`docs/AI_CHANGE_PROCESS.md`; use its unchanged fanout/aggregate validators.
No index clearing, staging, resetting, committing or rewriting is authorized.

This workflow optimization retains all four originally accepted roles
(`review-agent-policy`, `review-architecture`, `review-documentation` and
`review-security`), human review and an independent aggregate review. The
utility does not approve its own introduction or remediation.

## Optional Local Review Command

For the selected eligible shortcut:

```bash
node scripts/ai-change/review-local.mjs --mode local --plan <plan> --plan-review <plan-review> --implementation <implementation> --verification <verification> --print-subject
node scripts/ai-change/review-local.mjs --mode local --plan <plan> --plan-review <plan-review> --implementation <implementation> --verification <verification> --subject-sha256 <digest> --review <area-review>
```

`--print-subject` performs strict evidence/scope/index/config/attribute and
freshness checks, emits only the composite lowercase digest plus LF, accepts no
review inputs and creates no artifact. Repeat `--review <path>` for every
required role. Aggregation requires the fresh `--subject-sha256`, exact role
coverage and a current clean area set; it cannot dismiss findings.

Both CLI modes reject every staged difference. Unsupported index states remain
gaps in both routes. Unknown/duplicate singleton options, duplicate paths/roles,
incomplete inputs and modes other than `local` reject. No output-file or run-ID
override exists. Success emits canonical existing-schema aggregate JSON; failure
exits nonzero with bounded stderr and no artifact. Managed artifacts and the
reserved Gate-B base are excluded.

The utility replaces only clean model aggregation; it performs no verification,
source/index write, commit, hosting call or credential read. Never transfer stale
approval between routes. New verification bytes require fresh area judgments,
even with unchanged HEAD or reused run IDs.

## Handoff

Return current state, artifact paths/digests, finding IDs, exact commands run and
the next valid action. The private AI manager owns durable transitions; typed
evidence never implies a later state. Missing reviews, stale identities, schema
errors or failed verification block the run. No partial PR follows failed gates,
and local review grants no publication authority.

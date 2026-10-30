# Writing Contract

Write for the reader and action in the request. Beginner guides explain terms before jargon and put commands in task order. Expert reviews may need precise implementation detail. Short replies need the answer and its material qualification.

## Prose

- Lead with the outcome, decision, observation, or ask.
- Keep subjects explicit and use active verbs.
- Use exact names, values, units, conditions, and revisions.
- Keep paragraphs focused; use tables for genuine comparisons.
- Remove filler without changing quotations or command arguments.
- Preserve distinctions between facts, observations, inferences, and proposals.
- Reuse verified facts during compression; check new claims introduced by rewriting.

Sentence length and filler checks are editing suggestions. Do not split a correct block, duplicate a claim, or rename ordinary words to satisfy lint. Check meaning before polishing.

## Output shape

| Profile | Default shape |
|---|---|
| `compact_evidence_first` | clear assessment, useful sections, tables/figures where helpful |
| `email_brief` | needed context, decision/ask, relevant facts, next action |
| `chat_update` | requested sentence, compact paragraph, or a few bullets |
| `executive_summary` | decision, impact, material risks and uncertainty |

Issues describe the trigger, observed/requested behavior, and useful acceptance conditions. Never claim reproduction or testing that did not happen. MR comments/descriptions follow session conventions. Do not add title pages, TOCs, numbering, YAML metadata, or validation narration to short output by default.

Retain user feedback for the same artifact/channel. If testing/process prose was removed, keep it out unless requested or necessary to avoid misrepresenting a result. New implementation or audience requirements may justify new work; not all later changes are editorial failure.

## Self-contained evidence

Include values, observations, excerpts, and limits needed to understand the conclusion. Local IDs, line numbers, archive IDs, and checkout paths are audit metadata. Do not add local `Evidence` or `Locator` columns to recipient tables; use observations/results instead.

Cite accessible sources when useful. Declare access explicitly; HTTP links can still be inaccessible. Citations should lead to supporting pages, not internal IDs. Keep evidence appendices and source maps opt-in.

Use portable project paths. Keep required device paths literal in commands/system facts and declare them in `runtime_paths`. Do not turn required arguments into unusable placeholders to pass a path check.

## Final review

Read the final text as its intended reader. Check headings, tables, captions, diagrams, and commands against sources too. Review the actual final artifact after the last edit; static checks and extracted text cannot prove layout or semantic correctness.

Finish with the ASD-STE100 editing step in `SKILL.md`. Strongly prefer Simplified Technical English for final prose, including short replies. Preserve technical meaning, material qualifications, and required literals. Check the official rules and dictionary before claiming compliance; the structural validators do not establish it. Recheck evidence and affected artifacts after any wording change.

In the same pass, check audience fit and relevance. Match the reader's knowledge and task. Remove unnecessary testing commands, process history, implementation detail, and notes about obsolete behavior. Keep required reader actions and material constraints or uncertainty. Include history only when the requested task needs it; keep useful audit details in the work record.

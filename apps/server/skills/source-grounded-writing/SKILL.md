---
name: "source-grounded-writing"
description: "Write source-grounded technical replies and artifacts, using direct drafting for short outputs and a validated evidence-backed compiler for substantial documents."
cloudx_name: "Source Grounded Writing"
---

# Source Grounded Writing

Use this skill for technical docs, design decisions, issues, MR comments, email, chat replies, and rendered artifacts. Match the work to the requested output. Evidence quality does not depend on document length.

## Choose the writing path

**Direct writing:** For a short reply, issue, email, MR comment, or wording-only revision, read the relevant sources, check the claims, and write the requested text directly. Do not create IR files, probe rendering dependencies, compile Quarto, or install tools. A one-sentence answer may still need substantial investigation.

**Artifact writing:** Use the IR and compiler for substantial, reusable, or rendered documents when the evidence structure and formats justify them. Render only requested targets. Read setup and migration instructions in `README.md` when using this path.

Both paths follow the same source policy and meaning checks. Follow the session's documentation-search and original-source ingestion rules; this skill does not replace them. If archive services are unavailable, report that and inspect available originals without claiming archive validation.

## Establish the brief

Identify these from the request and prior conversation before drafting:

- What does the reader know, and what must they decide or do?
- What output, length, scope, and task order did the user request?
- What has the user excluded or asked to remove?
- Which source revision, configuration, board, or run is relevant?

Infer routine choices from context. Ask only when missing information materially changes the result. Carry corrections forward for the same artifact or channel: if testing narration was removed, do not add it back in a later rewrite. Keep qualifications when removing them would change meaning. Separate new requirements and implementation changes from avoidable editorial rework.

For a beginner guide, explain prerequisites in task order and try each instruction from that reader's perspective. Introduce terms before using them. Keep project history and optional future features outside the operator's main path.

## Read sources and check meaning

Use `references/evidence-policy.md`. Open the actual source; titles, search snippets, metadata, and prior drafts cannot verify a technical claim. Record its revision and precise locator. Prefer primary evidence for implementation and hardware behavior. Context establishes requests and history, not hardware or software correctness.

Classify material statements as technical facts, observations, inferences, or proposals. Keep those distinctions in the wording. Before writing, and after the final edit, check:

1. **Exact support:** Verify the complete sentence, including values, units, negation, conditions, and revision. Check headings, summaries, tables, captions, code explanations, and diagrams too.
2. **Measurement scope:** Distinguish configured or negotiated values from measurements, host delays from electrical timing, discrete samples from continuous behavior, and one passed stage from a passed workflow.
3. **Absence claims:** Inspect the effective dependency/configuration closure before saying something is missing. One manifest does not establish absence from a built image.
4. **Experiment scope:** Compare the reproducer's actual configuration with the target before generalizing. A fixture result proves what happened under that fixture, not an uninspected target.
5. **Causality:** Distinguish correlation from cause. Check counterexamples and plausible compositions before arguing against a proposal. State material unmeasured or unproven conditions.
6. **Revision consistency:** Do not combine results, binaries, sources, or board revisions without explaining the mismatch. A source hash does not prove runtime behavior.

When compressing verified text, reuse its facts and preserve material qualifiers. Recheck new causal or generalized conclusions. Do not invent acceptance criteria, measurements, implementation status, or test results to sound complete.

Missing support blocks the affected claim, not necessarily the task. Omit it or state the precise uncertainty. Use a gap report only when requested. A citation does not turn an unsupported assertion into a fact.

## Write for the requested channel

Follow `references/writing-contract.md`. Lead with the point the reader needs. Use exact terms, active verbs, compact paragraphs, and tables for comparisons. Preserve literal quotations and command arguments; stylistic lint is advisory.

Short replies and issues keep their requested shape. They do not need report scaffolding, evidence appendices, validation narration, or source maps. A report uses sections and figures when they help. Shorter is not automatically clearer.

Make recipient text self-contained. Include the observations and limitations needed to understand it. Keep IDs, checkout paths, and local evidence locators internal unless the user requests an audit packet or local links. Cite only sources the recipient can access. HTTP syntax alone does not establish access. Do not rename ordinary words to satisfy an internal source-ID rule.

## Artifact path

### Model the document once

Use `references/intermediate-schema.json`, version 2. Keep `claims`, `tables`, and `visuals` in document-wide registries. Sections contain titles and ordered `blocks`. Reuse claim IDs across sections instead of copying claims. Put summary prose in a paragraph block with claim references.

Every delivered assertion needs supporting claims, including table cells, captions, and visuals. Tables and visuals use `claim_ids`; citations derive from those claims. Claims need kind, support state, evidence, and reasoning for an inference. A proposal describes intended behavior without implying implementation or testing.

Declare each source's `access`: `local`, `recipient`, or `public`. Use portable locators. For local sources, add a relative `path` and optionally `sha256` so validators can verify existence and identity. URL/archive availability and semantic support still need source review. List literal target paths in `runtime_paths` only for required device facts or command arguments; do not whitelist checkout paths.

### Check only needed tools

Direct writing requires no setup. For artifacts, use the skill-local Python and target-specific dependency check in the README. Supply the IR to check only its visual dependencies. Do not run a full renderer diagnostic for plain Markdown.

### Validate, compile, and render

With `SGW` set to the skill directory:

```bash
"$SGW/.venv/bin/python" "$SGW/scripts/validate_evidence.py" draft.ir.json
"$SGW/.venv/bin/python" "$SGW/scripts/validate_presentation.py" draft.ir.json
"$SGW/.venv/bin/python" "$SGW/scripts/compile_doc.py" draft.ir.json --target html --out build/draft.qmd
"$SGW/.venv/bin/python" "$SGW/scripts/render_doc.py" build/draft.qmd --to html --out-dir build/html
"$SGW/.venv/bin/python" "$SGW/scripts/validate_presentation.py" draft.ir.json --artifact build/html/draft.html
```

Use `--allow-gaps` consistently in validation and compilation only for an explicit `doc_kind: gap_report`. Explicit gap blocks state what is unknown; they must not emit unsupported assertions as ordinary prose. Audit flags are opt-in; see the README.

### Render visuals explicitly

| Need | Visual language |
|---|---|
| flow, sequence, state | Mermaid |
| architecture, interconnect | D2 |
| dependency graph, hierarchy | Graphviz DOT |
| UML protocol/object model | PlantUML |
| charts from data | Vega-Lite |
| evidence from a source page | source image |

Use visuals when they explain better than prose. Give them meaningful alt text, captions, and claim references. Choose readable orientation and scale. Every supported visual must become a static image. Raw diagram code is not a finished figure. Keep the selected language and PDF engine; fix failures or report them without silently switching renderers, adding retries, or delivering another target.

### Review the delivered file

Automated validators check structure, references, source-file identity when supplied, and artifact content/assets. They do **not** prove that an excerpt entails a claim or that prose preserves it. A `supported` label is a review decision, not proof. Complete the meaning checks yourself.

After the final edit, validate the exact delivered file. Artifact checks report its hash and limits. Inspect actual browser output or PDF pages for layout, readable tables/figures, clipping, and pagination when relevant. Text extraction is not a layout check. Re-run only checks affected by later changes.

## Delivery and debugging

Deliver the requested text or artifact with material uncertainty and relevant validation limits. Keep drafting machinery out of recipient prose. When documenting debugging or validation, record only commands actually executed that found relevant information or produced the artifact. Keep detailed evidence in the work record; do not append process narration to a short reply unless requested.

## Final step: review language and audience

Before delivery, make a final editing pass guided by [ASD-STE100 Simplified Technical English (STE)](https://www.asd-ste100.org/STE_faq.html). **Strongly prefer STE for final user-facing English.** Apply this step to both writing paths, including one-sentence replies.

- Use short, direct sentences with one clear point. Give one action per instruction.
- Prefer active voice, simple verb forms, and direct commands for procedure steps.
- Use consistent technical names and words with a clear intended meaning. Remove avoidable jargon, idioms, and ambiguous references.
- Check approved vocabulary, meanings, and parts of speech against the STE dictionary when available. Keep necessary technical nouns and verbs; explain unfamiliar terms.
- Keep claims faithful to their evidence, including material uncertainty, conditions, values, and units. Do not rewrite retained quotations, code, commands, identifiers, or required literals.

Use the [official rules and dictionary](https://www.asd-ste100.org/STE_downloads.html) as the reference. Clear wording alone does not establish STE compliance; do not claim compliance without checking the applicable rules and vocabulary. The skill's validators do not check STE compliance. Keep this pass within the requested channel and length.

Check audience fit and relevance in the same pass:

- **Audience fit:** Does the output match the reader's knowledge, vocabulary, and task? Explain necessary terms and prerequisites. Put information in the order the reader needs it.
- **Necessary information:** Keep what the reader needs to act, decide, or understand the conclusion. Remove detailed commands used only during testing, debugging history, process notes, and implementation details that do not help that reader.
- **Current relevance:** Remove notes about behavior, features, or workarounds that no longer exist or apply. Include historical details only when needed for the requested migration, comparison, or historical analysis.
- **Meaning and action:** Keep commands the reader must run, current constraints, and uncertainty or test limits that affect the conclusion. Put useful audit details in a separate work record when needed.

After editing, recheck meaning against the sources. For artifacts, update the IR, regenerate affected outputs, and validate the final file before delivery.

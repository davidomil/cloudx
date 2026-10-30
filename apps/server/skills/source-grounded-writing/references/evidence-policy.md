# Evidence Policy

## Sources and access

| Authority | Examples | Can establish |
|---|---|---|
| Primary | datasheet, errata, schematic, BOM, source code, revisioned design record, original measurement/log | specified behavior, implementation, requirements, observations within the recorded scope |
| Secondary | vendor application note, user guide, reviewed analysis | explanation and constraints supported by primary material |
| Context | meeting note, chat, email, issue thread, scratch note | intent, history, stakeholder preference, open questions, what someone reported |

Context alone cannot establish hardware or software correctness. Quoting a reported result establishes what was reported, not an independently reproduced result. Open original sources and check content and revision; metadata and source IDs do not prove support.

Declare `access`: `local`, `recipient`, or `public`. Citation eligibility follows access, not URL syntax. Only link HTTP sources declared `recipient` or `public` in recipient output. Local evidence remains internal unless an audit packet or local references are requested.

## Precise, portable locators

- PDF: revision, page, section, table, figure, or crop.
- Code/configuration: repo path, commit, line or function, effective configuration when relevant.
- Schematic: revision, sheet, net, reference designator, pin.
- Table/log: row key, source line, timestamp, run identity, measurement conditions.
- Context: exported source, timestamp, sender, thread when available.

Use relative file locators. Optional source `path` is relative to the IR directory or explicit `--source-root`. It enables existence checks; `sha256` also checks identity. These do not establish semantic truth. Do not imply the validator opened an unverified URL/archive source.

Keep checkout paths internal. Literal target paths such as a required `/home/app/log` argument belong in `runtime_paths`; allow only exact paths needed by the document. Keep archive IDs out of recipient prose.

## Claim kinds and support

| Kind | Wording and review requirement |
|---|---|
| `technical_fact` | Exact specified/implemented behavior; primary or suitable secondary support, never context alone. |
| `observation` | What a named run, measurement, or record showed, with scope and conditions. |
| `inference` | A conclusion drawn from evidence; include `reasoning`, assumptions, and material limits. |
| `proposal` | Intended behavior or recommendation; support the need without implying implementation or testing. |

Use `supported`, `source_gap`, or `unsupported` for `support_status`. Every referenced claim in ordinary output must be supported regardless of `required_for_output`. Unreferenced rejected candidates may remain internal. A gap report requires `doc_kind: gap_report` and `--allow-gaps`, uses explicit `gap_ref` blocks, and makes missing support visible.

Supported claims need a real source ID, precise locator, and short excerpt or source-derived note. Split compound claims with different support. Tables, figures, captions, and summaries follow the same standard as paragraphs.

## Meaning review

Check values, units, negation, conditions, revisions, and scope. Distinguish negotiated from measured rates, configured delays from electrical waveforms, sampled status from continuous behavior, and stage success from workflow success. Read effective dependency/configuration closure before asserting absence. Match fixtures to targets before causal claims. Check counterexamples and alternate compositions before recommending against an option.

Structural validation cannot decide whether a source supports a sentence. Recheck meaning after compression and final edits, including headings, tables, captions, and diagrams. Preserve uncertainty that changes the conclusion.

## Source gaps

State what cannot be concluded, why evidence is insufficient, which source would close the gap, and whether it blocks the task. Omit or qualify affected claims. Do not attach a citation to an unsupported assertion and call it supported.

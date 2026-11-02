# Source Grounded Writing

Use direct drafting for short replies, issues, email, and wording edits. Read the sources and check meaning; no IR, renderer, dependency probe, or installation is needed. See `SKILL.md` for the shared evidence and writing workflow.

Both paths end with an ASD-STE100 Simplified Technical English and audience review. Strongly prefer STE wording while preserving technical meaning and required literals. Check that the output fits its reader and remove unnecessary testing history, process notes, and obsolete details. This is a writing review, not an automated compliance check.

The artifact path compiles version 2 IR to Quarto and renders requested HTML, GFM, DOCX, or PDF outputs. Claims, tables, and visuals are shared document-wide. Automated validation checks structure and artifact content; the author must still verify semantic support and inspect layout.

## Artifact setup

Artifact tools require Python 3.10 or newer. Verify `python3 --version` before
creating the environment; CloudX's older host-Python bootstrap requirement does
not apply to these tools. CloudX installations also have managed Python 3.12.

Enter the active skill's source directory before installing tools. Use the
source path supplied by its entrypoint or base-directory notice. Native project
Claude and Codex entries point to the durable system skill catalog; session
refreshes preserve its dependencies and outputs. CloudX-managed Claude uses a
per-launch source snapshot instead. Keep that launch's commands in its snapshot
so later catalog updates cannot change its source.

After entering the active source directory, set `SGW` and create the Python
environment before installing pinned requirements:

```bash
export SGW="$PWD"
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export PATH="$SGW/.tools/bin:$SGW/node_modules/.bin:$SGW/.venv/bin:$PATH"
```

Use `.venv/bin/python` explicitly for skill commands so validation uses the installed dependencies. Check the requested target and input before installing rendering tools:

```bash
.venv/bin/python scripts/check_deps.py --target html --ir assets/fixtures/minimal-ir.json
```

The check is local and does not contact release servers or install missing tools. Add only what the requested target/visuals need:

| Need | Setup |
|---|---|
| Quarto rendering | `.venv/bin/python scripts/install_tools.py quarto` |
| Mermaid, Vega-Lite, Graphviz, browser rasterization | `PUPPETEER_SKIP_DOWNLOAD=true npm install` |
| Browser rasterization | `./node_modules/.bin/playwright install chromium` |
| D2 | `.venv/bin/python scripts/install_tools.py d2` |
| PlantUML | `.venv/bin/python scripts/install_tools.py jre plantuml dot-wrapper` |
| Graphviz wrapper | `.venv/bin/python scripts/install_tools.py dot-wrapper` |
| Native PDF | installed `xelatex`, or `quarto install tinytex` |
| HTML PDF | Python requirements for WeasyPrint; npm dependencies for Paged.js |
| PDF content checks | installed `pdftotext` from Poppler |

Use an existing browser with `SGW_BROWSER_EXECUTABLE` when needed. On restricted systems, set `XDG_CACHE_HOME` to a writable task directory and explicitly select the installed browser. Do not change `HOME` or `CODEX_HOME`, silently download a browser, or switch engines after a failure.

Quarto includes Pandoc. Node packages provide Mermaid, Vega-Lite, Graphviz WASM, Playwright, and Paged.js. Python requirements include JSON Schema, HTML parsing, Pillow image decoding, YAML, and WeasyPrint. Binary installers pin Quarto, D2, Java, and PlantUML versions/checksums in `scripts/install_tools.py`.

Run the broad installation diagnostic only when investigating the complete tool installation:

```bash
.venv/bin/python scripts/check_deps.py --profile full
```

## Validate and render a fixture

The fixture cites `assets/fixtures/reset-design-note.txt`, a synthetic source unrelated to real hardware. Its SHA-256 and relative path are checked. Its claims are reused across sections and linked from its table and Mermaid figure.

```bash
.venv/bin/python scripts/validate_evidence.py assets/fixtures/minimal-ir.json
.venv/bin/python scripts/validate_presentation.py assets/fixtures/minimal-ir.json
.venv/bin/python scripts/compile_doc.py assets/fixtures/minimal-ir.json --target html --out build/minimal.qmd
.venv/bin/python scripts/render_doc.py build/minimal.qmd --to html --out-dir build/html
.venv/bin/python scripts/validate_presentation.py assets/fixtures/minimal-ir.json --artifact build/html/minimal.html
```

Compile separately for another target, or repeat `--target` for explicitly requested targets. With no `--target`, compilation uses `IR.targets`. For example:

```bash
.venv/bin/python scripts/compile_doc.py draft.ir.json --target gfm --out build/draft.qmd
.venv/bin/python scripts/render_doc.py build/draft.qmd --to gfm --out-dir build/gfm
.venv/bin/python scripts/validate_presentation.py draft.ir.json --artifact build/gfm/draft.md
```

Other render targets are `docx`, `pdf-quarto`, and `pdf-html`. Select the HTML PDF engine explicitly with `--engine weasyprint` or `--engine pagedjs`. Keep the chosen target and engine after a failure. GFM output omits YAML metadata. Short-channel profiles omit title/TOC/section scaffolding by default; optional IR `presentation` booleans control title, section headings, TOC, and numbering.

Embedded line breaks (LF, CRLF, or CR) in table cells become spaces so text stays readable in
HTML, Markdown, Word, and PDF exports.

Every visual kind (Mermaid, D2, Graphviz, PlantUML, Vega-Lite, source-image) produces a static asset or fails with the renderer's error output. Source-image paths resolve against the IR directory, or `--source-root`. Raster files are decoded before use. Diagram specs are not delivered as a substitute for images.

## Evidence and artifact checks

```bash
.venv/bin/python scripts/validate_evidence.py draft.ir.json --source-root evidence
.venv/bin/python scripts/validate_presentation.py draft.ir.json --source-root evidence --artifact build/html/draft.html
```

Both validators accept `--allow-gaps` only with `doc_kind: gap_report`; compilation accepts the same flag. Gap reports use explicit `gap_ref` blocks. Ordinary blocks may never emit unsupported claims, even if `required_for_output` is false.

Evidence validation checks schema, references, declared support states, source authority rules, portable paths, and supplied local file paths/hashes. It does not read remote sources or prove entailment. Presentation validation treats prose style as advisory, rejects explicit internal markers, and checks the final artifact's expected text, tables/captions, and local image assets. HTML and Markdown receive static content/asset checks; PDF and DOCX checks extract text and do not establish layout. Artifact checks report the exact file hash and their limits.

Code-block checks preserve literal punctuation, quotes, entity spellings, and
internal spacing in HTML, GFM, and DOCX. PDF code checks fold extracted whitespace
and cannot verify spacing.

Set a code block's `language` when terminal blank lines must survive GFM export.
Pandoc writes unlabeled code as an indented block and drops terminal blank lines;
validation reports that loss. Fenced code retains its final content newline.

Review the final artifact in a browser or inspect PDF pages when layout matters. Check readable figures/tables, clipping, pagination, and content after the last edit. A passing validator is not a semantic or visual approval.

## Optional audit output

```bash
.venv/bin/python scripts/compile_doc.py draft.ir.json --target html --out build/audit.qmd --citation-style footnotes --include-evidence-appendix --include-source-map --include-internal-markers
```

Citations require explicit `access: public` or `recipient` and an HTTP source locator. HTTP syntax alone does not imply reader access. Local evidence stays internal except in requested audit output. Audit artifacts deliberately expose internal details and should not be presented as ordinary recipient output.

## IR version 2 migration

This is a breaking format change. Old IR files fail with a version/migration error; no automatic compatibility layer is provided. To migrate:

1. Set `schema_version` to `2`.
2. Move section-local claims, tables, and visuals into top-level registries. Deduplicate claims and update all references.
3. Move each section's `summary` into a paragraph block with `claim_ids`.
4. Add claim `kind`: `technical_fact`, `observation`, `inference`, or `proposal`. Add `reasoning` to inferences.
5. Replace asset `source_ids` with supporting `claim_ids`.
6. Declare source `access`. Add relative `path` and optional `sha256` for local file checks.
7. Declare necessary literal device paths in `runtime_paths`. Keep checkout locators relative.
8. For gap reports, use explicit `gap_ref` blocks and pass `--allow-gaps` consistently.

Historical audit artifacts remain historical evidence; do not rewrite them merely to make them compile under version 2.

## Regression checks

```bash
.venv/bin/python -m unittest discover -s tests -v
```

Tests cover rejected structural failures, valid constructions that previously failed, compiler profiles, visual dispatch, and renderer errors. They do not replace source review, real renderer smoke checks, or qualitative trials of the writing workflow.

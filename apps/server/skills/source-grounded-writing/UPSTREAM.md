# Bundled skill source

Imported from `davidomil/cloudx-rules-skills`, directory
`skills/source-grounded-writing`, commit
`e9b674d5a3b1c8d50a852eaa0e4495b5dbe4b78b` (2026-10-30 UTC).

CloudX changes the README setup path to `system-skills`, states the Python 3.10
minimum required by its pinned dependencies, and prefixes generated figure
filenames with the output document name. Without this prefix, compiling
two documents with the same figure ID into one directory overwrites the first
document's image. Table-cell line breaks (LF, CRLF, and CR) become spaces so
exports preserve word boundaries instead of dropping raw HTML break tags or
splitting table rows. Artifact validation preserves code-block literals rather
than interpreting their contents as prose Markdown. Regressions cover compiled
and delivered images, portable table text, and literal code validation, including
real conversions when Quarto is installed. The remaining instructions, schema,
fixtures, and dependency versions match that revision.
No installed environments, renderers, or build outputs are bundled.

CloudX installs these files as a system skill for Codex and Claude sessions. Session
entrypoints refer to the durable catalog; tools and outputs are not copied into
temporary Claude homes. Catalog
refresh restores bundled files without replacing `.venv`, `node_modules`,
`.tools`, or user-created outputs. An existing same-ID user skill remains on disk
but the system skill takes precedence. Template references to system skills are
redundant and are omitted from the effective catalog.

To update, replace the tracked skill files from a reviewed upstream revision,
apply the README path change, update `sourceGroundedWriting.ts` if its file list
changes, and run the Python regressions and CloudX catalog/terminal tests.

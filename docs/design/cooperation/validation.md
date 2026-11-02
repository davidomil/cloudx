# Design package validation

This record covers the original design-only stage inspected on 2026-11-02. No production code changed during that stage. Current runtime behavior and verification scope are documented in [Use the cooperation blackboard](runtime.md); the historical checks below establish the design package's evidence and examples.

The six main documents passed the source-grounded-writing evidence and presentation validators, compilation to GFM, and checks against the exact compiled Markdown. The local compiler checked source-file identities and artifact content/assets. Semantic support was reviewed against the current repository and opened primary sources; structural checks alone do not prove it.

All three scenario snapshots passed the strict JSON Schema, ID/reference, Unicode anchor, serialized-size, image hash/bytes/dimensions, asset-pinning, and geometry checks. Eighteen invalid-input cases were rejected. Twelve geometry probes passed for rotated bounds, fixed ports, arc midpoint, zero-length paths, stroke/label/boundary contact, and fixture WIP coverage. These checks exercise the proposed contract and examples, not a production mutation service.

Four imagegen concepts and three static architecture/lifecycle/feedback figures were opened for visual review. The review corrected diagram escaping and an undersized SVG raster export. Final figures have readable labels and complete content. The visual-template guide identifies generated wording, mixed feedback states, and out-of-scope decorative controls. Image prompts and original PNGs are retained.

An independent design review found gaps in shared geometry, deleted-target preservation, actor routing, and lifecycle wording. The documents and examples now specify fixed routes and ink containment, strict target snapshots, stable tab actor IDs, authoritative automatic close, and an explicit same-run managed transfer exception.

The reviewer rechecked the regenerated files and closed all four finding groups. The package audit passed 68 local Markdown/image links, parsed the JSON transaction example, matched three skill drafts and four prompt/image pairs, and found all 18 requirement IDs. The 32 package files contain no QMD or machine-specific renderer configuration. Tracked changes affect the documentation index only; new deliverables are under this design directory.

Commands actually used for the main checks were:

```bash
python3 debug_tooling/blackboard-design/author_docs.py
python3 debug_tooling/blackboard-design/build_docs.py
/home/david/cloudx/.cloudx/rules-skills/skills/source-grounded-writing/.venv/bin/python debug_tooling/blackboard-design/validate_examples.py
python3 debug_tooling/blackboard-design/verify_package.py
git diff --check
```

The first two local scripts use the source-grounded-writing skill’s evidence validator, presentation validator, compiler, GFM renderer, D2/Mermaid renderers, and exact-artifact validator. Drafting scripts, IR, source extracts, and detailed logs stay in `debug_tooling`; they are local work records and are not production deliverables or files to commit.

Research used `rg --files`, focused `rg -n`, source reads, `git rev-parse HEAD`, and lockfile inspection to establish owners and versions. Archive-first searches used `cloudx-doc.mjs search`; original sources were imported through `ingest-url`/`ingest-path`, then reopened with `open` and searched again. One Claude skills Markdown URL extracted only an embedded example; the full HTML page was imported and reopened for the actual skill semantics. Source-code imports used generated documentation with original bytes retained; current source remained authoritative for implementation claims.

Existing focused Vitest runs attempted during research did not start because this worktree has no installed application dependencies. The observed error was `ERR_MODULE_NOT_FOUND` for Vitest while loading configuration. The attempted commands were:

```bash
npx vitest run apps/server/src/sessionRecovery.test.ts apps/server/src/sessionStore.agentSwitch.test.ts apps/server/src/plugins/pluginContributions.test.ts apps/server/src/agents/claude/ClaudeLaunch.test.ts apps/server/src/agents/claude/claudeSkillPolicy.test.ts apps/web/src/ui/AgentSwitchMenu.test.ts
npx vitest run apps/web/src/ui/AgentSwitchMenu.test.ts apps/web/src/ui/uiContributions.test.ts apps/web/src/ui/PluginPanelDock.test.ts apps/web/src/ui/theme.test.ts apps/web/src/ui/TabPanel.test.ts
```

No native model session, browser feature test, live image-opening test, load test, or host lifecycle implementation ran during the design-only stage. Their required evidence was listed in the [implementation plan](implementation-plan.md). The later implementation uses Claude's original-session inbox instead of custom channels and adds managed-run coordination; see the [runtime guide](runtime.md) and [research addendum](research.md).

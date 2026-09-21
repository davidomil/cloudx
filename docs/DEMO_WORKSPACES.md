# Desktop demo workspaces

## Reproduce the screenshots

The desktop demos use the current CloudX server and web build with
synthetic project data. The capture creates two workspace layouts, saves
them through the layout-template API, applies both saved templates, and
captures the resulting UI at 1600 × 1000 pixels.

Run the commands below from the repository root. Chromium must be
installed for the repository’s Playwright version. The capture writes
the desktop and plugin PNG files into `docs/screenshots/`.

```bash
npm ci
npx playwright install chromium
npm run docs:screenshots
npx vitest run scripts/readme-demo-fixtures.test.mjs
```

## Implementation & review

The first template places Codex Terminal on the left, File Browser above
Local Web on the right, and a Terminal tab beside Codex. The local
project contains a release gate whose Git diff adds a reviewer-approval
condition. The preview shows passing checks with approval still pending.

Terminal transcripts and preview values are synthetic. The runner
displays the transcripts through CloudX’s terminal session and rendering
path without launching Codex or an interactive shell. The transcript’s
example test results are demo content, not validation performed by the
capture.

[View the implementation and review
screenshot](screenshots/cloudx-desktop-development.png).

To build this layout in a regular workspace, create a project window,
add Codex Terminal and Terminal to one pane, and split a second pane
into File Browser above Local Web. Open the project diff and your local
application URL. Use **Layout templates → Save current layout as
template** to save the arrangement.

## Knowledge & automation

The second template places Documentation and Rules & Skills in the left
pane and Automation in the right pane. Documentation returns two
synthetic source passages about release approval and review boundaries.
The Automation canvas shows a saved, disabled **Worktree Created → Send
Notification** workflow.

Manual search remains enabled while AI assistance is disabled. The
triangle beside Documentation Archive is the existing AI-assistance
information indicator. The demo does not run extraction, embeddings, AI
answers, or an external documentation service.

[View the knowledge and automation
screenshot](screenshots/cloudx-desktop-knowledge.png).

To build this layout in a regular workspace, add Documentation and Rules
& Skills to one pane and Automation to a second pane. Import your
project references into the archive, define the rules you want Codex to
use, and create and validate the automation before enabling it. Save the
arrangement with **Layout templates → Save current layout as template**.

## What the capture validates

The runner checks that both saved templates contain the expected tabs,
retain relative working directories, and apply successfully. It waits
for the file diff, local preview, search results, workflow nodes,
worktree records, and plugin setup controls before taking their
screenshots. Browser exceptions and requests outside the two demo
origins fail the run.

The temporary project includes a real Git repository and two linked
worktrees. Terminal and documentation responses use fixtures. Jira and
Forge show their unconfigured setup state, and the Codex Settings screen
uses a synthetic read response. Update status uses an inert fixture. The
capture never submits credentials or starts workers, recordings, or
automation runs.

The capture removes its temporary CloudX data, Git repository, saved
templates, and local server after it finishes. Displayed temporary
directory prefixes become `/demo`; the underlying files remain in the
temporary directory during capture. The generated images are the
retained artifacts.

The fixture tests check that the layouts satisfy CloudX’s shared
validation rules, keep the intended workflows visible, and leave the
notification workflow disabled. A successful capture exercises the
current workspace and plugin UI; it does not validate Codex, Jira,
GitHub, GitLab, speech recognition, or documentation indexing
integrations.

## Image inventory

Use `cloudx-desktop-development.png` for the implementation layout and
`cloudx-desktop-knowledge.png` for the knowledge layout. Each bundled
plugin has a focused `cloudx-plugin-<plugin-id>.png` capture. These
include the Settings views for `codex-settings` and `audio-ai`, the
notification center for `notifications`, and the saved-template menu for
`workspace-control`.

Keep captions explicit about synthetic data and setup screens. When
adding a demo scenario, update the fixtures and capture readiness
assertions together, rerun the capture, and inspect every changed image
before committing.

## Maintain plugin workflow diagrams

Each plugin workflow keeps its Mermaid definition in
`docs/plugins/diagrams/<plugin-id>.mmd` beside the checked-in PNG. After
editing a definition, regenerate the image with Mermaid CLI and inspect
the result before committing.

```bash
mmdc --input docs/plugins/diagrams/codex-terminal.mmd --output docs/plugins/diagrams/codex-terminal.png --backgroundColor white
```

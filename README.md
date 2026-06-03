# Cloudx

Cloudx is a local-first mobile workbench for Codex CLI. Run and supervise Codex CLI from your phone on your own Linux build machine, with local-first sessions, panes, file tools, diffs, worktrees, and constrained voice control.

Cloudx is built for long-running agent work: multiple Codex terminals, split
panes, file browsing, rendered diffs, worktree management, local dashboard
previews, and constrained voice commands backed by local Faster Whisper.

Cloudx is intentionally local-first. Your code, credentials, shell tools, and
Codex login stay on your machine. Private by default. Tailnet recommended.
Public internet unsupported.

Do not expose Cloudx to the public internet. It can spawn terminals, send text
to shells and Codex, read and edit files under configured roots, and embed local
dashboards with token-bearing URLs. Use localhost, a trusted LAN, or a private
tailnet only.

## Screenshots

These screenshots use a throwaway demo workspace and avoid local paths, host
names, and dashboard tokens.

### Desktop Workspace

![Cloudx workspace window showing a Codex terminal, file browser, and local dashboard](docs/screenshots/cloudx-split-panes.png)

### Mobile Portrait

<p align="center">
  <img src="docs/screenshots/cloudx-mobile-portrait.png" width="390" alt="Cloudx mobile portrait workspace showing stacked panes and the bottom voice command bar">
</p>

## Features

- Responsive desktop and phone UI tuned for quick mobile sessions.
- Server-backed workspace windows with independent pane layouts, default work
  directories, quick name search, and AI-assisted context search.
- tmux-like panes with movable plugin tabs.
- Layout templates that save the current pane/tab arrangement and reopen it on a
  different project path.
- Codex terminal and standard shell terminal plugins.
- File browser plugin with voice-exposed read/write actions, active file search,
  optional Git setup controls, changed-file badges in the tree, and rendered
  per-file diffs.
- Worktree manager plugin for creating or cloning a bare repository and managing
  project worktree folders.
- Local web plugin for dashboards such as Understand Anything.
- Dynamic settings for global AI/microphone controls and plugin-owned options
  such as file-browser Git diff visibility.
- Shared path autocomplete for tab, window, and template directory fields.
- Voice control using browser audio, local Faster Whisper, and
  `gpt-5.3-codex-spark`.
- HTTPS on port `3001` with a local self-signed certificate for microphone
  access.

## Repository Map

- `apps/server`: Fastify server, plugin host, sessions, terminals, local-web
  proxy, ASR bridge, and voice controller.
- `apps/web`: React/Vite UI.
- `packages/plugin-api`: plugin contracts.
- `packages/shared`: shared domain types and validation helpers.
- `services/asr`: local Faster Whisper service.
- `docs/MOTIVATION.md`: why this exists.
- `docs/WEB_APP_PLAN.md`: product and architecture plan.
- `docs/SETUP.md`: install, service, HTTPS, and ASR details.
- `docs/SECURITY_MODEL.md`: threat model, current limits, and deployment guidance.

## Quick Start

On Ubuntu 22.04 or newer, the guided installer is the easiest path:

```bash
git clone https://github.com/davidomil/cloudx
cd cloudx
./install.sh
```

It shows each phase before running it. The bootstrap stage installs Ubuntu
packages, including the PDF and spreadsheet extraction tools used by the
documentation archive, installs Node.js 22 when needed, verifies both `node -v`
and `npm -v`, and falls back to Ubuntu's `npm` package if npm is still missing.
The wizard then installs Cloudx npm dependencies, installs and checks Codex CLI,
prepares the Faster Whisper ASR environment, prepares the documentation archive
indexer environment, downloads the local ASR model, writes Cloudx config, and
optionally installs user-level systemd services. Each question includes a short
explanation of what the choice changes, and the installer prints the local
Cloudx URL when it finishes. Add `--lan` only when you want Cloudx to bind to
`0.0.0.0` for a trusted LAN or tailnet.

Preview the installer without changing the system:

```bash
./install.sh --dry-run --yes
```

Update an existing install after pulling the latest checkout:

```bash
./install.sh --update
```

Remove Cloudx-managed services and local install artifacts:

```bash
./install.sh --uninstall
```

Manual development startup is still available when prerequisites are already
installed:

```bash
npm install
npm run build
npm run dev
```

Open `https://127.0.0.1:3001`. For phone access, prefer a private tailnet proxy
to the localhost service. LAN binding is explicit:

```bash
./install.sh --lan
```

That writes `CLOUDX_HOST=0.0.0.0` and prints a warning because Cloudx can control
shells and files. Use it only on a trusted LAN or tailnet.

For voice control:

```bash
python3 -m venv services/asr/.venv
services/asr/.venv/bin/pip install -e services/asr
services/asr/.venv/bin/uvicorn cloudx_asr.main:app \
  --app-dir services/asr/src --host 127.0.0.1 --port 7810
```

The ASR service defaults to the small CPU model. See `docs/SETUP.md` for the
installer details, large-v3 Faster Whisper setup, GPU/CPU choices, and systemd
service install.

For the local documentation archive:

```bash
npm run documentation:setup
npm run documentation:start
```

This starts the Turbovec-backed indexer at `http://127.0.0.1:7820`, which is the
Cloudx default `CLOUDX_DOCUMENTATION_URL`. Create a Documentation tab in Cloudx
to upload files, add local paths, ingest URLs, add copied text or media
transcripts, search active knowledge, invalidate stale sources, remove sources
from active search, install the documentation skills, and inspect the portable
backup manifest.

The documentation archive is portable as one directory. Stop writes, then back
up `.cloudx/documentation` or the directory named by
`CLOUDX_DOCUMENTATION_DATA_DIR`.

If the signed-in Codex account cannot use the configured planner model, disable
Settings > Global > Voice commands. This hides typed and microphone voice
command submission without disabling the rest of Cloudx.

## Configuration

Common environment variables:

- `CLOUDX_HOST`: bind address, default `127.0.0.1`. Set `0.0.0.0` only for a trusted LAN or tailnet.
- `CLOUDX_PORT`: app port, default `3001`.
- `CLOUDX_ALLOWED_ROOTS`: path-delimited allowed roots, default `~`.
- `CLOUDX_ASSISTANT_BIN`: resolved coding-assistant CLI executable for assistant-backed terminals and tools.
- `CLOUDX_TOOL_PATH`: path-delimited command directories prepended to Cloudx child processes.
- `CLOUDX_ASR_URL`: ASR endpoint, default `http://127.0.0.1:7810`.
- `CLOUDX_DOCUMENTATION_URL`: documentation indexer endpoint, default `http://127.0.0.1:7820`.
- `CLOUDX_DOCUMENTATION_DATA_DIR`: portable documentation archive directory, default `.cloudx/documentation`.
- `CLOUDX_VOICE_MODEL`: planner model, default `gpt-5.3-codex-spark`.
- `CLOUDX_VOICE_DEBUG_TRANSCRIPTS`: log raw transcripts and planner text.

## Engineering Status

Cloudx was built through heavy agent-assisted and vibe-coding workflows. It is
useful, but it is not a hardened service. The current security posture is
documented in `docs/SECURITY_MODEL.md`.

## Verify

```bash
npm run typecheck
npm test
npm run build
services/documentation-indexer/.venv/bin/python -m pytest services/documentation-indexer/tests
services/asr/.venv/bin/python -m pytest services/asr/tests
```

## License

MIT. Forks and copies must keep the copyright and license notice, which credits
the original author.

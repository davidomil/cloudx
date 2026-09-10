# Cloudx: Run and supervise Codex CLI from your phone on your own Linux build machine, with local-first sessions, panes, file tools, diffs, worktrees, and constrained voice control

This guide keeps the README short and collects the operational details needed
to run Cloudx with voice control.

## Requirements

- Node.js 22 or newer.
- OpenSSL 3.x or newer.
- Python 3.8 or newer with `venv` and `pip` for bootstrapping uv. The installer uses
  uv-managed Python 3.12 for both services, matching CI.
- ripgrep (`rg`) for file-browser search and jq for JSON helper scripts.
- Poppler utilities, LibreOffice, and FFmpeg for documentation archive PDF,
  table, image, spreadsheet, and media keyframe extraction. The Ubuntu
  installer installs these.
- Quarto, Pandoc, and TeX Live XeLaTeX/LuaLaTeX engines for rendering the
  memory-plugin guide PDF. The Ubuntu installer installs these.
- Codex CLI installed and authenticated on the backend host.
- An authenticated reverse proxy such as Tailscale Serve is recommended for
  remote laptop/phone access. Direct LAN binding is supported only as an
  explicit trusted-network opt-in.

`node-pty` is optional because native builds vary by host. Terminal plugins fail
clearly at runtime if it is unavailable.

## Install

For Ubuntu 22.04 or newer, use the installer wizard:

```bash
./install.sh
```

The installer is split into two visible phases:

1. `install.sh` is the Ubuntu bootstrap. It verifies Ubuntu, installs apt
   packages required by Cloudx, including `jq` for JSON helper scripts,
   `poppler-utils`, `libreoffice`, and `ffmpeg` for documentation extraction
   plus `pandoc`, TeX Live XeLaTeX/LuaLaTeX packages, and the pinned official
   Quarto `.deb` for rendering the memory-plugin PDF guide. It checks for
   Node.js 22 and npm, and installs the NodeSource Node.js
   22 package when Node.js is too old or missing. It then verifies `node -v` and
   `npm -v`, and installs Ubuntu's separate `npm` package if the `npm` command
   is missing. It checks for Git 2.36+ because the Worktree Manager uses
   `git worktree list --porcelain -z`; on older Git packages it can add
   `ppa:git-core/ppa` and install the current stable Git package after approval.
2. `scripts/install-cloudx.mjs` is the Cloudx wizard. It prints each phase as it
   runs: pinned Codex CLI 0.153.4 verification/login, install choices, `npm ci`, a private
   `uv 0.11.28` bootstrap, managed Python 3.12, locked ASR and
   documentation-indexer environments,
   optional alternate `whisper.cpp` ASR setup, Hugging Face model download,
   `npm run build`, certificate creation,
   `~/.config/cloudx/cloudx.env` rendering, and optional user-level systemd
   service installation. When services are started, the wizard waits for
   the HTTPS app, ASR, and documentation indexer readiness endpoints with bounded
   retries; if any endpoint does not become healthy, it prints recent systemd
   status and journal output. When the install finishes, it prints
   `https://127.0.0.1:<port>`.

Both install and update request managed Python 3.12 explicitly. uv downloads it
into `~/.local/share/cloudx/python` when needed and recreates an older service
virtualenv before synchronizing its locked dependencies. System Python and its
packages remain unchanged. The managed interpreter is separate from the uv
bootstrap and is retained on uninstall because other checkouts may use it.

The wizard asks for:

- Allowed workspace roots, written to `CLOUDX_ALLOWED_ROOTS`.
- HTTPS port and optional extra certificate hostnames.
- ASR CPU thread count.
- Optional alternate `whisper.cpp` ASR setup for documentation imports and
  voice control. Leave it disabled for CPU-only and NVIDIA CUDA installs because
  Faster Whisper already covers those paths. Choose `sycl` only after the Intel
  GPU runtime, oneAPI, and device access are available.
- Whether to write/start `cloudx.service`, `cloudx-asr.service`, and
  `cloudx-documentation.service`.
- Whether to enable systemd linger so user services can survive logout.

When `nvidia-smi` reports an NVIDIA GPU with Linux driver 525.60.13 or newer,
faster-whisper ASR is configured for CUDA automatically. The installer selects
the locked `cuda` dependency extra for both managed Python environments instead
of mutating them with a second install command or requiring system-wide CUDA
libraries before install.

Each prompt includes a short explanation before the question so the tradeoff is
visible during interactive installs.

Useful non-interactive planning options:

```bash
./install.sh --dry-run
./install.sh --update --dry-run
./install.sh --uninstall --dry-run
node scripts/install-cloudx.mjs --dry-run --yes
node scripts/install-cloudx.mjs --dry-run --answers ./answers.json --yes
```

Add `--verbose` to install, update, or uninstall commands when debugging. In
verbose mode, `install.sh` enables Bash command tracing and the Node wizard
prints command working directories, allowlisted installer environment values,
captured stdout/stderr from probes, service unit write paths, and health-check
failure context.

Cloudx binds to `127.0.0.1` by default. For a tailnet-authenticated path, add the
exact externally visible origin to the installed environment file, restart
Cloudx, and proxy the loopback service with Tailscale Serve:

```bash
printf '%s\n' 'CLOUDX_TRUSTED_ORIGINS=https://build-host.example.ts.net' \
  >> ~/.config/cloudx/cloudx.env
systemctl --user restart cloudx.service
tailscale serve --bg https+insecure://localhost:3001
```

Use Tailscale grants or ACLs so only the intended users and devices can reach
the Cloudx node.

For a direct trusted-LAN path, set both values in the installed environment
file, restart Cloudx, and browse to the concrete LAN URL:

```bash
CLOUDX_HOST=0.0.0.0
CLOUDX_TRUSTED_ORIGINS=https://192.168.8.250:3001
```

Open `https://192.168.8.250:3001`, not `0.0.0.0`. If that IP is absent from the
certificate, run `CLOUDX_CERT_HOSTS=192.168.8.250 npm run cert:create -- --force`
before restarting. Host/Origin admission is not authentication because a raw
client controls its headers. Permit port `3001` only from a fully trusted LAN
with host firewall rules; never use this mode on an untrusted LAN or the public
internet. See `docs/SECURITY_MODEL.md` for the complete boundary.

The answers JSON can contain:

```json
{
  "allowedRoots": "~",
  "port": 3001,
  "certificateHosts": "",
  "cpuThreads": 6,
  "useGpu": false,
  "upgradeGit": true,
  "installWhisperCpp": false,
  "whisperCppBuild": "sycl",
  "whisperCppModel": "large-v3-turbo",
  "installServices": true,
  "startServices": true,
  "enableLinger": true,
  "runCodexLogin": true
}
```

Keep `"installWhisperCpp": false` for normal CPU-only or NVIDIA CUDA installs.
Enable it only when you want the alternate compiled backend, such as the Intel
Arc SYCL path.

Faster-whisper GPU support is installed by the Ubuntu installer when
`nvidia-smi` reports an NVIDIA GPU with a CUDA 12-compatible driver. Linux
driver 525.60.13 or newer is required; a 595-series driver is sufficient. The
wizard resolves the locked Python `nvidia-cublas-cu12` and
`nvidia-cudnn-cu12` packages through each service's `cuda` extra, writes
`CLOUDX_ASR_DEVICE=cuda`, and
chooses `CLOUDX_ASR_COMPUTE_TYPE=int8_float16` for smaller GPUs such as 4GB
cards. Larger GPUs use `float16`. Set `"useGpu": false` in answers JSON to force
CPU.

## Update

Run:

```bash
./install.sh --update
```

The update path keeps the existing `~/.config/cloudx/cloudx.env` choices and
does the operational refresh:

- Checks the saved configuration and effective systemd service ownership before
  changing packages or the checkout. Standard units must belong to this checkout
  and use its saved environment file; custom definitions require the explicit
  web-service mode below. Reload pending unit edits before updating.
- Requires a clean checkout, fetches `origin/main`, and fast-forwards to that
  commit. Detached checkouts and branches without an upstream are supported.
  Local changes and commits absent from `origin/main` are rejected without
  resetting or stashing them. The command no longer follows the current branch's
  upstream, and it reloads the updated installer before installing dependencies.
- Verifies Ubuntu prerequisites, Node.js, npm, and Git 2.36+ before any Codex or
  Cloudx npm commands run. Updates require an existing Node.js executable for the
  initial ownership checks.
- Installs exactly `@openai/codex@0.153.4` in Cloudx's user-owned npm prefix
  (`~/.local/share/cloudx/npm-global`) and verifies the resolved executable and
  Codex login status.
- Applies Cloudx's shared Codex terminal defaults to new and restarted tabs:
  explicit `--yolo` execution, memories/Apps/Agent Plugins disabled, and only
  Cloudx-provided skills plus `imagegen` enabled. Generated homes default to
  `gpt-6-astra` when the base config omits a model; explicit model and
  reasoning-effort preferences are preserved. Editing that config does not
  change an already-running Codex process.
- Browser page reloads reattach running terminal tabs and restore retained
  output. A Cloudx service restart ends its terminal processes; this is a
  separate lifecycle from browser reattachment.
- Records the resolved assistant executable path in `CLOUDX_ASSISTANT_BIN` and
  relevant command directories in `CLOUDX_TOOL_PATH` so Cloudx services do not
  depend on systemd's minimal `PATH`.
- Reinstalls Node dependencies with `npm ci`.
- Recreates the private pinned `uv` bootstrap and synchronizes both Python
  environments from their checked-in lock files. CUDA hosts select the locked
  `cuda` extras in the same operation.
- Downloads the ASR model into the saved `CLOUDX_ASR_MODEL_PATH` only if missing.
  Existing model and runtime-data directories from the saved configuration are preserved.
- Rebuilds Cloudx and creates the local HTTPS certificate if it is missing.
- Rewrites user-level systemd service files when they are already installed.
- Asks whether to restart services now; if restarted, it verifies the Cloudx,
  ASR, and documentation indexer readiness endpoints and then prints the local URL.
  Documentation readiness uses the saved listener host and port.
  Updates preserve exact `CLOUDX_HOST=0.0.0.0` only when a nonempty
  `CLOUDX_TRUSTED_ORIGINS` is also present. Other network-facing values and an
  incomplete wildcard configuration are replaced with `127.0.0.1`.

Preview update without changing the system:

```bash
./install.sh --update --dry-run --yes
```

Dry runs perform read-only checkout and service inspection. They print the
planned fetch and build operations; remote availability and ancestry are checked
when the real fetch runs.

To update an existing custom web service, run from its checkout and identify its
unit and HTTPS port explicitly:

```bash
./install.sh --update --service cloudx-forge-test-3002.service --port 3002
```

The readiness address defaults to `127.0.0.1`. For a service bound to IPv6
loopback, specify its address:

```bash
./install.sh --update --service cloudx-forge-test-3002.service --port 3002 --host ::1
```

`--host` accepts an IPv4 or IPv6 address without brackets or a zone identifier.
The wildcard bind addresses `0.0.0.0` and `::` select `127.0.0.1` and `::1` for
readiness, respectively. The updater checks only the selected address; it does
not change the service's bind configuration.

This mode checks the service's effective working directory, updates the checkout
from `origin/main`, installs Node dependencies, rebuilds Cloudx, and asks whether
to restart only that unit. The address and port must match the service's HTTPS
listener. It preserves the unit definition and environment, including transient services, and
leaves shared Codex, ASR, documentation, model, and certificate installations in
place. Add `--no-start` to build without restarting or `--dry-run --yes` to inspect
the plan. The standard update mode rejects units owned by another checkout even
with `--no-start`.

## Uninstall

Run:

```bash
./install.sh --uninstall
```

The uninstall wizard removes Cloudx-managed local artifacts. By default it:

- Stops, disables, and removes `cloudx.service`, `cloudx-asr.service`, and
  `cloudx-documentation.service` from `~/.config/systemd/user`.
- Keeps `~/.config/cloudx/cloudx.env` unless you explicitly select config
  removal.
- Removes the Cloudx-managed Python virtualenvs at `services/asr/.venv` and
  `services/documentation-indexer/.venv`.
- Removes the Cloudx-managed `uv` bootstrap at `~/.local/share/cloudx/uv`.
- Leaves Node.js, npm, Python, apt packages, and Codex CLI installed.
- Leaves `.cloudx` runtime data/certificates, `node_modules`, the downloaded
  Faster Whisper model, and systemd linger unchanged unless you explicitly ask
  to remove or disable them.

The installer checks each systemd unit before removal. Absent or inactive units
need no stop; every active unit must stop successfully before the installer
removes service files, configuration, or managed environments.

Preview uninstall without changing the system:

```bash
./install.sh --uninstall --dry-run --yes
```

Manual setup remains available:

```bash
npm ci
sudo apt install ripgrep jq poppler-utils libreoffice ffmpeg pandoc \
  texlive-xetex texlive-latex-recommended texlive-latex-extra \
  texlive-fonts-recommended lmodern
curl -fL -o /tmp/quarto-1.9.38-linux-amd64.deb \
  https://github.com/quarto-dev/quarto-cli/releases/download/v1.9.38/quarto-1.9.38-linux-amd64.deb
sudo apt install /tmp/quarto-1.9.38-linux-amd64.deb
python3 -m venv ~/.local/share/cloudx/uv
~/.local/share/cloudx/uv/bin/pip install uv==0.11.28
UV_PROJECT_ENVIRONMENT="$PWD/services/asr/.venv" \
  UV_PYTHON_INSTALL_DIR="$HOME/.local/share/cloudx/python" \
  ~/.local/share/cloudx/uv/bin/uv sync --locked --python 3.12 --managed-python \
  --project services/asr --extra dev
UV_PROJECT_ENVIRONMENT="$PWD/services/documentation-indexer/.venv" \
  UV_PYTHON_INSTALL_DIR="$HOME/.local/share/cloudx/python" \
  ~/.local/share/cloudx/uv/bin/uv sync --locked --python 3.12 --managed-python \
  --project services/documentation-indexer --extra dev
```

On a CUDA host that meets the driver requirement, append `--extra cuda` to
both `uv sync` commands. A stale lock is an error: update and review the
relevant `uv.lock` explicitly instead of dropping `--locked`.

## Jira Cloud Integration

The built-in Jira plugin uses Jira Cloud REST API v3 through the configured site
URL. Configure it from Settings > Jira:

- `Jira site URL`: the HTTPS Jira Cloud site, for example
  `https://example.atlassian.net`.
- `Jira account email`: the Atlassian account email used with the API token.
- `Jira API token`: a plugin secret. Cloudx stores it outside `config.json` and
  never returns the token value from `/api/config`.
- Dashboard settings: filter JQL, grouping, sort order, and refresh interval.
- Polling settings: enabled flag, interval, overlap window, project-key bounds,
  additional JQL filter, comment detection, assignment detection, and issue
  limit.

Create a Jira tab after configuring the connection. The panel shows assigned
issues, groups them by Epic by default, opens the original Jira issue URL, lists
comments and valid transitions, adds comments, transitions issues, and can emit
the `jira.issueManualRun` automation trigger from an issue row.

Jira hooks are available to UI, HTTP, automation, and Cloudx-contributed skills.
They cover status checks, dashboard reads, JQL search, bounded all-page search,
current user, metadata, issue create/update/get, comments, transitions, issue
links, issue URLs, and one-shot polling. The helper skills call those hooks
through the Cloudx server so the API token remains server-side.

Polling is disabled by default. When enabled, Cloudx runs bounded polling and
emits automation triggers for issue created, issue updated, issue transitioned,
issue newly assigned, issue assigned to the configured account, comment created,
and the manual play action from the Jira panel. Use project-key bounds or a
narrow polling JQL filter before enabling polling on a large Jira site.

## Automation Workflows

Create an Automation tab to build saved graphs from triggers, plugin hooks,
primitive steps, and converter steps. Jira issue rows can start a saved flow
through the manual play action, while Jira polling can emit automation-only
events for created, updated, transitioned, newly assigned, assigned-to-me, and
comment-created issues. Poll-based Jira triggers are not exposed as public HTTP
trigger IDs.

For code-driven steps, use the Run Python and Run Bash primitives. Run Python
can call automation-exposed Cloudx hooks with `cloudx.call_hook(...)`; see
`docs/AUTOMATION_CODE_EXECUTION.md` for the exact hook ID format, examples,
outputs, and runtime limits.

## Codex Session Sources And Startup

New Codex tabs generate configuration, instructions and skills under
`CLOUDX_DATA_DIR/codex-launches/<tab-id>`. The original `CODEX_HOME` (or
`HOME/.codex`) remains the default SQLite owner with its complete history corpus.
An absent or whitespace-only `CODEX_SQLITE_HOME` receives that absolute source
home; a nonblank value is passed through unchanged, including native relative
environment semantics based on the process cwd. Explicit native `sqlite_home`
configuration and requirements keep their higher priority. In the generated
config copy, an ordinary relative `sqlite_home` is normalized against its source
config parent; absolute and home-relative values retain native handling. Source
configuration is never rewritten.

New sessions, Resume picker, Resume last and Resume ID all use the shared Codex
history automatically. There is no Session source chooser or source inventory
request. Resume picker and Resume last can include all directories or exec
sessions; Resume ID takes the saved session UUID or name.

The `initialInput.resume.sourceId` field and `GET /api/codex/state-sources`
endpoint have been removed. Requests containing the removed field fail explicitly;
callers must omit it. Retained `codex-homes` directories are no longer discovered
or selectable, and old legacy-bound launch views cannot be reopened. Shared
launch views retain their canonical binding and share the original home's
sessions, archives, native writer locks and maintenance lock. Only the maintenance
lock file is shared inside `.tmp`; other temporary/native output stays private.
Native name-index replacement is preserved on restart. Missing, corrupt or changed
bindings fail before launch.

Shared config reads are capped at 1 MiB with a 30-second operation deadline.
Existing owned readable/writable modes remain unchanged. Neither new nor resumed
launches enumerate retired homes, open SQLite, scan transcripts, or walk ordinary
project descendants. Existing ancestor instruction and skill discovery remains
enabled. Before removing retired homes, check that no process still uses them and
preserve any unique history outside the active CloudX data directory.

Before operational activation, existing direct old-home native writers must be
quiescent. One-time native initialization/reconciliation requires reviewed
read-only health checks and recoverable consistent backups of affected database
families. An existing complete marker alone does not establish a complete index.
The prepared native operation must enumerate all history sources/providers and
archives through paginated `thread/list` scan-and-repair, with no filters that
hide histories, no SQL edits and no background migration. Cloudx never starts
that operation automatically for a new tab.

Native preservation and timing acceptance remain required separately from unit
and browser transport tests. Targets after genuine initialization are median
startup at most 5 seconds and p95 at most 10 seconds for ten fresh processes per
project size, with at least 90% reduction from the paired repeated-index baseline;
these are acceptance targets, not published measurements. Actual model/effort,
full session UUID and a benign fresh response confirm native readiness; network
response time is recorded separately. Desktop and mobile reload acceptance must
each retain the same process and session across two page reloads. The previous
native desktop evidence does not establish completed mobile acceptance.

Native `/goal edit` auto-expands an objective-file reference only when its lexical
home matches the expected attachment path. An alias can leave that reference
verbatim; goal text and its absolute file remain accessible. The inspected
existing objectives contained no such references. This startup change does not
introduce a profile or instruction-role redesign for that editor convenience.

## Codex Terminal Image Paste

Built-in Codex terminal tabs accept pasted PNG, JPEG, WebP, and GIF clipboard
images. Cloudx uploads each pasted image into `.cloudx/pasted-images/` under the
tab workspace and inserts an `@.cloudx/pasted-images/...` reference into the
Codex prompt so the assistant can read the saved image. Standard shell terminal
tabs keep normal paste behavior and do not intercept image files.

## Documentation Archive Service

The documentation plugin talks to a local FastAPI indexer that owns the portable
SQLite, source snapshots, and Turbovec files. Create its virtualenv and install
the service:

```bash
npm run documentation:setup
```

That command synchronizes `services/documentation-indexer/.venv` from the
checked-in lock file with the PDF, image, table, Docling, yt-dlp, and
faster-whisper dependencies used for large datasheets and media sources. It
requires `uv 0.11.28`. FFmpeg is installed by the main installer and is required
for media and YouTube slide-frame extraction.

Start it on the default localhost endpoint:

```bash
npm run documentation:start
```

Equivalent explicit command:

```bash
CLOUDX_DOCUMENTATION_DATA_DIR=.cloudx/documentation \
services/documentation-indexer/.venv/bin/cloudx-documentation-indexer \
  --host 127.0.0.1 --port 7820
```

Cloudx defaults to `CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:7820`, so no app
configuration is required when the service runs on that endpoint. If you run the
indexer elsewhere, start Cloudx with:

```bash
CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:7820 npm run dev
```

For isolated frontend QA when another Cloudx server is already using the
default port, run the server and Vite dev server on alternate ports:

```bash
CLOUDX_HOST=127.0.0.1 CLOUDX_PORT=4301 \
CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:4820 \
CLOUDX_TRUSTED_ORIGINS=http://127.0.0.1:5178 \
  npm run dev -w @cloudx/server

CLOUDX_WEB_PORT=5178 \
CLOUDX_DEV_BACKEND_ORIGIN=http://127.0.0.1:4301 \
  npm run dev:web
```

In Cloudx, create a Documentation tab. The panel can:

- Ask assisted archive questions when Documentation AI assistance and global AI
  control are enabled.
- Search active indexed knowledge manually and open full source chunks when AI
  assistance is disabled.
- Upload files, add local paths under `CLOUDX_ALLOWED_ROOTS`, ingest URLs, add
  copied text, ingest YouTube videos or playlists, and store media transcripts.
- Autodetect titles and collections from uploaded filenames, local folders, URL
  hosts, playlist metadata, or the first text line when those fields are blank.
- Show queued imports with upload, download, transcript, keyframe, and
  enrichment progress channels while long media work is running.
- Inspect extracted source chunks next to table, figure, image, and keyframe
  artifacts in the source viewer.
- Mark sources stale, revoked, superseded, or quarantined.
- Remove a source from active search by marking it deleted.
- Show archive logical/disk size totals, the dense-index runtime estimate, the
  active document list, source chunks, extracted artifacts, and archive
  export/import controls. Portable manifest inspection and Turbovec rebuild are
  available through the documentation helper, plugin hooks, and indexer API.

Documentation skills are synced automatically as CloudX system skills when the
server starts. They use `CLOUDX_DOCUMENTATION_URL`, and Cloudx exports that URL
to child processes when Codex tabs run from Cloudx. Cloudx-launched Codex tabs
also receive `CLOUDX_SERVER_URL`; the bundled documentation helper needs that
server URL to resolve relative `ingest-path` arguments from the active
workspace. With only `CLOUDX_DOCUMENTATION_URL`, pass an absolute local path.

Render the memory plugin guide PDF from its Quarto source locally when a PDF
artifact is needed:

```bash
npm run docs:memory:pdf
```

### Portable Export, Import, And Restore

The portable database is the full directory named by
`CLOUDX_DOCUMENTATION_DATA_DIR` or, by default, `.cloudx/documentation`. Back up
the directory as a unit; do not copy only `catalog.sqlite` or only the Turbovec
index file. The preferred backup path is a first-class ZIP export because it
uses SQLite online backup semantics for the live catalog and stores a manifest
with hashes for every packaged file.

First-class export:

```bash
DOC="$CLOUDX_RULES_SKILLS_DIR/system-skills/documentation-archive-control/scripts/cloudx-doc.mjs"
node "$DOC" export --output documentation-archive.zip
```

First-class import:

```bash
DOC="$CLOUDX_RULES_SKILLS_DIR/system-skills/documentation-archive-control/scripts/cloudx-doc.mjs"
node "$DOC" import-merge documentation-archive.zip
node "$DOC" import-replace documentation-archive.zip --confirm REPLACE_DOCUMENTATION_ARCHIVE
```

Raw indexer archive endpoints:

```bash
curl -L http://127.0.0.1:7820/archive/export -o documentation-archive.zip
curl -F file=@documentation-archive.zip \
  -F confirmation=REPLACE_DOCUMENTATION_ARCHIVE \
  http://127.0.0.1:7820/archive/import/replace
curl -F file=@documentation-archive.zip \
  http://127.0.0.1:7820/archive/import/merge
```

Merge import validates the package, imports missing stable documents, skips
identical document IDs, reports document or URI conflicts, preserves
invalidation events, and rebuilds the dense index. Replace import is
destructive: it requires the exact confirmation token, validates the package
before touching the current root, moves the current archive aside as a backup,
installs the imported root, and rebuilds the dense index.

Manual archive-root move:

1. Stop CloudX or otherwise stop writes to the documentation indexer.
2. Copy or move the complete archive directory, not individual files.
3. Update `CLOUDX_DOCUMENTATION_DATA_DIR` to the new directory and restart the
   indexer.
4. Verify `curl -sS http://127.0.0.1:7820/stats` reports
   `"archiveLocality": {"ok": true, ...}`.
5. Run `curl -sS -X POST http://127.0.0.1:7820/rebuild-index` when changing
   service versions or when you want to prove the dense index can be rebuilt
   from SQLite chunks.

## Faster Whisper Large Model

The ASR service accepts either a Faster Whisper model name or a local model
directory. For higher-quality voice commands, use the CTranslate2 large-v3
model:

```bash
services/asr/.venv/bin/pip install "huggingface_hub[cli]"
mkdir -p ~/.cache/cloudx/models
services/asr/.venv/bin/hf download Systran/faster-whisper-large-v3 \
  --local-dir ~/.cache/cloudx/models/faster-whisper-large-v3
```

GPU:

```bash
services/asr/.venv/bin/pip install nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*'
export LD_LIBRARY_PATH="$(services/asr/.venv/bin/python -c 'import os, nvidia.cublas.lib, nvidia.cudnn.lib; print(os.path.dirname(nvidia.cublas.lib.__file__) + ":" + os.path.dirname(nvidia.cudnn.lib.__file__))')${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
CLOUDX_ASR_MODEL_PATH=$HOME/.cache/cloudx/models/faster-whisper-large-v3 \
CLOUDX_ASR_DEVICE=cuda \
CLOUDX_ASR_COMPUTE_TYPE=int8_float16 \
CLOUDX_ASR_LANGUAGE=en \
services/asr/.venv/bin/uvicorn cloudx_asr.main:app --app-dir services/asr/src --host 127.0.0.1 --port 7810
```

CPU:

```bash
CLOUDX_ASR_MODEL_PATH=$HOME/.cache/cloudx/models/faster-whisper-large-v3 \
CLOUDX_ASR_DEVICE=cpu \
CLOUDX_ASR_COMPUTE_TYPE=int8 \
CLOUDX_ASR_LANGUAGE=en \
CLOUDX_ASR_CPU_THREADS=12 \
services/asr/.venv/bin/uvicorn cloudx_asr.main:app --app-dir services/asr/src --host 127.0.0.1 --port 7810
```

## ASR Backends

YouTube documentation ingest uses Faster Whisper by default. This is the normal
CPU-only and NVIDIA CUDA path:

```bash
CLOUDX_DOCUMENTATION_ASR_BACKEND=faster-whisper
```

Direct Faster Whisper GPU acceleration requires NVIDIA CUDA. Intel Arc GPUs do
not use the Faster Whisper CUDA path. `whisper.cpp` is not required for CPU-only
or NVIDIA CUDA installs; install it only when you want the alternate compiled
backend, primarily Intel Arc SYCL after oneAPI and GPU device access are
available:

```bash
node scripts/install-cloudx.mjs --answers ./answers.json --yes
```

Use `"installWhisperCpp": true`, `"whisperCppBuild": "sycl"`, and
`"whisperCppModel": "large-v3-turbo"` in `answers.json`. The installer clones
`ggml-org/whisper.cpp` under `~/.local/share/cloudx/whisper.cpp`, builds
`whisper-cli`, downloads the GGML model under
`~/.cache/cloudx/models/whisper.cpp`, downloads the Silero VAD model, and writes
the same backend, binary, model, VAD, and thread settings for both voice control
and documentation import. VAD is important for long videos because silent
windows can otherwise be decoded as repeated filler text instead of being
skipped:

```bash
CLOUDX_ASR_BACKEND=whisper-cpp
CLOUDX_ASR_WHISPER_CPP_BIN=...
CLOUDX_ASR_WHISPER_CPP_MODEL_PATH=...
CLOUDX_ASR_WHISPER_CPP_VAD=true
CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH=...
CLOUDX_DOCUMENTATION_ASR_BACKEND=whisper-cpp
CLOUDX_DOCUMENTATION_WHISPER_CPP_BIN=...
CLOUDX_DOCUMENTATION_WHISPER_CPP_MODEL_PATH=...
CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD=true
CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD_MODEL_PATH=...
ONEAPI_DEVICE_SELECTOR=opencl:gpu
```

For Docker or containerized runs on Linux, the container must see `/dev/dri` and
the process user must have render/video access. The host also needs the Intel
graphics compute runtime. Inside the container, `ls /dev/dri` and `clinfo -l` or
`sycl-ls` should show the Arc device before selecting the `whisper-cpp` backend.

For a small first test, omit `CLOUDX_ASR_MODEL_PATH` and set
`CLOUDX_ASR_MODEL=small`.

## Systemd User Services

The main installer owns dependency synchronization, model download, build,
configuration, and user-level service installation as one tested path. Select
service installation when prompted:

```bash
./install.sh
```

Useful non-interactive variants:

```bash
./install.sh --dry-run --yes
./install.sh --no-start --yes
node scripts/install-cloudx.mjs --answers ./answers.json --yes
```

The setup writes:

- `~/.config/cloudx/cloudx.env`
- `~/.config/systemd/user/cloudx-asr.service`
- `~/.config/systemd/user/cloudx-documentation.service`
- `~/.config/systemd/user/cloudx.service`

Service commands:

```bash
systemctl --user status cloudx.service cloudx-asr.service cloudx-documentation.service
systemctl --user restart cloudx-asr.service cloudx-documentation.service cloudx.service
journalctl --user -u cloudx.service -u cloudx-asr.service -u cloudx-documentation.service -f
```

Enable lingering only if you want services to start before login:

```bash
sudo loginctl enable-linger "$USER"
```

## HTTPS And Microphone Access

Browsers require a secure context for microphone capture. `npm run dev` creates
`.cloudx/certs/cloudx-local.{key,crt}` if missing and starts Cloudx over HTTPS
on `127.0.0.1:3001`.

Regenerate the certificate:

```bash
npm run cert:create -- --force
```

Add additional certificate names:

```bash
CLOUDX_CERT_HOSTS=cloudx.tailnet.ts.net,workstation.local npm run cert:create -- --force
```

Use your own certificate:

```bash
CLOUDX_HTTPS_KEY_PATH=/path/to/key.pem \
CLOUDX_HTTPS_CERT_PATH=/path/to/cert.pem \
npm run dev
```

For command-line acceptance checks, use
`curl -k https://127.0.0.1:3001/api/ready` unless
the certificate is trusted by the OS.

## Tailscale

For a private HTTPS tailnet URL:

```bash
printf '%s\n' 'CLOUDX_TRUSTED_ORIGINS=https://build-host.example.ts.net' \
  >> ~/.config/cloudx/cloudx.env
systemctl --user restart cloudx.service
tailscale serve --bg https+insecure://localhost:3001
```

Do not use Tailscale Funnel or any public exposure without real authentication,
authorization, and process isolation.

## Full Configuration

- `CLOUDX_HOST`: bind host, default `127.0.0.1`. The only supported
  network-facing value is the explicit IPv4 wildcard `0.0.0.0`; it requires a
  nonempty `CLOUDX_TRUSTED_ORIGINS`. Arbitrary addresses, hostnames, and the
  IPv6 wildcard are rejected.
- `CLOUDX_PORT`: server port, default `3001`.
- `CLOUDX_TRUSTED_ORIGINS`: comma-separated additional canonical HTTP(S)
  origins for the actual browser URL, Vite, and authenticated reverse proxies.
  Do not include a trailing slash or repeat the built-in loopback origin. Absence means
  no extras except that `0.0.0.0` requires at least one; a present empty
  value, empty element, duplicate, or noncanonical origin fails startup. This
  intentionally rejects unconfigured loopback aliases, alternate ports, Vite
  origins, and reverse-proxy authorities.
- `CLOUDX_LOG_LEVEL`: server log level, one of `fatal`, `error`, `warn`,
  `info`, `debug`, `trace`, or `silent`; default `info`. Use `debug` or
  `trace` when collecting runtime diagnostics for plugin installation, plugin
  contribution sync, terminal, workspace, and voice issues.
- `CLOUDX_ALLOWED_ROOTS`: path-delimited roots tabs may open, default `~`.
- `CLOUDX_DATA_DIR`: runtime state directory, default `.cloudx`.
- `CLOUDX_VOICE_MODEL`: Codex planner model, default `gpt-5.3-codex-spark`.
- `CLOUDX_ASSISTANT_BIN`: resolved coding-assistant CLI path used by terminal
  sessions. The installer currently writes the resolved Codex executable here;
  future providers such as Claude can use the same variable.
- `CLOUDX_TOOL_PATH`: command directories prepended to child-process `PATH` so
  Cloudx shells and assistant subprocesses see the same tool installs as the
  installer.
- `CLOUDX_ASR_URL`: ASR service URL, default `http://127.0.0.1:7810`.
- `CLOUDX_DOCUMENTATION_URL`: documentation indexer URL, default
  `http://127.0.0.1:7820`.
- `CLOUDX_DOCUMENTATION_HOST`: documentation indexer bind address, default
  `127.0.0.1`.
- `CLOUDX_DOCUMENTATION_PORT`: documentation indexer port, default `7820`.
- `CLOUDX_DOCUMENTATION_TIMEOUT_MS`: documentation indexer and AI enrichment
  timeout, default `1800000`. Increase it for very long media imports, up to
  12 hours.
- `CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES`: maximum indexer response size,
  default `8388608`.
- `CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES`: browser documentation upload cap,
  Cloudx server forwarding cap, and indexer multipart file cap, default
  `268435456`.
- `CLOUDX_DOCUMENTATION_IMPORT_UPLOAD_MAX_BYTES`: indexer multipart archive
  import upload cap, default `1073741824`.
- `CLOUDX_DOCUMENTATION_ALLOW_PRIVATE_URL_INGEST`: set to `true` only for
  trusted local fixtures or private documentation networks. By default, URL
  ingest rejects hosts resolving to loopback, private, link-local, or otherwise
  non-public IP addresses, including redirect targets.
- `CLOUDX_DOCUMENTATION_DATA_DIR`: portable documentation archive directory,
  default `.cloudx/documentation`.
- `CLOUDX_TERMINAL_REPLAY_BYTES`: terminal replay buffer for reconnects and
  voice context.
- `CLOUDX_VOICE_DEBUG_TRANSCRIPTS`: include raw transcript and planner text in
  logs. Leave unset for normal use.

If your signed-in Codex account cannot use the configured planner model, turn
off Settings > Global > Voice commands. That disables typed and microphone voice
command submission while leaving terminals, files, worktrees, and other Cloudx
tools enabled.

ASR options:

- `CLOUDX_ASR_BACKEND`: `faster-whisper` or `whisper-cpp`, default
  `faster-whisper`.
- `CLOUDX_ASR_MODEL`: Faster Whisper model name, default `small`.
- `CLOUDX_ASR_MODEL_PATH`: local Faster Whisper model directory.
- `CLOUDX_ASR_DEVICE`: `cuda` or `cpu`, default `cpu`.
- `CLOUDX_ASR_COMPUTE_TYPE`: for example `int8`, `int8_float16`, or `float16`.
- `CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES`: shared HTTP and WebSocket audio
  admission limit, default `26214400` (25 MiB); must be a positive integer no
  greater than `536870912` (512 MiB).
- `CLOUDX_ASR_WHISPER_CPP_BIN`: `whisper-cli` binary used when
  `CLOUDX_ASR_BACKEND=whisper-cpp`.
- `CLOUDX_ASR_WHISPER_CPP_MODEL_PATH`: GGML model file used by whisper.cpp.
- `CLOUDX_ASR_WHISPER_CPP_THREADS`: CPU helper threads for whisper.cpp, from
  `1` through `32`.
- `CLOUDX_ASR_WHISPER_CPP_VAD`: set `true` to enable whisper.cpp VAD.
- `CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH`: GGML Silero VAD model file used
  when whisper.cpp VAD is enabled.
- `CLOUDX_ASR_WHISPER_CPP_ARGS`: optional explicit extra `whisper-cli`
  arguments.
- `CLOUDX_ASR_LANGUAGE`: language code, default `en`; use `auto` for detection.
- `CLOUDX_ASR_CPU_THREADS`: CPU threads, from `1` through `32`.
- `CLOUDX_ASR_NUM_WORKERS`: Faster Whisper worker count, default `1`; must be
  from `1` through `32`.
- `CLOUDX_ASR_INFERENCE_CONCURRENCY`: maximum concurrent inference jobs;
  defaults to `CLOUDX_ASR_NUM_WORKERS` and must be from `1` through `32`.
- `CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS`: deadline for one inference worker
  request, default `120`; must be finite, positive, and at most `3600`.
- `CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS`: time allowed for an inference
  worker to stop before forced termination, default `1`; must be finite,
  positive, and at most `30`.
- `CLOUDX_ASR_INFERENCE_WORKER_START_TIMEOUT_SECONDS`: deadline for an
  inference worker to report ready, default `120`; must be finite, positive,
  and at most `600`.
- `CLOUDX_ASR_BEAM_SIZE`: final transcript beam size, default `5`.
- `CLOUDX_ASR_MAX_NEW_TOKENS`: maximum decode tokens, default `96`; set `0` to
  let Faster Whisper decide.
- `CLOUDX_ASR_CONDITION_ON_PREVIOUS_TEXT`: default `false`.
- `CLOUDX_ASR_TEMPERATURE`: default `0`.
- `CLOUDX_ASR_VAD_FILTER`: default `false`.
- `CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS`: live partial interval, default `2.0`.
- `CLOUDX_ASR_PARTIAL_MIN_BYTES`: minimum bytes before a partial transcript,
  default `16000`.
- `CLOUDX_ASR_PARTIAL_BEAM_SIZE`: default `1`.
- `CLOUDX_ASR_PARTIAL_WINDOW_BYTES`: recent audio window for partials, default
  `192000`.

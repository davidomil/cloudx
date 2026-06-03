# Cloudx: Run and supervise Codex CLI from your phone on your own Linux build machine, with local-first sessions, panes, file tools, diffs, worktrees, and constrained voice control

This guide keeps the README short and collects the operational details needed
to run Cloudx with voice control.

## Requirements

- Node.js 22 or newer.
- OpenSSL 3.x or newer.
- Python 3.9 or newer; Python 3.12 is tested locally.
- ripgrep (`rg`) for file-browser search.
- Poppler utilities and LibreOffice for documentation archive PDF, table,
  image, and spreadsheet extraction. The Ubuntu installer installs these.
- Quarto, Pandoc, and TeX Live XeLaTeX/LuaLaTeX engines for rendering the
  memory-plugin guide PDF. The Ubuntu installer installs these.
- Codex CLI installed and authenticated on the backend host.
- A trusted LAN or private tailnet for remote laptop/phone access.

`node-pty` is optional because native builds vary by host. Terminal plugins fail
clearly at runtime if it is unavailable.

## Install

For Ubuntu 22.04 or newer, use the installer wizard:

```bash
./install.sh
```

The installer is split into two visible phases:

1. `install.sh` is the Ubuntu bootstrap. It verifies Ubuntu, installs apt
   packages required by Cloudx, including `poppler-utils` and `libreoffice` for
   documentation extraction plus `pandoc`, TeX Live XeLaTeX/LuaLaTeX packages,
   and the pinned official Quarto `.deb` for rendering the memory-plugin PDF
   guide. It checks for Node.js 22 and npm, and installs the NodeSource Node.js
   22 package when Node.js is too old or missing. It then verifies `node -v` and
   `npm -v`, and installs Ubuntu's separate `npm` package if the `npm` command
   is missing.
2. `scripts/install-cloudx.mjs` is the Cloudx wizard. It prints each phase as it
   runs: Codex CLI verification/login, install choices, `npm ci`, ASR virtualenv
   setup, documentation-indexer virtualenv setup with table-aware extraction
   dependencies, Hugging Face model download, `npm run build`, certificate
   creation, `~/.config/cloudx/cloudx.env` rendering, and optional user-level
   systemd service installation. When services are started, the wizard waits for
   the HTTPS app health endpoint and ASR health endpoint with bounded retries;
   if either endpoint does not become healthy, it prints recent systemd status
   and journal output. When the install finishes, it prints
   `https://127.0.0.1:<port>`. It prints detected LAN IPv4 URLs only when
   installed with `--lan`.

The wizard asks for:

- Allowed workspace roots, written to `CLOUDX_ALLOWED_ROOTS`.
- HTTPS port and optional extra certificate hostnames.
- ASR CPU thread count.
- Whether to use a detected NVIDIA GPU. GPU mode is configure-only and requires
  CUDA/cuDNN runtime libraries to already be installed.
- Whether to write/start `cloudx.service` and `cloudx-asr.service`.
- Whether to enable systemd linger so user services can survive logout.

Each prompt includes a short explanation before the question so the tradeoff is
visible during interactive installs.

Useful non-interactive planning options:

```bash
./install.sh --dry-run
./install.sh --update --dry-run
./install.sh --uninstall --dry-run
node scripts/install-cloudx.mjs --dry-run --yes
node scripts/install-cloudx.mjs --dry-run --answers ./answers.json
```

Cloudx is private by default and binds to `127.0.0.1`. To expose it on a trusted
LAN or tailnet, opt in explicitly:

```bash
./install.sh --lan
```

This writes `CLOUDX_HOST=0.0.0.0`, prints a warning, and advertises detected LAN
URLs. Do not use this for direct public internet exposure.

For a tailnet-authenticated path, keep Cloudx on localhost and proxy it with
Tailscale Serve:

```bash
tailscale serve --bg https+insecure://localhost:3001
```

Use Tailscale grants or ACLs so only the intended users and devices can reach
the Cloudx node.

The answers JSON can contain:

```json
{
  "allowedRoots": "~",
  "port": 3001,
  "certificateHosts": "",
  "cpuThreads": 6,
  "useGpu": false,
  "installServices": true,
  "startServices": true,
  "enableLinger": true,
  "runCodexLogin": true
}
```

GPU support is configure-only in the first Ubuntu installer. If an NVIDIA GPU is
detected, the wizard asks whether to use it; choosing GPU requires CUDA/cuDNN
runtime libraries to already be installed.

## Update

Run:

```bash
./install.sh --update
```

The update path keeps the existing `~/.config/cloudx/cloudx.env` choices and
does the operational refresh:

- Verifies Ubuntu prerequisites, Node.js, and npm before any Codex or Cloudx npm
  commands run.
- Pulls the current checkout with `git pull --ff-only`.
- Updates the global Codex CLI package with npm and verifies Codex login status.
- Records the resolved assistant executable path in `CLOUDX_ASSISTANT_BIN` and
  relevant command directories in `CLOUDX_TOOL_PATH` so Cloudx services do not
  depend on systemd's minimal `PATH`.
- Reinstalls Node dependencies with `npm ci`.
- Updates the ASR virtualenv packages and downloads the model if it is missing.
- Rebuilds Cloudx and creates the local HTTPS certificate if it is missing.
- Rewrites user-level systemd service files when they are already installed.
- Asks whether to restart services now; if restarted, it verifies the Cloudx and
  ASR health endpoints and then prints the local URL. Existing installs that
  already have `CLOUDX_HOST=0.0.0.0` still print detected LAN URLs.

Preview update without changing the system:

```bash
./install.sh --update --dry-run --yes
```

## Uninstall

Run:

```bash
./install.sh --uninstall
```

The uninstall wizard removes Cloudx-managed local artifacts. By default it:

- Stops, disables, and removes `cloudx.service` and `cloudx-asr.service` from
  `~/.config/systemd/user`.
- Removes `~/.config/cloudx/cloudx.env`.
- Removes the Cloudx-managed Python virtualenvs at `services/asr/.venv` and
  `services/documentation-indexer/.venv`.
- Leaves Node.js, npm, Python, apt packages, and Codex CLI installed.
- Leaves `.cloudx` runtime data/certificates, `node_modules`, the downloaded
  Faster Whisper model, and systemd linger unchanged unless you explicitly ask
  to remove or disable them.

Preview uninstall without changing the system:

```bash
./install.sh --uninstall --dry-run --yes
```

Manual setup remains available:

```bash
npm install
sudo apt install ripgrep poppler-utils libreoffice pandoc \
  texlive-xetex texlive-latex-recommended texlive-latex-extra \
  texlive-fonts-recommended lmodern
curl -fL -o /tmp/quarto-1.9.38-linux-amd64.deb \
  https://github.com/quarto-dev/quarto-cli/releases/download/v1.9.38/quarto-1.9.38-linux-amd64.deb
sudo apt install /tmp/quarto-1.9.38-linux-amd64.deb
python3 -m venv services/asr/.venv
services/asr/.venv/bin/pip install -e services/asr
```

## Documentation Archive Service

The documentation plugin talks to a local FastAPI indexer that owns the portable
SQLite, source snapshots, and Turbovec files. Create its virtualenv and install
the service:

```bash
npm run documentation:setup
```

That command creates `services/documentation-indexer/.venv` and installs the
indexer with the PDF, image, table, and Docling dependencies used for large
datasheets.

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
  npm run dev -w @cloudx/server

CLOUDX_WEB_PORT=5178 \
CLOUDX_DEV_BACKEND_ORIGIN=http://127.0.0.1:4301 \
  npm run dev:web
```

In Cloudx, create a Documentation tab. The panel can:

- Search active indexed knowledge.
- Upload files, add local paths under `CLOUDX_ALLOWED_ROOTS`, ingest URLs, add
  copied text, and store media transcripts.
- Mark sources stale, revoked, superseded, or quarantined.
- Remove a source from active search by marking it deleted.
- Show the portable archive manifest and rebuild the Turbovec index.

Documentation skills are synced automatically as CloudX system skills when the
server starts. They use `CLOUDX_DOCUMENTATION_URL`, and Cloudx exports that URL
to child processes when Codex tabs run from Cloudx.

Render the memory plugin guide PDF from its Quarto source after documentation
changes:

```bash
npm run docs:memory:pdf
```

### Portable Backup And Restore

The portable database is the full directory named by
`CLOUDX_DOCUMENTATION_DATA_DIR` or, by default, `.cloudx/documentation`. Back up
the directory as a unit; do not copy only `catalog.sqlite` or only the Turbovec
index file.

Manual backup:

```bash
tar -czf cloudx-documentation-$(date +%F).tar.gz -C .cloudx documentation
```

Manual restore to the default location:

```bash
mkdir -p .cloudx
tar -xzf cloudx-documentation-YYYY-MM-DD.tar.gz -C .cloudx
npm run documentation:start
curl -sS -X POST http://127.0.0.1:7820/rebuild-index
```

Run the rebuild after restore when you intentionally changed active document
states, changed the service version, or want to validate that the Turbovec file
can be reconstructed from SQLite chunks.

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
CLOUDX_ASR_MODEL_PATH=$HOME/.cache/cloudx/models/faster-whisper-large-v3 \
CLOUDX_ASR_DEVICE=cuda \
CLOUDX_ASR_COMPUTE_TYPE=float16 \
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

For a small first test, omit `CLOUDX_ASR_MODEL_PATH` and set
`CLOUDX_ASR_MODEL=small`.

## Systemd User Services

This command installs ripgrep on Debian/Ubuntu when missing, creates the Python
venv if needed, downloads the large-v3 model, builds Cloudx, writes user-level
units, and starts both services:

```bash
npm run service:install
```

Useful variants:

```bash
npm run service:install -- --cpu
npm run service:install -- --gpu
npm run service:install -- --skip-model
npm run service:install -- --lan
npm run service:install -- --no-start
```

The setup writes:

- `~/.config/cloudx/cloudx.env`
- `~/.config/systemd/user/cloudx-asr.service`
- `~/.config/systemd/user/cloudx.service`

Service commands:

```bash
systemctl --user status cloudx.service cloudx-asr.service
systemctl --user restart cloudx-asr.service cloudx.service
journalctl --user -u cloudx.service -u cloudx-asr.service -f
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

For command-line checks, use `curl -k https://127.0.0.1:3001/api/health` unless
the certificate is trusted by the OS.

## Tailscale

For a private HTTPS tailnet URL:

```bash
tailscale serve --bg https+insecure://localhost:3001
```

Do not use Tailscale Funnel or any public exposure without real authentication,
authorization, and process isolation.

## Full Configuration

- `CLOUDX_HOST`: server bind address, default `127.0.0.1`. Set `0.0.0.0` only
  for a trusted LAN or tailnet.
- `CLOUDX_PORT`: server port, default `3001`.
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

- `CLOUDX_ASR_MODEL`: Faster Whisper model name, default `small`.
- `CLOUDX_ASR_MODEL_PATH`: local Faster Whisper model directory.
- `CLOUDX_ASR_DEVICE`: `cuda` or `cpu`, default `cpu`.
- `CLOUDX_ASR_COMPUTE_TYPE`: for example `float16` or `int8`.
- `CLOUDX_ASR_LANGUAGE`: language code, default `en`; use `auto` for detection.
- `CLOUDX_ASR_CPU_THREADS`: CPU threads.
- `CLOUDX_ASR_NUM_WORKERS`: Faster Whisper worker count, default `1`.
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

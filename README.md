# Cloudx

Cloudx is a local-first web workbench for running and steering Codex CLI sessions from a laptop or phone. It exists because the current browser-based Codex CLI experiments tend to miss the practical loop: check long-running jobs, switch between several agents, speak commands while away from the keyboard, and keep the interface simple enough to use from a phone.

## Security Disclosure

This project was vibe coded. Treat it as an experimental local tool, not a hardened service.

Do not expose Cloudx to the public internet. It can spawn terminals, run Codex, send text into shells, read files under configured roots, and edit files through voice-exposed plugin actions. Use it only on localhost, a trusted LAN, or a private tailnet such as Tailscale. Public exposure requires real authentication, authorization, audit logging, rate limiting, process isolation, CSRF hardening, and a security review.

## What This Repo Contains

- `docs/MOTIVATION.md`: why this exists and what existing web Codex CLI attempts miss.
- `docs/WEB_APP_PLAN.md`: detailed product and architecture plan.
- `packages/shared`: shared TypeScript domain types and voice action validation.
- `packages/plugin-api`: plugin contract for panels, backend capabilities, and voice-exposed actions.
- `apps/server`: Fastify backend, static web serving, tab/session registry, terminal plugin host, app-server voice context, and voice action controller.
- `apps/web`: responsive React/Vite single-page UI with plugin tabs, resizable panes, terminal/file panels, and push-to-talk controls.
- `services/asr`: local Faster Whisper HTTP service.

## How It Works

Cloudx is a single Fastify server that hosts the built web app and exposes local APIs over HTTPS. The server owns tab sessions and plugin sessions. Each tab is backed by one plugin, such as a Codex terminal, a standard shell terminal, or the file browser.

Plugins export:

- a descriptor for the UI and action registry,
- voice-exposed actions with JSON-schema-like input contracts,
- a standardized `voiceContext()` snapshot that tells the voice planner what the plugin can see,
- optional terminal IO, resize, stop, and status hooks.

The voice path is deliberately tool-based. Browser audio is posted to the local ASR service, the transcript and workspace context are sent to a local `codex exec` planner running `gpt-5.3-codex-spark` with medium reasoning, and the planner may only return plugin actions that are marked `voiceExposed`. For example, "list directory" in a shell tab becomes `standard-terminal.enter_text` with `ls`, while file edits can be routed to `file-browser.replace_in_file` or `file-browser.write_file`.

## Requirements

- Node.js 22 or newer.
- OpenSSL 3.x or newer for the local self-signed HTTPS certificate.
- Python 3.9 or newer for Faster Whisper; Python 3.12 is tested locally.
- A local Faster Whisper model. `large-v3` is the recommended XXL-class model for useful voice control.
- Codex CLI installed and authenticated on the host that runs the backend.
- Tailscale if you want private phone/laptop access outside localhost.

## Install

```bash
npm install
python3 -m venv services/asr/.venv
services/asr/.venv/bin/pip install -e services/asr
```

`node-pty` is an optional dependency because native build support varies by Node version. The terminal plugin fails clearly at runtime if `node-pty` is unavailable.

## Faster Whisper XXL Setup

The ASR service uses `faster-whisper` and accepts either a model name or a local model directory. For the large/XXL setup, use the CTranslate2 large-v3 model from Hugging Face:

```bash
services/asr/.venv/bin/pip install "huggingface_hub[cli]"
mkdir -p ~/.cache/cloudx/models
services/asr/.venv/bin/hf download Systran/faster-whisper-large-v3 \
  --local-dir ~/.cache/cloudx/models/faster-whisper-large-v3
```

GPU example:

```bash
CLOUDX_ASR_MODEL_PATH=$HOME/.cache/cloudx/models/faster-whisper-large-v3 \
CLOUDX_ASR_DEVICE=cuda \
CLOUDX_ASR_COMPUTE_TYPE=float16 \
services/asr/.venv/bin/uvicorn cloudx_asr.main:app --app-dir services/asr/src --host 127.0.0.1 --port 7810
```

CPU example:

```bash
CLOUDX_ASR_MODEL_PATH=$HOME/.cache/cloudx/models/faster-whisper-large-v3 \
CLOUDX_ASR_DEVICE=cpu \
CLOUDX_ASR_COMPUTE_TYPE=int8 \
services/asr/.venv/bin/uvicorn cloudx_asr.main:app --app-dir services/asr/src --host 127.0.0.1 --port 7810
```

For a smaller first test, omit `CLOUDX_ASR_MODEL_PATH` and set `CLOUDX_ASR_MODEL=small`. The service defaults to `small`, `cpu`, and `int8`.

## Run Locally

```bash
npm run build
npm run dev
CLOUDX_ASR_MODEL_PATH=$HOME/.cache/cloudx/models/faster-whisper-large-v3 \
CLOUDX_ASR_DEVICE=cuda \
CLOUDX_ASR_COMPUTE_TYPE=float16 \
services/asr/.venv/bin/uvicorn cloudx_asr.main:app --app-dir services/asr/src --host 127.0.0.1 --port 7810
```

`npm run dev` creates `.cloudx/certs/cloudx-local.{key,crt}` if missing, then starts the Fastify server with HTTPS on `0.0.0.0:3001`.

Default URLs:

- App: `https://0.0.0.0:3001` or `https://<host-ip>:3001`
- Dev web HMR: `http://0.0.0.0:5173`
- ASR: `http://127.0.0.1:7810`

## HTTPS for Microphone Capture

Browsers expose microphone capture only in secure contexts. `localhost` works for local development, but a phone or laptop connecting to `http://<host-ip>:3001` will not expose `navigator.mediaDevices`.

Cloudx creates a local self-signed certificate with SAN entries for `localhost`, `127.0.0.1`, the host name, detected LAN IPv4 addresses, and any comma-separated `CLOUDX_CERT_HOSTS` values:

```bash
npm run cert:create
npm run cert:create -- --force
```

The generated certificate is auto-detected from `.cloudx/certs/`. To use your own key and certificate instead:

```bash
CLOUDX_HTTPS_KEY_PATH=/path/to/key.pem \
CLOUDX_HTTPS_CERT_PATH=/path/to/cert.pem \
npm run dev
```

The certificate must be trusted by each client device/browser for microphone capture to work reliably. For command-line checks, use `curl -k https://127.0.0.1:3001/api/health` unless the certificate is trusted by the OS.

## Tailscale Serve

The app binds to `0.0.0.0:3001` for LAN/Tailscale testing. For a private HTTPS tailnet URL, proxy that port with Tailscale Serve:

```bash
tailscale serve 3001
```

Do not use Tailscale Funnel for this app without adding real authentication and process isolation.

## Configuration

Useful environment variables:

- `CLOUDX_HOST`: server bind address, default `0.0.0.0`.
- `CLOUDX_PORT`: server port, default `3001`.
- `CLOUDX_ALLOWED_ROOTS`: path-delimited list of roots tabs may open, default `~`.
- `CLOUDX_VOICE_MODEL`: Codex model for voice planning, default `gpt-5.3-codex-spark`.
- `CLOUDX_ASR_URL`: ASR service URL, default `http://127.0.0.1:7810`.
- `CLOUDX_ASR_MODEL`: Faster Whisper model name when no local path is set, default `small`.
- `CLOUDX_ASR_MODEL_PATH`: local Faster Whisper model directory.
- `CLOUDX_ASR_DEVICE`: `cuda` or `cpu`, default `cpu`.
- `CLOUDX_ASR_COMPUTE_TYPE`: for example `float16` on GPU or `int8` on CPU.
- `CLOUDX_TERMINAL_REPLAY_BYTES`: terminal replay buffer retained server-side for reconnects and voice context.

## Verify

```bash
npm run typecheck
npm test
npm run build
python3 -m py_compile services/asr/src/cloudx_asr/main.py services/asr/tests/test_main.py
```

For browser screenshots on Linux, install Playwright browser dependencies when the host lacks Chromium system libraries:

```bash
npx playwright install-deps chromium
```

## Current Status

This is a functional v1 scaffold, not a hardened public service. It includes plugin contracts, Codex and standard terminal plugins, a file browser plugin with voice-edit actions, voice action validation, app-server context for voice, ASR service boundary, HTTPS for microphone capture, and responsive UI. Public internet exposure is explicitly out of scope.

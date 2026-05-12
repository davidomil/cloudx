# Cloudx

Cloudx is a local-first web workbench for running and steering Codex CLI sessions from a laptop or phone. It is intentionally scoped for private Tailscale/LAN access in v1 because it exposes terminals and agent control surfaces.

## What This Repo Contains

- `docs/MOTIVATION.md`: why this exists and what existing web Codex CLI attempts miss.
- `docs/WEB_APP_PLAN.md`: detailed product and architecture plan.
- `packages/shared`: shared TypeScript domain types and voice action validation.
- `packages/plugin-api`: plugin contract for panels, backend capabilities, and voice-exposed actions.
- `apps/server`: Fastify backend, static web serving, tab/session registry, terminal plugin host, app-server voice context, and voice action controller.
- `apps/web`: responsive React/Vite single-page UI with plugin tabs, resizable panes, terminal/file panels, and push-to-talk controls.
- `services/asr`: local Faster Whisper HTTP service.

## Requirements

- Node.js 22 or newer.
- Python 3.9 or newer for Faster Whisper; Python 3.12 is tested locally.
- Codex CLI installed and authenticated on the host that runs the backend.
- Tailscale if you want private phone/laptop access outside localhost.

## Install

```bash
npm install
python3 -m venv services/asr/.venv
services/asr/.venv/bin/pip install -e services/asr
```

`node-pty` is an optional dependency because native build support varies by Node version. The terminal plugin fails clearly at runtime if `node-pty` is unavailable.

## Run Locally

```bash
npm run build
npm run dev
services/asr/.venv/bin/uvicorn cloudx_asr.main:app --app-dir services/asr/src --host 127.0.0.1 --port 7810
```

Default URLs:

- App: `http://0.0.0.0:3001` or `http://<host-ip>:3001`
- Dev web HMR: `http://0.0.0.0:5173`
- ASR: `http://127.0.0.1:7810`

## Tailscale Serve

The app binds to `0.0.0.0:3001` for LAN/Tailscale testing. For a private HTTPS tailnet URL, proxy that port with Tailscale Serve:

```bash
tailscale serve 3001
```

Do not use Tailscale Funnel for this app without adding real authentication and process isolation.

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

This is a functional v1 scaffold, not a hardened public service. It includes plugin contracts, Codex and standard terminal plugins, a file browser plugin, voice action validation, app-server context for voice, ASR service boundary, and responsive UI. Public internet exposure is explicitly out of scope until authentication, audit logging, rate limiting, and process isolation are added.

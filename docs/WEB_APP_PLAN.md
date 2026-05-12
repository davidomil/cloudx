# Cloudx Web App Plan

## Summary

Cloudx is a private web workbench for Codex CLI sessions. It provides a responsive app that works on desktop and phone, tmux-like tabs and split panes, a plugin system for panels, and push-to-talk voice control backed by local Faster Whisper plus a restricted Codex controller.

V1 is Tailscale/LAN only. The server binds to `0.0.0.0:3001` for trusted network access. Public internet exposure is not supported.

## Source Notes

Primary sources checked before implementation:

- OpenAI Codex app-server documentation: rich Codex clients should prefer app-server for authentication, conversation history, approvals, and streamed events.
- OpenAI Codex harness article: app-server is the preferred Codex integration protocol when clients need full session semantics.
- xterm.js docs: terminal instances are extended with addons such as the fit addon.
- node-pty README: browser terminal backends need PTYs, and accessible servers must be protected because spawned processes run with the parent process privileges.
- MDN MediaRecorder docs: browser microphone capture is available through `getUserMedia` and `MediaRecorder`.
- SYSTRAN faster-whisper README: Faster Whisper can run locally, load local models, and supports CPU/GPU configurations.
- Tailscale Serve docs: local services can be privately exposed inside a tailnet, with ACLs still applying.

## Product Requirements

- Desktop and mobile single-page app.
- Tabs can be switched, reordered, and assigned to split panes.
- Codex work tabs use a PTY-backed Codex terminal; the plugin system also includes standard terminal and file browser panels.
- New tabs choose an existing directory or create a new directory first.
- Terminal support is implemented through a documented plugin system.
- Voice control records audio, transcribes locally, sends text and UI context to a restricted Codex controller, and executes only validated plugin actions.
- Voice controller model defaults to `gpt-5.3-codex-spark`.

## Architecture

### Frontend

- React + Vite.
- Responsive app shell with:
  - top status bar
  - tab creation dialog
  - draggable tab strips
  - resizable split panes
  - terminal panels rendered through xterm.js
  - file browser panels
  - push-to-talk mic control

### Backend

- Fastify HTTP and WebSocket server.
- Binds to `0.0.0.0:3001` by default and serves the built frontend from the same process.
- Owns:
  - plugin registry
  - tab/session registry
  - path validation
  - terminal PTY processes
  - ASR proxying
  - Codex app-server context for voice
  - voice action planning and validation

### Plugin System

Each plugin declares:

- stable id and display name
- tab creation capabilities
- backend actions
- JSON schema-like action inputs
- whether each action is voice-exposed
- session lifecycle methods
- voice context provider

V1 plugins:

- `codex-terminal`
  - creates a PTY running `codex`
  - exposes `enter_text`, `send_key`, `resize`, and `stop`
  - streams terminal output over WebSocket
- `standard-terminal`
  - creates a PTY running the user's shell
  - uses the same terminal action surface
- `file-browser`
  - lists directories and opens bounded text previews
  - exposes `list_directory` and `open_file`

Planned plugins:

- `diff-viewer`
- `logs`

### Voice Control

Flow:

1. User presses mic.
2. Browser records with `MediaRecorder`.
3. Audio is posted to the backend.
4. Backend sends audio to local Faster Whisper service.
5. Backend builds a compact context bundle:
   - active tab
   - pane and tab layout
   - plugin capabilities
   - recent tab summaries
   - per-tab context file path
6. Backend enriches voice context with Codex app-server thread state where available.
7. Backend asks Codex with model `gpt-5.3-codex-spark` for a structured action plan.
8. Backend validates actions against plugin schemas and session state.
9. Backend executes actions in order and returns an execution report.

The controller is not allowed to execute shell commands directly. Prompt restrictions are defense-in-depth only; enforcement happens in backend validation.

## Security Boundaries

- `0.0.0.0:3001` bind by default for LAN/Tailscale testing.
- Tailscale Serve is the recommended remote access path.
- User-provided paths must resolve under configured allowed roots.
- No public internet exposure without real authentication and process isolation.
- Voice actions are rejected if not exported by the target plugin.
- Codex voice controller runs with read-only sandbox settings and schema-constrained output.
- Secrets and session files are ignored by Git.

## Implementation Phases

1. Repo bootstrap and documentation.
2. Shared TypeScript contracts.
3. Backend plugin/session/path/voice services.
4. Responsive frontend with tabs, split panes, and terminal panels.
5. Local Faster Whisper service.
6. Unit and integration tests.
7. Browser QA and Tailscale deployment notes.

## Acceptance Criteria

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- A user can create a Codex terminal tab with a chosen directory.
- A user can switch, reorder, and split tabs in the UI.
- A terminal session streams through WebSocket when `node-pty` is installed.
- Voice transcript endpoint can produce and validate a structured action plan with a mocked planner.
- Faster Whisper service exposes `/health` and `/transcribe`.

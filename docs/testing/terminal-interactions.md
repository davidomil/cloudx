# Terminal interaction acceptance

The terminal fixture builds production React/xterm code once into a temporary
output directory and serves only those assets on an ephemeral loopback port.
It does not start Vite dependency optimization, alter live services, install a
native CLI, or read personal provider credentials. Playwright keeps failure
screenshots, video, traces and native fixture transcripts in `test-results/browser`.

Run the shared browser matrix with one worker:

```sh
npx playwright test tests/browser/terminal-copy.spec.ts --workers=1
```

The desktop and Pixel 7 projects test browser transport and rendering. Pixel 7
emulation does not verify a physical phone's keyboard, long-press selection or
clipboard. The terminal's **Select visible terminal text** action saves the
visible screen into a stable browser text area. Users can select and copy that
snapshot while native output continues, then close it to resume scrolling and
typing. Scroll to older output before taking another snapshot.

Run native Codex cases separately with an explicitly selected executable/version:

```sh
CLOUDX_NATIVE_CODEX=/absolute/path/to/codex \
CLOUDX_NATIVE_CODEX_VERSION=0.166.0 \
npx playwright test tests/browser/terminal-copy.spec.ts \
  --project=desktop-chromium --workers=1 --grep 'real Codex'
```

`NativeCodexCopySession` starts a real PTY with an isolated home, explicit local
model catalog and loopback Responses endpoint. Its child receives an allowlist
of environment variables. The endpoint records prompts and serves synthetic
answers. No personal token or paid model request is needed. The version guard
fails before launching a mismatched native version. Existing native OSC 52
selection coverage remains in the suite. The multiline/image case checks the
native composer and provider request, rather than treating an uploaded path as
proof of image delivery.

## Required release evidence

Keep an entry for every selected native version and platform. Record the commit,
Node/browser/native versions, exact command, resource limits, test outcome and
artifact paths. A skipped or unavailable case remains open.

| Boundary | Required checks | Current evidence scope |
| --- | --- | --- |
| Browser → shared host | HTTP/OSC 8/file links, Shift+Enter and composition, caption/image paste and drop, staging/removal/failure, capture controls and provider/tab switches | Automated Chromium desktop and emulated mobile suite |
| Browser → native Codex | Editable two-line draft, one deliberate submit, native image item and request bytes, image removal, OSC 52 consent and denied permission | Opt-in isolated native fixture; record each executed version |
| Browser → native Claude | Same composer, image, copy and transcript behavior through a local synthetic Anthropic endpoint and isolated home | Claude 2.1.316 is available in an isolated package; no browser/native interaction fixture or acceptance has been executed yet |
| Physical iOS/Android | Long press in selection mode, range handles, clipboard approval/denial, virtual keyboard resize, scroll rail, external keyboard Shift+Enter/Ctrl+C | Requires physical devices; emulation does not establish acceptance |
| Physical macOS/Windows | Option/Meta on/off, Option-/Shift-drag, Cmd/Ctrl+C ownership, modified Enter and IME confirmation, browser-reserved shortcuts | Requires those physical platforms |
| Native external editor | Inspect VISUAL/EDITOR target, invoke native action, edit a multiline prompt, return once without submission/replay | Requires native editor execution; the browser host cannot infer success |

CloudX host preferences live in this browser/origin and apply immediately.
Native provider settings remain separately owned. Native custom keybindings can
change the meaning of modified Enter or Ctrl+J; the host help states its encoding
and identifies provider defaults by provenance. Application clipboard writes
always require the existing explicit CloudX approval, including copy-on-select.

File/editor links use the originating tab and server file-transfer path policy.
They open a bounded read-only preview with line/column information. They do not
launch a process on the server. Unsupported destinations and inaccessible files
produce a visible result. Non-image file drops currently report their unsupported
status; paste a workspace citation instead. Uploaded images remain pending until
the user inserts them and checks the native prompt. Remove staged images in the
tray; after insertion, remove their native items in the native prompt.

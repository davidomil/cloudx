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
model catalog and loopback Responses endpoint. It explicitly uses `--no-daemon`
so the CLI does not install another daemon package into each fixture home. This
flag is available in the reviewed 0.160.0, 0.162.1 and 0.166.0 executables. Its child receives an allowlist
of environment variables. The endpoint records prompts and serves synthetic
answers. No personal token or paid model request is needed. The version guard
fails before launching a mismatched native version. Existing native OSC 52
selection coverage remains in the suite. The multiline/image case checks the
native composer and provider request, rather than treating an uploaded path as
proof of image delivery.

Run native Claude cases with a reviewed executable and exact version:

```sh
CLOUDX_NATIVE_CLAUDE=/absolute/path/to/claude \
CLOUDX_NATIVE_CLAUDE_VERSION=2.1.316 \
npx playwright test tests/browser/terminal-copy.spec.ts \
  --project=desktop-chromium --workers=1 --grep 'real Claude'
```

`NativeClaudeTerminalSession` uses the production PTY owner and browser terminal,
an isolated Claude home, a synthetic local Messages endpoint, and an allowlist of
environment variables. Its API key is a fixture string, and all model requests
go to loopback. It disables tools and nonessential traffic, and never reads
personal credentials. The fixture explicitly selects `tui: default` or
`tui: fullscreen`; it seeds its own onboarding state and accepts its own API key
in the native dialog. Both renderer cases observe an editable multiline draft,
an external editor returning an edit without submission, image paste/removal/drop,
ordinary file contents in the Messages request, and native `/copy` with browser
consent and simulated clipboard denial. The native transcript and request JSON
are saved before teardown, including on failure. These fixtures do not establish
physical keyboard or OS clipboard behavior.

Both fixtures configure a temporary VISUAL/EDITOR script that appends
` editor edit` and records one invocation. The Codex fixture checks the dropped
file's bytes on upload and its absolute reference in the Responses request;
Codex does not automatically inline the file's contents. The Claude fixture
checks the text file's contents included by its native `@` expansion. Image
request assertions run after native Backspace removes the earlier image.

## Automated evidence and independent physical follow-up

Keep an entry for every selected native version and platform. Record the commit,
Node/browser/native versions, exact command, resource limits, test outcome and
artifact paths. A skipped or unavailable case remains explicitly unverified.
The owner decision of 2 November 2026 moves physical-device sign-off to
[#253](https://github.com/davidomil/cloudx/issues/253), independently of this
implementation batch. Automated browser/PTY/native correctness remains required.

| Boundary                | Required checks                                                                                                                                       | Current evidence scope                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Browser → shared host   | HTTP/OSC 8/file links, Shift+Enter and composition, caption/image paste and drop, staging/removal/failure, capture controls and provider/tab switches | Automated Chromium desktop and emulated mobile suite                                                                          |
| Browser → native Codex  | Editable two-line draft, one deliberate submit, native image item and request bytes, image removal, OSC 52 consent and denied permission              | Opt-in isolated native fixture; record each executed version                                                                  |
| Browser → native Claude | Editable multiline, image paste/removal/drop, ordinary file references, copy consent and external editor through a local synthetic Anthropic endpoint | Opt-in isolated normal/fullscreen native fixture; record each executed version                                                |
| Physical iOS/Android    | Long press in selection mode, range handles, clipboard approval/denial, virtual keyboard resize, scroll rail, external keyboard Shift+Enter/Ctrl+C    | Requires physical devices; emulation does not establish acceptance                                                            |
| Physical macOS/Windows  | Option/Meta on/off, Option-/Shift-drag, Cmd/Ctrl+C ownership, modified Enter and IME confirmation, browser-reserved shortcuts                         | Requires those physical platforms                                                                                             |
| Native external editor  | Inspect VISUAL/EDITOR target, invoke native action, edit a multiline prompt, return once without submission/replay                                    | Automated Linux native fixtures invoke a temporary editor; macOS/Windows interactive editors require physical-platform checks |

CloudX host preferences live in this browser/origin and apply immediately.
Native provider settings remain separately owned. Native custom keybindings can
change the meaning of modified Enter or Ctrl+J; the host help states its encoding
and identifies provider defaults by provenance. Application clipboard writes
always require the existing explicit CloudX approval, including copy-on-select.

File/editor links use the originating tab and server file-transfer path policy.
They open a bounded read-only preview with line/column information. They do not
launch a process on the server. Unsupported destinations and inaccessible files
produce a visible result. Image, text/code, PDF and notebook drops upload to the
originating workspace through its existing file-transfer path policy, up to
20 MiB per file. Other types have an explicit unsupported status. Ordinary files
insert an editable native `@` reference; the provider's own inclusion limits and
permissions still apply.

An upload remains pending until the user checks **Native prompt is ready for
insertion** and inserts it. Sending its path still does not establish native
acceptance. Only **I can see the native image/file reference** records the user's
confirmation after looking at the native prompt. A changed connection prevents
insertion or confirmation from the old upload. Remove staged items in the tray;
after insertion, remove image chips or file-reference text in the native prompt.
**Dismiss attachment status** only dismisses the host status. The host does not
infer attachment state from rendered text or send guessed removal keystrokes.

Use [the physical acceptance checklist](terminal-physical-checklist.md) for the
device evidence tracked independently in #253. All physical rows remain **Not run**;
browser emulation and the Linux fixture must not be entered as physical-device
results. Recorded automated native runs cover Codex 0.160.0, 0.162.1 and 0.166.0,
and Claude 2.1.316 in ordinary/fullscreen mode. These are exact-version Linux
fixture observations, not platform-wide support certification.

# Physical terminal acceptance record

Physical-device sign-off is tracked independently in [#253](https://github.com/davidomil/cloudx/issues/253),
following the owner decision of 2 November 2026. These rows are follow-up work,
not completion prerequisites for the twenty-member implementation batch.
No physical device was available in the Linux Forge worker. Every result below
remains **Not run**. Pixel emulation and Linux PTY tests are separate evidence.
Automated native evidence covers Codex 0.160.0, 0.162.1 and 0.166.0, and Claude
2.1.316 (ordinary/fullscreen); it establishes only the recorded Linux fixture
behavior. It does not certify these versions on untested physical platforms.

Record the tested commit, device model, OS version, browser/version, keyboard and
IME, CloudX server platform, and exact Codex/Claude versions before testing. Run
each row once per provider on each listed platform. Use an isolated workspace and
local synthetic provider when testing submission or attachments; do not enter
personal credentials or assume a preview is proof of delivered image bytes.

| Platform                             | Procedure and expected observation                                                                                                                                                                                                                            | Result  | Evidence                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------- |
| iOS Safari / Android Chrome          | Open **Select visible terminal text** during output. Long press, move both range handles, copy a word and a multiline range. Output keeps streaming without moving the saved range.                                                                           | Not run | Device, recording, copied text                            |
| iOS Safari / Android Chrome          | Approve a native application-copy request; paste into another app. Deny browser clipboard permission and verify the reviewed text remains available. Dismiss each preview by tapping outside.                                                                 | Not run | Permission setting, copied text, recording                |
| iOS Safari / Android Chrome          | Open and dismiss the virtual keyboard, change orientation and drag the scroll rail. Keep the native composer and caret visible; return to typing after closing selection mode.                                                                                | Not run | Before/after viewport recording                           |
| iOS / Android with external keyboard | Type `first line`, Shift+Enter, `second line`; edit both lines, then press Enter once. Inspect one submitted prompt containing the newline. Repeat with Ctrl+J, reconnect and provider switching.                                                             | Not run | Keyboard model, native transcript and local request       |
| iOS / Android with external keyboard | Save a selection and press Ctrl/Cmd+C; it copies without native input. Clear it and press Ctrl+C; the native application receives cancellation.                                                                                                               | Not run | Clipboard text and native input evidence                  |
| macOS Safari / Chrome                | Toggle Settings → Terminal → Option as Meta. Observe native Option shortcuts with it on/off; Option-drag still saves a selection without sending native mouse input.                                                                                          | Not run | OS/browser, effective setting, recording                  |
| macOS / Windows                      | With native mouse reporting enabled, use Option-/Shift-drag to save a selection. Verify Cmd/Ctrl+C ownership and native Ctrl+C with no selection. Exercise browser-reserved shortcuts and record collisions.                                                  | Not run | Keyboard/layout, copied text and input evidence           |
| macOS / Windows                      | Confirm an IME composition with Enter and Shift+Enter. Hold/repeat keys and change input mode. No accidental submission or duplicate newline is allowed. Repeat in ordinary/fullscreen native renderers.                                                      | Not run | IME name, input trace, local provider request             |
| macOS / Windows                      | Select an actual VISUAL/EDITOR target, invoke native Ctrl+G, edit a two-line draft, save and return. The draft changes without submitting; one deliberate Enter submits it once.                                                                              | Not run | Executable/version, editor log and local provider request |
| All listed platforms                 | Paste a caption with an image; drop an image and a text file. Check native readiness before insertion and the visible native item before confirmation. Remove an image and edit/remove the file reference before submission. Inspect the final local request. | Not run | Native prompt recording, uploaded bytes, request JSON     |

A failed row needs its exact steps, native input/output and screenshot, with
credentials removed. Keep unexecuted rows open. A device result is accepted only
for its recorded hardware, OS, browser, input configuration and native versions.

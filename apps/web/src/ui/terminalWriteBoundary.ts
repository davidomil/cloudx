import type { Terminal } from "@xterm/xterm";

interface InputHandler {
  parse(data: string | Uint8Array, promiseResult?: boolean): void | Promise<boolean>;
}

/** xterm 6.0.0 queues writes; selection must be saved before parsing mutates cells. */
export function onBeforeTerminalWrite(terminal: Terminal, beforeWrite: () => void): { dispose(): void } {
  // There is no public pre-parse event. The exact dependency pin and browser
  // regressions guard this contract, including plain text and parser resumes.
  const inputHandler = (terminal as Terminal & { _core?: { _inputHandler?: InputHandler } })._core?._inputHandler;
  if (typeof inputHandler?.parse !== "function") {
    throw new Error("Unsupported xterm write boundary; expected the pinned xterm 6.0.0 input handler.");
  }
  const parse = inputHandler.parse;
  inputHandler.parse = function (data, promiseResult) {
    beforeWrite();
    return parse.call(this, data, promiseResult);
  };
  return { dispose: () => { inputHandler.parse = parse; } };
}

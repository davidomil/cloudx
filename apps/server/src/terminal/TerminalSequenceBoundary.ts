import type { Terminal } from "@xterm/headless";

/** Keeps the serialized screen at a complete VT sequence / Unicode boundary. */
export class TerminalSequenceBoundary {
  private readonly transitions: Uint8Array;
  private state = 0;
  private fragments: string[] = [];
  private trailingSurrogate = "";
  private pendingBytes = 0;

  constructor(terminal: Terminal, private readonly byteLimit: number) {
    // xterm 6's own VT500 table keeps framing consistent with its parser, including
    // C1 controls, cancellation, ignored sequences, and OSC/DCS terminators.
    const { _core } = terminal as unknown as {
      _core: { _inputHandler: { _parser: { _transitions: { table: Uint8Array } } } };
    };
    this.transitions = _core._inputHandler._parser._transitions.table;
  }

  takeComplete(data: string): string {
    const chunk = this.trailingSurrogate + data;
    this.trailingSurrogate = "";
    let boundary = 0;
    for (let offset = 0; offset < chunk.length;) {
      const code = chunk.codePointAt(offset)!;
      if (offset === chunk.length - 1 && code >= 0xd800 && code <= 0xdbff) {
        this.trailingSurrogate = chunk[offset]!;
        break;
      }
      // StringToUtf32 ignores BOM. OSC_END and DCS_UNHOOK also enter ESCAPE
      // when terminated by ESC.
      if (code !== 0xfeff) this.state = code === 0x1b ? 1 : this.transitions[this.state << 8 | Math.min(code, 0xa0)]! & 15;
      offset += code > 0xffff ? 2 : 1;
      if (this.state === 0) boundary = offset;
    }
    let complete = "";
    if (boundary) {
      complete = this.fragments.join("") + chunk.slice(0, boundary);
      this.fragments = [];
      this.pendingBytes = 0;
    }
    const remaining = chunk.slice(boundary, chunk.length - this.trailingSurrogate.length);
    if (remaining) {
      this.fragments.push(remaining);
      this.pendingBytes += Buffer.byteLength(remaining);
    }
    if (this.pendingBytes + Buffer.byteLength(this.trailingSurrogate) > this.byteLimit) {
      throw new Error("Incomplete terminal sequence exceeded its byte limit.");
    }
    return complete;
  }

  get pending(): string {
    return this.fragments.join("") + this.trailingSurrogate;
  }
}

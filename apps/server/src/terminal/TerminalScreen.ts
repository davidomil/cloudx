import headless from "@xterm/headless";
import type { Terminal, ITerminalAddon, IBuffer, IBufferCell } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { TerminalSequenceBoundary } from "./TerminalSequenceBoundary.js";

export interface TerminalScreenSnapshot {
  data: string;
  cols: number;
  rows: number;
}

export const MAX_TERMINAL_SCREEN_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_SCREEN_BYTES = 32 * 1024 * 1024;
const MAX_TERMINAL_SCREEN_CELLS = 1024 * 1024;
const TERMINAL_SCROLLBACK_ROWS = 1000;

/** Keeps screen contents and input modes independently of the raw output tail. */
export class TerminalScreen {
  private readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly sequences: TerminalSequenceBoundary;
  private readonly listeners = new Set<(data: string) => void>();
  private pending = Promise.resolve();
  private pendingBytes = 0;
  private failure?: Error;
  private disposed = false;

  constructor(cols = 100, rows = 30) {
    validateScreenDimensions(cols, rows);
    this.terminal = new headless.Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK_ROWS, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
    this.sequences = new TerminalSequenceBoundary(this.terminal, MAX_TERMINAL_SCREEN_BYTES);
  }

  write(data: string): void {
    if (this.disposed) return;
    if (this.failure) throw this.failure;
    const bytes = Buffer.byteLength(data);
    if (this.pendingBytes + bytes > MAX_PENDING_SCREEN_BYTES) {
      this.failure = new Error("Terminal screen output exceeded its pending byte limit.");
      throw this.failure;
    }
    this.pendingBytes += bytes;
    this.enqueue(() => new Promise<void>((resolve, reject) => {
      this.terminal.write(this.sequences.takeComplete(data), () => {
        this.pendingBytes -= bytes;
        try {
          for (const listener of this.listeners) listener(data);
          resolve();
        } catch (error) { reject(error); }
      });
    }));
  }

  resize(cols: number, rows: number): void {
    validateScreenDimensions(cols, rows);
    this.enqueue(() => { this.terminal.resize(cols, rows); });
  }

  restore(screen: TerminalScreenSnapshot): void {
    this.resize(screen.cols, screen.rows);
    this.write(`\x1bc${screen.data}`);
  }

  snapshot(): Promise<TerminalScreenSnapshot> {
    return this.pending.then(() => this.serialize());
  }

  attach(onData: (data: string) => void): Promise<{ screen: TerminalScreenSnapshot; dispose: () => void }> {
    return this.pending.then(() => {
      const screen = this.serialize();
      this.listeners.add(onData);
      return { screen, dispose: () => { this.listeners.delete(onData); } };
    });
  }

  flush(): Promise<void> {
    return this.pending;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.pending.finally(() => {
      this.listeners.clear();
      this.terminal.dispose();
    }).catch(() => undefined);
  }

  private serialize(): TerminalScreenSnapshot {
    if (this.disposed) throw new Error("The terminal screen is disposed.");
    if (this.failure) throw this.failure;
    let data = this.serializer.serialize();
    if (this.terminal.buffer.active.type === "alternate") {
      const normal = this.serializer.serialize({ excludeAltBuffer: true, excludeModes: true });
      // The addon's 1049 switch would overwrite the normal buffer's saved cursor.
      // Switch with 47 after restoring that buffer's own state instead.
      data = normal + this.bufferState(this.terminal.buffer.normal, false)
        + "\x1b[?47h\x1b[0m" + data.slice(normal.length + "\x1b[?1049h".length);
    }
    data += this.bufferState(this.terminal.buffer.active, this.terminal.modes.originMode) + this.mouseEncoding() + this.sequences.pending;
    if (Buffer.byteLength(data) > MAX_TERMINAL_SCREEN_BYTES) throw new Error("Terminal screen snapshot exceeded its byte limit.");
    return { data, cols: this.terminal.cols, rows: this.terminal.rows };
  }

  private mouseEncoding(): string {
    // SerializeAddon 0.14 retains tracking, but xterm 6 stores encoding separately.
    const { coreMouseService } = (this.terminal as unknown as {
      _core: { coreMouseService: { activeEncoding: string } };
    })._core;
    switch (coreMouseService.activeEncoding) {
      case "SGR": return "\x1b[?1006h";
      case "SGR_PIXELS": return "\x1b[?1016h";
      default: return "";
    }
  }

  private bufferState(buffer: IBuffer, originMode: boolean): string {
    // xterm 6 keeps DECSC/SCOSC/1048 state per buffer and uses absolute savedY.
    const { savedX, savedY, savedCurAttrData } = (buffer as unknown as {
      _buffer: { savedX: number; savedY: number; savedCurAttrData: IBufferCell };
    })._buffer;
    const hasSavedCursor = savedX !== 0 || savedY !== 0 || !savedCurAttrData.isAttributeDefault();
    let data = "";
    if (hasSavedCursor) {
      const { _curAttrData } = (this.terminal as unknown as {
        _core: { _inputHandler: { _curAttrData: IBufferCell } };
      })._core._inputHandler;
      const savedRow = Math.max(0, Math.min(this.terminal.rows - 1, savedY - buffer.baseY));
      data = `\x1b[?6l\x1b[r${cursorAttributes(savedCurAttrData)}\x1b[${savedRow + 1};${savedX + 1}H\x1b7${cursorAttributes(_curAttrData)}`;
      if (originMode) data += "\x1b[?6h";
    }
    return data + this.scrollRegion(buffer, originMode, hasSavedCursor);
  }

  private scrollRegion(buffer: IBuffer, originMode: boolean, restoreCursor: boolean): string {
    // SerializeAddon 0.14 omits DECSTBM; these are the actual xterm 6 margins
    // after buffer switches, resizes, and resets, rather than a second model.
    const { scrollTop, scrollBottom } = (buffer as unknown as {
      _buffer: { scrollTop: number; scrollBottom: number };
    })._buffer;
    if (scrollTop === 0 && scrollBottom === this.terminal.rows - 1 && !originMode && !restoreCursor) return "";
    const cursorRow = buffer.cursorY - (originMode ? scrollTop : 0) + 1;
    const region = `\x1b[${scrollTop + 1};${scrollBottom + 1}r`;
    if (buffer.cursorX < this.terminal.cols) return `${region}\x1b[${cursorRow};${buffer.cursorX + 1}H`;

    // CUP and DECRC clamp pending wrap to the last column. Repainting this row
    // restores wrap, wide cells, and attributes using the addon's own renderer.
    const row = buffer.baseY + buffer.cursorY;
    const serializer = this.serializer as unknown as {
      _serializeBufferByRange(terminal: Terminal, buffer: IBuffer, range: { start: number; end: number }, excludeFinalCursorPosition: boolean): string;
    };
    return `${region}\x1b[${cursorRow};1H\x1b[0m${serializer._serializeBufferByRange(this.terminal, buffer, { start: row, end: row }, true)}`;
  }

  private enqueue(operation: () => void | Promise<void>): void {
    this.pending = this.pending.then(operation);
    void this.pending.catch((error: unknown) => { this.failure = error instanceof Error ? error : new Error(String(error)); });
  }
}

function cursorAttributes(attributes: IBufferCell): string {
  const codes = [0];
  for (const [enabled, code] of [
    [attributes.isBold(), 1], [attributes.isDim(), 2], [attributes.isItalic(), 3],
    [attributes.isUnderline(), 4], [attributes.isBlink(), 5], [attributes.isInverse(), 7],
    [attributes.isInvisible(), 8], [attributes.isStrikethrough(), 9], [attributes.isOverline(), 53],
  ] as const) {
    if (enabled) codes.push(code);
  }
  for (const [color, rgb, palette, code] of [
    [attributes.getFgColor(), attributes.isFgRGB(), attributes.isFgPalette(), 38],
    [attributes.getBgColor(), attributes.isBgRGB(), attributes.isBgPalette(), 48],
  ] as const) {
    if (rgb) codes.push(code, 2, color >>> 16 & 255, color >>> 8 & 255, color & 255);
    else if (palette) codes.push(code, 5, color);
  }
  return `\x1b[${codes.join(";")}m`;
}

function validateScreenDimensions(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0 || cols * (rows + TERMINAL_SCROLLBACK_ROWS) > MAX_TERMINAL_SCREEN_CELLS) {
    throw new Error("Terminal dimensions exceed the screen cell limit.");
  }
}

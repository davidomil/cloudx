import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { onTerminalWrite } from "./terminalWriteBoundary.js";

describe("terminal write boundary", () => {
  it("observes cells before each queued chunk without changing the bytes or receiver", () => {
    let cells = "original";
    const seen: string[] = [];
    const parsed: string[] = [];
    const parse = vi.fn(function (this: unknown, data: string | Uint8Array) {
      expect(this).toBe(inputHandler);
      cells = typeof data === "string" ? data : new TextDecoder().decode(data);
    });
    const inputHandler = { parse };
    const terminal = { _core: { _inputHandler: inputHandler } } as unknown as Terminal;
    const writes = ["\x1b[1;", "1Hreplacement", new Uint8Array([65])];
    const listener = onTerminalWrite(terminal, { beforeWrite: () => seen.push(cells), afterWrite: () => parsed.push(cells) });

    for (const data of writes) inputHandler.parse(data);

    expect(seen).toEqual(["original", "\x1b[1;", "1Hreplacement"]);
    expect(parsed).toEqual(["\x1b[1;", "1Hreplacement", "A"]);
    expect(parse.mock.calls.map(([data]) => data)).toEqual(writes);
    expect(parse.mock.calls[2][0]).toBe(writes[2]);
    listener.dispose();
    expect(inputHandler.parse).toBe(parse);
    inputHandler.parse("after disposal");
    expect(seen).toHaveLength(3);
  });

  it("preserves parser promises and continuation arguments after bindings are replaced", async () => {
    const pending = Promise.resolve(true);
    const parse = vi.fn((_data: string, _promiseResult?: boolean) => pending);
    const inputHandler = { parse };
    const terminal = { _core: { _inputHandler: inputHandler } } as unknown as Terminal;
    const previousSelection = vi.fn();
    const currentSelection = vi.fn();
    onTerminalWrite(terminal, { beforeWrite: previousSelection, afterWrite: vi.fn() }).dispose();
    const afterWrite = vi.fn();
    const listener = onTerminalWrite(terminal, { beforeWrite: currentSelection, afterWrite });

    expect(inputHandler.parse("queued")).toBe(pending);
    const result = await pending;
    expect(inputHandler.parse("queued", result)).toBe(pending);
    expect(parse.mock.calls).toEqual([["queued", undefined], ["queued", true]]);
    expect(previousSelection).not.toHaveBeenCalled();
    expect(currentSelection).toHaveBeenCalledTimes(2);
    expect(afterWrite).toHaveBeenCalledTimes(2);
    listener.dispose();
  });

  it("propagates parser errors", () => {
    const failure = new Error("parser failed");
    const terminal = { _core: { _inputHandler: { parse: () => { throw failure; } } } };
    const beforeWrite = vi.fn();
    const afterWrite = vi.fn();
    const listener = onTerminalWrite(terminal as unknown as Terminal, { beforeWrite, afterWrite });
    expect(() => terminal._core._inputHandler.parse()).toThrow(failure);
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(afterWrite).toHaveBeenCalledOnce();
    listener.dispose();
  });

  it.each([{}, { _core: {} }, { _core: { _inputHandler: {} } }, { _core: { _inputHandler: { parse: true } } }])(
    "rejects an unsupported xterm contract: %j", (terminal) => {
      expect(() => onTerminalWrite(terminal as Terminal, { beforeWrite: vi.fn(), afterWrite: vi.fn() })).toThrow("expected the pinned xterm 6.0.0 input handler");
    }
  );
});

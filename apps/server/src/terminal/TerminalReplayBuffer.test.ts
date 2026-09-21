import { describe, expect, it, vi } from "vitest";

import { TerminalReplayBuffer } from "./TerminalReplayBuffer.js";

describe("terminal replay history", () => {
  it("retains ordered output up to its byte limit and releases it when cleared", () => {
    const history = new TerminalReplayBuffer(8);
    expect(history.snapshot()).toBe("");
    history.append("");
    history.append("old");
    history.append("tail");
    expect(history.snapshot()).toBe("oldtail");
    history.append("!");
    const snapshot = history.snapshot();
    expect(snapshot).toBe("oldtail!");
    history.append("new");
    expect(history.snapshot()).toBe("tail!new");
    expect(snapshot).toBe("oldtail!");
    history.clear();
    expect(history.snapshot()).toBe("");
    history.append("reused");
    expect(history.snapshot()).toBe("reused");
  });

  it.each(["é", "界", "😀"])("never retains a partial %s character at the oldest boundary", character => {
    const bytes = Buffer.byteLength(character);
    for (let capacity = 1; capacity <= bytes + 1; capacity++) {
      const history = new TerminalReplayBuffer(capacity);
      history.append("old");
      history.append(character);
      history.append("!");
      expect(history.snapshot()).toBe(capacity === bytes + 1 ? character + "!" : "!");
    }
  });

  it("discards earlier chunks when one new chunk exceeds the entire capacity", () => {
    const history = new TerminalReplayBuffer(7);
    history.append("old");
    history.append("discarded😀new");
    expect(history.snapshot()).toBe("😀new");
    history.append("!");
    expect(history.snapshot()).toBe("new!");
  });

  it("retains the same UTF-8 tail through repeated small appends and evictions", () => {
    const history = new TerminalReplayBuffer(17);
    let expected = "";
    for (let index = 0; index < 2000; index++) {
      const chunk = ["a", "é", "界", "😀", "\r\n"][index % 5]!;
      history.append(chunk);
      expected += chunk;
      while (Buffer.byteLength(expected) > 17) expected = [...expected].slice(1).join("");
      expect(history.snapshot()).toBe(expected);
    }
  });

  it.each([false, true])("bounds copying by incoming bytes when history starts in one chunk: %s", singleChunk => {
    const history = new TerminalReplayBuffer(1024 * 1024);
    const chunk = "\r".repeat(4096);
    const from = vi.spyOn(Buffer, "from");
    const concat = vi.spyOn(Buffer, "concat");
    const copy = vi.spyOn(Buffer.prototype, "copy");
    try {
      if (singleChunk) history.append(chunk.repeat(256));
      for (let index = 0; index < (singleChunk ? 256 : 512); index++) history.append(chunk);
      const encodedBytes = from.mock.results.reduce((total, result) => total + result.value.length, 0);
      const joinedBytes = concat.mock.results.reduce((total, result) => total + result.value.length, 0);
      const copiedBytes = copy.mock.results.reduce((total, result) => total + result.value, 0);
      expect(encodedBytes + joinedBytes + copiedBytes).toBeLessThanOrEqual(3 * 512 * Buffer.byteLength(chunk));
    } finally {
      copy.mockRestore();
      concat.mockRestore();
      from.mockRestore();
    }
    expect(history.snapshot()).toBe(chunk.repeat(256));
  });

  it("grows storage on demand within the replay limit even for one-byte output events", () => {
    const capacity = 16 * 1024;
    const history = new TerminalReplayBuffer(capacity);
    const allocate = vi.spyOn(Buffer, "allocUnsafe");
    try {
      history.append("a");
      expect(allocate.mock.calls.reduce((bytes, [size]) => bytes + size, 0)).toBeLessThan(capacity);
      for (let index = 1; index < capacity * 2; index++) history.append("b");
      expect(allocate.mock.calls.reduce((bytes, [size]) => bytes + size, 0)).toBeLessThan(capacity * 2);
    } finally {
      allocate.mockRestore();
    }
    expect(history.snapshot()).toBe("b".repeat(capacity));
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid capacity %s", capacity => {
    expect(() => new TerminalReplayBuffer(capacity)).toThrow("positive safe integer");
  });
});

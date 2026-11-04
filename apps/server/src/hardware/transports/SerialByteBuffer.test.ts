import { describe, expect, it } from "vitest";
import { SerialByteBuffer } from "./SerialByteBuffer.js";

describe("bounded serial byte buffer", () => {
  it("preserves arbitrary chunk boundaries and wraps without reordering bytes", () => {
    const bytes = new SerialByteBuffer(5);
    bytes.append(Buffer.from([0, 1, 2]));
    expect(bytes.read(2)).toEqual({ data: Buffer.from([0, 1]), truncated: true });
    bytes.append(Buffer.from([3, 4, 5, 6]));
    expect(bytes.size).toBe(5);
    expect(bytes.read(5)).toEqual({ data: Buffer.from([2, 3, 4, 5, 6]), truncated: false });
    expect(bytes.size).toBe(0);
  });

  it("bounds storage, reports discarded input, and clears retained bytes", () => {
    const bytes = new SerialByteBuffer(3);
    bytes.append(Buffer.from([0, 1, 2, 3, 4]));
    expect(bytes.size).toBe(3);
    expect(bytes.read(10)).toEqual({ data: Buffer.from([0, 1, 2]), truncated: true });
    expect(bytes.read(1)).toEqual({ data: Buffer.alloc(0), truncated: false });
    bytes.append(Buffer.from([5, 6]));
    bytes.clear();
    expect(bytes.size).toBe(0);
    expect(bytes.read(3)).toEqual({ data: Buffer.alloc(0), truncated: false });
  });
});

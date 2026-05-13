import { describe, expect, it } from "vitest";

import { AudioChunkQueue } from "./AudioChunkQueue.js";

describe("AudioChunkQueue", () => {
  it("streams pushed chunks and completes when ended", async () => {
    const queue = new AudioChunkQueue();
    const iterator = queue[Symbol.asyncIterator]();

    queue.push(Buffer.from("audio"));
    queue.end();

    await expect(iterator.next()).resolves.toEqual({ value: Buffer.from("audio"), done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("rejects pending and future reads when failed", async () => {
    const queue = new AudioChunkQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    const error = new Error("too small to decode");

    queue.fail(error);

    await expect(pending).rejects.toThrow("too small to decode");
    await expect(iterator.next()).rejects.toThrow("too small to decode");
  });
});

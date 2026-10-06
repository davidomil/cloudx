import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { JsonlCache } from "./JsonlCache.js";

// Attributes each usage line to the model of the latest context line.
function modelCache() {
  return new JsonlCache<{ model: string }, string>(() => ({ model: "none" }), (line, state) => {
    const value = line as { model?: string; usage?: string };
    if (value.model) state.model = value.model;
    return value.usage ? `${value.usage}:${state.model}` : undefined;
  });
}

describe("JsonlCache", () => {
  it("keeps concurrent reads of one file in order across chunks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jsonl-"));
    const file = path.join(root, "rollout.jsonl");
    // Several 1 MiB chunks, each model change separated from its usage line.
    const filler = JSON.stringify({ text: "x".repeat(600_000) });
    const turns = Array.from({ length: 8 }, (_, index) => [JSON.stringify({ model: `m${index}` }), filler, JSON.stringify({ usage: `u${index}` })]);
    await fs.writeFile(file, `${turns.flat().join("\n")}\n`);
    const cache = modelCache();
    const expected = turns.map((_, index) => `u${index}:m${index}`);
    expect(await Promise.all([cache.read(file), cache.read(file), cache.read(file), cache.read(file)])).toEqual([expected, expected, expected, expected]);
  });

  it("keeps multi-byte characters that a chunk boundary splits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jsonl-"));
    const file = path.join(root, "rollout.jsonl");
    // {"pad":" is 8 bytes and ","model":" 11, so "é" starts at the last byte of the first chunk.
    const padding = "x".repeat(1024 * 1024 - 20);
    await fs.writeFile(file, `${JSON.stringify({ pad: padding, model: "é-model" })}\n${JSON.stringify({ usage: "r1" })}\n`);
    expect(await modelCache().read(file)).toEqual(["r1:é-model"]);
  });
});

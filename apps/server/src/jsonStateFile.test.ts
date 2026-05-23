import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { JsonStateFile } from "./jsonStateFile.js";

describe("JsonStateFile", () => {
  it("rejects top-level values that cannot be represented as JSON documents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-json-state-non-json-"));
    const state = new JsonStateFile(root, "state.json", "Test state");

    await expect(state.write(undefined)).rejects.toThrow("Test state file must be JSON-serializable.");
    await expect(fs.access(path.join(root, "state.json"))).rejects.toThrow();
  });
});

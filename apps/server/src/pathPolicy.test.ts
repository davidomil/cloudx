import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PathPolicy } from "./pathPolicy.js";

describe("PathPolicy", () => {
  it("accepts paths under configured roots", () => {
    const root = path.join(os.tmpdir(), "cloudx-root");
    const policy = new PathPolicy([root]);

    expect(policy.resolve(path.join(root, "project"))).toBe(path.join(root, "project"));
  });

  it("rejects paths outside configured roots", () => {
    const policy = new PathPolicy([path.join(os.tmpdir(), "cloudx-root")]);

    expect(() => policy.resolve("/etc")).toThrow(/outside configured Cloudx roots/);
  });
});

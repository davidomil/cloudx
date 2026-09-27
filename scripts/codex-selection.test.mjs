import { describe, expect, it } from "vitest";
import { isCodexVersion, compareCodexVersions } from "./codex-selection.mjs";

describe("exact Codex versions", () => {
  it.each(["0.155.1", "0.159.0-alpha.9", "1.0.0-rc.1+build.0", "1.0.0-0"])("accepts %s", value => expect(isCodexVersion(value)).toBe(true));
  it.each([null, {}, "01.0.0", "1.0.0-01", "1.0.0-", "1.0.0+", "1.0.0-a..b", "1.0.0\n"])("rejects %j", value => expect(isCodexVersion(value)).toBe(false));
  it.each([
    ["0.155.1", "0.157.1"], ["1.0.0-alpha", "1.0.0-alpha.1"], ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"], ["1.0.0-beta.2", "1.0.0-beta.11"], ["1.0.0-rc.1", "1.0.0"],
    ["1.0.0-9", "1.0.0-a"], ["999999999999999999999.0.0", "1000000000000000000000.0.0"],
  ])("orders %s before %s", (first, second) => {
    expect(compareCodexVersions(first, second)).toBe(-1);
    expect(compareCodexVersions(second, first)).toBe(1);
  });
  it("ignores build metadata for precedence", () => expect(compareCodexVersions("1.0.0+a", "1.0.0+b")).toBe(0));
  it("rejects a non-version in comparison", () => expect(() => compareCodexVersions("latest", "1.0.0")).toThrow(/Invalid/));
});

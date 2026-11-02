import { describe, expect, it } from "vitest";

import { CLAUDE_LAUNCH_MODES, parseClaudeResolvedLaunchPolicy, resolveClaudeLaunchMode, type ClaudeResolvedLaunchPolicy } from "./claudeLaunchPolicy.js";

describe("Claude launch mode selection", () => {
  it("keeps managed mode opt-in and distinguishes launch, saved and fresh choices", () => {
    expect(CLAUDE_LAUNCH_MODES).toEqual(["native-project", "cloudx-managed"]);
    expect(resolveClaudeLaunchMode(undefined)).toEqual({ mode: "native-project", source: "default" });
    expect(resolveClaudeLaunchMode(undefined, null)).toEqual({ mode: "native-project", source: "default" });
    expect(resolveClaudeLaunchMode(undefined, "cloudx-managed")).toEqual({ mode: "cloudx-managed", source: "saved" });
    expect(resolveClaudeLaunchMode("native-project", "cloudx-managed")).toEqual({ mode: "native-project", source: "launch" });
    expect(resolveClaudeLaunchMode("cloudx-managed", "native-project")).toEqual({ mode: "cloudx-managed", source: "launch" });
  });

  it.each([null, "", "restricted", "safe-mode", {}, [], true, 1])("rejects an unsupported explicit mode %j", requested => {
    expect(() => resolveClaudeLaunchMode(requested, "native-project")).toThrow("Claude launch mode");
  });
});

const recorded: ClaudeResolvedLaunchPolicy = {
  mode: "cloudx-managed", contractVersion: 1, nativeVersion: "2.1.316", exclusiveSkills: true, activation: "next-launch",
  settingSources: ["user"], includedSources: ["personal instructions"], excludedSources: ["shared project settings", "project rules", "local instructions"],
  skills: [{ name: "docx", origin: "synced", account: "account-1", sourcePath: "skills/synced/account-1/docx", sha256: "a".repeat(64), nativeSource: "user" }],
  sourceFiles: [{ path: "/overlay/settings.json", state: "file", sha256: "b".repeat(64) }, { path: "/workspace/.claude/settings.json", state: "missing" }]
};

describe("recorded Claude launch policy", () => {
  it("returns a detached validated source snapshot rather than mutable caller state", () => {
    const result = parseClaudeResolvedLaunchPolicy(recorded);
    expect(result).toEqual(recorded);
    result.skills[0]!.name = "changed";
    expect(recorded.skills[0]!.name).toBe("docx");
    expect(parseClaudeResolvedLaunchPolicy({ ...recorded, mode: "native-project", exclusiveSkills: false, settingSources: ["user", "project", "local"], skills: [] }).mode).toBe("native-project");
    expect(parseClaudeResolvedLaunchPolicy({ ...recorded, mode: "native-project", nativeVersion: "unobserved", exclusiveSkills: false, settingSources: ["user", "project", "local"], skills: [] }).nativeVersion).toBe("unobserved");
  });

  it.each([
    null, [], {}, { ...recorded, token: "private" }, { ...recorded, mode: "restricted" }, { ...recorded, contractVersion: 2 },
    { ...recorded, exclusiveSkills: false }, { ...recorded, activation: "live" }, { ...recorded, nativeVersion: "unknown" },
    { ...recorded, nativeVersion: "2.1.315" },
    { ...recorded, nativeVersion: "unobserved" },
    { ...recorded, mode: "native-project", exclusiveSkills: false },
    { ...recorded, settingSources: ["user", "managed"] }, { ...recorded, settingSources: ["user", "user"] },
    { ...recorded, settingSources: ["user", "local"] }, { ...recorded, settingSources: [] },
    { ...recorded, includedSources: ["bad\nsource"] }, { ...recorded, excludedSources: Array(65).fill("source") },
    ...["bad/name", ""].map(name => ({ ...recorded, skills: [{ ...recorded.skills[0], name }] })),
    ...["plugin", "project"].map(origin => ({ ...recorded, skills: [{ ...recorded.skills[0], origin }] })),
    { ...recorded, skills: [{ ...recorded.skills[0], apiKey: "private" }] },
    { ...recorded, skills: [{ ...recorded.skills[0], sourcePath: "x\0y" }] },
    { ...recorded, skills: [{ ...recorded.skills[0], sha256: undefined }] },
    { ...recorded, skills: [{ ...recorded.skills[0], account: "../other" }] },
    { ...recorded, skills: [{ ...recorded.skills[0], account: undefined }] },
    { ...recorded, skills: [{ ...recorded.skills[0], nativeSource: "project" }] },
    { ...recorded, skills: [{ ...recorded.skills[0], origin: "personal" }] },
    { ...recorded, skills: Array(2001).fill(recorded.skills[0]) },
    { ...recorded, skills: [recorded.skills[0], recorded.skills[0]] },
    { ...recorded, sourceFiles: [{ path: "/file", state: "file" }] },
    { ...recorded, sourceFiles: [{ path: "/file", state: "missing", sha256: "a".repeat(64) }] },
    { ...recorded, sourceFiles: [{ path: "/file", state: "unreadable" }] }
  ])("rejects malformed or unsupported persisted input %# without a default-policy fallback", value => {
    expect(() => parseClaudeResolvedLaunchPolicy(value)).toThrow("Invalid recorded Claude launch policy");
  });
});

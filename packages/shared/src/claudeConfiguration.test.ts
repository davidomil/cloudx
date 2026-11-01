import { describe, expect, it } from "vitest";

import { CLAUDE_BOOLEAN_SETTINGS } from "./claudeSettings.js";
import { CLAUDE_CONFIGURATION_REFERENCE, claudeConfigurationAvailability, claudeConfigurationCatalog, claudeConfigurationDisposition, claudeConfigurationRequiresNewerVersion } from "./claudeConfiguration.js";

const setting = (name: string) => claudeConfigurationCatalog("", "settings").find(entry => entry.name === name)!;

describe("Claude native configuration inventory", () => {
  it("accounts for the complete retained reference surface without counting repeated flag summaries as independent controls", () => {
    const entries = claudeConfigurationCatalog();
    expect(entries.filter(entry => entry.family === "settings")).toHaveLength(247);
    expect(entries.filter(entry => entry.family === "environment")).toHaveLength(384);
    expect(entries.filter(entry => entry.family === "cli")).toHaveLength(116);
    expect(entries.filter(entry => entry.family === "cli").reduce((sum, entry) => sum + entry.referenceRows, 0)).toBe(121);
    expect(new Set(entries.map(entry => `${entry.family}:${entry.name}`)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.scope).not.toBe("");
      expect(entry.lifecycle).toMatch(/^(documented|deprecated|removed)$/u);
      expect(claudeConfigurationDisposition(entry).reason).not.toBe("");
      expect(CLAUDE_CONFIGURATION_REFERENCE.sources[entry.source]!.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(CLAUDE_CONFIGURATION_REFERENCE.verifiedNativeVersions).toEqual([]);
  });

  it("classifies managed policy, accounts, removed options, session flags and unsupported native lifecycle explicitly", () => {
    expect(claudeConfigurationDisposition(setting("allowManagedHooksOnly")).kind).toBe("managed");
    expect(claudeConfigurationDisposition(setting("apiKeyHelper")).kind).toBe("account");
    expect(claudeConfigurationDisposition(setting("permissionExplainerEnabled")).kind).toBe("legacy");
    expect(claudeConfigurationDisposition(setting("worktree")).kind).toBe("unsupported");
    expect(claudeConfigurationDisposition(setting("skillOverrides")).kind).toBe("launch-policy");
    expect(claudeConfigurationDisposition(setting("copyOnSelect")).kind).toBe("native-only");
    expect(claudeConfigurationDisposition(claudeConfigurationCatalog("--resume", "cli")[0]!).kind).toBe("launch-policy");
    expect(claudeConfigurationDisposition(claudeConfigurationCatalog("--debug-file", "cli")[0]!).kind).toBe("session-only");
  });

  it("preserves literal defaults, unset state, source provenance and version uncertainty", () => {
    expect(setting("copyOnSelect")).toMatchObject({ nativeDefault: true, defaultKind: "literal", scope: "Global config" });
    expect(setting("copyFullResponse")).toMatchObject({ nativeDefault: false, defaultKind: "literal" });
    expect(setting("modelSettings")).toMatchObject({ minimumVersion: "2.1.251", defaultKind: "unset" });
    expect(setting("disableAllHooks")).toMatchObject({ minimumVersion: null, versionMentions: expect.arrayContaining(["2.1.309"]) });
    expect(setting("allowManagedHooksOnly").minimumVersion).toBeNull();
    expect(claudeConfigurationAvailability(setting("modelSettings"), "2.1.250 (Claude Code)")).toContain("is older");
    expect(claudeConfigurationAvailability(setting("modelSettings"), "2.1.290 (Claude Code)")).toContain("runtime unverified");
    expect(claudeConfigurationAvailability(setting("modelSettings"))).toContain("unverified");
    expect(claudeConfigurationAvailability(setting("copyOnSelect"), "2.1.290")).toContain("Minimum version not established");
    expect(claudeConfigurationRequiresNewerVersion(setting("bashEditDiffEnabled"), "2.1.268")).toBe(true);
    expect(claudeConfigurationRequiresNewerVersion(setting("bashEditDiffEnabled"), "2.1.269")).toBe(false);
    expect(claudeConfigurationRequiresNewerVersion(setting("bashEditDiffEnabled"))).toBe(false);
  });

  it("keeps typed editors restricted to documented persistent keys and supports search by group and classification", () => {
    for (const name of CLAUDE_BOOLEAN_SETTINGS) {
      const entry = setting(name);
      expect(entry).toMatchObject({ type: "boolean", lifecycle: "documented" });
      expect(["Any file", "User or managed"]).toContain(entry.scope);
      expect(claudeConfigurationDisposition(entry).kind).toBe("editable");
    }
    expect(claudeConfigurationCatalog("sandbox managed", "settings").every(entry => entry.scope.toLowerCase().includes("managed"))).toBe(true);
    expect(claudeConfigurationCatalog("CLAUDE_CODE_USE_MANTLE", "environment")).toHaveLength(1);
    expect(claudeConfigurationCatalog("no-such-native-key")).toEqual([]);
  });
});

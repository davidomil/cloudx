import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { editCodexConfiguration } from "./CodexConfigurationDocument.js";
import { readCodexConfiguration, validateCodexNativeOptions } from "./CodexConfigurationSettings.js";

const snapshot = (text = "", version = "0.162.1") => readCodexConfiguration(text, version, "/bin/codex", "/user/config.toml", false);

describe("native Codex settings", () => {
  it("redacts authentication values, including nested profile credentials, while publishing environment references", () => {
    const text = '[mcp_servers.private]\ncommand="mcp"\nenv={ SECRET="hidden-value" }\nbearer_token="hidden-token"\nbearer_token_env_var="MCP_TOKEN"\n[model_providers.private]\nname="Provider"\nexperimental_bearer_token="hidden-provider-token"\nenv_key="PROVIDER_KEY"\n';
    const settings = snapshot(text);
    expect(JSON.stringify(settings)).not.toContain("hidden-");
    expect(settings.values).toMatchObject({ mcp_servers: { private: { command: "mcp", bearer_token_env_var: "MCP_TOKEN" } }, model_providers: { private: { env_key: "PROVIDER_KEY" } } });
  });

  it("validates enums, nested types, dynamic permission maps and unknown configuration fields", () => {
    const settings = snapshot();
    for (const options of [
      { model_verbosity: "loud" }, { tui: { animations: "yes" } },
      { tui: { unexpected: true } }, { permissions: { workspace: { network: { allowed_domains: "all" } } } },
      { mcp_servers: { private: { command: "mcp", env: { SECRET: "new-token" } } } },
      { made_up: true },
    ]) expect(() => validateCodexNativeOptions(options, settings, "")).toThrow();
    expect(() => validateCodexNativeOptions({ model_verbosity: "high", tui: { animations: false, resume_cwd: "current" } }, settings, "")).not.toThrow();
  });

  it.each(["0.160.0", "0.162.1"])("saves, reads and reloads arbitrary nested MCP hook input on %s", version => {
    const text = '# source note\n[unrelated]\nkeep="original"\n';
    const input = { details: { name: "start" }, tags: ["a", "b"], records: [{ nested: [{ name: "first" }] }] };
    const hooks = { SessionStart: [{ hooks: [{ type: "mcp_tool", server: "local", tool: "start", input }] }] };
    const initial = snapshot(text, version);
    expect(() => validateCodexNativeOptions({ hooks }, initial, text)).not.toThrow();
    const saved = editCodexConfiguration(text, "hooks", initial.values.hooks, hooks);
    expect(snapshot(saved, version).values.hooks).toEqual(hooks);
    expect(saved).toContain('# source note\n[unrelated]\nkeep="original"');
    const updated = structuredClone(hooks);
    updated.SessionStart[0]!.hooks[0]!.input.details.name = "reload";
    updated.SessionStart[0]!.hooks[0]!.input.tags.push("c");
    const read = snapshot(saved, version);
    expect(() => validateCodexNativeOptions({ hooks: updated }, read, saved)).not.toThrow();
    const reloaded = editCodexConfiguration(saved, "hooks", read.values.hooks, updated);
    expect(snapshot(reloaded, version).values.hooks).toEqual(updated);
    expect(parse(reloaded).unrelated).toEqual({ keep: "original" });
    expect(() => validateCodexNativeOptions({ hooks: { ...updated, unexpected: { nested: true } } }, snapshot(reloaded, version), reloaded)).toThrow(/not a reviewed/);
    expect(() => validateCodexNativeOptions({ desktop: { window: { geometry: [1, 2] } } }, read, saved)).toThrow(/not an editable/);
  });

  it.each(["0.160.0", "0.162.1"])("publishes existing nested MCP hook JSON without dropping objects or array items on %s", version => {
    const text = '[hooks]\nSessionStart=[{ hooks=[{ type="mcp_tool", server="local", tool="start", input={ details={ name="start" }, tags=["a", "b"], records=[{ names=["first"] }] } }] }]\n';
    expect(snapshot(text, version).values.hooks).toEqual(parse(text).hooks);
  });

  it.each(["0.160.0", "0.162.1"])("preserves ignored native fields while rejecting edits on %s", version => {
    const text = '[features.multi_agent_v2]\nenabled=true\nusage_hint_enabled=true # ignored legacy value\n';
    const read = snapshot(text, version);
    expect(read.values.features).toEqual({ multi_agent_v2: { enabled: true } });
    expect(() => validateCodexNativeOptions({ features: { multi_agent_v2: { enabled: false, usage_hint_enabled: false } } }, read, text)).toThrow(/managed/);
    expect(() => validateCodexNativeOptions({ features: { multi_agent_v2: { enabled: false } } }, read, text)).not.toThrow();
    const edited = editCodexConfiguration(text, "features", read.values.features, { multi_agent_v2: { enabled: false } });
    expect(parse(edited).features).toEqual({ multi_agent_v2: { enabled: false, usage_hint_enabled: true } });
    expect(edited).toContain("# ignored legacy value");
  });

  it("blocks unreviewed executables and reports profile precedence without exposing secrets", () => {
    expect(() => validateCodexNativeOptions({ tui: {} }, snapshot('model="custom"', "9.0.0"), "")).toThrow(/reviewed schema/);
    const settings = snapshot('model_verbosity="high"\nprofile="review"\n[profiles.review]\nmodel_verbosity="low"\n');
    expect(settings.values.model_verbosity).toBe("high");
    expect(settings.effectiveValues.model_verbosity).toBe("high");
    expect(settings.overrides.some(value => value.includes("Legacy config.toml profile selector"))).toBe(true);
    expect(() => validateCodexNativeOptions({ profile: "absent" }, settings, "")).toThrow(/not an editable/);
  });

  it.each([
    '[tui]\n# animation preference\nanimations=true # keep inline\nnotifications=false\n[unrelated]\nkeep="original"\n',
    'tui.animations=true # keep inline\ntui.notifications=false\n[unrelated]\nkeep="original"\n',
    'tui={ animations=true, notifications=false } # keep inline\n[unrelated]\nkeep="original"\n',
  ])("edits nested values without rewriting comments or unrelated tables %#", text => {
    const changed = editCodexConfiguration(text, "tui", { animations: true, notifications: false }, { animations: false, notifications: false, resume_cwd: "current" });
    expect(changed).toContain("# keep inline");
    expect(changed).toContain('[unrelated]\nkeep="original"');
    expect(parse(changed).tui).toEqual({ animations: false, notifications: false, resume_cwd: "current" });
  });

  it("unsets an explicit nested table and preserves sibling configuration and comments", () => {
    const text = '# own comment\n[tui]\nanimations=false # keep comment\nnotifications=false\n[profiles.review]\nmodel="custom"\n';
    const changed = editCodexConfiguration(text, "tui", { animations: false, notifications: false }, null);
    expect(parse(changed)).not.toHaveProperty("tui");
    expect(changed).toContain("# keep comment");
    expect(parse(changed).profiles).toEqual({ review: { model: "custom" } });
  });

  it("preserves hidden credentials when editing a provider map", () => {
    const text = '[model_providers.custom]\nname="Before"\nexperimental_bearer_token="hidden-value" # private\n';
    const before = snapshot(text).values.model_providers;
    const changed = editCodexConfiguration(text, "model_providers", before, { custom: { name: "After" } });
    expect(parse(changed).model_providers).toMatchObject({ custom: { name: "After", experimental_bearer_token: "hidden-value" } });
    expect(changed).toContain("# private");
  });

  it("edits and unsets TOML arrays of tables without duplicate tables", () => {
    const text = '[[skills.config]]\npath="/old/SKILL.md"\nenabled=true\n[unrelated]\nkeep=true\n';
    const changed = editCodexConfiguration(text, "skills", { config: [{ path: "/old/SKILL.md", enabled: true }] }, { config: [{ path: "/new/SKILL.md", enabled: false }] });
    expect(parse(changed).skills).toEqual({ config: [{ path: "/new/SKILL.md", enabled: false }] });
    expect(parse(editCodexConfiguration(text, "skills", { config: [{ path: "/old/SKILL.md", enabled: true }] }, null))).not.toHaveProperty("skills");
  });

  it("replaces a nested hook table array and removes its descendant tables while keeping comments", () => {
    const text = '[[hooks.PostToolUse]]\nmatcher="Bash"\n[[hooks.PostToolUse.hooks]]\ntype="command"\ncommand="old" # keep hook note\n[unrelated]\nkeep=true\n';
    const before = { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "old" }] }] };
    const after = { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "new" }] }] };
    const changed = editCodexConfiguration(text, "hooks", before, after);
    expect(parse(changed).hooks).toEqual(after);
    expect(changed).toContain("# keep hook note");
    expect(parse(editCodexConfiguration(text, "hooks", before, null))).not.toHaveProperty("hooks");
  });
});

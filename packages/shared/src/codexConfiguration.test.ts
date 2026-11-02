import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  CODEX_CONFIGURATION_BASELINE_VERSION, CODEX_CONFIGURATION_CLI_OPTIONS, CODEX_CONFIGURATION_SCHEMAS, CODEX_CONFIGURATION_VERSIONS,
  codexConfigurationCatalog, codexConfigurationCliCatalog, codexConfigurationCliCoverage, codexConfigurationCoverage,
  codexKeymapSelection, codexConfigurationSchema, codexConfigurationValidationSchema, inventoryCodexConfiguration, isCodexKnownPath, isCodexProtectedPath, isCodexReadOnlyPath,
  type CodexConfigurationSchema, type CodexConfigurationVersion,
} from "./codexConfiguration.js";

describe("reviewed native Codex configuration", () => {
  it.each(["0.160.0", "0.162.1", "0.166.0"] as CodexConfigurationVersion[])("covers every recursive schema path for %s without hiding an unmapped option", version => {
    const catalog = codexConfigurationCatalog(version);
    expect(codexConfigurationCoverage(CODEX_CONFIGURATION_SCHEMAS[version], catalog)).toEqual([]);
    expect(codexConfigurationCoverage(codexConfigurationValidationSchema(version), catalog)).toEqual([]);
    expect(new Set(catalog.map(entry => entry.path)).size).toBe(catalog.length);
    for (const entry of catalog) {
      expect(entry.description).not.toBe("");
      expect(entry.group).not.toBe("");
      expect(["stable", "experimental", "deprecated"]).toContain(entry.status);
      expect(["all", "linux", "macos", "windows"]).toContain(entry.platform);
      expect(["user", "user/project", "profile", "secret"]).toContain(entry.scope);
      if (!entry.editable) expect(entry.reason).toBeTruthy();
    }
    const schemaBytes = readFileSync(new URL(`./codexConfigurationSchema-${version}.json`, import.meta.url));
    expect(createHash("sha256").update(schemaBytes).digest("hex")).toBe(CODEX_CONFIGURATION_VERSIONS[version].schemaSha256);
  });

  it("pins the reviewed families and refuses unreviewed CLI versions", () => {
    expect(CODEX_CONFIGURATION_BASELINE_VERSION).toBe("0.166.0");
    expect(codexConfigurationCatalog().filter(entry => entry.path === entry.family)).toHaveLength(103);
    expect(() => codexConfigurationCatalog("0.163.0")).toThrow("no reviewed configuration catalog");
    expect(() => codexConfigurationCliCatalog("0.163.0")).toThrow("no reviewed configuration catalog");
  });

  it("detects new nested, map, array and alternative paths instead of inheriting blanket coverage", () => {
    const schema: CodexConfigurationSchema = {
      properties: { tools: { anyOf: [
        { properties: { command: { type: "string" } } },
        { additionalProperties: { type: "array", items: { properties: { enabled: { type: "boolean" } } } } },
      ] } },
    };
    expect(codexConfigurationCoverage(schema, [{ path: "tools" }])).toEqual([
      "tools.*", "tools.*.[]", "tools.*.[].enabled", "tools.command",
    ]);
    const selectedSchema = structuredClone(codexConfigurationSchema("0.160.0"));
    selectedSchema.properties!.tui = { ...selectedSchema.properties!.tui as object, properties: { newly_supported: { type: "boolean" } } };
    expect(codexConfigurationCoverage(selectedSchema, codexConfigurationCatalog("0.160.0"))).toContain("tui.newly_supported");
    const changedEnum = structuredClone(codexConfigurationSchema("0.166.0"));
    changedEnum.properties!.web_search = { type: "string", enum: ["disabled", "cached", "live", "future"] };
    expect(codexConfigurationCoverage(changedEnum, codexConfigurationCatalog("0.166.0"))).toContain("web_search (enum changed)");
  });

  it("records recursive references once while retaining item and tuple paths", () => {
    const schema: CodexConfigurationSchema = {
      definitions: { Node: { properties: { next: { $ref: "#/definitions/Node" } } } },
      properties: { recursive: { $ref: "#/definitions/Node" }, tuple: { items: [{ type: "string" }, true] } },
    };
    expect([...inventoryCodexConfiguration(schema).keys()]).toEqual(["recursive", "recursive.next", "tuple", "tuple.[0]", "tuple.[1]"]);
    expect(() => inventoryCodexConfiguration({ $ref: "https://example.test/schema" })).toThrow("external");
    expect(() => inventoryCodexConfiguration({ $ref: "#/definitions/Absent" })).toThrow("Missing");
  });

  it("keeps literal secrets private while exposing environment and credential references", () => {
    for (const parts of [
      ["mcp_servers", "company", "env", "API_KEY"], ["mcp_servers", "company", "http_headers", "Authorization"],
      ["mcp_servers", "company", "oauth", "client_secret"], ["model_providers", "company", "experimental_bearer_token"],
      ["otel", "trace_exporter", "otlp-http", "headers", "Authorization"], ["shell_environment_policy", "set", "TOKEN"],
      ["profiles", "work", "features", "multi_agent_v2", "message_board_remote", "bearer_token"],
    ]) expect(isCodexProtectedPath(parts), parts.join(".")).toBe(true);
    for (const parts of [
      ["mcp_servers", "company", "bearer_token_env_var"], ["mcp_servers", "company", "env_http_headers", "Authorization"],
      ["model_providers", "company", "env_key"], ["model_providers", "company", "env_http_headers", "Authorization"],
      ["permissions", "work", "network", "mitm", "actions", "auth", "inject_request_headers", "0", "secret_env_var"],
    ]) expect(isCodexProtectedPath(parts), parts.join(".")).toBe(false);
  });

  it("exposes supported map and array fields without publishing unknown nested authentication keys", () => {
    expect(isCodexKnownPath(["model_providers", "company", "api_key"])).toBe(false);
    expect(isCodexKnownPath(["model_providers", "company", "env_key"])).toBe(true);
    expect(isCodexKnownPath(["model_providers", "company", "base_url", "extra"])).toBe(false);
    expect(isCodexKnownPath(["skills", "config", "0", "path"])).toBe(true);
    expect(isCodexKnownPath(["skills", "config", "0", "secret"])).toBe(false);
    expect(isCodexKnownPath(["model_post_turn_compact_threshold_percent"], "0.160.0")).toBe(true);
    expect(() => isCodexKnownPath(["model"], "0.163.0")).toThrow("no reviewed");
  });

  it.each(["0.160.0", "0.162.1", "0.166.0"] as CodexConfigurationVersion[])("recognizes arbitrary hook JSON descendants without opening typed tables for %s", version => {
    const input = ["hooks", "SessionStart", "0", "hooks", "0", "input"];
    for (const suffix of [["details", "name"], ["tags", "0"], ["records", "0", "nested", "0", "name"]])
      expect(isCodexKnownPath([...input, ...suffix], version), suffix.join(".")).toBe(true);
    for (const parts of [
      ["hooks", "SessionStart", "0", "hooks", "0", "unexpected", "name"],
      ["model_providers", "company", "base_url", "extra"],
      ["mcp_servers", "company", "env", "API_KEY", "nested"],
      ["tui", "unexpected", "name"],
    ]) expect(isCodexKnownPath(parts, version), parts.join(".")).toBe(false);
    expect(isCodexKnownPath(["desktop", "window", "geometry"], version)).toBe(true);
    expect(isCodexReadOnlyPath(["desktop", "window", "geometry"], version)).toBe(true);
    expect(isCodexProtectedPath(["mcp_servers", "company", "env", "API_KEY", "nested"])).toBe(true);
  });

  it.each(["0.160.0", "0.162.1", "0.166.0"] as CodexConfigurationVersion[])("retains ignored leaf deprecation independently of its feature stage for %s", version => {
    const catalog = codexConfigurationCatalog(version);
    expect(catalog.find(entry => entry.path === "features.multi_agent_v2")).toMatchObject({ status: "stable", editable: true });
    const ignored = catalog.find(entry => entry.path === "features.multi_agent_v2.usage_hint_enabled")!;
    expect(ignored).toMatchObject({ status: "deprecated", editable: false });
    expect(ignored.reason).toContain("ignored");
    expect(isCodexReadOnlyPath(ignored.path.split("."), version)).toBe(true);
    expect(catalog.find(entry => entry.path === "profiles.*.features.multi_agent_v2.usage_hint_enabled")).toMatchObject({ status: "deprecated", editable: false });
  });

  it.each(["0.160.0", "0.162.1", "0.166.0"] as CodexConfigurationVersion[])("labels each computer-use operating-system subtree for %s", version => {
    const catalog = codexConfigurationCatalog(version);
    for (const platform of ["macos", "windows"]) {
      const entries = catalog.filter(entry => entry.path === `computer_use.${platform}` || entry.path.startsWith(`computer_use.${platform}.`));
      expect(entries.length).toBeGreaterThan(1);
      for (const entry of entries) expect(entry.platform, entry.path).toBe(platform);
    }
    expect(catalog.find(entry => entry.path === "computer_use.default_app_access")).toMatchObject({ platform: "all" });
  });

  it("explains managed state and tracks native feature removal by CLI version", () => {
    expect(isCodexReadOnlyPath(["desktop", "window", "geometry"])).toBe(true);
    expect(isCodexReadOnlyPath(["hooks", "state", "hook", "trusted"])).toBe(true);
    expect(isCodexReadOnlyPath(["skills", "bundled", "enabled"])).toBe(true);
    expect(codexConfigurationCatalog().find(entry => entry.path === "profile")).toMatchObject({ editable: false, status: "deprecated" });
    expect(codexConfigurationCatalog().find(entry => entry.path === "profiles.*.model")).toMatchObject({ editable: false, status: "deprecated" });
    const experimental = codexConfigurationCatalog("0.160.0").find(entry => entry.path === "features.apply_patch_preserve_line_endings")!;
    const removed = codexConfigurationCatalog("0.162.1").find(entry => entry.path === experimental.path)!;
    expect(experimental).toMatchObject({ status: "experimental", editable: true });
    expect(removed).toMatchObject({ status: "deprecated", editable: false });
    expect(isCodexReadOnlyPath(experimental.path.split("."), "0.160.0")).toBe(false);
    expect(isCodexReadOnlyPath(removed.path.split("."), "0.162.1")).toBe(true);
  });

  it("distinguishes schema defaults, tagged native feature defaults, and model-dependent defaults", () => {
    const catalog = codexConfigurationCatalog();
    expect(catalog.find(entry => entry.path === "tui.alternate_screen")).toMatchObject({ default: "auto", defaultSource: "schema" });
    expect(catalog.find(entry => entry.path === "tui.resume_cwd")).toMatchObject({ defaultSource: "runtime" });
    expect(catalog.find(entry => entry.path === "features.shell_tool")).toMatchObject({ default: true, defaultSource: "native-feature" });
    expect(catalog.find(entry => entry.path === "model_context_window")).toMatchObject({ defaultSource: "runtime" });
    expect(catalog.find(entry => entry.path === "model_context_window")!.defaultDescription).toContain("model/provider");
    expect(catalog.find(entry => entry.path === "web_search")!.enum).toEqual(expect.arrayContaining(["disabled", "cached", "live"]));
  });

  it.each(["0.160.0", "0.162.1", "0.166.0"])("uses pinned loader and keymap defaults for %s without substituting another version", version => {
    const catalog = codexConfigurationCatalog(version);
    for (const [path, value] of [
      ["file_opener", "vscode"], ["web_search", "cached"],
      ["tui.keymap.global.copy", ["Ctrl+O"]], ["tui.keymap.global.open_external_editor", ["Ctrl+G"]],
      ["tui.keymap.composer.submit", ["Enter"]], ["tui.keymap.global.open_agents", []],
    ]) {
      const entry = catalog.find(entry => entry.path === path)!;
      expect(entry).toMatchObject({ default: value, defaultSource: "native-source" });
      expect(entry.defaultProvenance).toContain(`rust-v${version}/`);
      expect(entry.defaultDescription).toContain(version);
    }
    expect(catalog.find(entry => entry.path === "tui.keymap.editor.insert_newline")!.default).toEqual(["Ctrl+J", "Ctrl+M", "Enter", "Shift+Enter", "Alt+Enter"]);
    expect(catalog.find(entry => entry.path === "tui.keymap.chat.toggle_voice_mute")!.default).toEqual(version === "0.166.0" ? ["F9"] : ["Ctrl+X"]);
  });

  it("keeps saved context bindings and explicit unbinding above reusable global and inherited defaults", () => {
    const path = "tui.keymap.composer.submit";
    expect(codexKeymapSelection("0.160.0", path, {})).toMatchObject({ value: ["Enter"], source: "Inherited native 0.160.0 bindings" });
    expect(codexKeymapSelection("0.160.0", path, { tui: { keymap: { global: { submit: "ctrl-s" } } } })).toMatchObject({ value: "ctrl-s" });
    expect(codexKeymapSelection("0.160.0", path, { tui: { keymap: { global: { submit: "ctrl-s" }, composer: { submit: [] } } } })).toMatchObject({ value: [], source: "Saved composer override (explicitly unbound)" });
    expect(() => codexKeymapSelection("0.167.0", path, {})).toThrow("no reviewed");
  });

  it("reviews newer structured features, presets, credentials and typed path requirements only in their selected release", () => {
    const old = codexConfigurationCatalog("0.162.1");
    const current = codexConfigurationCatalog("0.166.0");
    for (const path of ["tui.presets.*.input", "hooks.PreModelRequest.[].hooks.[].command", "features.async_compaction.enabled", "features.runtime_agent_instances.mode", "model_providers.*.credential_file"]) {
      expect(old.find(entry => entry.path === path)).toBeUndefined();
      expect(current.find(entry => entry.path === path)).toBeDefined();
    }
    expect(current.find(entry => entry.path === "mcp_enterprise_managed_auth.idp.client_secret")).toMatchObject({ scope: "secret", editable: false });
    expect(codexConfigurationCliCatalog("0.166.0").find(entry => entry.path === "codex queue --resume")!.reason).toContain("outside CloudX tab ownership");
    expect(codexConfigurationCliCatalog("0.166.0").find(entry => entry.path === "codex doctor --network-only")!.reason).toContain("Native diagnostic");
    expect(isCodexProtectedPath(["mcp_enterprise_managed_auth", "idp", "client_secret"])).toBe(true);
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(codexConfigurationValidationSchema("0.166.0"));
    expect(validate({ features: { async_compaction: { enabled: false, model_async_compact_threshold_percent: 65 } }, tui: { presets: { "1": { input: "Explain the change", label: "Review" } } } })).toBe(true);
    expect(validate({ features: { async_compaction: { model_async_compact_threshold_percent: 101 } } })).toBe(false);
    expect(validate({ model_providers: { gcp: { credential_file: "relative-secret.json" } } })).toBe(false);
    expect(validate({ model_providers: { gcp: { credential_file: "/private/adc.json" } } })).toBe(true);
  });

  it.each(["0.160.0", "0.162.1", "0.166.0"] as CodexConfigurationVersion[])("validates native flattened permission maps and nested alternatives for %s", version => {
    const raw = codexConfigurationSchema(version);
    expect(raw.definitions!.PermissionsToml!.additionalProperties).toBeUndefined();
    const schema = codexConfigurationValidationSchema(version);
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validate = ajv.compile(schema);
    expect(validate({ permissions: { work: {
      description: "Workspace", filesystem: { "/tmp": "write", ":project_roots": { "/": "read" }, glob_scan_max_depth: 2 },
      workspace_roots: { "/project": true }, network: { enabled: true, mode: "limited", domains: { "example.com": "allow" } },
    } } })).toBe(true);
    for (const invalid of [
      { workspace_roots: { "/project": "yes" } }, { filesystem: { "/tmp": "execute" } }, { filesystem: { glob_scan_max_depth: 0 } },
      { network: { domains: { "example.com": true } } }, { network: { mode: "unrestricted" } }, { unexpected: true },
    ]) expect(validate({ permissions: { work: invalid } }), JSON.stringify(invalid)).toBe(false);
    expect(validate({ tui: { notifications: ["agent-turn-complete"], resume_cwd: "session" } })).toBe(true);
    expect(validate({ tui: { resume_cwd: "random" } })).toBe(false);
    expect(validate({ model_post_turn_compact_threshold_percent: 101 })).toBe(false);
    expect(validate({ model_post_turn_compact_threshold_percent: 100 })).toBe(true);
  });

  it.each(["0.160.0", "0.162.1", "0.166.0"] as CodexConfigurationVersion[])("classifies every pinned applicable launch flag for %s separately from persistent defaults", version => {
    const catalog = codexConfigurationCliCatalog(version);
    for (const [command, options] of Object.entries(CODEX_CONFIGURATION_CLI_OPTIONS[version])) {
      const help = options.map(option => `    --${option}`).join("\n");
      expect(codexConfigurationCliCoverage(help, command, catalog)).toEqual([]);
      expect(codexConfigurationCliCoverage(`${help}\n    --new-launch-option`, command, catalog)).toEqual([`${command} --new-launch-option`]);
    }
    expect(catalog.find(entry => entry.path === "codex resume --all")!.reason).toContain("explicit Resume scope");
    expect(catalog.find(entry => entry.path === "codex resume --include-non-interactive")!.reason).toContain("independent");
    expect(catalog.find(entry => entry.path === "codex --yolo")).toMatchObject({ aliasOf: "--dangerously-bypass-approvals-and-sandbox" });
    expect(catalog.find(entry => entry.path === "codex --model")!.aliases).toContain("-m");
    expect(catalog.find(entry => entry.path === "codex app-server --managed-daemon")).toMatchObject({ internal: true });
  });
});

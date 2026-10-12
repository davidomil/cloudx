import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  CODEX_CONFIGURATION_BASELINE_VERSION, CODEX_CONFIGURATION_CLI_OPTIONS, CODEX_CONFIGURATION_SCHEMAS, CODEX_CONFIGURATION_VERSIONS,
  codexConfigurationCatalog, codexConfigurationCliCatalog, codexConfigurationCliCoverage, codexConfigurationCoverage,
  codexConfigurationSchema, codexConfigurationValidationSchema, inventoryCodexConfiguration, isCodexKnownPath, isCodexProtectedPath, isCodexReadOnlyPath,
  type CodexConfigurationSchema, type CodexConfigurationVersion,
} from "./codexConfiguration.js";

describe("reviewed native Codex configuration", () => {
  it.each(["0.160.0", "0.162.1"] as CodexConfigurationVersion[])("covers every recursive schema path for %s without hiding an unmapped option", version => {
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

  it("pins the audited 102 families and refuses unreviewed CLI versions", () => {
    expect(CODEX_CONFIGURATION_BASELINE_VERSION).toBe("0.162.1");
    expect(codexConfigurationCatalog().filter(entry => entry.path === entry.family)).toHaveLength(102);
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

  it.each(["0.160.0", "0.162.1"] as CodexConfigurationVersion[])("validates native flattened permission maps and nested alternatives for %s", version => {
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

  it.each(["0.160.0", "0.162.1"] as CodexConfigurationVersion[])("classifies every pinned applicable launch flag for %s separately from persistent defaults", version => {
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

import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { resolveCodexConfigurationPaths } from "./CodexConfigurationPaths.js";

const source = path.resolve("/source/codex");
const userHome = path.resolve("/home/native-user");

describe("materialized native configuration paths", () => {
  it("keeps all schema-typed paths relative to the defining config home, including maps and arrays", () => {
    const config = parse(`
model_catalog_json = "./models.json"
model_instructions_file = "prompts/../instructions.md"
experimental_compact_prompt_file = "../compact.md"
sqlite_home = "state"
log_dir = "logs"
[agents.reviewer]
config_file = "agents/reviewer.toml"
[mcp_servers.company]
cwd = "../mcp"
[model_providers.company.auth]
command = "token-provider"
cwd = "auth"
[skills]
config = [{path="skills/custom/SKILL.md",enabled=true}]
[sandbox_workspace_write]
writable_roots = ["../work", "../other"]
[otel.exporter.otlp-http.tls]
ca-certificate = "certs/ca.pem"
`);
    expect(resolveCodexConfigurationPaths(config, source, userHome)).toMatchObject({
      model_catalog_json: path.join(source, "models.json"), model_instructions_file: path.join(source, "instructions.md"),
      experimental_compact_prompt_file: path.resolve(source, "../compact.md"),
      sqlite_home: path.join(source, "state"), log_dir: path.join(source, "logs"),
      agents: { reviewer: { config_file: path.join(source, "agents/reviewer.toml") } },
      mcp_servers: { company: { cwd: path.resolve(source, "../mcp") } },
      model_providers: { company: { auth: { command: "token-provider", cwd: path.join(source, "auth") } } },
      skills: { config: [{ path: path.join(source, "skills/custom/SKILL.md"), enabled: true }] },
      sandbox_workspace_write: { writable_roots: [path.resolve(source, "../work"), path.resolve(source, "../other")] },
      otel: { exporter: { "otlp-http": { tls: { "ca-certificate": path.join(source, "certs/ca.pem") } } } },
    });
    expect(config.model_catalog_json).toBe("./models.json");
  });

  it("expands native home references using HOME, independently of CODEX_HOME", () => {
    const config = parse('model_catalog_json="~//models.json"\nmodel_instructions_file="~"\nlog_dir="~/logs"\n');
    expect(resolveCodexConfigurationPaths(config, source, userHome)).toMatchObject({
      model_catalog_json: path.join(userHome, "models.json"), model_instructions_file: userHome, log_dir: path.join(userHome, "logs"),
    });
  });

  it("preserves absolute paths, unknown data and command-relative strings while normalizing profile file layers identically", () => {
    const config = parse(`
model_instructions_file = "${path.join(userHome, "instructions.md")}"
notify = ["./notify", "~/literal-argument"]
[mcp_servers.company]
command = "./mcp"
args = ["../argument"]
env = { TOKEN = "~/secret" }
[permissions.work.filesystem]
":project_roots" = { "./src" = "read" }
[unrecognized]
path = "./preserved"
`);
    const resolved = resolveCodexConfigurationPaths(config, source, userHome);
    expect(resolved).toEqual(config);
    expect(resolveCodexConfigurationPaths(parse('model_catalog_json="models.json"'), source, userHome).model_catalog_json).toBe(path.join(source, "models.json"));
  });

  it("refuses ambiguous relative path origins", () => {
    expect(() => resolveCodexConfigurationPaths({}, "relative", userHome)).toThrow("absolute directories");
    expect(() => resolveCodexConfigurationPaths({}, source, "relative")).toThrow("absolute directories");
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateNativeCodexConfiguration } from "./CodexConfigurationProbe.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-capabilities-test-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function model(name: string, efforts = ["low"], defaultEffort = efforts[0] ?? "none") {
  return { model: name, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: defaultEffort, supportsPersonality: false };
}

async function validate(config: string, models: ReturnType<typeof model>[], previous: Record<string, unknown> = { model: "previous-model" }, options: { catalog?: unknown; inspection?: string; signal?: AbortSignal; remoteCatalog?: boolean } = {}) {
  const command = path.join(root, "codex");
  const calls = path.join(root, "calls.json");
  const catalog = options.catalog ?? { models: models.map(item => ({ slug: item.model,
    default_reasoning_level: item.defaultReasoningEffort === "none" ? null : item.defaultReasoningEffort,
    supported_reasoning_levels: item.supportedReasoningEfforts.map(item => ({ effort: item.reasoningEffort })) })) };
  await fs.writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv[2] === "debug") {
  fs.writeFileSync(${JSON.stringify(path.join(root, "inspection.json"))}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), config: fs.readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8") }));
  const behavior = ${JSON.stringify(options.inspection)};
  if (behavior === "error") { console.error("Synthetic private diagnostic."); process.exit(1); }
  if (behavior === "blocked") { setInterval(() => {}, 1000); }
  else if (behavior === "oversized") process.stdout.write("x".repeat(2097153), () => process.exit(0));
  else console.log(${JSON.stringify(typeof catalog === "string" ? catalog : JSON.stringify(catalog))});
  if (behavior !== "blocked" && behavior !== "oversized") process.exit(0);
  return;
}
const calls = [];
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  calls.push(request.method);
  fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));
  if (request.method === "initialized") return;
  const results = {
    initialize: {},
    "config/read": { config: {}, origins: {}, layers: null },
    "model/list": { data: ${JSON.stringify(models)} },
    "collaborationMode/list": { data: [{ mode: "plan", reasoning_effort: "medium" }] }
  };
  if (!Object.hasOwn(results, request.method)) throw new Error("Unexpected native validation request.");
  console.log(JSON.stringify({ id: request.id, result: results[request.method] }));
});
`, { mode: 0o700 });
  const catalogConfig = options.remoteCatalog || parse(config).model_catalog_json !== undefined ? config : `model_catalog_json="models.json"\n${config}`;
  return validateNativeCodexConfiguration(command, catalogConfig, { PATH: process.env.PATH }, options.signal, undefined,
    options.remoteCatalog ? previous : { model_catalog_json: "models.json", ...previous }, false);
}

describe("native model identity rules", () => {
  it("uses the longest catalog prefix for a versioned model identifier", async () => {
    await expect(validate('model="gpt-6.1-sol-preview"\nmodel_reasoning_effort="high"', [model("gpt-6"), model("gpt-6.1-sol", ["high"])]))
      .resolves.toBeUndefined();
  });

  it.each(["vendor", "Vendor_2", "vendor-name"])("resolves the single %s namespace without rewriting the requested model", async namespace => {
    await expect(validate(`model="${namespace}/gpt-6.1-sol-preview"\nmodel_reasoning_effort="high"`, [model("gpt-6"), model("gpt-6.1-sol", ["high"])]))
      .resolves.toBeUndefined();
  });

  it("prefers direct provider-specific metadata over canonical suffix metadata", async () => {
    await expect(validate('model="vendor/gpt-6.1-sol-preview"\nmodel_reasoning_effort="high"', [model("gpt-6.1-sol"), model("vendor/gpt-6", ["high"])]))
      .resolves.toBeUndefined();
  });

  it("keeps the first metadata entry when matching prefixes have equal length", async () => {
    await expect(validate('model="gpt-6.1-sol-preview"\nmodel_reasoning_effort="high"', [model("gpt-6.1-sol", ["high"]), model("gpt-6.1-sol")]))
      .resolves.toBeUndefined();
  });

  it.each(["vendor.name/gpt-6.1-sol", "vendor name/gpt-6.1-sol", "véndor/gpt-6.1-sol", "/gpt-6.1-sol", "vendor/group/gpt-6.1-sol", "vendor/unknown", "gpt"])("does not invent canonical metadata for %s", async requested => {
    await expect(validate(`model=${JSON.stringify(requested)}`, [model("gpt-6.1-sol")])).rejects.toThrow(/capabilities.*not advertised/);
  });

  it("still rejects an unsupported explicit effort after resolving a namespace", async () => {
    await expect(validate('model="vendor/gpt-6.1-sol"\nmodel_reasoning_effort="banana"', [model("gpt-6.1-sol")]))
      .rejects.toThrow(/chosen reasoning effort/);
  });
});

describe("absent native reasoning defaults", () => {
  it("accepts the inherited none sentinel and leaves the future Plan mode independent", async () => {
    await expect(validate('model="no-reasoning"', [model("no-reasoning", [])])).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(root, "calls.json"), "utf8"))).not.toContain("collaborationMode/list");
  });

  it("can remove an explicit main override to inherit no main effort", async () => {
    await expect(validate('model="no-reasoning"', [model("no-reasoning", [])], { model: "no-reasoning", model_reasoning_effort: "low" }))
      .resolves.toBeUndefined();
  });

  it.each(["none", "low", "banana"])("rejects explicit main effort %s when no effort is advertised", async effort => {
    await expect(validate(`model="no-reasoning"\nmodel_reasoning_effort=${JSON.stringify(effort)}`, [model("no-reasoning", [])])).rejects.toThrow(/chosen reasoning effort/);
  });

  it.each(["none", "low", "banana"])("rejects explicit Plan effort %s independently of the absent main default", async effort => {
    await expect(validate(`model="no-reasoning"\nplan_mode_reasoning_effort=${JSON.stringify(effort)}`, [model("no-reasoning", [])])).rejects.toThrow(/chosen Plan reasoning effort/);
  });

  it("rejects an unsupported inherited Plan preset after removing its explicit override", async () => {
    await expect(validate('model="no-reasoning"', [model("no-reasoning", [])], { model: "no-reasoning", plan_mode_reasoning_effort: "low" }))
      .rejects.toThrow(/inherited Plan reasoning effort/);
  });

  it("accepts an advertised Plan preset after unsetting its override without imposing main effort", async () => {
    await expect(validate('model="optional-reasoning"', [model("optional-reasoning", ["medium"], "none")], { model: "optional-reasoning", plan_mode_reasoning_effort: "low" }))
      .resolves.toBeUndefined();
  });
});

describe("optional native main defaults", () => {
  it("rejects a literal none default that is not a supported effort", async () => {
    await expect(validate('model="literal-none"', [model("literal-none", ["low"], "none")], undefined,
      { catalog: { models: [{ slug: "literal-none", default_reasoning_level: "none", supported_reasoning_levels: [{ effort: "low" }] }] } }))
      .rejects.toThrow(/chosen reasoning effort/);
  });

  it("accepts a supported literal none default as an effort", async () => {
    await expect(validate('model="literal-none"', [model("literal-none", ["none"], "none")], undefined,
      { catalog: { models: [{ slug: "literal-none", default_reasoning_level: "none", supported_reasoning_levels: [{ effort: "none" }] }] } }))
      .resolves.toBeUndefined();
  });

  it.each([null, undefined])("accepts the absent %s raw default independently of supported low effort", async defaultEffort => {
    await expect(validate('model="optional-low"', [model("optional-low", ["low"], "none")], undefined,
      { catalog: { models: [{ slug: "optional-low", default_reasoning_level: defaultEffort, supported_reasoning_levels: [{ effort: "low" }] }] } }))
      .resolves.toBeUndefined();
  });

  it.each([{ efforts: [] }, { efforts: ["none"] }])("uses original raw order when picker priority advertises duplicate efforts %j", async ({ efforts }) => {
    await expect(validate('model="duplicate"', [model("duplicate", efforts, "none"), model("duplicate", ["low"], "none")], undefined,
      { catalog: { models: [
        { slug: "duplicate", default_reasoning_level: "none", supported_reasoning_levels: [{ effort: "low" }], priority: 10 },
        { slug: "duplicate", default_reasoning_level: null, supported_reasoning_levels: [], priority: 0 }
      ] } })).rejects.toThrow(/chosen reasoning effort/);
  });

  it("rejects raw model identity that differs from the advertised metadata", async () => {
    await expect(validate('model="version-preview"', [model("version", [], "none")], undefined,
      { catalog: { models: [{ slug: "version-preview", supported_reasoning_levels: [] }] } })).rejects.toThrow(/capabilities.*not advertised/);
  });

  it("limits custom-catalog inspection to its descriptor without user integrations or provider authentication", async () => {
    await expect(validate('model="optional"\nmodel_catalog_json="models.json"\n[mcp_servers.private]\ncommand="synthetic-tool"\n[model_providers.private]\nhttp_headers={Authorization="synthetic-secret"}', [model("optional", [])]))
      .resolves.toBeUndefined();
    const inspection = JSON.parse(await fs.readFile(path.join(root, "inspection.json"), "utf8"));
    expect(inspection.args).toEqual(["debug", "models"]);
    expect(parse(inspection.config)).toEqual({ model_catalog_json: "models.json" });
  });

  it("rejects an ambiguous provider default without substituting bundled metadata for the same model", async () => {
    await expect(validate('model="gpt-6.1-sol"', [model("gpt-6.1-sol", ["low"], "none")], undefined, { remoteCatalog: true }))
      .rejects.toThrow(/does not distinguish.*Configure model_catalog_json/);
    await expect(fs.access(path.join(root, "inspection.json"))).rejects.toThrow();
  });

  it("accepts a supported explicit effort when the provider default is ambiguous", async () => {
    await expect(validate('model="gpt-6.1-sol"\nmodel_reasoning_effort="low"', [model("gpt-6.1-sol", ["low"], "none")], undefined, { remoteCatalog: true }))
      .resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "inspection.json"))).rejects.toThrow();
  });

  it("can select a provider model that supports its inherited none without a local descriptor", async () => {
    await expect(validate('model="gpt-6.1-sol-preview"', [model("gpt-6.1-sol", ["none"], "none")], undefined, { remoteCatalog: true }))
      .resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "inspection.json"))).rejects.toThrow();
  });

  it("can unset a main override when the provider supports inherited none without a local descriptor", async () => {
    await expect(validate('model="gpt-6.1-sol-preview"', [model("gpt-6.1-sol", ["none"], "none")],
      { model: "gpt-6.1-sol-preview", model_reasoning_effort: "none" }, { remoteCatalog: true })).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "inspection.json"))).rejects.toThrow();
  });

  it("still validates Plan effort when the provider supports inherited main none", async () => {
    await expect(validate('model="gpt-6.1-sol-preview"\nplan_mode_reasoning_effort="low"', [model("gpt-6.1-sol", ["none"], "none")], undefined, { remoteCatalog: true }))
      .rejects.toThrow(/chosen Plan reasoning effort/);
    await expect(fs.access(path.join(root, "inspection.json"))).rejects.toThrow();
  });

  it.each(["not-json", {}, { models: [{ slug: "optional", default_reasoning_level: 42, supported_reasoning_levels: [] }] }])("rejects malformed native metadata %j", async catalog => {
    await expect(validate('model="optional"', [model("optional", [])], undefined, { catalog })).rejects.toThrow(/could not inspect native model defaults/);
  });

  it("does not publish private native diagnostics when inspection fails", async () => {
    await expect(validate('model="optional"', [model("optional", [])], undefined, { inspection: "error" })).rejects.toThrow("Selected Codex could not inspect native model defaults.");
  });

  it("bounds native metadata output", async () => {
    await expect(validate('model="optional"', [model("optional", [])], undefined, { inspection: "oversized" })).rejects.toThrow(/metadata response exceeded/);
  });

  it("cancels and reaps a blocked metadata inspector before returning", async () => {
    const controller = new AbortController();
    const validating = validate('model="optional"', [model("optional", [])], undefined, { inspection: "blocked", signal: controller.signal });
    const rejected = expect(validating).rejects.toThrow(/validation cancelled/);
    await expect.poll(async () => fs.readFile(path.join(root, "inspection.json"), "utf8").catch(() => "")).not.toBe("");
    const { pid } = JSON.parse(await fs.readFile(path.join(root, "inspection.json"), "utf8"));
    controller.abort();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("reaps a metadata inspector that exceeds its deadline", async () => {
    const validating = validate('model="optional"', [model("optional", [])], undefined, { inspection: "blocked" });
    const rejected = expect(validating).rejects.toThrow(/inspect native model defaults within 10 seconds/);
    await expect.poll(async () => fs.readFile(path.join(root, "inspection.json"), "utf8").catch(() => "")).not.toBe("");
    const { pid } = JSON.parse(await fs.readFile(path.join(root, "inspection.json"), "utf8"));
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);
});

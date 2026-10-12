import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateNativeCodexConfiguration } from "./CodexConfigurationProbe.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-capabilities-test-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function model(name: string, efforts = ["low"], defaultEffort = efforts[0] ?? "none") {
  return { model: name, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: defaultEffort, supportsPersonality: false };
}

async function validate(config: string, models: unknown[], previous: Record<string, unknown> = { model: "previous-model" }) {
  const command = path.join(root, "codex");
  const calls = path.join(root, "calls.json");
  await fs.writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
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
  return validateNativeCodexConfiguration(command, config, { PATH: process.env.PATH }, undefined, undefined, previous, false);
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

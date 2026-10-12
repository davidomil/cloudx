import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { parse } from "smol-toml";
import type { WorkspaceTab } from "@cloudx/shared";
import type { PluginSession } from "@cloudx/plugin-api";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexSettingsService } from "./CodexSettingsService.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { completedVerificationTurn, readVerificationTranscript } from "./CodexVerificationTranscript.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;
const answer = "The saved native configuration completed this isolated turn.";
const tui = { resume_cwd: "current", notifications: false, animations: false };
const instructions = "Use the instructions file from the original isolated Codex home.";

it.skipIf(!codex).each(["tab", "Forge worker"])("saved configuration reaches a new native %s while an existing session keeps its launch defaults", async role => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: {
      model_verbosity: "low", model_reasoning_summary: "concise", tui
    } });
    expect(selected.configuration?.selectedVersion).toMatch(/^0\.(160\.0|162\.1)$/u);
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ text: { verbosity: "low" }, reasoning: { summary: "concise" } });
    expect(parse(await fs.readFile(fixture.overlayConfigPath, "utf8"))).toMatchObject({ tui });

    await fixture.settings.update({ expectedRevision: selected.revision, nativeOptions: { model_verbosity: "high", model_reasoning_summary: "detailed" } });
    await fixture.completeTurn();
    expect(fixture.requests[1]).toMatchObject({ text: { verbosity: "low" }, reasoning: { summary: "concise" } });

    await fixture.launch(role === "Forge worker");
    const completed = await fixture.completeTurn();
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests[2]).toMatchObject({ text: { verbosity: "high" }, reasoning: { summary: "detailed" } });
    const persisted = parse(await fs.readFile(path.join(fixture.home, "config.toml"), "utf8"));
    expect(persisted).toMatchObject({ model_verbosity: "high", model_reasoning_summary: "detailed", tui });
    expect(persisted).not.toHaveProperty("profile");
    expect(parse(await fs.readFile(fixture.overlayConfigPath, "utf8"))).toMatchObject({ tui });
    if (role === "Forge worker") {
      expect(fixture.requests[2]).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "xhigh" } });
      await expect.poll(async () => JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")), { timeout: 5_000 })
        .toMatchObject({ status: "completed", threadId: completed.threadId, turnId: completed.turnId });
      await fixture.session!.handleAction("finish", { threadId: completed.threadId, turnId: completed.turnId });
      expect(fixture.session!.snapshot().status).toBe("completed");
    }
  } finally { await fixture.dispose(); }
}, 50_000);

it.skipIf(!codex)("rejects schema-listed legacy profile selection before modifying shared configuration", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    const configPath = path.join(fixture.home, "config.toml");
    const text = await fs.readFile(configPath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: original.revision, nativeOptions: {
      profiles: { writing: { model_verbosity: "low" } }, profile: "writing"
    } })).rejects.toThrow(/profile|selected Codex/iu);
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
  } finally { await fixture.dispose(); }
}, 15_000);

it.skipIf(!codex)("native profile files override shared defaults and trusted project values override the selected profile", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model_verbosity: "low", model_reasoning_summary: "concise" } });
    const profilePath = path.join(fixture.home, "writing.config.toml");
    await fs.writeFile(profilePath, "# Selected native profile\n");
    const profile = await fixture.settings.read(undefined, "writing");
    expect(profile.configuration).toMatchObject({ targetProfile: "writing", sourcePath: profilePath });
    await fixture.settings.update({ expectedRevision: profile.revision, targetProfile: "writing", nativeOptions: { model_verbosity: "high", model_reasoning_summary: "detailed" } });
    const shared = await fixture.settings.read();
    await fixture.settings.update({ expectedRevision: shared.revision, configProfile: "writing" });
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ text: { verbosity: "high" }, reasoning: { summary: "detailed" } });

    const currentProfile = await fixture.settings.read(undefined, "writing");
    await fixture.settings.update({ expectedRevision: currentProfile.revision, targetProfile: "writing", nativeOptions: { model_verbosity: "medium" } });
    await fixture.completeTurn();
    expect(fixture.requests[1]).toMatchObject({ text: { verbosity: "high" }, reasoning: { summary: "detailed" } });
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[2]).toMatchObject({ text: { verbosity: "medium" }, reasoning: { summary: "detailed" } });
    expect(parse(await fs.readFile(path.join(path.dirname(fixture.overlayConfigPath), "writing.config.toml"), "utf8"))).toMatchObject({ model_verbosity: "medium" });

    await fs.mkdir(path.join(fixture.root, ".codex"));
    await fs.writeFile(path.join(fixture.root, ".codex", "config.toml"), 'model_verbosity = "low"\n');
    await fixture.launch(true);
    const completed = await fixture.completeTurn();
    expect(fixture.requests[3]).toMatchObject({ text: { verbosity: "low" }, reasoning: { summary: "detailed", effort: "xhigh" } });
    await expect.poll(async () => JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")), { timeout: 5_000 })
      .toMatchObject({ status: "completed", threadId: completed.threadId, turnId: completed.turnId });
    await fixture.session!.handleAction("finish", { threadId: completed.threadId, turnId: completed.turnId });
    expect(fixture.session!.snapshot().status).toBe("completed");
    expect(parse(await fs.readFile(profilePath, "utf8"))).toMatchObject({ model_verbosity: "medium", model_reasoning_summary: "detailed" });
    expect((await fixture.settings.read()).configuration!.values.model_verbosity).toBe("low");
  } finally { await fixture.dispose(); }
}, 60_000);

it.skipIf(!codex).each(["tab", "Forge worker"])("relative model catalog and instructions paths survive save validation and a native %s launch", async role => {
  const fixture = await NativeConfigurationSession.create({ relativePaths: true });
  try {
    const original = await fixture.settings.read();
    await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model_verbosity: "high", model_reasoning_summary: "detailed" } });
    const source = await fs.readFile(path.join(fixture.home, "config.toml"), "utf8");
    expect(source).toContain('model_catalog_json = "models.json"');
    expect(source).toContain('model_instructions_file = "instructions.md"');
    await fixture.launch(role === "Forge worker");
    const completed = await fixture.completeTurn();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ text: { verbosity: "high" }, reasoning: { summary: "detailed" } });
    expect(JSON.stringify(fixture.requests[0])).toContain(instructions);
    expect(parse(await fs.readFile(fixture.overlayConfigPath, "utf8"))).toMatchObject({
      model_catalog_json: path.join(fixture.home, "models.json"), model_instructions_file: path.join(fixture.home, "instructions.md")
    });
    if (role === "Forge worker") {
      await expect.poll(async () => JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")), { timeout: 5_000 })
        .toMatchObject({ status: "completed", threadId: completed.threadId, turnId: completed.turnId });
      await fixture.session!.handleAction("finish", { threadId: completed.threadId, turnId: completed.turnId });
      expect(fixture.session!.snapshot().status).toBe("completed");
    }
    expect(await fs.readFile(path.join(fixture.home, "config.toml"), "utf8")).toBe(source);
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex)("rejects reasoning effort missing from the selected native model capabilities without changing the source", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model_reasoning_effort: "low" } });
    expect(selected.configuration!.values.model_reasoning_effort).toBe("low");
    const configPath = path.join(fixture.home, "config.toml");
    const text = await fs.readFile(configPath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: selected.revision, nativeOptions: { model_reasoning_effort: "banana" } }))
      .rejects.toThrow("Selected model does not advertise the chosen reasoning effort.");
    await expect(fixture.settings.update({ expectedRevision: selected.revision, reasoningEffort: "none" }))
      .rejects.toThrow("Selected model does not advertise the chosen reasoning effort.");
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
  } finally { await fixture.dispose(); }
}, 15_000);

it.skipIf(!codex)("rejects unsupported Plan effort and an unset that would expose the native Plan preset", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { plan_mode_reasoning_effort: "low" } });
    const configPath = path.join(fixture.home, "config.toml");
    const text = await fs.readFile(configPath, "utf8");
    for (const effort of ["banana", null]) {
      await expect(fixture.settings.update({ expectedRevision: selected.revision, nativeOptions: { plan_mode_reasoning_effort: effort } }))
        .rejects.toThrow(/Plan reasoning effort/);
      expect(await fs.readFile(configPath, "utf8")).toBe(text);
    }
    await fixture.launch();
    await fixture.enterPlanMode();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ reasoning: { effort: "low" } });
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex).each(["model_reasoning_effort", "plan_mode_reasoning_effort"])("rejects clearing a profile that masks an unsupported base %s", async key => {
  const fixture = await NativeConfigurationSession.create();
  try {
    await fs.writeFile(path.join(fixture.home, "writing.config.toml"), 'model_reasoning_effort="low"\nplan_mode_reasoning_effort="low"\n');
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, configProfile: "writing" });
    const saved = await fixture.settings.update({ expectedRevision: selected.revision, nativeOptions: { [key]: "banana" } });
    expect(saved.configuration?.effectiveValues[key]).toBe("low");
    const configPath = path.join(fixture.home, "config.toml");
    const text = await fs.readFile(configPath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: saved.revision, configProfile: null })).rejects.toThrow(/reasoning effort/);
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
    await fixture.launch();
    if (key === "plan_mode_reasoning_effort") await fixture.enterPlanMode();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ reasoning: { effort: "low" } });
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex).each(["model_reasoning_effort", "plan_mode_reasoning_effort"])("rejects unsetting a profile %s that masks an unsupported base value", async key => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const configPath = path.join(fixture.home, "config.toml");
    await fs.writeFile(configPath, `${key}="banana"\n${await fs.readFile(configPath, "utf8")}`);
    const profilePath = path.join(fixture.home, "writing.config.toml");
    await fs.writeFile(profilePath, 'model_reasoning_effort="low"\nplan_mode_reasoning_effort="low"\n');
    const original = await fixture.settings.read();
    await fixture.settings.update({ expectedRevision: original.revision, configProfile: "writing" });
    const profile = await fixture.settings.read(undefined, "writing");
    const text = await fs.readFile(profilePath, "utf8");
    const base = await fs.readFile(configPath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: profile.revision, targetProfile: "writing", nativeOptions: { [key]: null } })).rejects.toThrow(/reasoning effort/);
    expect(await fs.readFile(profilePath, "utf8")).toBe(text);
    expect(await fs.readFile(configPath, "utf8")).toBe(base);
  } finally { await fixture.dispose(); }
}, 15_000);

it.skipIf(!codex).each(["model_reasoning_effort", "plan_mode_reasoning_effort"])("rejects selecting a profile with an unsupported %s", async key => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const configPath = path.join(fixture.home, "config.toml");
    const profilePath = path.join(fixture.home, "writing.config.toml");
    await fs.writeFile(profilePath, `model_reasoning_effort="low"\nplan_mode_reasoning_effort="low"\n`.replace(`${key}="low"`, `${key}="banana"`));
    const original = await fixture.settings.read();
    const base = await fs.readFile(configPath, "utf8");
    const profile = await fs.readFile(profilePath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: original.revision, configProfile: "writing" })).rejects.toThrow(/reasoning effort/);
    expect(await fs.readFile(configPath, "utf8")).toBe(base);
    expect(await fs.readFile(profilePath, "utf8")).toBe(profile);
  } finally { await fixture.dispose(); }
}, 15_000);

it.skipIf(!codex)("unsetting main effort inherits the advertised model default without changing Plan effort", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model_reasoning_effort: "xhigh", plan_mode_reasoning_effort: "low" } });
    const saved = await fixture.settings.update({ expectedRevision: selected.revision, reasoningEffort: null });
    expect(saved.configuration?.values).not.toHaveProperty("model_reasoning_effort");
    expect(saved.configuration?.values.plan_mode_reasoning_effort).toBe("low");
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ reasoning: { effort: "low" } });
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex)("unsetting Plan effort uses its advertised native preset independently of main effort", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const catalogPath = path.join(fixture.home, "models.json");
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    catalog.models[0].supported_reasoning_levels.push({ effort: "medium", description: "medium" });
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model_reasoning_effort: "xhigh", plan_mode_reasoning_effort: "low" } });
    const saved = await fixture.settings.update({ expectedRevision: selected.revision, nativeOptions: { plan_mode_reasoning_effort: null } });
    expect(saved.configuration?.values).not.toHaveProperty("plan_mode_reasoning_effort");
    expect(saved.configuration?.values.model_reasoning_effort).toBe("xhigh");
    await fixture.launch();
    await fixture.enterPlanMode();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ reasoning: { effort: "medium" } });
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex).each(["model_reasoning_effort", "plan_mode_reasoning_effort"])("rejects a model change that would make %s unsupported", async key => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const catalogPath = path.join(fixture.home, "models.json");
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    catalog.models.push({ ...catalog.models[0], slug: "gpt-6-sol", supported_reasoning_levels: [{ effort: "low", description: "low" }] });
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model_reasoning_effort: "low", plan_mode_reasoning_effort: "low", [key]: "xhigh" } });
    const configPath = path.join(fixture.home, "config.toml");
    const text = await fs.readFile(configPath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: selected.revision, model: "gpt-6-sol" })).rejects.toThrow(/reasoning effort/);
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
  } finally { await fixture.dispose(); }
}, 15_000);

it.skipIf(!codex)("unsetting model validates the CloudX launch default when the native catalog prefers another model", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const catalogPath = path.join(fixture.home, "models.json");
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    catalog.models.unshift({ ...catalog.models[0], slug: "custom-native-default", default_reasoning_level: "xhigh" });
    catalog.models[1].priority = 1;
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    const configPath = path.join(fixture.home, "config.toml");
    await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace('model = "gpt-6.1-sol"', 'model = "custom-native-default"'));
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { plan_mode_reasoning_effort: "low" } });
    const text = await fs.readFile(configPath, "utf8");
    await fs.writeFile(catalogPath, JSON.stringify({ models: [catalog.models[0]] }));
    await expect(fixture.settings.update({ expectedRevision: selected.revision, model: null })).rejects.toThrow(/capabilities.*not advertised/);
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    const saved = await fixture.settings.update({ expectedRevision: selected.revision, model: null });
    expect(saved.configuration?.values).not.toHaveProperty("model");
    expect(saved.configuration?.effectiveValues.model).toBe("gpt-6.1-sol");
    expect(saved.configuration?.overrides.some(value => value.includes("CloudX launch default"))).toBe(true);
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "low" } });
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex)("an ignored personality in a profile does not suppress effective effort validation or block native launch", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const profilePath = path.join(fixture.home, "writing.config.toml");
    const profile = 'personality="friendly"\nmodel_reasoning_effort="low"\nplan_mode_reasoning_effort="low"\n';
    await fs.writeFile(profilePath, profile);
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, configProfile: "writing" });
    const configPath = path.join(fixture.home, "config.toml");
    const base = await fs.readFile(configPath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: selected.revision, nativeOptions: { plan_mode_reasoning_effort: "banana" }, configProfile: null })).rejects.toThrow(/Plan reasoning effort/);
    expect(await fs.readFile(configPath, "utf8")).toBe(base);
    expect(await fs.readFile(profilePath, "utf8")).toBe(profile);
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ reasoning: { effort: "low" } });
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex)("nested arbitrary MCP hook input survives native save, read and reload", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const input = { details: { name: "start" }, tags: ["a", "b"], records: [{ nested: [true, { count: 2 }] }] };
    const hooks = { SessionStart: [{ hooks: [{ type: "mcp_tool", server: "local", tool: "start", input }] }] };
    const original = await fixture.settings.read();
    const saved = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { hooks } });
    expect(saved.configuration?.values.hooks).toEqual(hooks);
    expect((await fixture.settings.read()).configuration?.values.hooks).toEqual(hooks);
    const next = structuredClone(hooks);
    next.SessionStart[0]!.hooks[0]!.input.details.name = "reloaded";
    const reloaded = await fixture.settings.update({ expectedRevision: saved.revision, nativeOptions: { hooks: next } });
    expect(reloaded.configuration?.values.hooks).toEqual(next);
    expect(parse(await fs.readFile(path.join(fixture.home, "config.toml"), "utf8")).hooks).toEqual(next);
  } finally { await fixture.dispose(); }
}, 15_000);

it.skipIf(!codex).each(["base", "selected profile"])("rejects a same-name legacy table from the %s before selecting a separate launch profile", async location => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const configPath = path.join(fixture.home, "config.toml");
    const profilePath = path.join(fixture.home, "writing.config.toml");
    await fs.writeFile(profilePath, 'model_verbosity="high"\n');
    await fs.appendFile(location === "base" ? configPath : profilePath, '# Keep this legacy table unchanged.\n[profiles.writing]\nmodel_verbosity="low"\n');
    const original = await fixture.settings.read();
    const text = await fs.readFile(configPath, "utf8");
    const profile = await fs.readFile(profilePath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: original.revision, configProfile: "writing" })).rejects.toThrow(/legacy.*profiles\.writing/);
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
    expect(await fs.readFile(profilePath, "utf8")).toBe(profile);
    expect((await fixture.settings.read()).revision).toBe(original.revision);
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests).toHaveLength(1);
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex).each(["base", "selected profile"])("an unrelated legacy table in the %s does not block a separate native launch profile", async location => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const configPath = path.join(fixture.home, "config.toml");
    const profilePath = path.join(fixture.home, "writing.config.toml");
    await fs.writeFile(profilePath, 'model_verbosity="high"\n');
    const legacyPath = location === "base" ? configPath : profilePath;
    await fs.appendFile(legacyPath, '[profiles.other]\nmodel_verbosity="low" # keep unrelated legacy content\n');
    const original = await fixture.settings.read();
    await fixture.settings.update({ expectedRevision: original.revision, configProfile: "writing" });
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ text: { verbosity: "high" } });
    expect(await fs.readFile(legacyPath, "utf8")).toContain('# keep unrelated legacy content');
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex)("a namespaced model uses native canonical metadata without an exact catalog entry", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const configPath = path.join(fixture.home, "config.toml");
    await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace(/^model_catalog_json = .*\n/m, ""));
    const original = await fixture.settings.read();
    const saved = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model: "vendor/gpt-6.1-sol" } });
    expect(saved.configuration?.values.model).toBe("vendor/gpt-6.1-sol");
    expect(saved.configuration?.values).not.toHaveProperty("model_catalog_json");
    const text = await fs.readFile(configPath, "utf8");
    for (const key of ["model_reasoning_effort", "plan_mode_reasoning_effort"]) {
      await expect(fixture.settings.update({ expectedRevision: saved.revision, nativeOptions: { [key]: "banana" } })).rejects.toThrow(/reasoning effort/);
      expect(await fs.readFile(configPath, "utf8")).toBe(text);
    }
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ model: "vendor/gpt-6.1-sol", reasoning: { effort: "low" } });
    expect(parse(await fs.readFile(fixture.overlayConfigPath, "utf8")).model).toBe("vendor/gpt-6.1-sol");
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex)("an advertised model with no default main reasoning effort saves and completes a default-mode turn", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const catalogPath = path.join(fixture.home, "models.json");
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    catalog.models.push({ ...catalog.models[0], slug: "local-no-reasoning", default_reasoning_level: null, supported_reasoning_levels: [] });
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    const original = await fixture.settings.read();
    const saved = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model: "local-no-reasoning" } });
    const configPath = path.join(fixture.home, "config.toml");
    const text = await fs.readFile(configPath, "utf8");
    for (const key of ["model_reasoning_effort", "plan_mode_reasoning_effort"]) {
      for (const effort of ["low", "none", "banana"]) {
        await expect(fixture.settings.update({ expectedRevision: saved.revision, nativeOptions: { [key]: effort } })).rejects.toThrow(/reasoning effort/);
        expect(await fs.readFile(configPath, "utf8")).toBe(text);
      }
    }
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ model: "local-no-reasoning", reasoning: {} });
    expect(fixture.requests[0]?.reasoning).not.toHaveProperty("effort");
    expect(saved.configuration?.values).not.toHaveProperty("model_reasoning_effort");
    expect(saved.configuration?.values).not.toHaveProperty("plan_mode_reasoning_effort");
  } finally { await fixture.dispose(); }
}, 30_000);

interface ConfigurationRequest {
  text?: { verbosity?: string };
  reasoning?: { summary?: string; effort?: string };
}

class NativeConfigurationSession {
  readonly home: string;
  readonly data: string;
  readonly sources: CodexStateSources;
  readonly settings: CodexSettingsService;
  readonly recovery: CodexConversationRecovery;
  readonly receiptPath: string;
  readonly overlayConfigPath: string;
  readonly requests: ConfigurationRequest[] = [];
  session?: PluginSession;
  private readonly env: NodeJS.ProcessEnv;
  private readonly provider;

  private constructor(readonly root: string) {
    this.home = path.join(root, "home");
    this.data = path.join(root, "data");
    this.env = { PATH: process.env.PATH, HOME: this.home, CODEX_HOME: this.home, CLOUDX_ASSISTANT_BIN: codex, SHELL: "/bin/sh", TERM: "xterm-256color" };
    this.sources = new CodexStateSources(this.data, this.env);
    this.settings = new CodexSettingsService(this.sources, this.env);
    this.recovery = new CodexConversationRecovery(this.sources.viewPath("configuration"));
    this.receiptPath = path.join(root, "turn.json");
    this.overlayConfigPath = path.join(this.sources.viewPath("configuration"), "config.toml");
    this.provider = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const input = JSON.parse(body);
        const title = Boolean(input.text?.format?.schema?.properties?.title);
        if (!title) this.requests.push(input as ConfigurationRequest);
        const text = title ? '{"title":"Native configuration validation"}' : answer;
        const item = { type: "message", id: "msg_configuration", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id: "resp_configuration", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
          { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "resp_configuration", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
  }

  static async create({ relativePaths = false }: { relativePaths?: boolean } = {}) {
    expect(path.isAbsolute(codex!)).toBe(true);
    const fixture = new NativeConfigurationSession(await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-configuration-")));
    try {
      await new Promise<void>(resolve => fixture.provider.listen(0, "127.0.0.1", resolve));
      const port = (fixture.provider.address() as { port: number }).port;
      await fs.mkdir(fixture.home, { mode: 0o700 });
      const catalogPath = path.join(fixture.home, "models.json");
      if (relativePaths) await fs.writeFile(path.join(fixture.home, "instructions.md"), instructions);
      await fs.writeFile(catalogPath, JSON.stringify({ models: [{
        slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", default_reasoning_level: "low",
        supported_reasoning_levels: ["low", "xhigh"].map(effort => ({ effort, description: effort })),
        shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
        model_messages: { instructions_template: "Respond using the isolated native test provider." },
        support_verbosity: true, default_verbosity: "medium", supports_reasoning_summaries: true,
        supports_reasoning_summary_parameter: true, truncation_policy: { mode: "tokens", limit: 10_000 }, experimental_supported_tools: []
      }] }));
      await fs.writeFile(path.join(fixture.home, "config.toml"), [
        '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
        'model = "gpt-6.1-sol"', `model_catalog_json = ${JSON.stringify(relativePaths ? "models.json" : catalogPath)}`,
        ...(relativePaths ? ['model_instructions_file = "instructions.md"'] : []),
        'model_provider = "cloudx-native"', 'check_for_update_on_startup = false',
        '[model_providers.cloudx-native]', 'name = "CloudX native configuration test"',
        `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
        `[projects.${JSON.stringify(fixture.root)}]`, 'trust_level = "trusted"', ''
      ].join("\n"));
      return fixture;
    } catch (error) { await fixture.dispose(); throw error; }
  }

  async launch(forge = false) {
    await this.session?.terminate?.();
    const tab: WorkspaceTab = { id: "configuration", pluginId: "codex-terminal", ...(forge ? { ownerPluginId: "forge" } : {}), title: "Native configuration", cwd: this.root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
    this.session = await new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, this.data, this.sources, this.env).createSession({
      tab, cwd: this.root,
      ...(forge ? { initialInput: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" }, agentTurn: { workerId: "native-configuration", attemptId: "native-configuration-attempt", receiptPath: this.receiptPath } } : {}),
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    this.session.onData!(chunk => { if (chunk.includes("\u001b[6n")) this.session!.write!("\u001b[1;1R"); });
    await expect.poll(() => this.recovery.read()?.sessionId ?? this.session?.snapshot().recentOutput, { timeout: 15_000 }).toMatch(/^[a-f0-9-]{36}$/u);
    await this.session.handleAction("wait_until_ready", { timeoutMs: 10_000 });
  }

  async completeTurn() {
    const threadId = this.recovery.read()!.sessionId;
    const firstNewEvent = (await readVerificationTranscript(this.recovery.read()?.transcriptPath)).length;
    await this.session!.handleAction("enter_text", { text: "Verify the saved native configuration.", submit: true });
    let completed: ReturnType<typeof completedVerificationTurn>;
    await expect.poll(async () => {
      completed = completedVerificationTurn(await readVerificationTranscript(this.recovery.read()?.transcriptPath), firstNewEvent, threadId, answer);
      return completed;
    }, { timeout: 10_000 }).toMatchObject({ threadId, turnId: expect.any(String) });
    await this.session!.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    return completed!;
  }

  async enterPlanMode() {
    await this.session!.handleAction("enter_text", { text: "/plan" });
    await expect.poll(() => stripVTControlCharacters(this.session!.snapshot().recentOutput ?? ""), { timeout: 5_000 }).toContain("/plan");
    await this.session!.handleAction("send_key", { key: "enter" });
    await expect.poll(() => stripVTControlCharacters(this.session!.snapshot().recentOutput ?? ""), { timeout: 5_000 }).toContain("Plan mode");
    await this.session!.handleAction("wait_until_ready", { timeoutMs: 10_000 });
  }

  async dispose() {
    try { await this.session?.terminate?.(); }
    finally {
      this.provider.closeAllConnections();
      await new Promise<void>(resolve => this.provider.close(() => resolve()));
      await this.sources.dispose();
      await fs.rm(this.root, { recursive: true, force: true });
    }
  }
}

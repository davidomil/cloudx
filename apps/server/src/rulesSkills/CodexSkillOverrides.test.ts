import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify, type TomlTable } from "smol-toml";
import { CodexStateSources } from "../plugins/CodexStateSources.js";
import { materializeCodexHomeOverlay, readCodexSkillOverrides } from "./CodexHomeOverlay.js";
import { captureCodexSkillOverrides, parseCodexSkillOverrides, resolveCodexSkillOverrides } from "./CodexSkillOverrides.js";
import type { ResolvedPersonalityTemplate } from "./RulesSkillsCatalogService.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fork-skills-"));
  roots.push(root);
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const projectSkill = path.join(cwd, ".agents", "skills", "project", "SKILL.md");
  const selected = path.join(dataDir, "rules-skills", "skills", "selected", "SKILL.md");
  for (const target of [projectSkill, selected]) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `---\nname: ${path.basename(path.dirname(target))}\ndescription: Fork skill settings.\n---\nFollow the selected skill.\n`);
  }
  await fs.mkdir(home);
  const sharedConfig = '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}\nmodel = "shared-model"\n';
  await fs.writeFile(path.join(home, "config.toml"), sharedConfig);
  const sources = new CodexStateSources(dataDir, { CODEX_HOME: home });
  const source = await sources.resolve();
  const resolved: ResolvedPersonalityTemplate = {
    source: "tab", template: { id: "selected", name: "Selected", color: "green", ruleIds: [], skillIds: ["selected"] }, rules: [],
    skills: [{ id: "selected", name: "Selected", description: "Fork skill settings." }]
  };
  const options = { dataDir, sources, source, cwd, baseEnv: { HOME: home }, resolved };
  return { ...options, root, home, projectSkill, sharedConfig, options };
}

it("carries native enabled project skills and disabled generated skills into a separate child view", async () => {
  const { sources, options, projectSkill, home, sharedConfig } = await fixture();
  try {
    const parent = await materializeCodexHomeOverlay({ ...options, tabId: "parent" });
    const generated = parent.skillPaths.find(file => file.includes("/cloudx/selected/"))!;
    const config = parse(await fs.readFile(parent.configPath, "utf8"));
    const skills = config.skills as TomlTable;
    // Native enables a skill by removing the disabled override and disables it by writing false.
    skills.config = (skills.config as TomlTable[]).filter(entry => entry.path !== projectSkill).map(entry => entry.path === generated ? { ...entry, enabled: false } : entry);
    (skills.config as TomlTable[]).push({ name: "native-name-choice", enabled: false });
    config.model = "unrelated-per-tab-edit";
    await fs.writeFile(parent.configPath, stringify(config));
    const overrides = await readCodexSkillOverrides(parent.codexHome, { cwd: options.cwd, homeDir: home });
    expect(overrides).toContainEqual({ path: projectSkill, enabled: true });
    expect(overrides).toContainEqual({ generatedPath: "skills/cloudx/selected/SKILL.md", enabled: false });
    const child = await materializeCodexHomeOverlay({ ...options, tabId: "child", nativeSkillOverrides: overrides });
    const childConfig = parse(await fs.readFile(child.configPath, "utf8"));
    expect(childConfig.model).toBe("shared-model");
    expect((childConfig.skills as TomlTable).config).toEqual(expect.arrayContaining([
      { path: projectSkill, enabled: true },
      { path: path.join(child.codexHome, "skills/cloudx/selected/SKILL.md"), enabled: false },
      { name: "native-name-choice", enabled: false }
    ]));
    expect(JSON.stringify(childConfig)).not.toContain(parent.codexHome);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(sharedConfig);
    // A child's own native changes are recaptured before process-loss recovery.
    (childConfig.skills as TomlTable).config = ((childConfig.skills as TomlTable).config as TomlTable[]).map(entry => entry.path === projectSkill ? { ...entry, enabled: false } : entry)
      .filter(entry => entry.path !== path.join(child.codexHome, "skills/cloudx/selected/SKILL.md"));
    await fs.writeFile(child.configPath, stringify(childConfig));
    const recovered = await materializeCodexHomeOverlay({ ...options, tabId: "child", nativeSkillOverrides: await readCodexSkillOverrides(child.codexHome, { cwd: options.cwd, homeDir: home }) });
    expect((parse(await fs.readFile(recovered.configPath, "utf8")).skills as TomlTable).config).toEqual(expect.arrayContaining([
      { path: projectSkill, enabled: false },
      { path: path.join(child.codexHome, "skills/cloudx/selected/SKILL.md"), enabled: true }
    ]));
  } finally { await sources.dispose(); }
});

it.each(["name only", "path then name", "name then path"])("preserves native %s rule precedence over inferred defaults", async order => {
  const { sources, options, projectSkill, home } = await fixture();
  try {
    const parent = await materializeCodexHomeOverlay({ ...options, tabId: "parent" });
    const nameRule = { name: "project", enabled: false };
    const pathRule = { path: projectSkill, enabled: true };
    const nativeRules = order === "name only" ? [nameRule] : order === "path then name" ? [pathRule, nameRule] : [nameRule, pathRule];
    const config = parse(await fs.readFile(parent.configPath, "utf8"));
    (config.skills as TomlTable).config = nativeRules;
    await fs.writeFile(parent.configPath, stringify(config));

    const captured = await readCodexSkillOverrides(parent.codexHome, { cwd: options.cwd, homeDir: home });
    const expected = order === "name only" ? [pathRule, nameRule] : nativeRules;
    expect(captured).toEqual(expected);
    const child = await materializeCodexHomeOverlay({ ...options, tabId: "child", nativeSkillOverrides: captured });
    const childRules = (parse(await fs.readFile(child.configPath, "utf8")).skills as TomlTable).config as TomlTable[];
    expect(childRules.filter(entry => entry.path === projectSkill || entry.name === "project")).toEqual(expected);
  } finally { await sources.dispose(); }
});

it("drops generated overrides for skills absent from the child's selected catalog", () => {
  const child = "/views/child";
  expect(resolveCodexSkillOverrides([
    { generatedPath: "skills/cloudx/removed/SKILL.md", enabled: false },
    { generatedPath: "skills/cloudx-system/system/SKILL.md", enabled: false },
    { generatedPath: "skills/cloudx-exceptions/default/SKILL.md", enabled: false }
  ], child, [path.join(child, "skills/cloudx-system/system/SKILL.md"), path.join(child, "skills/cloudx-exceptions/default/SKILL.md")])).toEqual([
    { path: path.join(child, "skills/cloudx-system/system/SKILL.md"), enabled: false },
    { path: path.join(child, "skills/cloudx-exceptions/default/SKILL.md"), enabled: false }
  ]);
});

it.each([
  null, {}, [{ path: "relative/SKILL.md", enabled: false }], [{ name: "", enabled: true }], [{ path: "/skill", enabled: "false" }],
  [{ path: "/skill", name: "both", enabled: true }], [{ generatedPath: "skills/cloudx/../SKILL.md", enabled: false }],
  [{ generatedPath: "../skills/cloudx/selected/SKILL.md", enabled: false }], [{ generatedPath: "/skills/cloudx/selected/SKILL.md", enabled: false }],
  [{ generatedPath: "skills/unmanaged/selected/SKILL.md", enabled: false }], [{ path: "/nul\0/SKILL.md", enabled: true }]
])("rejects malformed native skill selections %j", value => {
  expect(() => parseCodexSkillOverrides(value)).toThrow(/native Codex skill/i);
});

it("bounds serialized override counts and excludes unrelated properties", () => {
  expect(() => parseCodexSkillOverrides(Array.from({ length: 20_001 }, () => ({ name: "skill", enabled: false })))).toThrow(/overrides/);
  expect(parseCodexSkillOverrides([{ name: " chosen ", enabled: false, model: "discard" }])).toEqual([{ name: "chosen", enabled: false }]);
});

it.each(["symlink", "directory", "oversized", "invalid TOML", "invalid skills", "invalid entries"])("rejects %s source config without copying it", async failure => {
  const { options, sources, root } = await fixture();
  try {
    const home = path.join(root, "untrusted-view");
    await fs.mkdir(home);
    const config = path.join(home, "config.toml");
    if (failure === "symlink") await fs.symlink(path.join(options.source.home, "config.toml"), config);
    else if (failure === "directory") await fs.mkdir(config);
    else await fs.writeFile(config, failure === "oversized" ? "#".repeat(2 * 1024 * 1024 + 1) : failure === "invalid TOML" ? "skills = [" : failure === "invalid skills" ? "skills = []" : "[skills]\nconfig = 1\n");
    await expect(captureCodexSkillOverrides(home, [])).rejects.toThrow();
  } finally { await sources.dispose(); }
});

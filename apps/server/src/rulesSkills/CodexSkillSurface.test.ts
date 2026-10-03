import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexStateSources } from "../plugins/CodexStateSources.js";
import { materializeCodexTemplate } from "../plugins/CodexTerminalPlugin.js";
import { materializeCodexSkillSurface } from "./CodexSkillSurface.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-skill-surface-"));
  roots.push(root);
  const source = path.join(root, "source");
  const target = path.join(root, "generated");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: focused\ndescription: Focused skill.\n---\nRead references/guide.md.\n");
  return { root, source, target };
}

it("exposes a bounded entrypoint and native metadata while pointing resource reads to the source", async () => {
  const { source, target } = await fixture();
  for (const directory of ["agents", "scripts", "assets", "references", "node_modules/dependency", ".venv/dependency"]) {
    await fs.mkdir(path.join(source, directory), { recursive: true });
    await fs.writeFile(path.join(source, directory, "resource"), directory);
  }
  await fs.writeFile(path.join(source, "agents/openai.yaml"), 'interface:\n  display_name: "Focused skill"\n');
  await fs.writeFile(path.join(source, "node_modules/dependency/SKILL.md"), "Unrelated dependency skill");
  await materializeCodexSkillSurface(source, target);
  expect((await fs.readdir(target)).sort()).toEqual(["SKILL.md", "agents"]);
  expect(await fs.readdir(path.join(target, "agents"))).toEqual(["openai.yaml"]);
  expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
  for (const relative of ["SKILL.md", "agents/openai.yaml"]) {
    expect((await fs.lstat(path.join(target, relative))).isFile()).toBe(true);
  }
  expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toContain(JSON.stringify(path.join(source, "SKILL.md")));
  expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toContain("Resolve task input and output paths from the task working directory");
  const resourceRoot = source;
  expect(await fs.readFile(path.join(resourceRoot, "scripts/resource"), "utf8")).toBe("scripts");
  await fs.writeFile(path.join(source, "SKILL.md"), "User edit");
  expect(await fs.readFile(path.join(resourceRoot, "SKILL.md"), "utf8")).toBe("User edit");
  await fs.rm(target, { recursive: true });
  expect(await fs.readFile(path.join(source, "node_modules/dependency/SKILL.md"), "utf8")).toBe("Unrelated dependency skill");
});

it("accepts an entrypoint without optional metadata", async () => {
  const { source, target } = await fixture();
  await materializeCodexSkillSurface(source, target);
  expect(await fs.readdir(target)).toEqual(["SKILL.md"]);
});

it.each(["missing entrypoint", "directory entrypoint", "directory metadata", "broken metadata link"])("reports the specific source and actionable failure for %s", async (failure) => {
  const { source, target } = await fixture();
  if (failure.includes("entrypoint")) {
    await fs.unlink(path.join(source, "SKILL.md"));
    if (failure === "directory entrypoint") await fs.mkdir(path.join(source, "SKILL.md"));
  } else {
    await fs.mkdir(path.join(source, "agents"));
    if (failure === "directory metadata") await fs.mkdir(path.join(source, "agents/openai.yaml"));
    else await fs.symlink(path.join(source, "missing"), path.join(source, "agents/openai.yaml"));
  }
  await expect(materializeCodexSkillSurface(source, target)).rejects.toThrow(`Cannot expose Codex skill ${source} in ${target}`);
});

it("links only the two metadata icons and preserves native policy and dependencies", async () => {
  const { source, target } = await fixture();
  await fs.mkdir(path.join(source, "agents"));
  await fs.mkdir(path.join(source, "assets/nested"), { recursive: true });
  await fs.writeFile(path.join(source, "assets/nested/small.svg"), "icon");
  await fs.writeFile(path.join(source, "agents/openai.yaml"), 'interface:\n  icon_small: ./assets/nested/small.svg\npolicy:\n  allow_implicit_invocation: false\ndependencies:\n  tools: []\n');
  await materializeCodexSkillSurface(source, target);
  expect(await fs.readFile(path.join(target, "assets/icon_small.svg"), "utf8")).toBe("icon");
  expect(await fs.readFile(path.join(target, "agents/openai.yaml"), "utf8")).toContain("allow_implicit_invocation: false");
  expect((await fs.readdir(path.join(target, "assets"))).sort()).toEqual(["icon_small.svg"]);
});

it.each(["/absolute.svg", "../outside.svg", "scripts/icon.svg", "assets/missing.svg", ""])("rejects an unusable metadata icon %j instead of silently losing it", async (icon) => {
  const { source, target } = await fixture();
  await fs.mkdir(path.join(source, "agents"));
  await fs.writeFile(path.join(source, "agents/openai.yaml"), `interface:\n  icon_small: ${JSON.stringify(icon)}\n`);
  await expect(materializeCodexSkillSurface(source, target)).rejects.toThrow("Cannot expose Codex skill");
});

it.each(["missing frontmatter", "invalid metadata", "oversized metadata"])("reports %s without publishing an incomplete surface", async failure => {
  const { source, target } = await fixture();
  if (failure === "missing frontmatter") await fs.writeFile(path.join(source, "SKILL.md"), "No frontmatter");
  else {
    await fs.mkdir(path.join(source, "agents"));
    await fs.writeFile(path.join(source, "agents/openai.yaml"), failure === "invalid metadata" ? "interface: [" : "#".repeat(1024 * 1024 + 1));
  }
  await expect(materializeCodexSkillSurface(source, target)).rejects.toThrow("Cannot expose Codex skill");
});

it("rejects an oversized selected catalog before replacing the last generated configuration", async () => {
  const { root, source } = await fixture();
  await fs.writeFile(path.join(source, "config.toml"), '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}\n');
  const dataDir = path.join(root, "data");
  const env = { HOME: root, CODEX_HOME: source };
  const sources = new CodexStateSources(dataDir, env);
  try {
    const options = { dataDir, tabId: "bounded", sources, cwd: root };
    const launch = await materializeCodexTemplate(undefined, env, options);
    const config = await fs.readFile(launch.overlay!.configPath, "utf8");
    await expect(materializeCodexTemplate({
      source: "tab", rules: [],
      template: { id: "large", name: "Large", color: "green", ruleIds: [], skillIds: [] },
      skills: Array.from({ length: 666 }, (_, index) => ({ id: `skill-${index}`, name: `Skill ${index}`, description: "Bound test." }))
    }, env, options)).rejects.toThrow(/cannot expose.*native discovery limits.*665 skills/);
    expect(await fs.readFile(launch.overlay!.configPath, "utf8")).toBe(config);
    expect((await fs.readdir(launch.overlay!.codexHome)).filter(name => name.startsWith(".cloudx-generated-"))).toEqual([]);
  } finally { await sources.dispose(); }
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RulesSkillsCatalogService } from "./RulesSkillsCatalogService.js";

const bundle = new URL("../../skills/source-grounded-writing/", import.meta.url);

describe("bundled source-grounded writing", () => {
  it("installs the complete skill without installing rendering dependencies", async ({ onTestFinished }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-writing-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const catalog = new RulesSkillsCatalogService(root);

    const store = await catalog.list();
    const skill = store.systemSkills.find(skill => skill.id === "source-grounded-writing");
    expect(skill).toMatchObject({ scope: "system", name: "Source Grounded Writing" });
    expect(skill?.instructions).toBe(await fs.readFile(new URL("SKILL.md", bundle), "utf8"));
    const installed = path.join(catalog.catalogRoot(), "system-skills", "source-grounded-writing");
    for (const file of await fs.readdir(bundle, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const source = path.join(file.parentPath, file.name);
      const relative = path.relative(fileURLToPath(bundle), source);
      if (relative.split(path.sep).some(part => [".venv", "node_modules", ".tools", "build", "__pycache__"].includes(part))) continue;
      expect(await fs.readFile(path.join(installed, relative))).toEqual(await fs.readFile(source));
    }
    await expect(fs.stat(path.join(installed, ".venv"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(path.join(installed, "scripts", "compile_doc.py"))).mode & 0o111).not.toBe(0);
    await expect(catalog.saveSkill({ id: "source-grounded-writing", name: "Shadow", description: "Shadow the built-in." })).rejects.toThrow("system skill already exists");
  });

  it("refreshes bundled files and preserves local tools, outputs, and unchanged mtimes", async ({ onTestFinished }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-writing-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const catalog = new RulesSkillsCatalogService(root);
    await catalog.list();
    const installed = path.join(catalog.catalogRoot(), "system-skills", "source-grounded-writing");
    const readme = path.join(installed, "README.md");
    const oldTime = new Date("2001-01-01T00:00:00Z");
    await fs.utimes(readme, oldTime, oldTime);
    const sentinels = [".venv/installed", "node_modules/installed", ".tools/installed", "build/report.md", "notes.txt"];
    for (const file of sentinels) {
      await fs.mkdir(path.dirname(path.join(installed, file)), { recursive: true });
      await fs.writeFile(path.join(installed, file), "keep");
    }
    await fs.writeFile(path.join(installed, "scripts", "compile_doc.py"), "old compiler");

    await catalog.list();

    expect((await fs.stat(readme)).mtimeMs).toBe(oldTime.getTime());
    for (const file of sentinels) expect(await fs.readFile(path.join(installed, file), "utf8")).toBe("keep");
    expect(await fs.readFile(path.join(installed, "scripts", "compile_doc.py"))).toEqual(await fs.readFile(new URL("scripts/compile_doc.py", bundle)));
  });

  it("uses the system skill once while retaining an existing user copy and template on disk", async ({ onTestFinished }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-writing-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const catalog = new RulesSkillsCatalogService(root);
    const userDir = path.join(catalog.catalogRoot(), "skills", "source-grounded-writing");
    const templateDir = path.join(catalog.catalogRoot(), "templates");
    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(templateDir, { recursive: true });
    const original = '---\nname: source-grounded-writing\ndescription: User writing skill.\n---\nCustom instructions.\n';
    await fs.writeFile(path.join(userDir, "SKILL.md"), original);
    const template = { id: "writer", name: "Writer", color: "green", ruleIds: [], skillIds: ["source-grounded-writing"] };
    await fs.writeFile(path.join(templateDir, "writer.json"), JSON.stringify(template));

    const store = await catalog.list();

    expect(store.skills).toEqual([]);
    expect(store.systemSkills.filter(skill => skill.id === "source-grounded-writing")).toHaveLength(1);
    expect(store.templates).toContainEqual({ ...template, skillIds: [] });
    await expect(catalog.resolveFor({ id: "tab", pluginId: "codex-terminal" } as Parameters<typeof catalog.resolveFor>[0])).resolves.toMatchObject({ skills: [], template: { id: "writer" } });
    expect(await fs.readFile(path.join(userDir, "SKILL.md"), "utf8")).toBe(original);
    expect(JSON.parse(await fs.readFile(path.join(templateDir, "writer.json"), "utf8"))).toEqual(template);
  });

  it("rejects resource directories and files that redirect writes outside the catalog", async ({ onTestFinished }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-writing-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const catalog = new RulesSkillsCatalogService(root);
    await catalog.list();
    const installed = path.join(catalog.catalogRoot(), "system-skills", "source-grounded-writing");
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.rm(path.join(installed, "scripts"), { recursive: true });
    await fs.symlink(outside, path.join(installed, "scripts"), "dir");
    await expect(catalog.list()).rejects.toThrow("symbolic link");
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(path.join(installed, "scripts"));
    await catalog.list();
    const file = path.join(outside, "compiler.py");
    await fs.writeFile(file, "keep");
    await fs.rm(path.join(installed, "scripts", "compile_doc.py"));
    await fs.symlink(file, path.join(installed, "scripts", "compile_doc.py"));
    await expect(catalog.list()).rejects.toThrow("symbolic link");
    expect(await fs.readFile(file, "utf8")).toBe("keep");
  });

  it("keeps plugin-owned ID conflicts visible for the plugin adoption checks", async ({ onTestFinished }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-writing-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const catalog = new RulesSkillsCatalogService(root);
    await catalog.saveSystemSkill({ id: "plugin-workflow", name: "Plugin Workflow", description: "A plugin-owned skill." });
    const userDir = path.join(catalog.catalogRoot(), "skills", "plugin-workflow");
    await fs.mkdir(userDir);
    await fs.writeFile(path.join(userDir, "SKILL.md"), '---\nname: plugin-workflow\ndescription: Conflicting user skill.\n---\nUser instructions.\n');
    await catalog.saveTemplate({ id: "plugin-user", name: "Plugin User", color: "green", ruleIds: [], skillIds: ["plugin-workflow"] });

    const store = await catalog.list();

    expect(store.skills).toContainEqual(expect.objectContaining({ id: "plugin-workflow", scope: "user" }));
    expect(store.systemSkills).toContainEqual(expect.objectContaining({ id: "plugin-workflow", scope: "system" }));
    expect(store.templates.find(template => template.id === "plugin-user")?.skillIds).toEqual(["plugin-workflow"]);
  });
});

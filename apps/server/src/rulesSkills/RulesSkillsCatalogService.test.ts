import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RULES_SKILLS_PLUGIN_ID, type WorkspaceTab, type WorkspaceWindow } from "@cloudx/shared";

import { RulesSkillsCatalogService } from "./RulesSkillsCatalogService.js";

describe("RulesSkillsCatalogService", () => {
  it("stores rules, skills, and templates in the folder-backed catalog", async () => {
    const service = await createService();
    await service.saveRule({ id: "review-carefully", description: "Review carefully.", text: "Review carefully before changing code." });
    await service.saveSkill({ id: "reviewer", name: "Reviewer", description: "Review code.", instructions: "Reviewer skill instructions." });
    const store = await service.saveTemplate({
      id: "focused",
      name: "Focused",
      color: "yellow",
      ruleIds: ["review-carefully"],
      skillIds: ["reviewer"]
    });

    expect(store.templates.map((template) => template.id)).toContain("focused");
    expect(store.rules.map((rule) => rule.id)).toContain("review-carefully");
    expect(store.skills.find((skill) => skill.id === "reviewer")?.instructions).toContain("Reviewer skill instructions.");
    expect(store.systemSkills.map((skill) => skill.id)).toEqual(["create-cloudx-skill", "migrate-skill-to-cloudx"]);
    const skillFile = await fs.readFile(path.join(service.catalogRoot(), "skills", "reviewer", "SKILL.md"), "utf8");
    expect(skillFile).toContain('name: "reviewer"');
    expect(skillFile).toContain('description: "Review code."');
    expect(skillFile).toContain('cloudx_name: "Reviewer"');
    await expect(fs.stat(path.join(service.catalogRoot(), "skills", "reviewer", "skill.json"))).rejects.toThrow();
    const systemSkillFile = await fs.readFile(path.join(service.catalogRoot(), "system-skills", "create-cloudx-skill", "SKILL.md"), "utf8");
    expect(systemSkillFile).toContain("CLOUDX_RULES_SKILLS_DIR");
  });

  it("resolves default, window, and tab template precedence", async () => {
    const service = await createService();
    await service.saveTemplate({ id: "window-template", name: "Window Template", color: "yellow", ruleIds: [], skillIds: [] });
    await service.saveTemplate({ id: "tab-template", name: "Tab Template", color: "red", ruleIds: [], skillIds: [] });

    const tab = codexTab();
    await expect(service.resolveFor(tab)).resolves.toMatchObject({ source: "default", template: { id: "default-codex" } });

    const window = workspaceWindow({ selectedTemplateId: "window-template" });
    await expect(service.resolveFor(tab, window)).resolves.toMatchObject({ source: "window", template: { id: "window-template" } });

    await expect(service.resolveFor({ ...tab, pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: { selectedTemplateId: "tab-template" } } }, window)).resolves.toMatchObject({
      source: "tab",
      template: { id: "tab-template", color: "red" }
    });
  });

  it("uses template colors for Codex tab indicators only", async () => {
    const service = await createService();
    await service.saveTemplate({ id: "focused", name: "Focused", color: "yellow", ruleIds: [], skillIds: [] });
    const window = workspaceWindow({ selectedTemplateId: "focused" });

    await expect(service.tabIndicatorFor(codexTab(), window)).resolves.toMatchObject({ color: "yellow", label: "Focused" });
    await expect(service.tabIndicatorFor({ ...codexTab(), pluginId: "standard-terminal" }, window)).resolves.toBeUndefined();
  });

  it("notifies subscribers when template definitions change", async () => {
    const service = await createService();
    const listener = vi.fn();
    const dispose = service.onChange(listener);

    await service.saveTemplate({ id: "focused", name: "Focused", color: "yellow", ruleIds: [], skillIds: [] });
    await service.setDefaultTemplate("focused");
    await service.deleteTemplate("focused");

    expect(listener).toHaveBeenCalledTimes(3);

    dispose();
    await service.saveTemplate({ id: "review", name: "Review", color: "red", ruleIds: [], skillIds: [] });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("migrates existing skills into the CloudX catalog and rejects duplicates", async () => {
    const service = await createService();
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-source-skill-"));
    const sourceSkill = path.join(sourceRoot, "source-skill");
    await fs.mkdir(sourceSkill, { recursive: true });
    await fs.writeFile(path.join(sourceSkill, "SKILL.md"), "# Source Skill\n\nUse this skill.\n", "utf8");
    await fs.mkdir(path.join(sourceSkill, "scripts"), { recursive: true });
    await fs.writeFile(path.join(sourceSkill, "scripts", "run.sh"), "echo migrated\n", "utf8");

    await service.migrateSkill({ sourcePath: sourceSkill, id: "cloudx-source-skill" });

    const migratedSkill = await fs.readFile(path.join(service.catalogRoot(), "skills", "cloudx-source-skill", "SKILL.md"), "utf8");
    expect(migratedSkill).toContain('name: "cloudx-source-skill"');
    expect(migratedSkill).toContain('description: "Source Skill"');
    await expect(fs.readFile(path.join(service.catalogRoot(), "skills", "cloudx-source-skill", "scripts", "run.sh"), "utf8")).resolves.toContain("migrated");
    await expect(service.migrateSkill({ sourcePath: sourceSkill, id: "cloudx-source-skill" })).rejects.toThrow("CloudX skill already exists");
  });

  it("rejects unsafe catalog ids and missing migration sources with clear errors", async () => {
    const service = await createService();

    await expect(service.saveRule({ id: ".", description: "Invalid.", text: "Invalid rule id." })).rejects.toThrow("rule id");
    await expect(
      service.saveSkill({ id: "create-cloudx-skill", name: "Shadow", description: "Shadow system skill.", instructions: "No." }, { failIfExists: true })
    ).rejects.toThrow("CloudX skill already exists: create-cloudx-skill");
    await expect(service.migrateSkill({ sourcePath: path.join(os.tmpdir(), "missing-cloudx-skill") })).rejects.toThrow("Source skill does not exist");
  });
});

async function createService(): Promise<RulesSkillsCatalogService> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-skills-"));
  return new RulesSkillsCatalogService(path.join(root, ".cloudx"));
}

function codexTab(): WorkspaceTab {
  return {
    id: "tab-1",
    pluginId: "codex-terminal",
    title: "Codex",
    cwd: "/tmp",
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function workspaceWindow(metadata: Record<string, unknown>): WorkspaceWindow {
  return {
    id: "window-1",
    name: "Main",
    defaultCwd: "/tmp",
    layout: { root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } }, activePaneId: "pane-1" },
    pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: metadata },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

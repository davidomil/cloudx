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
    expect(store.systemRules).toEqual([]);
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

  it("does not recreate a deleted default rule during catalog refresh", async () => {
    const service = await createService();
    await expect(service.list()).resolves.toMatchObject({
      defaultTemplateId: "default-codex"
    });

    const store = await service.deleteRule("keep-changes-focused");

    expect(store.rules.map((rule) => rule.id)).not.toContain("keep-changes-focused");
    expect(store.templates.find((template) => template.id === "default-codex")?.ruleIds).not.toContain("keep-changes-focused");
    await expect(service.list()).resolves.toMatchObject({
      rules: expect.not.arrayContaining([expect.objectContaining({ id: "keep-changes-focused" })])
    });
  });

  it("does not rewrite unchanged system skill files during catalog refresh", async () => {
    const service = await createService();
    await service.list();
    const systemSkillFile = path.join(service.catalogRoot(), "system-skills", "create-cloudx-skill", "SKILL.md");
    const oldTime = new Date("2001-01-01T00:00:00.000Z");
    await fs.utimes(systemSkillFile, oldTime, oldTime);
    const before = await fs.stat(systemSkillFile);

    await service.list();

    const after = await fs.stat(systemSkillFile);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("stores plugin-contributed system skills beside built-in system skills", async () => {
    const service = await createService();

    const store = await service.saveSystemSkill({
      id: "documentation-search",
      name: "Documentation Search",
      description: "Search the local documentation archive.",
      instructions: "Read `CLOUDX_DOCUMENTATION_URL` before searching."
    });

    expect(store.systemSkills.map((skill) => skill.id)).toEqual([
      "create-cloudx-skill",
      "documentation-search",
      "migrate-skill-to-cloudx"
    ]);
    const skillFile = await fs.readFile(path.join(service.catalogRoot(), "system-skills", "documentation-search", "SKILL.md"), "utf8");
    expect(skillFile).toContain("CLOUDX_DOCUMENTATION_URL");
    await expect(service.saveSkill({ id: "documentation-search", name: "User Shadow", description: "Shadow system skill." })).rejects.toThrow("system skill already exists");
  });

  it("stores plugin-contributed system rules separately from user rules", async () => {
    const service = await createService();

    const store = await service.saveSystemRule({
      id: "documentation-ingest-evidence",
      description: "Capture task evidence.",
      text: "Download task evidence and add it to the documentation archive."
    });

    expect(store.rules.map((rule) => rule.id)).toEqual(["keep-changes-focused"]);
    expect(store.systemRules).toContainEqual(expect.objectContaining({
      id: "documentation-ingest-evidence",
      scope: "system",
      text: "Download task evidence and add it to the documentation archive."
    }));
    const ruleFile = await fs.readFile(path.join(service.catalogRoot(), "system-rules", "documentation-ingest-evidence.md"), "utf8");
    expect(ruleFile).toContain("Download task evidence");
    await expect(service.saveRule({ id: "documentation-ingest-evidence", description: "Shadow.", text: "Shadow rule." })).rejects.toThrow("system rule already exists");
  });

  it("seeds catalog directories idempotently when concurrent reads create the same path", async () => {
    const service = await createService();
    const rulesPath = path.join(service.catalogRoot(), "rules");
    const originalMkdir = fs.mkdir.bind(fs);
    const enteredRulesMkdir = deferred<void>();
    const resumeRulesMkdir = deferred<void>();
    let delayedRulesMkdir = false;
    const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]) === rulesPath && !delayedRulesMkdir) {
        delayedRulesMkdir = true;
        enteredRulesMkdir.resolve();
        await resumeRulesMkdir.promise;
      }
      return originalMkdir(...args);
    });

    try {
      const firstRead = service.list();
      await enteredRulesMkdir.promise;
      const secondRead = service.list();
      await letPendingOperationsRun();
      resumeRulesMkdir.resolve();

      await expect(Promise.all([firstRead, secondRead])).resolves.toEqual([
        expect.objectContaining({ defaultTemplateId: "default-codex" }),
        expect.objectContaining({ defaultTemplateId: "default-codex" })
      ]);
    } finally {
      mkdir.mockRestore();
    }
  });

  it("does not reattach a deleted default rule when recreating the last template", async () => {
    const service = await createService();
    await service.deleteRule("keep-changes-focused");

    const store = await service.deleteTemplate("default-codex");

    expect(store.rules.map((rule) => rule.id)).not.toContain("keep-changes-focused");
    expect(store.templates).toContainEqual(expect.objectContaining({
      id: "default-codex",
      ruleIds: []
    }));
  });

  it("rejects catalog writes through symlinked files", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = await createService();
    await service.list();
    const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-skills-outside-")), "outside.md");
    await fs.writeFile(outside, "outside\n", "utf8");
    const ruleFile = path.join(service.catalogRoot(), "rules", "keep-changes-focused.md");
    await fs.rm(ruleFile);
    await fs.symlink(outside, ruleFile);

    await expect(service.saveRule({ id: "keep-changes-focused", description: "Changed.", text: "Changed rule." })).rejects.toThrow("symbolic link");
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("outside\n");
  });

  it("rejects catalog writes through symlinked catalog directories", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = await createService();
    await service.list();
    const outsideTemplates = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-skills-templates-"));
    const templatesPath = path.join(service.catalogRoot(), "templates");
    await fs.rm(templatesPath, { recursive: true, force: true });
    await fs.symlink(outsideTemplates, templatesPath, "dir");

    await expect(service.saveTemplate({ id: "outside-template", name: "Outside", color: "yellow", ruleIds: [], skillIds: [] })).rejects.toThrow("symbolic link");
    await expect(fs.stat(path.join(outsideTemplates, "outside-template.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked catalog roots before seeding default files outside the catalog", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-skills-root-link-"));
    const dataDir = path.join(root, ".cloudx");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-skills-root-outside-"));
    await fs.mkdir(dataDir);
    await fs.symlink(outside, path.join(dataDir, "rules-skills"), "dir");
    const service = new RulesSkillsCatalogService(dataDir);

    await expect(service.list()).rejects.toThrow("symbolic link");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("rejects symlinked system-skill directories before creating system skill files outside the catalog", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = await createService();
    await service.list();
    const outsideSystemSkills = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-system-skills-outside-"));
    const systemSkillsPath = path.join(service.catalogRoot(), "system-skills");
    await fs.rm(systemSkillsPath, { recursive: true, force: true });
    await fs.symlink(outsideSystemSkills, systemSkillsPath, "dir");

    await expect(service.list()).rejects.toThrow("symbolic link");
    await expect(fs.readdir(outsideSystemSkills)).resolves.toEqual([]);
  });

  it("rejects symlinked catalog settings before reading external default-template state", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = await createService();
    await service.list();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-skills-settings-outside-"));
    const outsideSettings = path.join(outside, "settings.json");
    await fs.writeFile(outsideSettings, JSON.stringify({ defaultTemplateId: "outside-template" }), "utf8");
    const settingsPath = path.join(service.catalogRoot(), "settings.json");
    await fs.rm(settingsPath);
    await fs.symlink(outsideSettings, settingsPath);

    await expect(service.list()).rejects.toThrow("symbolic link");
  });

  it("rejects migrated skill resource copies through symlinked skills directories", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = await createService();
    await service.list();
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-source-skill-"));
    const sourceSkill = path.join(sourceRoot, "source-skill");
    await fs.mkdir(path.join(sourceSkill, "scripts"), { recursive: true });
    await fs.writeFile(path.join(sourceSkill, "SKILL.md"), "# Source Skill\n\nUse this skill.\n", "utf8");
    await fs.writeFile(path.join(sourceSkill, "scripts", "run.sh"), "echo escaped\n", "utf8");
    const outsideSkills = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-skills-skill-dir-"));
    const skillsPath = path.join(service.catalogRoot(), "skills");
    await fs.rm(skillsPath, { recursive: true, force: true });
    await fs.symlink(outsideSkills, skillsPath, "dir");

    await expect(service.migrateSkill({ sourcePath: sourceSkill, id: "escaped-skill" })).rejects.toThrow("symbolic link");
    await expect(fs.stat(path.join(outsideSkills, "escaped-skill", "scripts", "run.sh"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a replacement default when deleting the active template", async () => {
    const service = await createService();
    await service.saveTemplate({ id: "focused", name: "Focused", color: "yellow", ruleIds: [], skillIds: [] });
    await service.setDefaultTemplate("focused");

    const afterDelete = await service.deleteTemplate("focused");

    expect(afterDelete.defaultTemplateId).toBe("default-codex");
    await service.saveTemplate({ id: "focused", name: "Focused Again", color: "red", ruleIds: [], skillIds: [] });
    const afterRecreate = await service.list();
    expect(afterRecreate.defaultTemplateId).toBe("default-codex");
    await expect(fs.readFile(path.join(service.catalogRoot(), "settings.json"), "utf8")).resolves.toContain('"defaultTemplateId": "default-codex"');
  });

  it("normalizes wrong-shaped settings instead of failing catalog reads", async () => {
    const service = await createService();
    await service.list();
    await fs.writeFile(path.join(service.catalogRoot(), "settings.json"), "null\n", "utf8");

    await expect(service.list()).resolves.toMatchObject({
      defaultTemplateId: "default-codex"
    });
  });

  it("loads skills written directly into the folder-backed catalog", async () => {
    const service = await createService();
    const skillDir = path.join(service.catalogRoot(), "skills", "view-logs");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: View Logs",
        "description: View logs for the CloudX 3002 service.",
        "---",
        "",
        "# View Logs",
        "",
        "Use journalctl to inspect the 3002 service.",
        ""
      ].join("\n"),
      "utf8"
    );

    const store = await service.list();

    expect(store.skills).toContainEqual(expect.objectContaining({
      id: "view-logs",
      name: "View Logs",
      description: "View logs for the CloudX 3002 service."
    }));
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

  it("does not leave templates referencing rules deleted by concurrent catalog mutations", async () => {
    const service = await createService();
    await service.saveRule({ id: "volatile-rule", description: "Volatile.", text: "Volatile rule." });
    const rulePath = path.join(service.catalogRoot(), "rules", "volatile-rule.md");
    const originalRm = fs.rm.bind(fs);
    const enteredRuleRemoval = deferred<void>();
    const resumeRuleRemoval = deferred<void>();
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === rulePath) {
        enteredRuleRemoval.resolve();
        await resumeRuleRemoval.promise;
      }
      return originalRm(...args);
    });

    const deleteRule = service.deleteRule("volatile-rule");
    await enteredRuleRemoval.promise;
    const saveTemplate = service.saveTemplate({
      id: "late-template",
      name: "Late Template",
      color: "yellow",
      ruleIds: ["volatile-rule"],
      skillIds: []
    });
    await letPendingOperationsRun();
    resumeRuleRemoval.resolve();
    await Promise.allSettled([deleteRule, saveTemplate]);
    rm.mockRestore();

    const store = await service.list();
    expect(store.rules.map((rule) => rule.id)).not.toContain("volatile-rule");
    expect(store.templates.flatMap((template) => template.ruleIds)).not.toContain("volatile-rule");
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

  it("rejects symlinked migrated skill resources and removes the partial target skill", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = await createService();
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-source-skill-link-"));
    const sourceSkill = path.join(sourceRoot, "source-skill");
    const outsideFile = path.join(sourceRoot, "outside.sh");
    await fs.mkdir(sourceSkill, { recursive: true });
    await fs.writeFile(path.join(sourceSkill, "SKILL.md"), "# Source Skill\n\nUse this skill.\n", "utf8");
    await fs.writeFile(outsideFile, "echo outside\n", "utf8");
    await fs.symlink(outsideFile, path.join(sourceSkill, "outside-link.sh"));

    await expect(service.migrateSkill({ sourcePath: sourceSkill, id: "linked-resource" })).rejects.toThrow("symbolic link");
    await expect(fs.stat(path.join(service.catalogRoot(), "skills", "linked-resource"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe catalog ids and missing migration sources with clear errors", async () => {
    const service = await createService();

    await expect(service.saveRule({ id: ".", description: "Invalid.", text: "Invalid rule id." })).rejects.toThrow("rule id");
    await expect(
      service.saveSkill({ id: "create-cloudx-skill", name: "Shadow", description: "Shadow system skill.", instructions: "No." }, { failIfExists: true })
    ).rejects.toThrow("CloudX system skill already exists with the same id: create-cloudx-skill");
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function letPendingOperationsRun(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

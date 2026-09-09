import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RulesSkillsCatalogService } from "./RulesSkillsCatalogService.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function catalog() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-catalog-drafts-"));
  temporaryDirectories.push(directory);
  return new RulesSkillsCatalogService(directory);
}

describe("catalog draft recovery", () => {
  it("restores a removed rule under its original ID with the preserved draft and description", async () => {
    const service = await catalog();
    const original = { id: "focused", description: "Separate description.", text: "Keep focused." };
    await service.saveRule(original);
    await service.deleteRule(original.id);
    const restored = { ...original, text: "Keep this unsaved rule." };

    await service.saveRule(restored);

    const store = await service.list();
    expect(store.rules.filter(rule => rule.id === original.id)).toEqual([expect.objectContaining(restored)]);
    expect(await fs.readFile(path.join(service.catalogRoot(), "rules", "focused.md"), "utf8")).toContain(restored.text);
  });

  it.each(["rule", "skill"])("accepts a preserved template after its missing %s reference is deselected", async kind => {
    const service = await catalog();
    await service.saveRule({ id: "focused", description: "Focus.", text: "Keep focused." });
    await service.saveSkill({ id: "reviewer", name: "Reviewer", description: "Review changes.", instructions: "Review the change." });
    await service.saveSkill({ id: "builder", name: "Builder", description: "Build changes.", instructions: "Build the change." });
    const template = { id: "preserved", name: "Original name", color: "green", ruleIds: ["focused", "keep-changes-focused"], skillIds: ["reviewer", "builder"] };
    await service.saveTemplate(template);
    const draft = { ...template, name: "Keep this renamed template", color: "yellow" };
    if (kind === "rule") await service.deleteRule("focused");
    else await service.deleteSkill("reviewer");

    await expect(service.saveTemplate(draft)).rejects.toThrow(`references missing ${kind}: ${kind === "rule" ? "focused" : "reviewer"}`);
    const reconciledDraft = { ...draft, ruleIds: kind === "rule" ? ["keep-changes-focused"] : draft.ruleIds, skillIds: kind === "skill" ? ["builder"] : draft.skillIds };
    await service.saveTemplate(reconciledDraft);

    const store = await service.list();
    expect(store.templates.find(saved => saved.id === draft.id)).toEqual(reconciledDraft);
  });
});

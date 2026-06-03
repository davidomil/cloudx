import { describe, expect, it, vi } from "vitest";

import type { PluginRuleContribution, PluginSkillContribution, WorkspacePlugin } from "@cloudx/plugin-api";
import type { RulesSkillsStore } from "@cloudx/shared";

import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { syncPluginContributions } from "./pluginContributions.js";

type FakeCatalog = Pick<RulesSkillsCatalogService, "saveSystemRule" | "saveSystemSkill" | "list">;

describe("syncPluginContributions", () => {
  it("stores plugin rules and skills as system catalog entries", async () => {
    const catalog = fakeCatalog();

    await syncPluginContributions([
      plugin("alpha", { rules: [rule("alpha-ingest-evidence")], skills: [skill("alpha-search")] }),
      plugin("beta", { rules: [rule("beta-keep-citations")], skills: [skill("beta-ingest")] })
    ], catalog as RulesSkillsCatalogService);

    expect(catalog.saveSystemRule).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: "alpha-ingest-evidence",
      scope: "system"
    }));
    expect(catalog.saveSystemRule).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: "beta-keep-citations",
      scope: "system"
    }));
    expect(catalog.saveSystemSkill).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: "alpha-search",
      scope: "system"
    }));
    expect(catalog.saveSystemSkill).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: "beta-ingest",
      scope: "system"
    }));
    expect(catalog.list).not.toHaveBeenCalled();
  });

  it("returns the catalog unchanged when no plugin contributes rules or skills", async () => {
    const catalog = fakeCatalog();

    await syncPluginContributions([plugin("alpha", {})], catalog as RulesSkillsCatalogService);

    expect(catalog.saveSystemRule).not.toHaveBeenCalled();
    expect(catalog.saveSystemSkill).not.toHaveBeenCalled();
    expect(catalog.list).toHaveBeenCalledOnce();
  });

  it("requires contributed ids to be owned by the plugin id prefix", async () => {
    await expect(syncPluginContributions([plugin("alpha", { rules: [rule("ingest-evidence")] })], fakeCatalog() as RulesSkillsCatalogService)).rejects.toThrow(
      "Plugin alpha rule contribution must use the plugin id prefix"
    );
    await expect(syncPluginContributions([plugin("alpha", { skills: [skill("search")] })], fakeCatalog() as RulesSkillsCatalogService)).rejects.toThrow(
      "Plugin alpha skill contribution must use the plugin id prefix"
    );
  });

  it("rejects duplicate contributed ids before writing to the catalog", async () => {
    const catalog = fakeCatalog();

    await expect(syncPluginContributions([plugin("alpha", { rules: [rule("alpha-evidence"), rule("alpha-evidence")] })], catalog as RulesSkillsCatalogService)).rejects.toThrow(
      "CloudX system rule contribution alpha-evidence is already claimed by alpha"
    );
    await expect(syncPluginContributions([plugin("alpha", { skills: [skill("alpha-search"), skill("alpha-search")] })], catalog as RulesSkillsCatalogService)).rejects.toThrow(
      "CloudX system skill contribution alpha-search is already claimed by alpha"
    );
    expect(catalog.saveSystemRule).not.toHaveBeenCalled();
    expect(catalog.saveSystemSkill).not.toHaveBeenCalled();
  });
});

function fakeCatalog(): FakeCatalog {
  const emptyStore: RulesSkillsStore = {
    rules: [],
    systemRules: [],
    skills: [],
    systemSkills: [],
    templates: [],
    defaultTemplateId: undefined
  };
  return {
    saveSystemRule: vi.fn(async (rule: PluginRuleContribution) => ({
      ...emptyStore,
      systemRules: [{ ...rule, scope: "system" as const }]
    })),
    saveSystemSkill: vi.fn(async (skill: PluginSkillContribution) => ({
      ...emptyStore,
      systemSkills: [{ ...skill, scope: "system" as const }]
    })),
    list: vi.fn(async () => emptyStore)
  };
}

function plugin(id: string, contributions: { rules?: PluginRuleContribution[]; skills?: PluginSkillContribution[] }): WorkspacePlugin {
  return {
    id,
    acronym: id.slice(0, 3).toUpperCase(),
    displayName: id,
    description: `${id} plugin`,
    panelKind: "placeholder",
    creatable: false,
    requiresDirectory: false,
    actions: [],
    ruleContributions: contributions.rules,
    skillContributions: contributions.skills,
    createSession() {
      throw new Error("not used");
    },
    descriptor() {
      throw new Error("not used");
    }
  };
}

function rule(id: string): PluginRuleContribution {
  return {
    id,
    description: `${id} rule`,
    text: `Apply ${id}.`
  };
}

function skill(id: string): PluginSkillContribution {
  return {
    id,
    name: id,
    description: `${id} skill`,
    instructions: `Use ${id}.`
  };
}

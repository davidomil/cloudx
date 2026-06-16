import { describe, expect, it, vi } from "vitest";

import type { PluginRuleContribution, PluginSkillContribution, WorkspacePlugin } from "@cloudx/plugin-api";
import type { RulesSkillsStore } from "@cloudx/shared";

import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { syncPluginContributions } from "./pluginContributions.js";

type FakeCatalog = Pick<RulesSkillsCatalogService, "deleteRule" | "deleteSkill" | "deleteSystemRule" | "deleteSystemSkill" | "saveSystemRule" | "saveSystemSkill" | "list">;

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
    expect(catalog.list).toHaveBeenCalledOnce();
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

  it("rejects user-owned id conflicts before writing to the catalog", async () => {
    const catalog = fakeCatalog({
      rules: [rule("alpha-existing-rule")],
      skills: [skill("alpha-existing-skill")]
    });

    await expect(syncPluginContributions([
      plugin("alpha", {
        rules: [rule("alpha-existing-rule"), rule("alpha-new-rule")],
        skills: [skill("alpha-existing-skill"), skill("alpha-new-skill")]
      })
    ], catalog as RulesSkillsCatalogService)).rejects.toThrow(
      "Plugin contribution ids conflict with user-defined catalog entries: rule alpha-existing-rule, skill alpha-existing-skill"
    );
    expect(catalog.saveSystemRule).not.toHaveBeenCalled();
    expect(catalog.saveSystemSkill).not.toHaveBeenCalled();
    expect(catalog.list).toHaveBeenCalledOnce();
  });

  it("adopts plugin-declared legacy user contributions before writing system entries", async () => {
    const catalog = fakeCatalog({
      rules: [rule("alpha-existing-rule")],
      skills: [skill("alpha-existing-skill")]
    });

    await syncPluginContributions([
      plugin("alpha", {
        rules: [rule("alpha-existing-rule")],
        skills: [skill("alpha-existing-skill")],
        adoptUserRuleIds: ["alpha-existing-rule"],
        adoptUserSkillIds: ["alpha-existing-skill"]
      })
    ], catalog as RulesSkillsCatalogService);

    expect(catalog.deleteRule).toHaveBeenCalledWith("alpha-existing-rule");
    expect(catalog.deleteSkill).toHaveBeenCalledWith("alpha-existing-skill");
    expect(catalog.saveSystemRule).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha-existing-rule", scope: "system" }));
    expect(catalog.saveSystemSkill).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha-existing-skill", scope: "system" }));
  });

  it("prunes obsolete plugin-owned system contributions before writing current entries", async () => {
    const catalog = fakeCatalog({
      systemRules: [
        { ...rule("alpha-current-rule"), scope: "system" },
        { ...rule("alpha-old-rule"), scope: "system" },
        { ...rule("gamma-old-rule"), scope: "system" }
      ],
      systemSkills: [
        { ...skill("alpha-current-skill"), scope: "system" },
        { ...skill("alpha-old-skill"), scope: "system" },
        { ...skill("gamma-old-skill"), scope: "system" }
      ]
    });

    await syncPluginContributions([
      plugin("alpha", {
        rules: [rule("alpha-current-rule")],
        skills: [skill("alpha-current-skill")]
      })
    ], catalog as RulesSkillsCatalogService);

    expect(catalog.deleteSystemRule).toHaveBeenCalledTimes(1);
    expect(catalog.deleteSystemRule).toHaveBeenCalledWith("alpha-old-rule");
    expect(catalog.deleteSystemSkill).toHaveBeenCalledTimes(1);
    expect(catalog.deleteSystemSkill).toHaveBeenCalledWith("alpha-old-skill");
    expect(catalog.deleteSystemRule).not.toHaveBeenCalledWith("alpha-current-rule");
    expect(catalog.deleteSystemSkill).not.toHaveBeenCalledWith("alpha-current-skill");
    expect(catalog.deleteSystemRule).not.toHaveBeenCalledWith("gamma-old-rule");
    expect(catalog.deleteSystemSkill).not.toHaveBeenCalledWith("gamma-old-skill");
    expect(catalog.saveSystemRule).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha-current-rule", scope: "system" }));
    expect(catalog.saveSystemSkill).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha-current-skill", scope: "system" }));
  });

  it("emits debug logs for contribution sync, adoption, and pruning", async () => {
    const catalog = fakeCatalog({
      rules: [rule("alpha-current-rule")],
      systemSkills: [{ ...skill("alpha-old-skill"), scope: "system" }]
    });
    const logs: Array<{ fields: Record<string, unknown>; message?: string }> = [];

    await syncPluginContributions([
      plugin("alpha", {
        rules: [rule("alpha-current-rule")],
        skills: [skill("alpha-current-skill")],
        adoptUserRuleIds: ["alpha-current-rule"]
      })
    ], catalog as RulesSkillsCatalogService, { debug: (fields, message) => logs.push({ fields, message }) });

    expect(logs.map((entry) => entry.message)).toEqual(expect.arrayContaining([
      "Syncing plugin rule and skill contributions.",
      "Adopting user rule contribution for plugin-owned system rule.",
      "Pruning obsolete plugin-owned system skill.",
      "Synced plugin rule and skill contributions."
    ]));
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ fields: expect.objectContaining({ pluginCount: 1, ruleCount: 1, skillCount: 1 }) }),
      expect.objectContaining({ fields: expect.objectContaining({ ruleId: "alpha-current-rule" }) }),
      expect.objectContaining({ fields: expect.objectContaining({ skillId: "alpha-old-skill" }) }),
      expect.objectContaining({ fields: expect.objectContaining({ pruned: true }) })
    ]));
  });
});

function fakeCatalog(overrides: Partial<RulesSkillsStore> = {}): FakeCatalog {
  const emptyStore: RulesSkillsStore = {
    rules: [],
    systemRules: [],
    skills: [],
    systemSkills: [],
    templates: [],
    defaultTemplateId: undefined,
    ...overrides
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
    deleteRule: vi.fn(async () => emptyStore),
    deleteSkill: vi.fn(async () => emptyStore),
    deleteSystemRule: vi.fn(async () => emptyStore),
    deleteSystemSkill: vi.fn(async () => emptyStore),
    list: vi.fn(async () => emptyStore)
  };
}

function plugin(
  id: string,
  contributions: { adoptUserRuleIds?: string[]; adoptUserSkillIds?: string[]; rules?: PluginRuleContribution[]; skills?: PluginSkillContribution[] }
): WorkspacePlugin {
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
    adoptUserRuleContributionIds: contributions.adoptUserRuleIds,
    adoptUserSkillContributionIds: contributions.adoptUserSkillIds,
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

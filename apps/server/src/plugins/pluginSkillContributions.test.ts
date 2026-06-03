import { describe, expect, it, vi } from "vitest";

import type { PluginSkillContribution, WorkspacePlugin } from "@cloudx/plugin-api";
import type { RulesSkillsStore } from "@cloudx/shared";

import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { syncPluginSkillContributions } from "./pluginSkillContributions.js";

type FakeCatalog = Pick<RulesSkillsCatalogService, "saveSystemSkill" | "list">;

describe("syncPluginSkillContributions", () => {
  it("stores plugin skills as system skills through the shared catalog path", async () => {
    const catalog = fakeCatalog();

    await syncPluginSkillContributions([
      plugin("alpha", [skill("alpha-search")]),
      plugin("beta", [skill("beta-ingest")])
    ], catalog as RulesSkillsCatalogService);

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

  it("returns the catalog unchanged when no plugin contributes skills", async () => {
    const catalog = fakeCatalog();

    await syncPluginSkillContributions([plugin("alpha", [])], catalog as RulesSkillsCatalogService);

    expect(catalog.saveSystemSkill).not.toHaveBeenCalled();
    expect(catalog.list).toHaveBeenCalledOnce();
  });

  it("requires contributed skill ids to be owned by the plugin id prefix", async () => {
    await expect(syncPluginSkillContributions([plugin("alpha", [skill("search")])], fakeCatalog() as RulesSkillsCatalogService)).rejects.toThrow(
      "Plugin alpha skill contribution must use the plugin id prefix"
    );
  });

  it("rejects duplicate contributed skill ids before writing to the catalog", async () => {
    const catalog = fakeCatalog();

    await expect(syncPluginSkillContributions([plugin("alpha", [skill("alpha-search"), skill("alpha-search")])], catalog as RulesSkillsCatalogService)).rejects.toThrow(
      "CloudX system skill contribution alpha-search is already claimed by alpha"
    );
    expect(catalog.saveSystemSkill).not.toHaveBeenCalled();
  });
});

function fakeCatalog(): FakeCatalog {
  const emptyStore: RulesSkillsStore = {
    rules: [],
    skills: [],
    systemSkills: [],
    templates: [],
    defaultTemplateId: undefined
  };
  return {
    saveSystemSkill: vi.fn(async (skill: PluginSkillContribution) => ({
      ...emptyStore,
      systemSkills: [{ ...skill, scope: "system" as const }]
    })),
    list: vi.fn(async () => emptyStore)
  };
}

function plugin(id: string, skillContributions: PluginSkillContribution[]): WorkspacePlugin {
  return {
    id,
    acronym: id.slice(0, 3).toUpperCase(),
    displayName: id,
    description: `${id} plugin`,
    panelKind: "placeholder",
    creatable: false,
    requiresDirectory: false,
    actions: [],
    skillContributions,
    createSession() {
      throw new Error("not used");
    },
    descriptor() {
      throw new Error("not used");
    }
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

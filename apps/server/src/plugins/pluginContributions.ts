import type { PluginRuleContribution, PluginSkillContribution, WorkspacePlugin } from "@cloudx/plugin-api";
import type { RulesSkillsStore } from "@cloudx/shared";

import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";

export async function syncPluginContributions(
  plugins: WorkspacePlugin[],
  rulesSkills: RulesSkillsCatalogService
): Promise<RulesSkillsStore> {
  const contributions = pluginContributions(plugins);
  let store: RulesSkillsStore | undefined;
  for (const rule of contributions.rules) {
    store = await rulesSkills.saveSystemRule(rule);
  }
  for (const skill of contributions.skills) {
    store = await rulesSkills.saveSystemSkill(skill);
  }
  return store ?? await rulesSkills.list();
}

function pluginContributions(plugins: WorkspacePlugin[]): { rules: PluginRuleContribution[]; skills: PluginSkillContribution[] } {
  return {
    rules: ownedContributions(plugins, (plugin) => plugin.ruleContributions ?? [], "rule"),
    skills: ownedContributions(plugins, (plugin) => plugin.skillContributions ?? [], "skill")
  };
}

function ownedContributions<T extends { id: string }>(
  plugins: WorkspacePlugin[],
  contributionsFor: (plugin: WorkspacePlugin) => T[],
  label: "rule" | "skill"
): Array<T & { scope: "system" }> {
  const ownerById = new Map<string, string>();
  const contributions: Array<T & { scope: "system" }> = [];
  for (const plugin of plugins) {
    for (const contribution of contributionsFor(plugin)) {
      if (!contribution.id.startsWith(`${plugin.id}-`)) {
        throw new Error(`Plugin ${plugin.id} ${label} contribution must use the plugin id prefix: ${contribution.id}`);
      }
      const existingOwner = ownerById.get(contribution.id);
      if (existingOwner) {
        throw new Error(`CloudX system ${label} contribution ${contribution.id} is already claimed by ${existingOwner}`);
      }
      ownerById.set(contribution.id, plugin.id);
      contributions.push({ ...contribution, scope: "system" });
    }
  }
  return contributions;
}

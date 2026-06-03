import type { PluginSkillContribution, WorkspacePlugin } from "@cloudx/plugin-api";
import type { RulesSkillsStore } from "@cloudx/shared";

import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";

export async function syncPluginSkillContributions(
  plugins: WorkspacePlugin[],
  rulesSkills: RulesSkillsCatalogService
): Promise<RulesSkillsStore> {
  let store: RulesSkillsStore | undefined;
  for (const skill of pluginSkillContributions(plugins)) {
    store = await rulesSkills.saveSystemSkill(skill);
  }
  return store ?? await rulesSkills.list();
}

function pluginSkillContributions(plugins: WorkspacePlugin[]): PluginSkillContribution[] {
  const ownerBySkillId = new Map<string, string>();
  const contributions: PluginSkillContribution[] = [];
  for (const plugin of plugins) {
    for (const skill of plugin.skillContributions ?? []) {
      if (!skill.id.startsWith(`${plugin.id}-`)) {
        throw new Error(`Plugin ${plugin.id} skill contribution must use the plugin id prefix: ${skill.id}`);
      }
      const existingOwner = ownerBySkillId.get(skill.id);
      if (existingOwner) {
        throw new Error(`CloudX system skill contribution ${skill.id} is already claimed by ${existingOwner}`);
      }
      ownerBySkillId.set(skill.id, plugin.id);
      contributions.push({ ...skill, scope: "system" });
    }
  }
  return contributions;
}

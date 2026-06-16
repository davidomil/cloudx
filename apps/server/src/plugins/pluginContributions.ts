import type { PluginRuleContribution, PluginSkillContribution, WorkspacePlugin } from "@cloudx/plugin-api";
import type { RulesSkillsStore } from "@cloudx/shared";

import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";

interface PluginContributionSet {
  pluginIds: Set<string>;
  rules: Array<PluginRuleContribution & { scope: "system" }>;
  skills: Array<PluginSkillContribution & { scope: "system" }>;
  ruleIds: Set<string>;
  skillIds: Set<string>;
  adoptUserRuleIds: Set<string>;
  adoptUserSkillIds: Set<string>;
}

interface PluginContributionLogger {
  debug?(fields: Record<string, unknown>, message?: string): void;
}

export async function syncPluginContributions(
  plugins: WorkspacePlugin[],
  rulesSkills: RulesSkillsCatalogService,
  logger?: PluginContributionLogger
): Promise<RulesSkillsStore> {
  const contributions = pluginContributions(plugins);
  logger?.debug?.(
    { pluginCount: plugins.length, ruleCount: contributions.rules.length, skillCount: contributions.skills.length },
    "Syncing plugin rule and skill contributions."
  );
  const initialStore = await rulesSkills.list();
  await assertNoUserContributionConflicts(contributions, rulesSkills, initialStore, logger);
  const pruned = await pruneObsoleteSystemContributions(contributions, rulesSkills, initialStore, logger);
  let store: RulesSkillsStore | undefined = pruned ? undefined : initialStore;
  for (const rule of contributions.rules) {
    store = await rulesSkills.saveSystemRule(rule);
  }
  for (const skill of contributions.skills) {
    store = await rulesSkills.saveSystemSkill(skill);
  }
  const syncedStore = store ?? await rulesSkills.list();
  logger?.debug?.(
    { pluginCount: plugins.length, ruleCount: contributions.rules.length, skillCount: contributions.skills.length, pruned },
    "Synced plugin rule and skill contributions."
  );
  return syncedStore;
}

async function assertNoUserContributionConflicts(
  contributions: PluginContributionSet,
  rulesSkills: RulesSkillsCatalogService,
  store: RulesSkillsStore,
  logger?: PluginContributionLogger
): Promise<void> {
  if (contributions.rules.length === 0 && contributions.skills.length === 0) {
    return;
  }
  const userRuleIds = new Set(store.rules.map((rule) => rule.id));
  const userSkillIds = new Set(store.skills.map((skill) => skill.id));
  const conflicts = [
    ...contributions.rules.filter((rule) => userRuleIds.has(rule.id) && !contributions.adoptUserRuleIds.has(rule.id)).map((rule) => `rule ${rule.id}`),
    ...contributions.skills.filter((skill) => userSkillIds.has(skill.id) && !contributions.adoptUserSkillIds.has(skill.id)).map((skill) => `skill ${skill.id}`)
  ];
  if (conflicts.length > 0) {
    throw new Error(
      `Plugin contribution ids conflict with user-defined catalog entries: ${conflicts.join(", ")}. ` +
      "Rename or remove the user-defined entry, or change the plugin contribution id."
    );
  }
  for (const rule of contributions.rules) {
    if (userRuleIds.has(rule.id) && contributions.adoptUserRuleIds.has(rule.id)) {
      logger?.debug?.({ ruleId: rule.id }, "Adopting user rule contribution for plugin-owned system rule.");
      await rulesSkills.deleteRule(rule.id);
    }
  }
  for (const skill of contributions.skills) {
    if (userSkillIds.has(skill.id) && contributions.adoptUserSkillIds.has(skill.id)) {
      logger?.debug?.({ skillId: skill.id }, "Adopting user skill contribution for plugin-owned system skill.");
      await rulesSkills.deleteSkill(skill.id);
    }
  }
}

async function pruneObsoleteSystemContributions(
  contributions: PluginContributionSet,
  rulesSkills: RulesSkillsCatalogService,
  store: RulesSkillsStore,
  logger?: PluginContributionLogger
): Promise<boolean> {
  let pruned = false;
  for (const rule of store.systemRules) {
    if (isOwnedBySyncedPlugin(rule.id, contributions.pluginIds) && !contributions.ruleIds.has(rule.id)) {
      logger?.debug?.({ ruleId: rule.id }, "Pruning obsolete plugin-owned system rule.");
      await rulesSkills.deleteSystemRule(rule.id);
      pruned = true;
    }
  }
  for (const skill of store.systemSkills) {
    if (isOwnedBySyncedPlugin(skill.id, contributions.pluginIds) && !contributions.skillIds.has(skill.id)) {
      logger?.debug?.({ skillId: skill.id }, "Pruning obsolete plugin-owned system skill.");
      await rulesSkills.deleteSystemSkill(skill.id);
      pruned = true;
    }
  }
  return pruned;
}

function pluginContributions(plugins: WorkspacePlugin[]): PluginContributionSet {
  const pluginIds = new Set(plugins.map((plugin) => plugin.id));
  const rules = ownedContributions(plugins, (plugin) => plugin.ruleContributions ?? [], "rule");
  const skills = ownedContributions(plugins, (plugin) => plugin.skillContributions ?? [], "skill");
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const skillIds = new Set(skills.map((skill) => skill.id));
  const adoptUserRuleIds = adoptedIds(plugins, "adoptUserRuleContributionIds", ruleIds, "rule");
  const adoptUserSkillIds = adoptedIds(plugins, "adoptUserSkillContributionIds", skillIds, "skill");
  return { pluginIds, rules, skills, ruleIds, skillIds, adoptUserRuleIds, adoptUserSkillIds };
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

function adoptedIds(
  plugins: WorkspacePlugin[],
  property: "adoptUserRuleContributionIds" | "adoptUserSkillContributionIds",
  contributedIds: Set<string>,
  label: "rule" | "skill"
): Set<string> {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    const declared = plugin[property] ?? [];
    for (const id of declared) {
      if (!id.startsWith(`${plugin.id}-`)) {
        throw new Error(`Plugin ${plugin.id} adopted user ${label} contribution must use the plugin id prefix: ${id}`);
      }
      if (!contributedIds.has(id)) {
        throw new Error(`Plugin ${plugin.id} adopted user ${label} contribution is not contributed by the plugin: ${id}`);
      }
      ids.add(id);
    }
  }
  return ids;
}

function isOwnedBySyncedPlugin(id: string, pluginIds: Set<string>): boolean {
  for (const pluginId of pluginIds) {
    if (id.startsWith(`${pluginId}-`)) {
      return true;
    }
  }
  return false;
}

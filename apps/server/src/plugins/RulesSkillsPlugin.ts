import type { CreatePluginSessionInput, HookDefinition, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";
import { RULES_SKILLS_PLUGIN_ID } from "@cloudx/shared";

import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";

export class RulesSkillsPlugin implements WorkspacePlugin {
  readonly id = RULES_SKILLS_PLUGIN_ID;
  readonly acronym = "RUL";
  readonly displayName = "Rules & Skills";
  readonly description = "Manages Codex rules, skills, and personality templates.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly configFields = [];
  readonly hooks: HookDefinition[];
  readonly uiContributions = [
    {
      id: "rules-skills.templatesPanel",
      owner: { kind: "plugin" as const, pluginId: RULES_SKILLS_PLUGIN_ID },
      slot: "plugin.panel" as const,
      renderer: "rules-skills.templates-panel" as const,
      title: "Rules & Skills Templates",
      targetPluginId: RULES_SKILLS_PLUGIN_ID
    },
    {
      id: "rules-skills.windowTemplate",
      owner: { kind: "plugin" as const, pluginId: RULES_SKILLS_PLUGIN_ID },
      slot: "window.settings.sections" as const,
      renderer: "rules-skills.window-template-section" as const,
      title: "Personality Template",
      order: 10
    }
  ];

  constructor(private readonly catalog: RulesSkillsCatalogService) {
    this.hooks = [
      {
        id: "rules-skills.catalog.list",
        owner: { kind: "plugin", pluginId: this.id },
        title: "List Rules Skills Catalog",
        description: "Return stored CloudX rules, skills, and personality templates.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ store: await this.catalog.list() })
      },
      {
        id: "rules-skills.templates.save",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Save Personality Template",
        description: "Create or update a rules/skills personality template.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            template: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                color: { type: "string", enum: ["green", "yellow", "red"] },
                ruleIds: { type: "array", items: { type: "string" } },
                skillIds: { type: "array", items: { type: "string" } }
              },
              required: ["id", "name", "color", "ruleIds", "skillIds"],
              additionalProperties: false
            }
          },
          required: ["template"],
          additionalProperties: false
        },
        execute: async (input) => ({ store: await this.catalog.saveTemplate(requireRecord(input.template, "template")) })
      },
      {
        id: "rules-skills.templates.delete",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Delete Personality Template",
        description: "Delete a rules/skills personality template.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: { templateId: { type: "string" } },
          required: ["templateId"],
          additionalProperties: false
        },
        execute: async (input) => ({ store: await this.catalog.deleteTemplate(requireString(input.templateId, "templateId")) })
      },
      {
        id: "rules-skills.templates.setDefault",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Set Default Personality Template",
        description: "Set the default rules/skills personality template.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: { templateId: { type: "string" } },
          additionalProperties: false
        },
        execute: async (input) => ({ store: await this.catalog.setDefaultTemplate(optionalString(input.templateId, "templateId")) })
      },
      {
        id: "rules-skills.rules.save",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Save Rule",
        description: "Create or update a CloudX rule.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            rule: {
              type: "object",
              properties: {
                id: { type: "string" },
                description: { type: "string" },
                text: { type: "string" }
              },
              required: ["text"],
              additionalProperties: false
            }
          },
          required: ["rule"],
          additionalProperties: false
        },
        execute: async (input) => ({ store: await this.catalog.saveRule(requireRecord(input.rule, "rule")) })
      },
      {
        id: "rules-skills.rules.delete",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Delete Rule",
        description: "Delete a CloudX rule and remove it from templates.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: { ruleId: { type: "string" } },
          required: ["ruleId"],
          additionalProperties: false
        },
        execute: async (input) => ({ store: await this.catalog.deleteRule(requireString(input.ruleId, "ruleId")) })
      },
      {
        id: "rules-skills.skills.createCloudxSkill",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Create CloudX Skill",
        description: "Create a CloudX skill in the folder-backed rules/skills catalog.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            skill: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                instructions: { type: "string" }
              },
              required: ["id", "name", "description", "instructions"],
              additionalProperties: false
            }
          },
          required: ["skill"],
          additionalProperties: false
        },
        execute: async (input) => ({ store: await this.catalog.saveSkill(requireRecord(input.skill, "skill"), { failIfExists: true }) })
      },
      {
        id: "rules-skills.skills.migrateToCloudx",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Migrate Skill To CloudX",
        description: "Import an existing Codex skill into the CloudX rules/skills catalog.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            sourcePath: { type: "string" },
            skillId: { type: "string" },
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" }
          },
          additionalProperties: false
        },
        execute: async (input) => ({ store: await this.catalog.migrateSkill({
          sourcePath: optionalString(input.sourcePath, "sourcePath"),
          skillId: optionalString(input.skillId, "skillId"),
          id: optionalString(input.id, "id"),
          name: optionalString(input.name, "name"),
          description: optionalString(input.description, "description")
        }) })
      }
    ];
  }

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new RulesSkillsSession(input.tab);
  }

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
      configFields: this.configFields,
      actions: this.actions,
      hooks: this.hooks,
      uiContributions: this.uiContributions
    };
  }
}

class RulesSkillsSession implements PluginSession {
  constructor(public readonly tab: CreatePluginSessionInput["tab"]) {}

  snapshot() {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.tab.status
    };
  }

  voiceContext() {
    return {
      kind: "rules-skills",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: "Rules and skills template manager."
    };
  }

  handleAction(): Record<string, unknown> {
    throw new Error("Rules & Skills does not expose tab actions.");
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, name);
}

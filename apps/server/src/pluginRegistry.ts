import type { PluginActionDefinition, WorkspacePlugin } from "@cloudx/plugin-api";
import { descriptorFromPlugin } from "@cloudx/plugin-api";
import type { PluginDescriptor, PluginId } from "@cloudx/shared";

export class PluginRegistry {
  private readonly plugins = new Map<PluginId, WorkspacePlugin>();

  register(plugin: WorkspacePlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  get(pluginId: PluginId): WorkspacePlugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }
    return plugin;
  }

  list(): PluginDescriptor[] {
    return Array.from(this.plugins.values()).map((plugin) => descriptorFromPlugin(plugin));
  }

  getVoiceAction(pluginId: PluginId, actionName: string): PluginActionDefinition {
    const action = this.getAction(pluginId, actionName);
    if (!action.voiceExposed) {
      throw new Error(`Action ${pluginId}.${actionName} is not voice-exposed.`);
    }
    return action;
  }

  getAction(pluginId: PluginId, actionName: string): PluginActionDefinition {
    const action = this.get(pluginId).actions.find((candidate) => candidate.name === actionName);
    if (!action) {
      throw new Error(`Plugin ${pluginId} does not export action ${actionName}.`);
    }
    return action;
  }

  validateVoiceInput(pluginId: PluginId, actionName: string, input: Record<string, unknown>): void {
    const action = this.getVoiceAction(pluginId, actionName);
    validateObjectSchema(action.inputSchema, input, `${pluginId}.${actionName}`);
  }

  validateInput(pluginId: PluginId, actionName: string, input: Record<string, unknown>): void {
    const action = this.getAction(pluginId, actionName);
    validateObjectSchema(action.inputSchema, input, `${pluginId}.${actionName}`);
  }
}

function validateObjectSchema(schema: PluginActionDefinition["inputSchema"], input: Record<string, unknown>, label: string): void {
  if (schema.type !== "object") {
    throw new Error(`Action schema ${label} must be an object schema.`);
  }
  const required = new Set(schema.required ?? []);
  for (const key of required) {
    if (!(key in input)) {
      throw new Error(`Action ${label} missing required input: ${key}`);
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new Error(`Action ${label} does not accept input: ${key}`);
      }
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties?.[key];
    if (!property) {
      continue;
    }
    if (property.enum && typeof value === "string" && !property.enum.includes(value)) {
      throw new Error(`Action ${label} input ${key} must be one of: ${property.enum.join(", ")}`);
    }
    if (property.type === "string" && typeof value !== "string") {
      throw new Error(`Action ${label} input ${key} must be a string.`);
    }
    if (property.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`Action ${label} input ${key} must be a number.`);
    }
    if (property.type === "boolean" && typeof value !== "boolean") {
      throw new Error(`Action ${label} input ${key} must be a boolean.`);
    }
  }
}

import type { PluginActionDefinition, WorkspacePlugin } from "@cloudx/plugin-api";
import { descriptorFromPlugin } from "@cloudx/plugin-api";
import type { PluginDescriptor, PluginId } from "@cloudx/shared";
import { assertObjectRecord, validateObjectSchema } from "./hooks/schema.js";

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

  values(): WorkspacePlugin[] {
    return Array.from(this.plugins.values());
  }

  getVoiceAction(pluginId: PluginId, actionName: string): PluginActionDefinition {
    const action = this.getAction(pluginId, actionName);
    if (!action.voiceExposed) {
      throw new Error(`Action ${pluginId}.${actionName} is not voice-exposed.`);
    }
    return action;
  }

  getDefaultVoiceAction(pluginId: PluginId): PluginActionDefinition | undefined {
    return this.get(pluginId).actions.find((action) => action.voiceExposed && action.defaultForVoice);
  }

  getUnhandledVoiceAction(pluginId: PluginId): PluginActionDefinition | undefined {
    return this.get(pluginId).actions.find((action) => action.voiceExposed && action.handlesUnhandledVoice);
  }

  getAction(pluginId: PluginId, actionName: string): PluginActionDefinition {
    const action = this.get(pluginId).actions.find((candidate) => candidate.name === actionName);
    if (!action) {
      throw new Error(`Plugin ${pluginId} does not export action ${actionName}.`);
    }
    return action;
  }

  updatesTabState(pluginId: PluginId, actionName: string): boolean {
    return this.getAction(pluginId, actionName).updatesTabState === true;
  }

  validateVoiceInput(pluginId: PluginId, actionName: string, input: Record<string, unknown>): void {
    const action = this.getVoiceAction(pluginId, actionName);
    validateObjectSchema(action.inputSchema, input, `${pluginId}.${actionName}`);
  }

  sanitizeVoiceInput(pluginId: PluginId, actionName: string, input: Record<string, unknown>): Record<string, unknown> {
    const action = this.getVoiceAction(pluginId, actionName);
    const allowed = new Set(Object.keys(action.inputSchema.properties ?? {}));
    return Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.has(key) && value !== null && value !== undefined));
  }

  validateInput(pluginId: PluginId, actionName: string, input: Record<string, unknown>): void {
    const action = this.getAction(pluginId, actionName);
    validateObjectSchema(action.inputSchema, input, `${pluginId}.${actionName}`);
  }

  validateOutput(pluginId: PluginId, actionName: string, output: unknown): Record<string, unknown> {
    const action = this.getAction(pluginId, actionName);
    const normalizedOutput = output ?? {};
    assertObjectRecord(normalizedOutput, `${pluginId}.${actionName}`, "output");
    if (action.outputSchema) {
      validateObjectSchema(action.outputSchema, normalizedOutput, `${pluginId}.${actionName}`, "output");
    }
    return normalizedOutput;
  }
}

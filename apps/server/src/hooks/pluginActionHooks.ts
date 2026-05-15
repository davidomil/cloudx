import { pluginActionHookId } from "@cloudx/plugin-api";
import type { HookDefinition, PluginActionDefinition } from "@cloudx/plugin-api";

import type { PluginRegistry } from "../pluginRegistry.js";
import type { SessionStore } from "../sessionStore.js";
import type { HookRegistry } from "./HookRegistry.js";

export function registerPluginActionHooks(hooks: HookRegistry, plugins: PluginRegistry, sessions: SessionStore): void {
  for (const plugin of plugins.values()) {
    for (const action of plugin.actions) {
      hooks.register(actionHookDefinition(plugin.id, action, sessions));
    }
  }
}

function actionHookDefinition(pluginId: string, action: PluginActionDefinition, sessions: SessionStore): HookDefinition {
  const hookId = pluginActionHookId(pluginId, action.name);
  return {
    id: hookId,
    owner: { kind: "plugin", pluginId },
    title: action.name,
    description: action.description,
    inputSchema: action.inputSchema,
    exposures: action.voiceExposed ? ["plugin", "voice", "ui", "http"] : ["plugin", "ui", "http"],
    defaultForVoice: action.defaultForVoice,
    handlesUnhandledVoice: action.handlesUnhandledVoice,
    execute: (input, context) => sessions.executePluginHook(pluginId, hookId, action.name, context.targetTabId, input, context.caller)
  };
}

import { displayTitleFromIdentifier, pluginActionHookId } from "@cloudx/plugin-api";
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
    title: displayTitleFromIdentifier(action.name),
    description: action.description,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    exposures: [
      "plugin",
      "ui",
      "http",
      ...(action.voiceExposed ? ["voice" as const] : []),
      ...(action.automationExposed ? ["automation" as const] : [])
    ],
    automationSafety: action.automationSafety,
    defaultForVoice: action.defaultForVoice,
    handlesUnhandledVoice: action.handlesUnhandledVoice,
    execute: (input, context) => sessions.executePluginHook(pluginId, hookId, action.name, context.targetTabId, input, context.caller, context.signal)
  };
}

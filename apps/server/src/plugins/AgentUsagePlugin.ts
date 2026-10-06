import { descriptorFromPlugin, type HookDefinition, type PluginSession, type WorkspacePlugin } from "@cloudx/plugin-api";
import { AGENT_USAGE_HOOKS, AGENT_USAGE_PLUGIN_ID } from "@cloudx/shared";

import type { AgentUsageLedger } from "../agents/usage/AgentUsageLedger.js";
import type { AgentUsageService } from "../agents/usage/AgentUsageService.js";
import type { AgentPricing } from "../agents/usage/pricing.js";

const OWNER_IDS_SCHEMA = { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 200 } } as const;

// Serves token usage and cost for agent tabs, windows and Forge workers.
export class AgentUsagePlugin implements WorkspacePlugin {
  readonly id = AGENT_USAGE_PLUGIN_ID;
  readonly acronym = "USE";
  readonly displayName = "Agent Usage";
  readonly description = "Token usage and cost of Codex and Claude work per tab, window and Forge worker.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = false;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly hooks: HookDefinition[];

  constructor(usage: AgentUsageService, ledger: AgentUsageLedger, pricing: AgentPricing, liveTabIds: () => string[]) {
    const owner = { kind: "plugin" as const, pluginId: this.id };
    this.hooks = [
      {
        id: AGENT_USAGE_HOOKS.read, owner,
        title: "Read agent usage",
        description: "Tokens and cost for the given agent tabs and Forge workers, with their combined total.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: { type: "object", properties: { tabIds: OWNER_IDS_SCHEMA, forgeWorkerIds: OWNER_IDS_SCHEMA }, additionalProperties: false },
        execute: async (input) => {
          await ledger.prune(new Set(liveTabIds()));
          return { usage: await usage.read({ tabIds: input.tabIds as string[] | undefined, forgeWorkerIds: input.forgeWorkerIds as string[] | undefined }) };
        }
      },
      {
        id: AGENT_USAGE_HOOKS.readPricing, owner,
        title: "Read agent pricing",
        description: "The built-in model prices with their date, and the saved overrides.",
        exposures: ["ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ pricing: await pricing.state() })
      },
      {
        id: AGENT_USAGE_HOOKS.updatePricing, owner,
        title: "Update agent pricing",
        description: "Replace the per-model price overrides, in USD per million tokens.",
        exposures: ["ui", "http"],
        inputSchema: { type: "object", properties: { overrides: { type: "object" } }, required: ["overrides"], additionalProperties: false },
        execute: async (input) => ({ pricing: await pricing.updateOverrides(input.overrides) })
      }
    ];
  }

  descriptor() {
    return descriptorFromPlugin(this);
  }

  createSession(): PluginSession {
    throw new Error("Agent usage has no workspace tab.");
  }
}

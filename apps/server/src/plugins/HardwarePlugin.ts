import type { CreatePluginSessionInput, HardwareTypeProvider, HookDefinition, JsonSchemaLike, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";
import type { HardwareOwner, WorkspaceTab } from "@cloudx/shared";
import { HARDWARE_RULES, HARDWARE_SKILLS } from "../hardware/hardwareContributions.js";

const operator: HardwareOwner = { kind: "user", userId: "local" };
export const HARDWARE_DISCOVERY_ACTIONS = ["hardware.tags.list", "hardware.types.list", "hardware.statuses.list", "hardware.items.list", "hardware.items.get", "hardware.reservations.list"] as const;

export class HardwarePlugin implements WorkspacePlugin {
  readonly id = "hardware";
  readonly acronym = "HW";
  readonly displayName = "Hardware";
  readonly description = "Discover, reserve, and use shared SSH and UART hardware.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly ruleContributions = HARDWARE_RULES;
  readonly skillContributions = HARDWARE_SKILLS;
  readonly uiContributions = [{ id: "hardware.panel", owner: { kind: "plugin" as const, pluginId: "hardware" },
    slot: "plugin.panel" as const, renderer: "hardware.panel", title: "Hardware", targetPluginId: "hardware" }];
  readonly hooks: HookDefinition[];

  constructor(readonly hardwareTypes: HardwareTypeProvider<unknown>[], execute: (action: string, input: Record<string, unknown>, owner: HardwareOwner) => Promise<unknown>) {
    this.hooks = HARDWARE_DISCOVERY_ACTIONS.map(id => ({ id, owner: { kind: "plugin", pluginId: this.id }, title: id,
      description: `Read ${id.slice("hardware.".length).replaceAll(".", " ")} without opening hardware. Agent ownership requires the private Hardware helper.`,
      ...discoverySchemas(id), exposures: ["ui", "http", "automation"], automationSafety: "read",
      execute: async input => execute(id, input, operator) as Promise<Record<string, unknown>> }));
  }

  descriptor() {
    return { id: this.id, acronym: this.acronym, displayName: this.displayName, description: this.description,
      panelKind: this.panelKind, creatable: this.creatable, requiresDirectory: this.requiresDirectory, configFields: [], actions: this.actions };
  }

  createSession(input: CreatePluginSessionInput): PluginSession { return new HardwarePanelSession(input.tab); }
}

function discoverySchemas(action: typeof HARDWARE_DISCOVERY_ACTIONS[number]): Pick<HookDefinition, "inputSchema" | "outputSchema"> {
  const id: JsonSchemaLike = { type: "string", minLength: 1, maxLength: 128 };
  const ids: JsonSchemaLike = { type: "array", maxItems: 256, items: id };
  const page: Record<string, JsonSchemaLike> = {
    cursor: { type: "string", description: "Continue the original query at the same inventory revision." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum records returned on this page, from 1 to 200." }
  };
  const itemFilters: Record<string, JsonSchemaLike> = {
    text: { type: "string", maxLength: 4096, description: "Case-insensitive text within hardware names, descriptions, or notes." },
    typeIds: { ...ids, description: "Installed hardware type IDs that candidates must match." },
    tags: { type: "object", additionalProperties: false, description: "Required, alternative, and excluded capability tag IDs.", properties: { all: ids, any: ids, none: ids } },
    statuses: { type: "array", description: "Exact typed status values required of each candidate.", items: { type: "object", additionalProperties: false, required: ["definitionId", "equals", "requireFresh"], properties: { definitionId: id, equals: { type: ["boolean", "string"] }, requireFresh: { type: "boolean" } } } },
    availability: { type: "string", enum: ["available", "held", "ineligible"], description: "Computed eligibility and exclusive-hold state to select." },
    ownedByMe: { type: "boolean", description: "Select the admitted local user's own reservations; targetTabId does not change the owner." },
    enabled: { type: "boolean", description: "Select hardware with this enabled setting." }
  };
  if (action === "hardware.items.get") return {
    inputSchema: { type: "object", additionalProperties: false, required: ["hardwareId"], properties: { hardwareId: { ...id, description: "Stable hardware item ID whose current notes and access details to inspect." } } },
    outputSchema: { type: "object", properties: {
      item: { type: "object", description: "Complete current item, configuration references, notes, and revisions." },
      observations: { type: "array", items: { type: "object" }, description: "Typed status values with freshness and check outcomes." },
      reservation: { type: ["object", "null"], description: "Current exclusive owner and generation, if this group is reserved." },
      checkHold: { type: "object", description: "Current system status-check exclusion hold, when present." },
      availability: { type: "string", description: "Whether this item is available, held, or ineligible." },
      blockers: { type: "array", items: { type: "string" }, description: "Readiness and admission conditions that currently prevent reservation." },
      access: { type: "object", description: "Non-secret connection metadata without opening the endpoint." },
      aliases: { type: "array", items: { type: "object" }, description: "Other access items that share this physical resource's exclusive claim." },
      revision: { type: "integer", description: "Inventory revision observed by this read." }
    } }
  };
  const catalog = action.split(".")[1]!;
  const properties = { ...page, ...(action === "hardware.items.list" ? itemFilters : action === "hardware.reservations.list" ? {
    state: { type: "string", enum: ["preparing", "active", "releasing", "recovery_required", "checking"], description: "Reservation or system-check phase to select." }, ownedByMe: itemFilters.ownedByMe!
  } : {}) };
  return { inputSchema: { type: "object", additionalProperties: false, properties }, outputSchema: { type: "object", required: [catalog, "nextCursor", "revision"], properties: {
    [catalog]: { type: "array", items: { type: "object" }, description: `Current ${catalog} records matching this query and page.` },
    ...(catalog === "reservations" ? { checkHolds: { type: "array", items: { type: "object" }, description: "System status-check holds that exclude competing access." } } : {}),
    nextCursor: { type: ["string", "null"], description: "Opaque continuation cursor, or null when this query has no further page." },
    revision: { type: "integer", description: "Inventory revision bound to this query's pagination cursor." }
  } } };
}

class HardwarePanelSession implements PluginSession {
  constructor(readonly tab: WorkspaceTab) {}
  snapshot() { return { tabId: this.tab.id, pluginId: this.tab.pluginId, title: this.tab.title, cwd: this.tab.cwd, status: this.tab.status, state: {} }; }
  restoreInput(): Record<string, unknown> { return {}; }
  voiceContext() { return { kind: "hardware", cwd: this.tab.cwd, status: this.tab.status, summary: "Shared Hardware inventory and reservations." }; }
  handleAction(action: string): never { throw new Error(`Unsupported Hardware panel action: ${action}`); }
}

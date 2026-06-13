import { randomUUID } from "node:crypto";

import { descriptorFromTrigger, type TriggerDefinition } from "@cloudx/plugin-api";
import type { TriggerDescriptor, TriggerEvent, TriggerEventSource, TriggerExposure, TriggerId } from "@cloudx/shared";

import { validateObjectSchema } from "../hooks/schema.js";
import type { PluginRegistry } from "../pluginRegistry.js";

export type TriggerEventSubscriber = (event: TriggerEvent) => Promise<void> | void;

export interface TriggerRegistryOptions {
  recordEvent?: (event: TriggerEvent) => Promise<void> | void;
}

export class TriggerRegistry {
  private readonly triggers = new Map<TriggerId, TriggerDefinition>();
  private readonly subscribers = new Set<TriggerEventSubscriber>();

  constructor(private readonly options: TriggerRegistryOptions = {}) {}

  register(definition: TriggerDefinition): void {
    if (this.triggers.has(definition.id)) {
      throw new Error(`Trigger already registered: ${definition.id}`);
    }
    this.triggers.set(definition.id, definition);
  }

  list(): TriggerDescriptor[] {
    return Array.from(this.triggers.values()).map((trigger) => descriptorFromTrigger(trigger));
  }

  get(triggerId: TriggerId): TriggerDefinition {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) {
      throw new Error(`Unknown trigger: ${triggerId}`);
    }
    return trigger;
  }

  subscribe(subscriber: TriggerEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async emit(triggerId: TriggerId, payload: Record<string, unknown> = {}, source: TriggerEventSource): Promise<TriggerEvent> {
    const trigger = this.get(triggerId);
    assertExposure(trigger, exposureForSource(source));
    assertSourceOwnsTrigger(trigger, source);
    validateObjectSchema(trigger.payloadSchema, payload, trigger.id, "payload");
    const event: TriggerEvent = {
      id: randomUUID(),
      triggerId,
      source,
      payload,
      emittedAt: new Date().toISOString()
    };
    await this.options.recordEvent?.(event);
    for (const subscriber of this.subscribers) {
      await subscriber(event);
    }
    return event;
  }
}

export function registerPluginTriggers(registry: TriggerRegistry, plugins: PluginRegistry): void {
  if (typeof plugins.values !== "function") {
    return;
  }
  for (const plugin of plugins.values()) {
    for (const trigger of plugin.triggers ?? []) {
      registry.register(trigger);
    }
  }
}

function exposureForSource(source: TriggerEventSource): TriggerExposure {
  if (source.kind === "http") {
    return "http";
  }
  if (source.kind === "plugin") {
    return "plugin";
  }
  if (source.kind === "app" || source.kind === "test") {
    return "automation";
  }
  return "automation";
}

function assertSourceOwnsTrigger(trigger: TriggerDefinition, source: TriggerEventSource): void {
  if (source.kind !== "plugin" || trigger.owner.kind !== "plugin") {
    return;
  }
  if (trigger.owner.pluginId !== source.pluginId) {
    throw new Error(`Plugin ${source.pluginId ?? "unknown"} cannot emit trigger ${trigger.id}.`);
  }
}

function assertExposure(trigger: TriggerDefinition, exposure: TriggerExposure): void {
  if (!trigger.exposures.includes(exposure)) {
    const error = new Error(`Trigger ${trigger.id} is not exposed to ${exposure} callers.`) as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}

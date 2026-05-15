import type { HookCallContext, HookDefinition } from "@cloudx/plugin-api";
import { descriptorFromHook } from "@cloudx/plugin-api";
import type { HookDescriptor, HookExposure, HookId } from "@cloudx/shared";
import { validateObjectSchema } from "./schema.js";

export class HookRegistry {
  private readonly hooks = new Map<HookId, HookDefinition>();

  register(definition: HookDefinition): void {
    if (this.hooks.has(definition.id)) {
      throw new Error(`Hook already registered: ${definition.id}`);
    }
    this.hooks.set(definition.id, definition);
  }

  list(): HookDescriptor[] {
    return Array.from(this.hooks.values()).map((hook) => descriptorFromHook(hook));
  }

  get(hookId: HookId): HookDefinition {
    const hook = this.hooks.get(hookId);
    if (!hook) {
      throw new Error(`Unknown hook: ${hookId}`);
    }
    return hook;
  }

  async call(hookId: HookId, input: Record<string, unknown> = {}, context: HookCallContext): Promise<Record<string, unknown>> {
    const hook = this.get(hookId);
    this.assertExposure(hook, context.caller.kind);
    validateObjectSchema(hook.inputSchema, input, hook.id);
    const result = await hook.execute(input, context);
    return result ?? {};
  }

  private assertExposure(hook: HookDefinition, exposure: HookExposure): void {
    if (!hook.exposures.includes(exposure)) {
      throw new Error(`Hook ${hook.id} is not exposed to ${exposure} callers.`);
    }
  }
}

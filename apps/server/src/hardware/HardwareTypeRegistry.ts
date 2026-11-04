import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareEndpointInspection, JsonObject } from "@cloudx/shared";
import type { ValidateFunction } from "ajv";
import { compileHardwareSchema, HardwareProviderError, validateHardwareValue } from "./transports/HardwareValidation.js";

export interface HardwareTypeContribution {
  id: string;
  hardwareTypes?: HardwareTypeProvider<unknown>[];
}

interface RegisteredType {
  provider: HardwareTypeProvider<unknown>;
  config: ValidateFunction;
  operations: Map<string, { input: ValidateFunction; output: ValidateFunction }>;
}

export class HardwareTypeRegistry {
  private readonly types = new Map<string, RegisteredType>();

  constructor(plugins: Iterable<HardwareTypeContribution> = []) {
    for (const plugin of plugins) {
      for (const provider of plugin.hardwareTypes ?? []) this.register(plugin.id, provider);
    }
  }

  values(): HardwareTypeProvider<unknown>[] { return [...this.types.values()].map(({ provider }) => provider); }

  get(typeId: string): HardwareTypeProvider<unknown> {
    const registered = this.types.get(typeId);
    if (!registered) throw new HardwareProviderError("PROVIDER_UNAVAILABLE", `Hardware type ${typeId} is not installed.`);
    return registered.provider;
  }

  parseConfig(typeId: string, configVersion: number, value: unknown): unknown {
    const provider = this.get(typeId);
    if (provider.descriptor.configVersion !== configVersion) throw new HardwareProviderError("PROVIDER_UNAVAILABLE", `Hardware type ${typeId} does not support configuration version ${configVersion}.`);
    validateHardwareValue(this.types.get(typeId)!.config, value, `${typeId} configuration`);
    return provider.parseConfig(value);
  }

  inspectEndpoint(typeId: string, configVersion: number, value: unknown): Promise<HardwareEndpointInspection> {
    return this.get(typeId).inspectEndpoint(this.parseConfig(typeId, configVersion, value));
  }

  validateInput(typeId: string, operationId: string, value: unknown): asserts value is JsonObject {
    validateHardwareValue(this.operation(typeId, operationId).input, value, `${operationId} input`);
  }

  validateOutput(typeId: string, operationId: string, value: unknown): asserts value is JsonObject {
    validateHardwareValue(this.operation(typeId, operationId).output, value, `${operationId} output`);
  }

  private operation(typeId: string, operationId: string) {
    this.get(typeId);
    const operation = this.types.get(typeId)!.operations.get(operationId);
    if (!operation) throw new HardwareProviderError("INVALID_INPUT", `Hardware type ${typeId} does not provide operation ${operationId}.`);
    return operation;
  }

  private register(ownerPluginId: string, provider: HardwareTypeProvider<unknown>): void {
    const descriptor = provider.descriptor;
    const name = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
    const suffix = descriptor.id?.slice(ownerPluginId.length + 1);
    if (!name.test(ownerPluginId) || descriptor.ownerPluginId !== ownerPluginId || !descriptor.id.startsWith(`${ownerPluginId}.`) || !name.test(suffix)) {
      throw new HardwareProviderError("INVALID_PROVIDER", `Hardware type ${descriptor.id} must be namespaced to its owning plugin ${ownerPluginId}.`);
    }
    if (descriptor.apiVersion !== 1 || !Number.isSafeInteger(descriptor.configVersion) || descriptor.configVersion < 1) {
      throw new HardwareProviderError("INVALID_PROVIDER", `Hardware type ${descriptor.id} has an unsupported API or configuration version.`);
    }
    if (this.types.has(descriptor.id)) throw new HardwareProviderError("INVALID_PROVIDER", `Duplicate hardware type ${descriptor.id}.`);
    if (!descriptor.displayName?.trim() || !descriptor.description?.trim() || descriptor.operations.length > 100) {
      throw new HardwareProviderError("INVALID_PROVIDER", `Hardware type ${descriptor.id} needs a display name, description, and at most 100 operations.`);
    }
    for (const method of ["parseConfig", "inspectEndpoint", "describeAccess", "connect"] as const) {
      if (typeof provider[method] !== "function") throw new HardwareProviderError("INVALID_PROVIDER", `Hardware type ${descriptor.id} is missing ${method}.`);
    }
    const config = compileHardwareSchema(descriptor.configSchema, `${descriptor.id} configuration schema`);
    const operations = new Map<string, { input: ValidateFunction; output: ValidateFunction }>();
    for (const operation of descriptor.operations) {
      if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(operation.id) || operations.has(operation.id) || !operation.description?.trim()) {
        throw new HardwareProviderError("INVALID_PROVIDER", `Hardware type ${descriptor.id} has an invalid or duplicate operation ${operation.id}.`);
      }
      operations.set(operation.id, {
        input: compileHardwareSchema(operation.inputSchema, `${operation.id} input schema`),
        output: compileHardwareSchema(operation.outputSchema, `${operation.id} output schema`)
      });
    }
    this.types.set(descriptor.id, { provider, config, operations });
  }
}

import type { HardwareAccessDescription, HardwareEndpointInspection, HardwareReservation, HardwareTypeDescriptor, JsonObject, ProviderOutcome } from "@cloudx/shared";

export interface HardwareAccessContext {
  reservation: HardwareReservation;
  signal: AbortSignal;
  resolveCredential(refId: string): Promise<string>;
  recordEvent(event: { kind: string; detail: JsonObject }): Promise<void>;
  registerCleanup(close: (signal: AbortSignal) => Promise<ProviderOutcome<null>>): void;
}

export interface HardwareConnection {
  invoke(operationId: string, input: JsonObject, signal: AbortSignal): Promise<ProviderOutcome<JsonObject>>;
  close(signal: AbortSignal): Promise<ProviderOutcome<null>>;
}

export interface HardwareTypeProvider<Config> {
  readonly descriptor: HardwareTypeDescriptor;
  parseConfig(value: unknown): Config;
  inspectEndpoint(config: Config): Promise<HardwareEndpointInspection>;
  describeAccess(config: Config): HardwareAccessDescription;
  connect(config: Config, context: HardwareAccessContext): Promise<ProviderOutcome<HardwareConnection>>;
  registerKey?(config: Config, input: JsonObject, context: HardwareAccessContext): Promise<ProviderOutcome<JsonObject>>;
}

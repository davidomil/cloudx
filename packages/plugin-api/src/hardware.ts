import type { HardwareAccessDescription, HardwareConnectionResult, HardwareEndpointInspection, HardwareReservation, HardwareTypeDescriptor, JsonObject, ProviderOutcome } from "@cloudx/shared";

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

export type HardwareConnectionCheckContext = Pick<HardwareAccessContext, "signal" | "resolveCredential" | "registerCleanup">;

export interface HardwareTypeProvider<Config> {
  readonly descriptor: HardwareTypeDescriptor;
  parseConfig(value: unknown): Config;
  inspectEndpoint(config: Config): Promise<HardwareEndpointInspection>;
  describeAccess(config: Config): HardwareAccessDescription;
  connect(config: Config, context: HardwareAccessContext): Promise<ProviderOutcome<HardwareConnection>>;
  checkConnection?(config: Config, context: HardwareConnectionCheckContext): Promise<ProviderOutcome<HardwareConnectionResult>>;
  setupKey?(config: Config, input: JsonObject, context: HardwareConnectionCheckContext): Promise<ProviderOutcome<JsonObject>>;
  registerKey?(config: Config, input: JsonObject, context: HardwareAccessContext): Promise<ProviderOutcome<JsonObject>>;
}

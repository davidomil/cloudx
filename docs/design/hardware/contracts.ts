// Proposed contracts. This file is a design artifact, not a registered plugin.
// All external inputs and provider outputs also require runtime schema validation.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type JsonSchema = JsonObject; // JSON Schema draft 2020-12, without remote refs.
export type StatusValue = boolean | string;

export interface CapabilityTag {
  id: string;
  revision: number;
  label: string;
  description: string;
}

export interface PhysicalResource {
  id: string;
  revision: number;
  name: string;
}

export interface BashScript {
  source: string;
  cwd: string; // An absolute, host-policy-approved directory.
  timeoutMs: number;
  maxOutputBytes: number;
  credentialRefIds: string[];
}

export interface StatusDefinition {
  id: string;
  revision: number;
  label: string;
  valueType: "boolean" | "text" | "enum";
  enumValues?: string[]; // Required only for enum.
}

export type StatusBinding = {
  revision: number;
  definitionId: string;
  requiredForReserve?: { equals: StatusValue };
} & (
  | { source: "manual"; value: StatusValue }
  | { source: "command"; script: BashScript; maxAgeMs: number; intervalMs: number | null }
);

export interface StatusObservation {
  definitionId: string;
  bindingRevision: number;
  state: "known" | "unknown" | "error";
  value?: StatusValue;
  observedAt: string;
  expiresAt?: string;
  errorCode?: string;
  runId?: string;
}

export interface HardwareItem {
  id: string;
  revision: number;
  name: string;
  description: string;
  enabled: boolean;
  physicalResourceId: string;
  typeId: string;
  configVersion: number;
  config: JsonObject;
  tagIds: string[];
  notes: string;
  notesRevision: number;
  statuses: StatusBinding[];
  hooks: { beforeReserve?: BashScript; onRelease?: BashScript };
}

export type AgentOwner = {
  kind: "agent";
  tabId: string;
  providerId: "codex" | "claude";
  executionId: string;
  ownerPluginId?: string;
  logicalRunId?: string;
  workerId?: string;
  attemptId?: string;
};

export type HardwareOwner = AgentOwner | { kind: "user"; userId: string };
export type ReservationState = "preparing" | "active" | "releasing" | "recovery_required";

export interface ReservationRef {
  reservationId: string;
  generation: number;
}

export interface HardwareReservation extends ReservationRef {
  revision: number;
  hardwareId: string;
  owner: HardwareOwner;
  state: ReservationState;
  resourceKeys: string[];
  purpose: string;
  acquiredItemRevision: number;
  acquiredNotesRevision: number;
  acquiredAt: string;
  updatedAt: string;
  lastOwnerObservation: "active" | "confirmed_ended" | "unknown";
  lastOwnerObservedAt?: string;
  activeOperationIds: string[];
  recoveryReason?: string;
}

// Server-only retained acquisition data. Public responses use HardwareReservation.
export interface HardwareReservationRecord extends HardwareReservation {
  acquiredItem: HardwareItem;
  preparationRunId?: string;
  releaseRunId?: string;
}

export interface HardwareCheckHold {
  kind: "system_check";
  runId: string;
  revision: number;
  generation: number;
  hardwareId: string;
  resourceKeys: string[];
  state: "checking" | "recovery_required";
  bindingRevisions: { definitionId: string; revision: number }[];
  startedAt: string;
  recoveryReason?: string;
}

export interface HardwareFilter {
  text?: string;
  typeIds?: string[];
  tags?: { all?: string[]; any?: string[]; none?: string[] };
  statuses?: { definitionId: string; equals: StatusValue; requireFresh: boolean }[];
  availability?: "available" | "held" | "ineligible";
  ownedByMe?: boolean;
  enabled?: boolean;
  limit?: number;
  cursor?: string;
}

export interface HardwareSummary {
  item: HardwareItem;
  observations: StatusObservation[];
  reservation: HardwareReservation | null;
  availability: "available" | "held" | "ineligible";
  blockers: string[];
  checkHold?: HardwareCheckHold;
}

export interface ReserveHardware {
  requestId: string;
  hardwareId: string;
  expectedItemRevision: number;
  purpose: string;
}

export interface ReleaseHardware extends ReservationRef {
  requestId: string;
}

export type HardwareHoldRef =
  | ({ kind: "reservation" } & ReservationRef)
  | { kind: "system_check"; runId: string; generation: number };

export interface ForceReleaseHardware {
  requestId: string;
  target: HardwareHoldRef;
  expectedHoldRevision: number;
  reason: string;
  acceptUnresolvedExternalActivity: boolean;
}

export interface HardwareOperationDescriptor {
  id: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export interface HardwareTypeDescriptor {
  id: string;
  ownerPluginId: string;
  apiVersion: 1;
  configVersion: number;
  displayName: string;
  description: string;
  configSchema: JsonSchema;
  operations: HardwareOperationDescriptor[];
}

export interface HardwareAccessDescription {
  summary: string;
  details: JsonObject; // Public connection metadata. Never private key bytes.
}

export interface HardwareEndpointInspection {
  resourceKeys: string[];
  ready: boolean;
  blockers: string[];
}

// This server-side envelope drives recovery independently of type-specific JSON.
// A known command exit failure is completed with its observed domain result.
export type ProviderOutcome<T> =
  | { state: "completed"; value: T }
  | { state: "failed"; effects: "none" | "settled"; error: { code: string; message: string } }
  | { state: "unknown"; error: { code: string; message: string } };

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

// New extension point in @cloudx/plugin-api. HardwareService calls these methods.
export interface HardwareTypeProvider<Config> {
  readonly descriptor: HardwareTypeDescriptor;
  parseConfig(value: unknown): Config;
  inspectEndpoint(config: Config): Promise<HardwareEndpointInspection>;
  describeAccess(config: Config): HardwareAccessDescription;
  connect(config: Config, context: HardwareAccessContext): Promise<ProviderOutcome<HardwareConnection>>;
}

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  auth: { kind: "agent"; socketPath: string } | { kind: "identity_file"; path: string };
  knownHostsFile: string;
  connectTimeoutMs: number;
}

export interface UartConfig {
  devicePath: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: "none" | "even" | "odd";
  flowControl: "none" | "rtscts";
}

export interface InvokeHardware extends ReservationRef {
  requestId: string;
  operationId: string;
  input: JsonObject;
}

export interface OperationReceipt {
  requestId: string;
  runId: string;
  reservation?: ReservationRef;
  state: "running" | "succeeded" | "failed" | "unknown";
  result?: JsonObject;
  error?: { code: string; message: string };
  startedAt: string;
  finishedAt?: string;
}

// Proposed WorkspacePlugin addition, separate from the existing UI/session API.
export interface HardwareTypeContributions {
  hardwareTypes?: HardwareTypeProvider<unknown>[];
}

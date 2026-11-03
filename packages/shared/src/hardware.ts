// Hardware records shared by the server, native panel, and agent helper.

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
  accessState?: "closed" | "opening" | "open" | "closing" | "unknown";
}

// Server-only retained acquisition data. Public responses use HardwareReservation.
export interface HardwareReservationRecord extends HardwareReservation {
  acquiredItem: HardwareItem;
  preparationRunId?: string;
  releaseRunId?: string;
  recoveryCause?: "owner" | "effects" | "hook" | "cleanup" | "restart";
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
  outputPruned?: { at: string; reason: "age" | "count" | "budget" };
}

export interface HardwareHistoryEntry {
  id: string;
  at: string;
  kind: string;
  detail: string;
  hardwareId?: string;
  reservationId?: string;
  runId?: string;
  owner?: HardwareOwner;
}

export interface HardwareAgentReadiness {
  tabId: string;
  providerId: "codex" | "claude";
  executionId?: string;
  state: "ready" | "relaunch_required" | "unavailable";
  reason?: string;
}

export interface HardwareRetentionSettings {
  completedMaxAgeMs: number;
  completedMaxEntries: number;
  outputMaxBytes: number;
  snapshotMaxCompletedReceipts: number;
}

export interface HardwareStateView {
  revision: number;
  items: HardwareSummary[];
  tags: CapabilityTag[];
  groups: PhysicalResource[];
  types: HardwareTypeDescriptor[];
  statusDefinitions: StatusDefinition[];
  reservations: HardwareReservation[];
  checkHolds: HardwareCheckHold[];
  receipts: OperationReceipt[];
  history: HardwareHistoryEntry[];
  currentOwner: HardwareOwner;
  readiness: { state: "ready" | "unavailable"; reason?: string };
  agentReadiness?: HardwareAgentReadiness[];
  retention?: HardwareRetentionSettings;
}

export type HardwareItemDraft = Omit<HardwareItem, "id" | "revision" | "notesRevision">;

export interface CreateHardwareItem {
  requestId: string;
  item: HardwareItemDraft;
  newGroupName?: string;
}

export interface UpdateHardwareItem {
  requestId: string;
  hardwareId: string;
  expectedItemRevision: number;
  patch: Partial<HardwareItemDraft>;
}

export interface SetHardwareStatus {
  requestId: string;
  hardwareId: string;
  expectedItemRevision: number;
  definitionId: string;
  value: StatusValue;
}

export interface RefreshHardwareStatuses extends Partial<ReservationRef> {
  requestId: string;
  hardwareId: string;
  statusIds?: string[];
}

export interface HardwareMutationResult {
  receipt: OperationReceipt;
  reservation?: HardwareReservation;
}

export function hardwareRecord(value: unknown, label = "Hardware input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

export function hardwareText(value: unknown, label: string, maximum = 4096, empty = false): string {
  if (typeof value !== "string" || !empty && !value.trim() || value.length > maximum || value.includes("\0"))
    throw new Error(`${label} must contain ${empty ? "0" : "1"} to ${maximum} characters without NUL.`);
  return value;
}

export function hardwareId(value: unknown, label = "Hardware ID"): string {
  const id = hardwareText(value, label, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) throw new Error(`${label} contains unsupported characters.`);
  return id;
}

export function hardwareInteger(value: unknown, label: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return Number(value);
}

export function parseHardwareOwner(value: unknown): HardwareOwner {
  const owner = hardwareRecord(value, "Hardware owner");
  if (Object.keys(owner).some(key => !(owner.kind === "user" ? ["kind", "userId"] : ["kind", "tabId", "providerId", "executionId", "ownerPluginId", "logicalRunId", "workerId", "attemptId"]).includes(key))) throw new Error("Hardware owner contains unknown fields.");
  if (owner.kind === "user") return { kind: "user", userId: hardwareId(owner.userId, "User ID") };
  if (owner.kind !== "agent" || !["codex", "claude"].includes(String(owner.providerId))) throw new Error("A supported exact hardware owner is required.");
  const result: AgentOwner = { kind: "agent", tabId: hardwareId(owner.tabId, "Tab ID"), providerId: owner.providerId as AgentOwner["providerId"], executionId: hardwareId(owner.executionId, "Execution ID") };
  for (const field of ["ownerPluginId", "logicalRunId", "workerId", "attemptId"] as const) if (owner[field] !== undefined) result[field] = hardwareId(owner[field], field);
  if (Boolean(result.ownerPluginId) !== Boolean(result.logicalRunId) || Boolean(result.ownerPluginId) !== Boolean(result.attemptId)) throw new Error("Managed hardware owners require owner plugin, logical run, and attempt identity together.");
  return result;
}

export function parseHardwareScript(value: unknown): BashScript {
  const script = hardwareRecord(value, "Bash script");
  if (Object.keys(script).some(key => !["source", "cwd", "timeoutMs", "maxOutputBytes", "credentialRefIds"].includes(key))) throw new Error("Bash script contains unknown fields.");
  const cwd = hardwareText(script.cwd, "Script working directory", 4096);
  if (!cwd.startsWith("/")) throw new Error("Script working directory must be absolute.");
  if (!Array.isArray(script.credentialRefIds) || script.credentialRefIds.length > 32) throw new Error("Script credential references must be a bounded list.");
  const credentialRefIds = script.credentialRefIds.map(id => hardwareId(id, "Credential reference"));
  if (new Set(credentialRefIds.map(id => id.toUpperCase().replace(/[^A-Z0-9]/g, "_"))).size !== credentialRefIds.length) throw new Error("Script credential references must have unique environment names.");
  return { source: hardwareText(script.source, "Script source", 256 * 1024), cwd, timeoutMs: hardwareInteger(script.timeoutMs, "Script deadline", 1, 3_600_000), maxOutputBytes: hardwareInteger(script.maxOutputBytes, "Script output bound", 1, 1024 * 1024), credentialRefIds };
}

export function validateHardwareStatusValue(value: unknown, definition: StatusDefinition): asserts value is StatusValue {
  if (definition.valueType === "boolean" ? typeof value !== "boolean" : typeof value !== "string" || value.length > 4096 || definition.valueType === "enum" && !definition.enumValues?.includes(value))
    throw new Error(`Status ${definition.label} requires its declared ${definition.valueType} value.`);
}

export function parseHardwareItem(value: unknown): HardwareItem {
  const item = hardwareRecord(value, "Hardware item");
  if (Object.keys(item).some(key => !["id", "revision", "name", "description", "enabled", "physicalResourceId", "typeId", "configVersion", "config", "tagIds", "notes", "notesRevision", "statuses", "hooks"].includes(key))) throw new Error("Hardware item contains unknown fields.");
  if (typeof item.enabled !== "boolean" || !Array.isArray(item.tagIds) || item.tagIds.length > 256 || !Array.isArray(item.statuses) || item.statuses.length > 128) throw new Error("Hardware flags, tags, or statuses are invalid.");
  const config = hardwareRecord(item.config, "Connection configuration");
  validateHardwareJson(config);
  const hooks = hardwareRecord(item.hooks, "Hardware hooks");
  if (Object.keys(hooks).some(key => !["beforeReserve", "onRelease"].includes(key))) throw new Error("Unknown hardware hook.");
  const statuses = item.statuses.map(value => {
    const binding = hardwareRecord(value, "Status binding");
    if (Object.keys(binding).some(key => !["revision", "definitionId", "requiredForReserve", "source", ...(binding.source === "manual" ? ["value"] : ["script", "maxAgeMs", "intervalMs"])].includes(key))) throw new Error("Status binding contains unknown fields.");
    const base = { revision: hardwareInteger(binding.revision, "Binding revision"), definitionId: hardwareId(binding.definitionId, "Status definition") };
    const rawRequirement = binding.requiredForReserve === undefined ? undefined : hardwareRecord(binding.requiredForReserve);
    if (rawRequirement && Object.keys(rawRequirement).some(key => key !== "equals")) throw new Error("Status requirement contains unknown fields.");
    const requirement = rawRequirement === undefined ? {} : { requiredForReserve: { equals: hardwareStatusPrimitive(rawRequirement.equals) } };
    if (binding.source === "manual") return { ...base, ...requirement, source: "manual" as const, value: hardwareStatusPrimitive(binding.value) };
    if (binding.source !== "command") throw new Error("Status source must be manual or command.");
    return { ...base, ...requirement, source: "command" as const, script: parseHardwareScript(binding.script), maxAgeMs: hardwareInteger(binding.maxAgeMs, "Observation maximum age", 1, 86_400_000), intervalMs: binding.intervalMs === null ? null : hardwareInteger(binding.intervalMs, "Check interval", 1000, 86_400_000) };
  });
  if (new Set(statuses.map(binding => binding.definitionId)).size !== statuses.length) throw new Error("Each item can bind a status definition once.");
  const tagIds = item.tagIds.map(id => hardwareId(id, "Tag ID"));
  if (new Set(tagIds).size !== tagIds.length) throw new Error("Item tags must be unique.");
  return { id: hardwareId(item.id), revision: hardwareInteger(item.revision, "Item revision"), name: hardwareText(item.name, "Hardware name", 200), description: hardwareText(item.description, "Hardware description", 4096, true), enabled: item.enabled, physicalResourceId: hardwareId(item.physicalResourceId, "Physical resource"), typeId: hardwareId(item.typeId, "Type ID"), configVersion: hardwareInteger(item.configVersion, "Configuration version"), config: config as JsonObject, tagIds, notes: hardwareText(item.notes, "Hardware notes", 128 * 1024, true), notesRevision: hardwareInteger(item.notesRevision, "Notes revision"), statuses, hooks: { ...(hooks.beforeReserve === undefined ? {} : { beforeReserve: parseHardwareScript(hooks.beforeReserve) }), ...(hooks.onRelease === undefined ? {} : { onRelease: parseHardwareScript(hooks.onRelease) }) } };
}

export function hardwareStatusPrimitive(value: unknown): StatusValue {
  if (typeof value !== "boolean" && (typeof value !== "string" || value.length > 4096)) throw new Error("Status values must be a boolean or bounded text.");
  return value as StatusValue;
}

export function validateHardwareJson(value: unknown): asserts value is Json {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (++nodes > 50_000 || depth > 16) throw new Error("Hardware JSON exceeds its complexity bound.");
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string" && candidate.length <= 1024 * 1024 || typeof candidate === "number" && Number.isFinite(candidate)) return;
    if (Array.isArray(candidate)) { candidate.forEach(child => visit(child, depth + 1)); return; }
    if (candidate && typeof candidate === "object" && Object.getPrototypeOf(candidate) === Object.prototype) { Object.values(candidate).forEach(child => visit(child, depth + 1)); return; }
    throw new Error("Hardware data must contain finite JSON values.");
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) throw new Error("Hardware JSON exceeds its byte bound.");
}

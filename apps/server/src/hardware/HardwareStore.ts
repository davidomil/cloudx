import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hardwareId, hardwareInteger, hardwareRecord, hardwareText, parseHardwareItem, parseHardwareOwner, validateHardwareJson, validateHardwareStatusValue, type CapabilityTag, type HardwareCheckHold, type HardwareHistoryEntry, type HardwareHoldRef, type HardwareItem, type HardwareOwner, type HardwareReservationRecord, type OperationReceipt, type PhysicalResource, type StatusDefinition, type StatusObservation } from "@cloudx/shared";
import { requireSafeDirectory } from "../jsonStateFile.js";
import { HardwareError, requireHardware } from "./HardwareError.js";
import { HardwareWriterLease } from "./HardwareWriterLease.js";
import { HARDWARE_STATE_BYTES } from "./HardwareCapacity.js";

export interface StoredHardwareReceipt { owner: HardwareOwner; action: string; digest: string; receipt: OperationReceipt; finalCleanupTarget?: HardwareHoldRef }
export interface HardwareStoredState {
  schemaVersion: 1;
  revision: number;
  nextGeneration: number;
  items: HardwareItem[];
  tags: CapabilityTag[];
  groups: PhysicalResource[];
  statusDefinitions: StatusDefinition[];
  observations: Record<string, StatusObservation[]>;
  endpointKeys: Record<string, string[]>;
  reservations: HardwareReservationRecord[];
  checkHolds: HardwareCheckHold[];
  receipts: StoredHardwareReceipt[];
  history: HardwareHistoryEntry[];
}

export const emptyHardwareState = (): HardwareStoredState => ({ schemaVersion: 1, revision: 0, nextGeneration: 1, items: [], tags: [], groups: [], statusDefinitions: [], observations: {}, endpointKeys: {}, reservations: [], checkHolds: [], receipts: [], history: [] });

export class HardwareStore {
  private readonly directory: string;
  private readonly writer: HardwareWriterLease;
  constructor(private readonly dataDir: string, onWriterLost?: (error: HardwareError) => void) { this.directory = path.join(path.resolve(dataDir), "hardware"); this.writer = new HardwareWriterLease(onWriterLost); }

  async init(): Promise<HardwareStoredState> {
    await requireSafeDirectory(this.dataDir, this.directory, { create: true, label: "Hardware data directory" });
    await this.writer.acquire(path.join(this.directory, ".writer-lock"));
    try { return await this.read(); }
    catch (error) { await this.writer.release(); throw error; }
  }

  assertHeld(): void { this.writer.assertHeld(); }
  dispose(): Promise<void> { return this.writer.release(); }

  async read(): Promise<HardwareStoredState> {
    const directory = await this.openDirectory();
    try {
      let file;
      try { file = await fs.open(`/proc/self/fd/${directory.fd}/state.json`, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyHardwareState(); throw error; }
      try {
        const stat = await file.stat();
        requireHardware(stat.isFile() && stat.size <= HARDWARE_STATE_BYTES, "STORE_UNAVAILABLE", "Hardware state must be a bounded regular file.");
        return validateHardwareState(JSON.parse(await file.readFile("utf8")));
      } finally { await file.close(); }
    } catch (error) { throw new HardwareError("STORE_UNAVAILABLE", `Hardware state cannot be read. Preserve it for repair. ${error instanceof Error ? error.message : ""}`); }
    finally { await directory.close(); }
  }

  async write(state: HardwareStoredState): Promise<void> {
    this.writer.assertHeld();
    validateHardwareState(state);
    const text = `${JSON.stringify(state)}\n`;
    requireHardware(Buffer.byteLength(text) <= HARDWARE_STATE_BYTES, "LIMIT_EXCEEDED", "Hardware state exceeds its 64 MiB bound.");
    const directory = await this.openDirectory();
    const temporary = `/proc/self/fd/${directory.fd}/.state-${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const destination = `/proc/self/fd/${directory.fd}/state.json`;
      const prior = await fs.lstat(destination).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      requireHardware(!prior || prior.isFile(), "STORE_UNAVAILABLE", "Hardware state cannot replace a link or non-file.");
      const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      this.writer.assertHeld();
      await fs.rename(temporary, destination);
      renamed = true;
      await directory.sync();
    } catch (error) {
      if (!renamed) await fs.rm(temporary, { force: true });
      throw new HardwareError("STORE_UNAVAILABLE", "Hardware persistence failed. No new effects may start until state is reconciled.", { authorityReplaced: renamed });
    } finally { await directory.close(); }
  }

  private async openDirectory() {
    await requireSafeDirectory(this.dataDir, this.directory, { create: false, label: "Hardware data directory" });
    return fs.open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }
}

export function validateHardwareState(value: unknown): HardwareStoredState {
  const record = hardwareRecord(value, "Hardware state");
  const fields = Object.keys(emptyHardwareState());
  requireHardware(record.schemaVersion === 1 && Object.keys(record).length === fields.length && fields.every(field => Object.hasOwn(record, field)), "STORE_UNAVAILABLE", "Unsupported or incomplete hardware state.");
  hardwareInteger(record.revision, "Store revision", 0); hardwareInteger(record.nextGeneration, "Generation counter");
  for (const field of ["items", "tags", "groups", "statusDefinitions", "reservations", "checkHolds", "history"] as const) requireHardware(Array.isArray(record[field]) && record[field].length <= 100_000, "STORE_UNAVAILABLE", `Invalid hardware ${field}.`);
  requireHardware(Array.isArray(record.receipts), "STORE_UNAVAILABLE", "Invalid hardware receipts.");
  hardwareRecord(record.observations); hardwareRecord(record.endpointKeys);
  const state = record as unknown as HardwareStoredState;
  const timestamp = (value: unknown) => requireHardware(typeof value === "string" && Number.isFinite(Date.parse(value)), "STORE_UNAVAILABLE", "Invalid hardware observation time.");
  const resourceKeys = (value: unknown) => requireHardware(Array.isArray(value) && value.length <= 65536 && value.every(key => typeof key === "string" && key.length > 0 && key.length <= 4096) && new Set(value).size === value.length, "STORE_UNAVAILABLE", "Invalid hardware resource keys.");
  const unique = (records: { id: string }[]) => { const ids = records.map(record => hardwareId(record.id)); requireHardware(new Set(ids).size === ids.length, "STORE_UNAVAILABLE", "Hardware record IDs must be unique."); };
  for (const records of [state.items, state.tags, state.groups, state.statusDefinitions]) { unique(records); for (const record of records) hardwareInteger(record.revision, "Record revision"); }
  for (const tag of state.tags) { hardwareText(tag.label, "Tag label", 200); hardwareText(tag.description, "Tag description", 4096, true); }
  for (const group of state.groups) hardwareText(group.name, "Group name", 200);
  for (const definition of state.statusDefinitions) { hardwareText(definition.label, "Status label", 200); requireHardware(["boolean", "text", "enum"].includes(definition.valueType) && (definition.valueType === "enum" ? Array.isArray(definition.enumValues) && definition.enumValues.length > 0 && definition.enumValues.length <= 100 && definition.enumValues.every(value => typeof value === "string" && value.length > 0 && value.length <= 200) && new Set(definition.enumValues).size === definition.enumValues.length : definition.enumValues === undefined), "STORE_UNAVAILABLE", "Invalid status definition."); }
  for (const item of state.items) {
    parseHardwareItem(item);
    requireHardware(state.groups.some(group => group.id === item.physicalResourceId) && item.tagIds.every(id => state.tags.some(tag => tag.id === id)), "STORE_UNAVAILABLE", "Hardware item references a missing group or tag.");
    for (const binding of item.statuses) { const definition = state.statusDefinitions.find(definition => definition.id === binding.definitionId); requireHardware(definition, "STORE_UNAVAILABLE", "Status binding references a missing definition."); if (binding.source === "manual") validateHardwareStatusValue(binding.value, definition); if (binding.requiredForReserve) validateHardwareStatusValue(binding.requiredForReserve.equals, definition); }
  }
  for (const [id, observations] of Object.entries(state.observations)) {
    const item = state.items.find(item => item.id === id);
    requireHardware(item && Array.isArray(observations) && observations.length <= 128 && new Set(observations.map(observation => observation.definitionId)).size === observations.length, "STORE_UNAVAILABLE", "Invalid item status observations.");
    for (const observation of observations) {
      hardwareInteger(observation.bindingRevision, "Observation binding revision"); timestamp(observation.observedAt);
      if (observation.expiresAt !== undefined) timestamp(observation.expiresAt);
      const definition = state.statusDefinitions.find(definition => definition.id === observation.definitionId);
      requireHardware(definition && item.statuses.some(binding => binding.definitionId === definition.id) && ["known", "unknown", "error"].includes(observation.state), "STORE_UNAVAILABLE", "Observation references a missing status binding.");
      if (observation.state === "known") validateHardwareStatusValue(observation.value, definition);
      else requireHardware(observation.value === undefined, "STORE_UNAVAILABLE", "Unknown and failed statuses cannot retain a usable value.");
      if (observation.errorCode !== undefined) hardwareText(observation.errorCode, "Observation error code", 128);
      if (observation.runId !== undefined) hardwareId(observation.runId, "Observation run ID");
    }
  }
  for (const [id, keys] of Object.entries(state.endpointKeys)) { requireHardware(state.items.some(item => item.id === id), "STORE_UNAVAILABLE", "Endpoint identity references a missing hardware item."); resourceKeys(keys); }
  const keys = new Set<string>();
  const holdIds = new Set<string>();
  for (const hold of [...state.reservations, ...state.checkHolds]) {
    hardwareInteger(hold.generation, "Hold generation"); hardwareInteger(hold.revision, "Hold revision");
    requireHardware(hold.generation < state.nextGeneration && state.items.some(item => item.id === hold.hardwareId) && Array.isArray(hold.resourceKeys) && hold.resourceKeys.length > 0, "STORE_UNAVAILABLE", "Invalid hardware hold.");
    resourceKeys(hold.resourceKeys);
    const item = state.items.find(item => item.id === hold.hardwareId)!;
    requireHardware(hold.resourceKeys.includes(`physical:${item.physicalResourceId}`), "STORE_UNAVAILABLE", "A live hold must include its physical group key.");
    for (const key of hold.resourceKeys) { requireHardware(!keys.has(key), "STORE_UNAVAILABLE", "Live hardware holds have conflicting resource keys."); keys.add(key); }
    const id = "reservationId" in hold ? hold.reservationId : hold.runId;
    hardwareId(id, "Hold ID"); requireHardware(!holdIds.has(id), "STORE_UNAVAILABLE", "Live hold IDs must be unique."); holdIds.add(id);
    if (hold.recoveryReason !== undefined) hardwareText(hold.recoveryReason, "Recovery reason", 4096);
    if ("reservationId" in hold) {
      parseHardwareOwner(hold.owner); parseHardwareItem(hold.acquiredItem); hardwareText(hold.purpose, "Reservation purpose", 2000); timestamp(hold.acquiredAt); timestamp(hold.updatedAt);
      hardwareInteger(hold.acquiredItemRevision, "Acquired item revision"); hardwareInteger(hold.acquiredNotesRevision, "Acquired notes revision");
      requireHardware(hold.acquiredItem.id === item.id && hold.acquiredItem.physicalResourceId === item.physicalResourceId && ["preparing", "active", "releasing", "recovery_required"].includes(hold.state) && Array.isArray(hold.activeOperationIds) && hold.activeOperationIds.length <= 10000 && new Set(hold.activeOperationIds).size === hold.activeOperationIds.length && ["active", "confirmed_ended", "unknown"].includes(hold.lastOwnerObservation) && (hold.accessState === undefined || ["closed", "opening", "open", "closing", "unknown"].includes(hold.accessState)), "STORE_UNAVAILABLE", "Invalid reservation state.");
      for (const runId of [...hold.activeOperationIds, hold.preparationRunId, hold.releaseRunId]) if (runId !== undefined) hardwareId(runId, "Reservation operation ID");
      if (hold.lastOwnerObservedAt !== undefined) timestamp(hold.lastOwnerObservedAt);
    } else {
      timestamp(hold.startedAt);
      requireHardware(hold.kind === "system_check" && ["checking", "recovery_required"].includes(hold.state) && Array.isArray(hold.bindingRevisions) && hold.bindingRevisions.length > 0 && hold.bindingRevisions.length <= 128, "STORE_UNAVAILABLE", "Invalid checking hold.");
      for (const binding of hold.bindingRevisions) { hardwareId(binding.definitionId); hardwareInteger(binding.revision, "Checking binding revision"); }
    }
  }
  const requests = new Set<string>();
  for (const stored of state.receipts) {
    const owner = parseHardwareOwner(stored.owner), receipt = stored.receipt;
    hardwareId(receipt.requestId, "Request ID"); hardwareId(receipt.runId, "Run ID"); hardwareText(stored.action, "Receipt action", 128); timestamp(receipt.startedAt);
    if (receipt.finishedAt !== undefined) timestamp(receipt.finishedAt);
    requireHardware(receipt.state === "running" ? receipt.finishedAt === undefined : receipt.finishedAt !== undefined, "STORE_UNAVAILABLE", "Receipt completion requires a saved completion time.");
    if (receipt.reservation) { hardwareId(receipt.reservation.reservationId, "Receipt reservation ID"); hardwareInteger(receipt.reservation.generation, "Receipt generation"); }
    if (receipt.result !== undefined) validateHardwareJson(receipt.result);
    if (receipt.outputPruned) { timestamp(receipt.outputPruned.at); requireHardware(["age", "count", "budget"].includes(receipt.outputPruned.reason) && ["succeeded", "failed"].includes(receipt.state) && receipt.result === undefined, "STORE_UNAVAILABLE", "Only completed receipt output can be pruned."); }
    if (stored.finalCleanupTarget !== undefined) {
      const target = hardwareRecord(stored.finalCleanupTarget, "Final cleanup target");
      requireHardware(stored.action === "hardware.forceRelease" && ["reservation", "system_check"].includes(String(target.kind)) && Object.keys(target).length === 3, "STORE_UNAVAILABLE", "Only an acknowledged override can reserve final cleanup capacity.");
      hardwareInteger(target.generation, "Final cleanup generation");
      hardwareId(target.kind === "reservation" ? target.reservationId : target.runId, "Final cleanup target ID");
      if (target.kind === "reservation") requireHardware(receipt.reservation && receipt.reservation.reservationId === target.reservationId && receipt.reservation.generation === target.generation, "STORE_UNAVAILABLE", "Final cleanup must match its recorded reservation generation.");
    }
    if (receipt.error) { hardwareText(receipt.error.code, "Receipt error code", 128); hardwareText(receipt.error.message, "Receipt error message", 4096); }
    const key = JSON.stringify([owner, receipt.requestId]); requireHardware(!requests.has(key) && /^[a-f0-9]{64}$/.test(stored.digest) && ["running", "succeeded", "failed", "unknown"].includes(receipt.state), "STORE_UNAVAILABLE", "Invalid operation receipt index."); requests.add(key);
  }
  unique(state.history);
  for (const event of state.history) { timestamp(event.at); hardwareText(event.kind, "History kind", 128); hardwareText(event.detail, "History detail", 4096, true); if (event.owner) parseHardwareOwner(event.owner); for (const id of [event.hardwareId, event.reservationId, event.runId]) if (id !== undefined) hardwareId(id, "History reference"); }
  return state;
}

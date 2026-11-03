import { createHash, randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { HardwareAccessContext, HardwareConnection, HardwareTypeProvider } from "@cloudx/plugin-api";
import { hardwareId, hardwareInteger, hardwareRecord, hardwareText, parseHardwareItem, parseHardwareOwner, validateHardwareJson, validateHardwareStatusValue, type BashScript, type CapabilityTag, type HardwareEndpointInspection, type HardwareFilter, type HardwareItem, type HardwareMutationResult, type HardwareOwner, type HardwareReservation, type HardwareReservationRecord, type HardwareRetentionSettings, type HardwareStateView, type HardwareSummary, type JsonObject, type OperationReceipt, type PhysicalResource, type ProviderOutcome, type ReservationRef, type StatusDefinition, type StatusObservation } from "@cloudx/shared";
import type { PathPolicy } from "../pathPolicy.js";
import { HardwareError, hardwareInput, requireHardware } from "./HardwareError.js";
import { HardwareScriptRunner, type HardwareScriptResult } from "./HardwareScriptRunner.js";
import { emptyHardwareState, HardwareStore, type HardwareStoredState, type StoredHardwareReceipt } from "./HardwareStore.js";
import { HardwareCapacity } from "./HardwareCapacity.js";

export interface HardwareRegistry {
  values(): HardwareTypeProvider<unknown>[];
  get(typeId: string): HardwareTypeProvider<unknown>;
}
export interface HardwareServiceOptions {
  dataDir: string;
  registry: HardwareRegistry;
  pathPolicy?: PathPolicy;
  resolveCredential?: (id: string) => Promise<string>;
  discardCredential?: (id: string) => Promise<void>;
  ownerState?: (owner: HardwareOwner) => "active" | "confirmed_ended" | "unknown" | Promise<"active" | "confirmed_ended" | "unknown">;
  retention?: Partial<HardwareRetentionSettings>;
}
interface Endpoint { provider?: HardwareTypeProvider<unknown>; config?: unknown; inspection: HardwareEndpointInspection }
interface Inventory { endpoints: Map<string, Endpoint>; groupKeys: Map<string, string[]>; conflictingGroups: Set<string> }
interface Task { ref?: ReservationRef; hardwareId: string; controller: AbortController; promise: Promise<void> }
interface Access { generation: number; connection?: HardwareConnection; cleanup: Array<(signal: AbortSignal) => Promise<ProviderOutcome<null>>> }

const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const ownerKey = (owner: HardwareOwner) => canonical(owner);
const sameOwner = (a: HardwareOwner, b: HardwareOwner) => ownerKey(a) === ownerKey(b);
const sameRef = (claim: ReservationRef, ref: ReservationRef) => claim.reservationId === ref.reservationId && claim.generation === ref.generation;
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const refOf = (claim: ReservationRef): ReservationRef => ({ reservationId: claim.reservationId, generation: claim.generation });
const publicClaim = (record: HardwareReservationRecord): HardwareReservation => { const { acquiredItem: _item, preparationRunId: _prepare, releaseRunId: _release, recoveryCause: _cause, ...claim } = record; return clone(claim); };
const failure = (code: string, message: string): ProviderOutcome<JsonObject> => ({ state: "failed", effects: "none", error: { code, message } });

export class HardwareService {
  private readonly store: HardwareStore;
  private readonly scripts: HardwareScriptRunner;
  private state = emptyHardwareState();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly tasks = new Map<string, Task>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly access = new Map<string, Access>();
  private ready = false;
  private stopping = false;
  private unavailableReason?: string;
  private initialization?: Promise<void>;
  private disposal?: Promise<void>;
  private scheduler?: ReturnType<typeof setInterval>;
  private readonly retention: HardwareRetentionSettings;
  private readonly capacity = new HardwareCapacity();
  private readonly replayedRequests = new WeakSet<HardwareStoredState>();

  constructor(private readonly options: HardwareServiceOptions) {
    this.store = new HardwareStore(options.dataDir, error => { this.unavailableReason = error.message; this.beginShutdown(); for (const task of this.tasks.values()) task.controller.abort(error); this.notifyChange(); });
    this.scripts = new HardwareScriptRunner(options);
    this.retention = { completedMaxAgeMs: 30 * 86_400_000, completedMaxEntries: 10_000, outputMaxBytes: 16 * 1024 * 1024, snapshotMaxCompletedReceipts: 200, ...options.retention };
    hardwareInput(() => { hardwareInteger(this.retention.completedMaxAgeMs, "Completed retention age", 1, 3650 * 86_400_000); hardwareInteger(this.retention.completedMaxEntries, "Completed retention entries", 1, 100_000); hardwareInteger(this.retention.outputMaxBytes, "Completed output budget", 1, 32 * 1024 * 1024); hardwareInteger(this.retention.snapshotMaxCompletedReceipts, "Snapshot completed receipt limit", 1, 10_000); });
  }

  init(): Promise<void> { return this.initialization ??= this.initialize(); }
  private async initialize(): Promise<void> {
    this.state = await this.store.init();
    try {
      const next = clone(this.state);
      for (const record of next.receipts) if (record.receipt.state === "running") { record.receipt.state = "unknown"; record.receipt.error = { code: "OUTCOME_UNKNOWN", message: "CloudX restarted before the operation outcome was saved. The effect will not be replayed." }; record.receipt.finishedAt = now(); }
      for (const claim of next.reservations) {
        const observation = claim.lastOwnerObservation === "confirmed_ended" ? "confirmed_ended" : await this.observeOwner(claim.owner);
        claim.lastOwnerObservation = observation; claim.lastOwnerObservedAt = now();
        const linkedRuns = [claim.preparationRunId, claim.releaseRunId, ...claim.activeOperationIds].filter((id): id is string => Boolean(id));
        const ownerOnlyHold = claim.state === "recovery_required" && claim.recoveryCause === "owner";
        const uncertainEffects = claim.state !== "active" && !ownerOnlyHold || Boolean(claim.activeOperationIds.length) || Boolean(claim.accessState && claim.accessState !== "closed") || linkedRuns.some(id => !next.receipts.some(record => record.receipt.runId === id)) || next.receipts.some(record => record.receipt.reservation && sameRef(record.receipt.reservation, claim) && record.receipt.state === "unknown");
        if (uncertainEffects || observation !== "active") {
          claim.state = "recovery_required"; claim.recoveryReason = "Startup could not prove the exact owner and all prior effects are settled.";
          if (uncertainEffects) { claim.recoveryCause = claim.recoveryCause === "owner" ? "restart" : claim.recoveryCause ?? "restart"; claim.accessState = "unknown"; }
          else claim.recoveryCause ??= "owner";
          claim.revision++;
        }
        claim.activeOperationIds = [];
      }
      for (const hold of next.checkHolds) { hold.state = "recovery_required"; hold.recoveryReason = "CloudX restarted before this checking process was confirmed ended."; hold.revision++; }
      next.revision++;
      this.pruneDetails(next);
      await this.store.write(next);
      this.state = next; this.ready = true;
      const ended = new Map(next.reservations.filter(claim => claim.lastOwnerObservation === "confirmed_ended").map(claim => [ownerKey(claim.owner), claim.owner]));
      for (const owner of ended.values()) await this.ownerEnded(owner);
      if (!this.stopping) {
        this.scheduler = setInterval(() => { void this.checkScheduledStatuses().catch(() => undefined); }, 1000);
        this.scheduler.unref();
      }
    } catch (error) {
      this.beginShutdown();
      for (const task of this.tasks.values()) task.controller.abort(error);
      await Promise.allSettled([...this.tasks.values()].map(task => task.promise));
      this.ready = false;
      await this.store.dispose();
      throw error;
    }
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  ownerClaims(): HardwareReservation[] { return this.state.reservations.map(publicClaim); }

  async snapshot(candidate: HardwareOwner): Promise<HardwareStateView> {
    const owner = hardwareInput(() => parseHardwareOwner(candidate));
    requireHardware(this.ready, "STORE_UNAVAILABLE", this.unavailableReason ?? "Hardware inventory has not finished loading.");
    try { this.store.assertHeld(); } catch { this.unavailableReason = "Hardware lost its exclusive writer authority."; this.beginShutdown(); for (const task of this.tasks.values()) task.controller.abort(); }
    const state = clone(this.state);
    const inventory = await this.inspectInventory(state);
    const visible = state.receipts.filter(record => owner.kind === "user" || sameOwner(record.owner, owner));
    const completed = new Set(visible.filter(record => ["succeeded", "failed"].includes(record.receipt.state)).sort((a, b) => Date.parse(a.receipt.finishedAt!) - Date.parse(b.receipt.finishedAt!)).slice(-this.retention.snapshotMaxCompletedReceipts));
    return { revision: state.revision, items: state.items.map(item => this.summary(state, item, inventory)), tags: state.tags, groups: state.groups, types: this.options.registry.values().map(provider => clone(provider.descriptor)), statusDefinitions: state.statusDefinitions, reservations: state.reservations.map(publicClaim), checkHolds: state.checkHolds,
      receipts: visible.filter(record => completed.has(record) || ["running", "unknown"].includes(record.receipt.state)).map(record => clone(record.receipt)), history: state.history, currentOwner: owner, retention: clone(this.retention),
      readiness: { state: this.stopping || this.unavailableReason ? "unavailable" : "ready", ...(this.unavailableReason ? { reason: this.unavailableReason } : {}) } };
  }

  async execute(action: string, candidate: unknown, candidateOwner: HardwareOwner): Promise<unknown> {
    const owner = hardwareInput(() => parseHardwareOwner(candidateOwner));
    const input = hardwareInput(() => hardwareRecord(candidate));
    if (action === "hardware.state" || action === "hardware.readiness") return this.snapshot(owner);
    this.assertAdmission();
    if (action === "hardware.receipt.get") {
      const requestId = hardwareInput(() => hardwareId(input.requestId, "Request ID"));
      const record = this.state.receipts.find(record => sameOwner(record.owner, owner) && record.receipt.requestId === requestId);
      return { receipt: record ? clone(record.receipt) : null };
    }
    if (action.endsWith(".list")) return this.list(action, input, owner);
    if (action === "hardware.items.get") {
      const hardwareIdValue = hardwareInput(() => hardwareId(input.hardwareId));
      const state = clone(this.state), item = this.requireItem(state, hardwareIdValue), inventory = await this.inspectInventory(state);
      const endpoint = inventory.endpoints.get(item.id)!;
      return { ...this.summary(state, item, inventory), access: endpoint.provider ? endpoint.provider.describeAccess(endpoint.config) : { summary: "Provider unavailable", details: {} }, aliases: state.items.filter(alias => alias.physicalResourceId === item.physicalResourceId), revision: state.revision };
    }
    if (action === "hardware.reserve") return this.reserve(input, owner);
    if (action === "hardware.release") return this.release(input, owner);
    if (action === "hardware.forceRelease") return this.override(input, owner);
    if (action === "hardware.statuses.refresh") return this.refresh(input, owner);
    if (action === "hardware.ssh.registerKey") return this.registerSshKey(input, owner);
    if (["hardware.access.open", "hardware.access.invoke", "hardware.access.close"].includes(action)) return this.accessAction(action, input, owner);
    if (/^hardware\.(items|tags|groups|statuses)\.(create|update|delete|set)$/.test(action)) return this.manage(action, input, owner);
    throw new HardwareError("INVALID_INPUT", `Unknown hardware action: ${action}`);
  }

  private async manage(action: string, input: Record<string, unknown>, owner: HardwareOwner): Promise<HardwareMutationResult> {
    requireHardware(owner.kind === "user", "FORBIDDEN", "Hardware catalog and configuration changes belong to the user.");
    return this.change(async next => {
      const admitted = this.admit(next, action, input, owner);
      if (admitted.existing) return { receipt: admitted.record.receipt };
      const receipt = admitted.record.receipt;
      let result: unknown;
      if (action.startsWith("hardware.items.")) result = { item: await this.manageItem(next, action, input) };
      else if (action === "hardware.statuses.set") result = { item: this.setManualStatus(next, input) };
      else result = this.manageCatalog(next, action, input);
      receipt.state = "succeeded"; receipt.finishedAt = now(); receipt.result = json(result);
      this.addHistory(next, action, "Hardware configuration updated.", owner);
      return { receipt };
    });
  }

  private async manageItem(next: HardwareStoredState, action: string, input: Record<string, unknown>): Promise<HardwareItem | null> {
    if (action === "hardware.items.create") {
      fields(input, ["requestId", "item", "newGroupName"]);
      const draft = hardwareInput(() => hardwareRecord(input.item));
      const raw = clone(draft);
      if (input.newGroupName !== undefined) { const group = { id: `group-${randomUUID()}`, revision: 1, name: hardwareInput(() => hardwareText(input.newGroupName, "Group name", 200)).trim() }; this.uniqueLabel(next.groups, group.name, undefined, record => record.name); next.groups.push(group); raw.physicalResourceId = group.id; }
      const item = hardwareInput(() => parseHardwareItem({ ...raw, id: `hardware-${randomUUID()}`, revision: 1, notesRevision: 1 }));
      this.validateItemReferences(next, item); this.provider(item);
      await this.validateItemScripts(item);
      next.items.push(item); this.manualObservations(next, item);
      const inventory = await this.inspectInventory(next);
      requireHardware(!inventory.conflictingGroups.has(item.physicalResourceId), "ENDPOINT_CONFLICT", "An endpoint belongs to another physical group. Group its aliases together.");
      const keys = inventory.groupKeys.get(item.physicalResourceId)!;
      this.requireNoHold(next, keys);
      return item;
    }
    fields(input, action === "hardware.items.update" ? ["requestId", "hardwareId", "expectedItemRevision", "patch", "newGroupName"] : ["requestId", "hardwareId", "expectedItemRevision"]);
    const item = this.requireItem(next, hardwareInput(() => hardwareId(input.hardwareId)));
    this.requireRevision(item.revision, input.expectedItemRevision);
    const inventory = await this.inspectInventory(next), oldKeys = inventory.groupKeys.get(item.physicalResourceId)!;
    if (action === "hardware.items.delete") {
      this.requireNoHold(next, oldKeys); next.items = next.items.filter(record => record.id !== item.id); delete next.observations[item.id]; delete next.endpointKeys[item.id]; return null;
    }
    const patch = clone(hardwareInput(() => hardwareRecord(input.patch)));
    requireHardware((Object.keys(patch).length > 0 || input.newGroupName !== undefined) && Object.keys(patch).every(key => ["name", "description", "enabled", "physicalResourceId", "typeId", "configVersion", "config", "tagIds", "notes", "statuses", "hooks"].includes(key)), "INVALID_INPUT", "Item patch contains unknown fields.");
    if (input.newGroupName !== undefined) {
      this.requireNoHold(next, oldKeys);
      const group = { id: `group-${randomUUID()}`, revision: 1, name: hardwareInput(() => hardwareText(input.newGroupName, "Group name", 200)).trim() };
      this.uniqueLabel(next.groups, group.name, undefined, record => record.name);
      next.groups.push(group);
      patch.physicalResourceId = group.id;
    }
    const changesIdentity = ["physicalResourceId", "typeId", "configVersion", "config"].some(key => Object.hasOwn(patch, key) && canonical(patch[key]) !== canonical(item[key as keyof HardwareItem]));
    if (changesIdentity || ["statuses", "hooks"].some(key => Object.hasOwn(patch, key) && canonical(patch[key]) !== canonical(item[key as keyof HardwareItem]))) this.requireNoHold(next, oldKeys);
    const updated = hardwareInput(() => parseHardwareItem({ ...item, ...patch, revision: item.revision + 1, notesRevision: item.notesRevision + (patch.notes !== undefined && patch.notes !== item.notes ? 1 : 0) }));
    for (const binding of updated.statuses) {
      const previous = item.statuses.find(previous => previous.definitionId === binding.definitionId);
      if (!previous) continue;
      const { revision: _before, ...before } = previous, { revision: _after, ...after } = binding;
      requireHardware(canonical(before) === canonical(after) ? binding.revision >= previous.revision : binding.revision > previous.revision, "REVISION_CONFLICT", "A changed status binding requires a greater binding revision so old measurements cannot satisfy it.");
    }
    this.validateItemReferences(next, updated); this.provider(updated);
    if (Object.hasOwn(patch, "statuses") || Object.hasOwn(patch, "hooks")) await this.validateItemScripts(updated);
    next.items[next.items.indexOf(item)] = updated;
    const prospective = await this.inspectInventory(next);
    requireHardware(!changesIdentity || !prospective.conflictingGroups.has(updated.physicalResourceId), "ENDPOINT_CONFLICT", "An endpoint belongs to another physical group.");
    if (updated.physicalResourceId !== item.physicalResourceId) this.requireNoHold(next, prospective.groupKeys.get(updated.physicalResourceId)!);
    this.manualObservations(next, updated); return updated;
  }

  private manageCatalog(next: HardwareStoredState, action: string, input: Record<string, unknown>): unknown {
    const [, catalog, operation] = action.split(".");
    const records: Array<CapabilityTag | PhysicalResource | StatusDefinition> = catalog === "tags" ? next.tags : catalog === "groups" ? next.groups : next.statusDefinitions;
    const allowed = catalog === "tags" ? ["label", "description"] : catalog === "groups" ? ["name"] : ["label", "valueType", "enumValues"];
    fields(input, ["requestId", ...(operation === "create" ? [] : ["id", "expectedRevision"]), ...allowed]);
    const previous = operation === "create" ? undefined : records.find(record => record.id === hardwareInput(() => hardwareId(input.id)));
    if (operation !== "create") { requireHardware(previous, "NOT_FOUND", "The hardware catalog record no longer exists."); this.requireRevision(previous.revision, input.expectedRevision); }
    const used = previous && next.items.some(item => catalog === "tags" ? item.tagIds.includes(previous.id) : catalog === "groups" ? item.physicalResourceId === previous.id : item.statuses.some(binding => binding.definitionId === previous.id));
    if (operation === "delete") { requireHardware(!used, "IN_USE", "Reassign or remove this record's uses before deletion."); records.splice(records.indexOf(previous!), 1); return { deleted: true }; }
    const record = { ...previous, id: previous?.id ?? `${catalog.slice(0, -1)}-${randomUUID()}`, revision: (previous?.revision ?? 0) + 1 } as Record<string, unknown>;
    for (const field of allowed) if (Object.hasOwn(input, field)) record[field] = clone(input[field]);
    if (catalog === "groups") record.name = hardwareInput(() => hardwareText(record.name, "Group name", 200)).trim();
    else { record.label = hardwareInput(() => hardwareText(record.label, "Catalog label", 200)).trim(); if (catalog === "tags") record.description = hardwareInput(() => hardwareText(record.description ?? "", "Tag description", 4096, true)); }
    this.uniqueLabel(records, String(record[catalog === "groups" ? "name" : "label"]), previous?.id, value => String((value as unknown as Record<string, unknown>)[catalog === "groups" ? "name" : "label"]));
    if (catalog === "statuses") {
      requireHardware(["boolean", "text", "enum"].includes(String(record.valueType)), "INVALID_INPUT", "Status value type must be boolean, text, or enum.");
      if (record.valueType === "enum") { requireHardware(Array.isArray(record.enumValues) && record.enumValues.length > 0 && record.enumValues.length <= 100 && record.enumValues.every(value => typeof value === "string" && value.length > 0 && value.length <= 200) && new Set(record.enumValues).size === record.enumValues.length, "INVALID_INPUT", "Enum values must be a unique nonempty bounded list."); }
      else delete record.enumValues;
      if (used) requireHardware((previous as StatusDefinition).valueType === record.valueType && canonical((previous as StatusDefinition).enumValues) === canonical(record.enumValues), "IN_USE", "A used status definition cannot change its value type or enum domain. Create and rebind a new definition.");
    }
    if (previous) records[records.indexOf(previous)] = record as never; else records.push(record as never);
    return { [catalog === "tags" ? "tag" : catalog === "groups" ? "group" : "statusDefinition"]: record };
  }

  private setManualStatus(next: HardwareStoredState, input: Record<string, unknown>): HardwareItem {
    fields(input, ["requestId", "hardwareId", "expectedItemRevision", "definitionId", "value"]);
    const item = this.requireItem(next, hardwareInput(() => hardwareId(input.hardwareId)));
    this.requireRevision(item.revision, input.expectedItemRevision);
    const binding = item.statuses.find(binding => binding.definitionId === input.definitionId);
    requireHardware(binding?.source === "manual", "INVALID_INPUT", "Select a manual status binding.");
    const definition = next.statusDefinitions.find(definition => definition.id === binding.definitionId)!;
    hardwareInput(() => validateHardwareStatusValue(input.value, definition));
    if (binding.value !== input.value) binding.revision++;
    binding.value = input.value as boolean | string; item.revision++;
    this.manualObservations(next, item); return item;
  }

  private async reserve(input: Record<string, unknown>, owner: HardwareOwner): Promise<HardwareMutationResult> {
    fields(input, ["requestId", "hardwareId", "expectedItemRevision", "purpose"]);
    let dispatch: { runId: string; ref: ReservationRef; hardwareId: string; script: BashScript } | undefined;
    const result = await this.change(async next => {
      const admitted = this.admit(next, "hardware.reserve", input, owner);
      if (admitted.existing) return this.mutationResult(next, admitted.record.receipt);
      await this.assertOwnerActive(owner);
      const item = this.requireItem(next, hardwareInput(() => hardwareId(input.hardwareId)));
      this.requireRevision(item.revision, input.expectedItemRevision);
      const inventory = await this.inspectInventory(next), summary = this.summary(next, item, inventory);
      this.requireNoHold(next, inventory.groupKeys.get(item.physicalResourceId)!);
      requireHardware(summary.availability === "available", "STATUS_NOT_READY", "Hardware does not satisfy its admission requirements.", { blockers: summary.blockers });
      await this.assertOwnerActive(owner);
      const claim: HardwareReservationRecord = { reservationId: `reservation-${randomUUID()}`, generation: next.nextGeneration++, revision: 1, hardwareId: item.id, owner, state: item.hooks.beforeReserve ? "preparing" : "active", resourceKeys: inventory.groupKeys.get(item.physicalResourceId)!, purpose: hardwareInput(() => hardwareText(input.purpose, "Reservation purpose", 2000)), acquiredItemRevision: item.revision, acquiredNotesRevision: item.notesRevision, acquiredAt: now(), updatedAt: now(), lastOwnerObservation: "active", lastOwnerObservedAt: now(), activeOperationIds: [], accessState: "closed", acquiredItem: clone(item) };
      next.reservations.push(claim);
      const receipt = admitted.record.receipt; receipt.reservation = refOf(claim);
      if (item.hooks.beforeReserve) { claim.preparationRunId = receipt.runId; claim.activeOperationIds.push(receipt.runId); dispatch = { runId: receipt.runId, ref: refOf(claim), hardwareId: item.id, script: clone(item.hooks.beforeReserve) }; }
      else { receipt.state = "succeeded"; receipt.finishedAt = now(); receipt.result = { reservationId: claim.reservationId, generation: claim.generation, state: "active" }; }
      this.addHistory(next, "reserved", claim.purpose, owner, claim); return this.mutationResult(next, receipt);
    });
    if (dispatch) { const work = dispatch; this.launch(work.hardwareId, work.runId, work.ref, async signal => {
      await this.assertOwnerActive(owner);
      const claim = this.currentClaim(work.ref, ["preparing"]); signal.throwIfAborted();
      const outcome = await this.runScript(work.script, claim, "before_reserve", signal);
      await this.finish(work.runId, work.ref, outcome.state === "completed" ? { state: "completed", value: { reservationId: claim.reservationId, generation: claim.generation, state: "active" } } : outcome.state === "unknown" ? { state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "Preparation outcome is uncertain." } } : failure("HOOK_FAILED", "Preparation hook failed; its effects require review."), (_next, current, receipt) => {
        receipt.result = { ...receipt.result, diagnostics: scriptDiagnostics(outcome) };
        if (!current) return;
        if (outcome.state === "completed") { if (current.state === "preparing") current.state = "active"; }
        else this.recover(current, "Preparation hook failed or its effects are uncertain.", "hook");
      });
    }); }
    return result;
  }

  private async release(input: Record<string, unknown>, owner: HardwareOwner, internal = false): Promise<HardwareMutationResult> {
    fields(input, ["requestId", "reservationId", "generation"]);
    let dispatch: { runId: string; ref: ReservationRef; hardwareId: string } | undefined;
    const result = await this.change(next => {
      const admitted = this.admit(next, "hardware.release", input, owner);
      if (admitted.existing) return this.mutationResult(next, admitted.record.receipt);
      const claim = this.requireClaim(next, input, owner);
      requireHardware(claim.state !== "recovery_required", "RECOVERY_REQUIRED", "Unknown effects require operator reconciliation or override.");
      requireHardware(["active", "releasing"].includes(claim.state) || internal && claim.state === "preparing" && claim.lastOwnerObservation === "confirmed_ended", "INVALID_PHASE", "Only an active reservation or confirmed ended preparation can start release.");
      if (claim.state === "releasing" && claim.releaseRunId) {
        const original = next.receipts.find(record => record.receipt.runId === claim.releaseRunId)!;
        admitted.record.receipt = { ...clone(original.receipt), requestId: admitted.record.receipt.requestId };
        return this.mutationResult(next, admitted.record.receipt);
      }
      const receipt = admitted.record.receipt; receipt.reservation = refOf(claim);
      claim.state = "releasing"; claim.revision++; claim.updatedAt = now(); claim.releaseRunId = receipt.runId;
      claim.activeOperationIds.push(receipt.runId);
      dispatch = { runId: receipt.runId, ref: refOf(claim), hardwareId: claim.hardwareId };
      return this.mutationResult(next, receipt);
    }, internal);
    if (dispatch) {
      const work = dispatch; this.cancelTasks(work.ref);
      this.launch(work.hardwareId, work.runId, work.ref, async signal => {
        const claim = this.currentClaim(work.ref, ["releasing", "recovery_required"]);
        const closed = await this.closeAccess(work.ref, signal);
        let diagnostics: HardwareScriptResult | undefined;
        let outcome: ProviderOutcome<JsonObject> = closed.state === "completed" ? { state: "completed", value: { released: true } } : closed;
        const current = this.state.reservations.find(record => sameRef(record, work.ref));
        if (current?.recoveryReason) outcome = { state: "unknown", error: { code: "RECOVERY_REQUIRED", message: current.recoveryReason } };
        if (outcome.state === "completed" && claim.acquiredItem.hooks.onRelease) {
          const hook = await this.runScript(claim.acquiredItem.hooks.onRelease, claim, "on_release", signal);
          diagnostics = hook;
          if (hook.state !== "completed") outcome = hook.state === "unknown" ? { state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "Release-hook outcome is uncertain." } } : failure("HOOK_FAILED", "Release hook failed; hardware remains held.");
        }
        await this.finish(work.runId, work.ref, outcome, (next, held, receipt) => {
          if (diagnostics) receipt.result = { ...receipt.result, diagnostics: scriptDiagnostics(diagnostics) };
          if (!held) return;
          if (outcome.state === "completed") { next.reservations = next.reservations.filter(record => record !== held); this.addHistory(next, "released", "Reservation released after confirmed cleanup.", owner, held); }
          else this.recover(held, outcome.error.message, "cleanup");
        });
      });
    }
    return result;
  }

  private async override(input: Record<string, unknown>, owner: HardwareOwner): Promise<HardwareMutationResult> {
    requireHardware(owner.kind === "user", "FORBIDDEN", "Force release belongs to the user.");
    fields(input, ["requestId", "target", "expectedHoldRevision", "reason", "acceptUnresolvedExternalActivity"]);
    const target = hardwareInput(() => hardwareRecord(input.target));
    requireHardware(["reservation", "system_check"].includes(String(target.kind)) && typeof input.acceptUnresolvedExternalActivity === "boolean", "INVALID_INPUT", "Choose an exact reservation or check target and an explicit unresolved-activity acknowledgement.");
    fields(target, target.kind === "reservation" ? ["kind", "reservationId", "generation"] : ["kind", "runId", "generation"]);
    const reason = hardwareInput(() => hardwareText(input.reason, "Override reason", 2000));
    let dispatch: { runId: string; hardwareId: string; priorRef?: ReservationRef; currentRef?: ReservationRef; checkRunId?: string; generation: number; priorUncertainty: boolean; priorOperationIds: string[]; hook?: BashScript } | undefined;
    const result = await this.change(next => {
      const admitted = this.admit(next, "hardware.forceRelease", input, owner);
      if (admitted.existing) return this.mutationResult(next, admitted.record.receipt);
      const hold = target.kind === "reservation" ? next.reservations.find(record => record.reservationId === target.reservationId) : next.checkHolds.find(record => record.runId === target.runId);
      requireHardware(hold && hold.generation === target.generation, "STALE_RESERVATION", "The override target changed. Read the current held resource.");
      this.requireRevision(hold.revision, input.expectedHoldRevision);
      this.capacity.assertCleanupAvailable(next, "reservationId" in hold ? { kind: "reservation", ...refOf(hold) } : { kind: "system_check", runId: hold.runId, generation: hold.generation });
      const priorUncertainty = hold.state === "recovery_required";
      const priorOperationIds = "reservationId" in hold ? [...hold.activeOperationIds] : [hold.runId];
      const priorRef = "reservationId" in hold ? refOf(hold) : undefined;
      const generation = next.nextGeneration++; hold.generation = generation; hold.revision++;
      if ("reservationId" in hold) {
        const hook = !hold.releaseRunId ? hold.acquiredItem.hooks.onRelease : undefined;
        hold.state = "releasing"; hold.updatedAt = now(); hold.activeOperationIds.push(admitted.record.receipt.runId);
        if (hook) hold.releaseRunId = admitted.record.receipt.runId;
        admitted.record.receipt.reservation = refOf(hold);
        dispatch = { runId: admitted.record.receipt.runId, hardwareId: hold.hardwareId, priorRef, currentRef: refOf(hold), generation, priorUncertainty, priorOperationIds, hook };
      } else { hold.state = "recovery_required"; hold.recoveryReason = "The previous checking generation was revoked for operator cleanup."; dispatch = { runId: admitted.record.receipt.runId, hardwareId: hold.hardwareId, checkRunId: hold.runId, generation, priorUncertainty, priorOperationIds }; }
      if (input.acceptUnresolvedExternalActivity) admitted.record.finalCleanupTarget = "reservationId" in hold ? { kind: "reservation", ...refOf(hold) } : { kind: "system_check", runId: hold.runId, generation };
      this.addHistory(next, "override_requested", reason, owner, "reservationId" in hold ? hold : undefined, hold.hardwareId);
      return this.mutationResult(next, admitted.record.receipt);
    });
    if (dispatch) {
      const work = dispatch;
      if (work.priorRef) this.cancelTasks(work.priorRef);
      if (work.checkRunId) this.tasks.get(work.checkRunId)?.controller.abort(new Error("Checking generation revoked by the operator."));
      this.launch(work.hardwareId, work.runId, work.currentRef, async signal => {
        let unresolved = work.priorUncertainty;
        let diagnostics: HardwareScriptResult | undefined;
        unresolved ||= work.priorOperationIds.some(id => { const receipt = this.state.receipts.find(record => record.receipt.runId === id)?.receipt; return !receipt || ["running", "unknown"].includes(receipt.state) || receipt.state === "failed" && receipt.error?.code === "HOOK_FAILED"; });
        if (work.priorRef) {
          try { const closed = await this.closeAccess({ reservationId: work.priorRef.reservationId, generation: this.access.get(work.priorRef.reservationId)?.generation ?? work.priorRef.generation }, signal); unresolved ||= closed.state !== "completed"; }
          catch { unresolved = true; }
          if (work.hook) {
            try {
              const held = this.currentClaim(work.currentRef!, ["releasing", "recovery_required"]);
              const hook = await this.runScript(work.hook, held, "on_release", signal);
              diagnostics = hook; unresolved ||= hook.state !== "completed";
            } catch { unresolved = true; }
          }
        } else if (work.checkRunId) {
          const check = this.state.receipts.find(record => record.receipt.runId === work.checkRunId)?.receipt;
          unresolved ||= !check || ["running", "unknown"].includes(check.state);
        }
        const accepted = !unresolved || input.acceptUnresolvedExternalActivity === true;
        const outcome: ProviderOutcome<JsonObject> = accepted ? { state: "completed", value: { released: true, unresolvedActivityAccepted: unresolved, reason } } : { state: "unknown", error: { code: "RECOVERY_REQUIRED", message: "Cleanup remains uncertain. Inspect current activity, then explicitly acknowledge unresolved external activity to clear this hold." } };
        await this.finish(work.runId, work.currentRef, outcome, (next, held, receipt) => {
          if (diagnostics) receipt.result = { ...receipt.result, diagnostics: scriptDiagnostics(diagnostics) };
          if (work.currentRef && held) { if (accepted) next.reservations = next.reservations.filter(record => record !== held); else this.recover(held, outcome.state === "unknown" ? outcome.error.message : "Cleanup is uncertain.", "cleanup"); }
          if (work.checkRunId) { const check = next.checkHolds.find(record => record.runId === work.checkRunId && record.generation === work.generation); if (check) { if (accepted) next.checkHolds = next.checkHolds.filter(record => record !== check); else { check.state = "recovery_required"; check.revision++; check.recoveryReason = "Operator acknowledgement of unresolved checking activity is required."; } } }
          this.addHistory(next, accepted ? "override_released" : "override_held", reason, owner, held, work.hardwareId);
        });
      });
    }
    return result;
  }

  private async refresh(input: Record<string, unknown>, owner: HardwareOwner): Promise<HardwareMutationResult> {
    fields(input, ["requestId", "hardwareId", "statusIds", "reservationId", "generation"]);
    let dispatch: { runId: string; item: HardwareItem; bindings: HardwareItem["statuses"]; ref?: ReservationRef; checkGeneration?: number } | undefined;
    const result = await this.change(async next => {
      const admitted = this.admit(next, "hardware.statuses.refresh", input, owner);
      if (admitted.existing) return this.mutationResult(next, admitted.record.receipt);
      await this.assertOwnerActive(owner);
      const item = this.requireItem(next, hardwareInput(() => hardwareId(input.hardwareId)));
      requireHardware(input.statusIds === undefined || Array.isArray(input.statusIds) && input.statusIds.length > 0 && input.statusIds.length <= 128 && new Set(input.statusIds).size === input.statusIds.length && input.statusIds.every(id => item.statuses.some(binding => binding.definitionId === id)), "INVALID_INPUT", "Choose a unique bounded list of existing status bindings.");
      const bindings = item.statuses.filter(binding => input.statusIds === undefined || (input.statusIds as string[]).includes(binding.definitionId));
      const commands = bindings.filter(binding => binding.source === "command");
      const owned = input.reservationId !== undefined || input.generation !== undefined ? this.requireClaim(next, input, owner) : undefined;
      if (owned) requireHardware(owned.state === "active" && owned.acquiredItem.physicalResourceId === item.physicalResourceId, "INVALID_PHASE", "Owner refresh requires an active claim for this physical group.");
      if (!commands.length) { this.manualObservations(next, item); admitted.record.receipt.state = "succeeded"; admitted.record.receipt.finishedAt = now(); admitted.record.receipt.result = json({ observations: next.observations[item.id] ?? [] }); return { receipt: admitted.record.receipt }; }
      const inventory = await this.inspectInventory(next), keys = inventory.groupKeys.get(item.physicalResourceId)!;
      requireHardware(!inventory.conflictingGroups.has(item.physicalResourceId), "ENDPOINT_CONFLICT", "Correct the cross-group endpoint conflict before checking hardware.");
      let ref: ReservationRef | undefined, checkGeneration: number | undefined;
      if (owned) {
        ref = refOf(owned); owned.activeOperationIds.push(admitted.record.receipt.runId); owned.revision++; admitted.record.receipt.reservation = ref;
      } else {
        this.requireNoHold(next, keys);
        checkGeneration = next.nextGeneration++;
        next.checkHolds.push({ kind: "system_check", runId: admitted.record.receipt.runId, generation: checkGeneration, revision: 1, hardwareId: item.id, resourceKeys: keys, state: "checking", bindingRevisions: commands.map(binding => ({ definitionId: binding.definitionId, revision: binding.revision })), startedAt: now() });
      }
      dispatch = { runId: admitted.record.receipt.runId, item: clone(item), bindings: clone(commands), ref, checkGeneration };
      return { receipt: admitted.record.receipt };
    });
    if (dispatch) { const work = dispatch; this.launch(work.item.id, work.runId, work.ref, async signal => {
      const observations: StatusObservation[] = [];
      const diagnostics: JsonObject[] = [];
      let uncertain = false, measurementError = false;
      for (const binding of work.bindings) {
        if (binding.source !== "command") continue;
        await this.assertOwnerActive(owner);
        if (work.ref) this.currentClaim(work.ref, ["active"]);
        else requireHardware(this.state.checkHolds.some(hold => hold.runId === work.runId && hold.generation === work.checkGeneration && hold.state === "checking"), "STALE_RESERVATION", "Checking generation was revoked.");
        signal.throwIfAborted();
        const result = await this.scripts.run(binding.script, { purpose: "status", hardwareId: work.item.id, physicalResourceId: work.item.physicalResourceId, runId: work.runId, generation: work.ref?.generation ?? work.checkGeneration!, owner: json(owner), connection: work.item.config }, signal);
        diagnostics.push({ definitionId: binding.definitionId, ...scriptDiagnostics(result, Math.floor(64 * 1024 / work.bindings.length)) });
        const observation: StatusObservation = { definitionId: binding.definitionId, bindingRevision: binding.revision, state: "error", observedAt: now(), expiresAt: new Date(Date.now() + binding.maxAgeMs).toISOString(), runId: work.runId };
        try {
          const definition = this.state.statusDefinitions.find(definition => definition.id === binding.definitionId)!;
          const normalExit = result.exitCode !== null && result.cleanupConfirmed && !result.timedOut && !result.cancelled && (result.state === "completed" || result.state === "failed" && result.errorCode === "EXIT_CODE");
          requireHardware(normalExit && (definition.valueType === "boolean" || result.state === "completed" && result.exitCode === 0), "STATUS_CHECK_FAILED", "Status command did not complete successfully.");
          const value: unknown = definition.valueType === "boolean" ? result.exitCode === 0 : JSON.parse(result.stdout);
          validateHardwareStatusValue(value, definition);
          observation.state = "known"; observation.value = value;
        } catch { observation.errorCode = result.errorCode ?? "INVALID_STATUS_VALUE"; measurementError = true; }
        observations.push(observation);
        if (result.state === "unknown") { uncertain = true; break; }
      }
      const outcome: ProviderOutcome<JsonObject> = uncertain ? { state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "Status checking process or effects remain uncertain." } } : measurementError ? failure("STATUS_CHECK_FAILED", "A status command returned an invalid or failed observation.") : { state: "completed", value: json({ observations }) };
      await this.finish(work.runId, work.ref, outcome, (next, claim, receipt) => {
        if (work.ref && !claim) return;
        const hold = next.checkHolds.find(hold => hold.runId === work.runId && hold.generation === work.checkGeneration);
        if (!work.ref && !hold) return;
        const current = next.observations[work.item.id] ?? [];
        next.observations[work.item.id] = [...current.filter(old => !observations.some(observation => observation.definitionId === old.definitionId)), ...observations];
        receipt.result = json({ observations, diagnostics });
        if (hold) { if (uncertain) { hold.state = "recovery_required"; hold.revision++; hold.recoveryReason = "The checking execution has an uncertain outcome."; } else next.checkHolds = next.checkHolds.filter(record => record !== hold); }
      });
    }); }
    return result;
  }

  private async accessAction(action: string, input: Record<string, unknown>, owner: HardwareOwner, internal = false): Promise<HardwareMutationResult> {
    fields(input, ["requestId", "reservationId", "generation", ...(action === "hardware.access.invoke" ? ["operationId", "input"] : [])]);
    let dispatch: { runId: string; ref: ReservationRef; hardwareId: string } | undefined;
    const result = await this.change(async next => {
      const admitted = this.admit(next, action, input, owner);
      if (admitted.existing) return this.mutationResult(next, admitted.record.receipt);
      if (action !== "hardware.access.close") await this.assertOwnerActive(owner);
      const claim = this.requireClaim(next, input, owner);
      requireHardware(action === "hardware.access.close" || claim.state === "active", "INVALID_PHASE", "Hardware effects require an active reservation.");
      if (action === "hardware.access.close" && claim.accessState === "closed" && !this.access.has(claim.reservationId)) {
        const receipt = admitted.record.receipt; receipt.reservation = refOf(claim); receipt.state = "succeeded"; receipt.finishedAt = now(); receipt.result = { closed: true };
        return this.mutationResult(next, receipt);
      }
      const item = claim.acquiredItem;
      const provider = action === "hardware.access.close" ? undefined : this.provider(item);
      if (action === "hardware.access.invoke") {
        const operation = provider!.descriptor.operations.find(operation => operation.id === input.operationId);
        requireHardware(operation, "INVALID_INPUT", "This provider does not advertise the requested operation.");
        validateSchema(operation.inputSchema, input.input);
        requireHardware(this.access.get(claim.reservationId)?.connection && claim.accessState === "open", "INVALID_PHASE", "Explicitly open this reservation's managed connection before invoking an operation.");
      }
      if (action === "hardware.access.open") {
        const inventory = await this.inspectInventory(next), endpoint = inventory.endpoints.get(item.id)!;
        requireHardware(endpoint.inspection.ready && !inventory.conflictingGroups.has(item.physicalResourceId), "STATUS_NOT_READY", "The selected endpoint is not ready or has conflicting aliases.");
        const keys = inventory.groupKeys.get(item.physicalResourceId)!;
        if (canonical(keys) !== canonical(claim.resourceKeys)) {
          this.recover(claim, "Endpoint identity changed after acquisition. Inspect and release or reconcile this reservation.");
          admitted.record.receipt.state = "unknown"; admitted.record.receipt.finishedAt = now(); admitted.record.receipt.error = { code: "OUTCOME_UNKNOWN", message: claim.recoveryReason! };
          return this.mutationResult(next, admitted.record.receipt);
        }
      }
      const receipt = admitted.record.receipt; receipt.reservation = refOf(claim); claim.activeOperationIds.push(receipt.runId); claim.revision++;
      if (action === "hardware.access.open" && claim.accessState !== "open") claim.accessState = "opening";
      if (action === "hardware.access.close") claim.accessState = "closing";
      dispatch = { runId: receipt.runId, ref: refOf(claim), hardwareId: item.id };
      return this.mutationResult(next, receipt);
    }, internal);
    if (dispatch) { const work = dispatch; this.launch(work.hardwareId, work.runId, work.ref, async signal => {
      if (action !== "hardware.access.close") await this.assertOwnerActive(owner);
      const claim = this.currentClaim(work.ref, action === "hardware.access.close" ? ["preparing", "active", "releasing", "recovery_required"] : ["active"]);
      signal.throwIfAborted();
      const provider = action === "hardware.access.close" ? undefined : this.provider(claim.acquiredItem);
      let outcome: ProviderOutcome<JsonObject>;
      if (action === "hardware.access.open") {
        let access = this.access.get(claim.reservationId);
        if (access?.generation === claim.generation && access.connection) outcome = { state: "completed", value: json({ connectionId: claim.reservationId, operations: provider!.descriptor.operations }) };
        else {
          access = { generation: claim.generation, cleanup: [] }; this.access.set(claim.reservationId, access);
          const opened = await bounded(signal, 10_000, childSignal => provider!.connect(provider!.parseConfig(claim.acquiredItem.config), this.accessContext(claim, childSignal, access!)));
          if (opened.state === "completed") {
            const validConnection = opened.value && typeof opened.value.invoke === "function" && typeof opened.value.close === "function";
            if (validConnection) access.connection = opened.value;
            outcome = validConnection && access.cleanup.length ? { state: "completed", value: json({ connectionId: claim.reservationId, operations: provider!.descriptor.operations }) } : { state: "unknown", error: { code: "INVALID_PROVIDER_OUTPUT", message: "Connection setup did not provide a valid connection and register cleanup before dispatch." } };
          }
          else outcome = opened;
        }
      } else if (action === "hardware.access.close") {
        const closed = await this.closeAccess(work.ref, signal);
        outcome = closed.state === "completed" ? { state: "completed", value: { closed: true } } : closed;
      } else {
        const access = this.access.get(claim.reservationId);
        requireHardware(access?.generation === claim.generation && access.connection, "INVALID_PHASE", "The managed connection is no longer open.");
        const values = hardwareInput(() => hardwareRecord(input.input));
        const timeoutMs = hardwareInput(() => hardwareInteger(values.timeoutMs ?? (typeof values.durationMs === "number" ? values.durationMs + 1000 : 60_000), "Operation deadline", 1, 3_600_000));
        outcome = await bounded(signal, timeoutMs, childSignal => access.connection!.invoke(String(input.operationId), values as JsonObject, childSignal));
        if (outcome.state === "completed") { const operation = provider!.descriptor.operations.find(operation => operation.id === input.operationId)!; try { validateSchema(operation.outputSchema, outcome.value); } catch { outcome = { state: "unknown", error: { code: "INVALID_PROVIDER_OUTPUT", message: "The provider returned invalid output after dispatch." } }; } }
      }
      await this.finish(work.runId, work.ref, outcome, (_next, held) => {
        if (!held) return;
        if (action === "hardware.access.open") held.accessState = outcome.state === "completed" ? "open" : outcome.state === "unknown" ? "unknown" : "closed";
        if (action === "hardware.access.close") { held.accessState = outcome.state === "completed" ? "closed" : "unknown"; if (outcome.state !== "completed") this.recover(held, "Managed access cleanup is incomplete.", "cleanup"); }
      });
    }); }
    return result;
  }

  private async registerSshKey(input: Record<string, unknown>, owner: HardwareOwner): Promise<HardwareMutationResult> {
    requireHardware(owner.kind === "user", "FORBIDDEN", "SSH key registration belongs to the user.");
    fields(input, ["requestId", "reservationId", "generation", "timeoutMs", "credentialRefId"]);
    const timeoutMs = hardwareInput(() => hardwareInteger(input.timeoutMs, "Registration deadline", 1, 3_600_000));
    const credentialRefId = input.credentialRefId === undefined ? undefined : hardwareInput(() => hardwareId(input.credentialRefId, "SSH credential reference"));
    requireHardware(!credentialRefId || credentialRefId.startsWith("ssh-registration-") || credentialRefId.startsWith("ssh-password-"), "INVALID_INPUT", "Choose a private SSH password reference.");
    let dispatch: { runId: string; ref: ReservationRef; hardwareId: string } | undefined;
    const result = await this.change(async next => {
      const admitted = this.admit(next, "hardware.ssh.registerKey", input, owner);
      if (admitted.existing) return this.mutationResult(next, admitted.record.receipt);
      const claim = this.requireClaim(next, input, owner), provider = this.provider(claim.acquiredItem);
      requireHardware(claim.state === "active" && claim.accessState === "closed" && !this.access.get(claim.reservationId)?.connection, "INVALID_PHASE", "Register the SSH key before opening managed access on an active reservation.");
      requireHardware(provider.descriptor.id === "hardware.ssh" && typeof provider.registerKey === "function", "INVALID_INPUT", "This hardware provider does not support SSH key registration.");
      const inventory = await this.inspectInventory(next), endpoint = inventory.endpoints.get(claim.hardwareId)!;
      requireHardware(endpoint.inspection.ready && !inventory.conflictingGroups.has(claim.acquiredItem.physicalResourceId), "STATUS_NOT_READY", "The selected endpoint is not ready or has conflicting aliases.");
      if (canonical(inventory.groupKeys.get(claim.acquiredItem.physicalResourceId)) !== canonical(claim.resourceKeys)) {
        this.recover(claim, "Endpoint identity changed after acquisition. Inspect and release or reconcile this reservation.");
        admitted.record.receipt.reservation = refOf(claim); admitted.record.receipt.state = "unknown"; admitted.record.receipt.finishedAt = now(); admitted.record.receipt.error = { code: "OUTCOME_UNKNOWN", message: claim.recoveryReason! };
        return this.mutationResult(next, admitted.record.receipt);
      }
      const receipt = admitted.record.receipt; receipt.reservation = refOf(claim); claim.activeOperationIds.push(receipt.runId); claim.revision++;
      dispatch = { runId: receipt.runId, ref: refOf(claim), hardwareId: claim.hardwareId };
      return this.mutationResult(next, receipt);
    });
    if (dispatch) {
      const work = dispatch;
      let providerWork: Promise<ProviderOutcome<JsonObject>> | undefined, cleanupConfirmed = false;
      this.launch(work.hardwareId, work.runId, work.ref, async signal => {
        let claim = this.currentClaim(work.ref, ["active"]);
        const provider = this.provider(claim.acquiredItem);
        const inventory = await this.inspectInventory(this.state), endpoint = inventory.endpoints.get(claim.hardwareId)!;
        signal.throwIfAborted(); claim = this.currentClaim(work.ref, ["active"]);
        if (!endpoint.inspection.ready || inventory.conflictingGroups.has(claim.acquiredItem.physicalResourceId) || canonical(inventory.groupKeys.get(claim.acquiredItem.physicalResourceId)) !== canonical(claim.resourceKeys)) {
          await this.finish(work.runId, work.ref, { state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "The SSH endpoint identity or readiness changed before registration dispatch." } }); return;
        }
        requireHardware(!this.access.get(claim.reservationId)?.connection && provider.descriptor.id === "hardware.ssh" && typeof provider.registerKey === "function", "INVALID_PHASE", "SSH registration requires closed managed access and the acquired SSH provider.");
        const access = this.access.get(claim.reservationId) ?? { generation: claim.generation, cleanup: [] };
        requireHardware(access.generation === claim.generation, "INVALID_PHASE", "A prior access generation still requires cleanup.");
        this.access.set(claim.reservationId, access);
        const priorClosers = access.cleanup.length;
        let outcome = await bounded(signal, timeoutMs, childSignal => {
          providerWork = Promise.resolve().then(() => provider.registerKey!(provider.parseConfig(claim.acquiredItem.config), { timeoutMs, ...(credentialRefId ? { credentialRefId } : {}) }, this.accessContext(claim, childSignal, access)));
          return providerWork;
        });
        const noEffects = outcome.state === "failed" && outcome.effects === "none";
        if (noEffects && !access.cleanup.length) { this.access.delete(claim.reservationId); cleanupConfirmed = true; }
        else { const ownCleanup = access.cleanup.length > priorClosers; cleanupConfirmed = (await this.closeAccess(work.ref, new AbortController().signal)).state === "completed" && (noEffects || ownCleanup); }
        if (!cleanupConfirmed) outcome = { state: "unknown", error: { code: "CLEANUP_UNCONFIRMED", message: "SSH registration could not confirm that its managed processes ended." } };
        if (outcome.state === "completed") { try { validateHardwareJson(outcome.value); } catch { outcome = { state: "unknown", error: { code: "INVALID_PROVIDER_OUTPUT", message: "SSH registration returned invalid output after dispatch." } }; } }
        await this.finish(work.runId, work.ref, outcome, (_next, held) => { if (held) held.accessState = cleanupConfirmed ? "closed" : "unknown"; });
      });
      if (credentialRefId?.startsWith("ssh-registration-") && this.options.discardCredential) {
        void this.tasks.get(work.runId)!.promise.then(async () => {
          if (providerWork && !cleanupConfirmed) return;
          await providerWork?.catch(() => undefined);
          await this.options.discardCredential!(credentialRefId);
        }).catch(async () => {
          try { await this.change(next => this.addHistory(next, "credential_discard_failed", "A temporary SSH credential could not be removed from private storage.", owner), true); }
          catch { /* Local credential cleanup cannot replace the saved provider outcome. */ }
        });
      }
    }
    return result;
  }

  private accessContext(claim: HardwareReservationRecord, signal: AbortSignal, access: Access): HardwareAccessContext {
    return { reservation: publicClaim(claim), signal,
      resolveCredential: async id => { requireHardware(this.options.resolveCredential, "CREDENTIAL_UNAVAILABLE", "The configured hardware credential cannot be resolved."); return this.options.resolveCredential(id); },
      recordEvent: async event => { await this.change(next => this.addHistory(next, event.kind, "Managed provider event.", claim.owner, claim), true); },
      registerCleanup: close => { this.currentClaim(refOf(claim), ["active"]); signal.throwIfAborted(); access.cleanup.push(close); } };
  }

  beginShutdown(): void {
    this.stopping = true;
    if (this.scheduler) clearInterval(this.scheduler);
  }

  async ownerUnknown(candidate: HardwareOwner, reason = "The exact execution owner cannot be confirmed."): Promise<void> {
    if (!this.ready) return;
    const owner = hardwareInput(() => parseHardwareOwner(candidate));
    const refs = await this.change(next => {
      const held = next.reservations.filter(claim => sameOwner(claim.owner, owner) && claim.lastOwnerObservation !== "confirmed_ended");
      for (const claim of held) {
        claim.lastOwnerObservation = "unknown"; claim.lastOwnerObservedAt = now();
        this.recover(claim, reason, claim.recoveryCause ?? "owner");
        this.addHistory(next, "owner_unknown", reason, owner, claim);
      }
      return held.map(refOf);
    }, true);
    for (const ref of refs) this.cancelTasks(ref);
  }

  async ownerEnded(candidate: HardwareOwner): Promise<void> {
    if (!this.ready) return;
    const owner = hardwareInput(() => parseHardwareOwner(candidate));
    const refs = await this.change(next => {
      const held = next.reservations.filter(claim => sameOwner(claim.owner, owner));
      for (const claim of held) {
        claim.lastOwnerObservation = "confirmed_ended"; claim.lastOwnerObservedAt = now(); claim.revision++;
        if (claim.state === "recovery_required" && claim.recoveryCause === "owner") { claim.state = "active"; delete claim.recoveryReason; delete claim.recoveryCause; }
        this.addHistory(next, "owner_ended", "The exact execution owner has ended and its producer has quiesced.", owner, claim);
      }
      return held.map(claim => ({ ref: refOf(claim), state: claim.state, accessState: claim.accessState }));
    }, true);
    for (const { ref, state, accessState } of refs) {
      if (["preparing", "active", "releasing"].includes(state)) {
        try { await this.release({ requestId: `owner-ended-${randomUUID()}`, ...ref }, owner, true); }
        catch (error) {
          if (error instanceof HardwareError && error.code === "CAPACITY_EXCEEDED") { await this.requireOperatorCleanupAtCapacity(ref, owner); continue; }
          if (!(error instanceof HardwareError) || !["RECOVERY_REQUIRED", "STALE_RESERVATION"].includes(error.code)) throw error;
          await this.closeEndedOwner(ref, owner);
        }
      }
      else if (accessState !== "closed") await this.closeEndedOwner(ref, owner);
      else this.cancelTasks(ref);
    }
  }
  private async closeEndedOwner(ref: ReservationRef, owner: HardwareOwner): Promise<void> {
    this.cancelTasks(ref);
    const held = this.state.reservations.find(claim => sameRef(claim, ref));
    if (!held || held.accessState === "closed" || !this.access.has(ref.reservationId)) return;
    try { await this.accessAction("hardware.access.close", { requestId: `owner-ended-close-${randomUUID()}`, ...ref }, owner, true); }
    catch (error) {
      if (error instanceof HardwareError && error.code === "CAPACITY_EXCEEDED") await this.requireOperatorCleanupAtCapacity(ref, owner);
      else if (!(error instanceof HardwareError) || error.code !== "STALE_RESERVATION") throw error;
    }
  }
  private async requireOperatorCleanupAtCapacity(ref: ReservationRef, owner: HardwareOwner): Promise<void> {
    await this.change(next => {
      const held = next.reservations.find(claim => sameRef(claim, ref));
      if (!held) return;
      const reason = "Automatic cleanup reached Hardware capacity. The resource remains held. Inspect its activity and use an acknowledged operator override.";
      this.recover(held, reason, "cleanup");
      this.addHistory(next, "cleanup_capacity", reason, owner, held);
    }, true);
    this.cancelTasks(ref);
  }

  dispose(): Promise<void> { return this.disposal ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.beginShutdown();
    if (!this.ready) { await this.initialization?.catch(() => undefined); if (!this.ready) { await this.store.dispose(); return; } }
    try {
      for (const task of this.tasks.values()) task.controller.abort(new Error("Hardware service is shutting down."));
      await Promise.allSettled([...this.tasks.values()].map(task => task.promise));
      for (const [reservationId, access] of this.access) {
        const outcome = await this.closeAccess({ reservationId, generation: access.generation }, new AbortController().signal);
        await this.change(next => {
          const claim = next.reservations.find(claim => claim.reservationId === reservationId && claim.generation === access.generation);
          if (!claim) return;
          claim.accessState = outcome.state === "completed" ? "closed" : "unknown"; claim.revision++;
          if (outcome.state !== "completed") this.recover(claim, "Shutdown could not confirm managed access cleanup.", "cleanup");
        }, true);
      }
      await this.tail;
    } finally {
      this.ready = false;
      await this.store.dispose();
      this.listeners.clear();
    }
  }

  private assertAdmission(): void {
    requireHardware(this.ready && !this.stopping && !this.unavailableReason, "STORE_UNAVAILABLE", this.unavailableReason ?? (this.stopping ? "Hardware is shutting down." : "Hardware has not finished loading."));
    try { this.store.assertHeld(); } catch (error) { this.unavailableReason = "Hardware lost its exclusive writer authority."; this.beginShutdown(); for (const task of this.tasks.values()) task.controller.abort(error); throw error; }
  }
  private async assertOwnerActive(owner: HardwareOwner): Promise<void> {
    const observation = await this.observeOwner(owner);
    requireHardware(observation === "active", "OWNER_CHANGED", "The exact execution owner is no longer confirmed active.");
  }
  private async observeOwner(owner: HardwareOwner): Promise<"active" | "confirmed_ended" | "unknown"> {
    if (owner.kind === "user") return "active";
    try { return await this.options.ownerState?.(owner) ?? "unknown"; }
    catch { return "unknown"; }
  }

  private async change<T>(update: (next: HardwareStoredState) => T | Promise<T>, internal = false): Promise<T> {
    const mutation = this.tail.then(async () => {
      if (!internal) this.assertAdmission();
      else { requireHardware(this.ready, "STORE_UNAVAILABLE", "Hardware store is closed."); this.store.assertHeld(); }
      const next = clone(this.state);
      const result = await update(next);
      if (this.replayedRequests.has(next)) return clone(result);
      next.revision++;
      this.pruneDetails(next);
      this.capacity.assertMutation(this.state, next);
      try { await this.store.write(next); }
      catch (error) {
        this.unavailableReason = "Hardware could not confirm its durable state. Admission is closed until restart and reconciliation.";
        this.beginShutdown(); for (const task of this.tasks.values()) task.controller.abort(error);
        throw error;
      }
      this.state = next;
      this.notifyChange();
      return clone(result);
    });
    this.tail = mutation.catch(() => undefined);
    return mutation;
  }
  private notifyChange(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Observers cannot undo the durable authority. */ } } }

  private admit(next: HardwareStoredState, action: string, input: Record<string, unknown>, owner: HardwareOwner): { record: StoredHardwareReceipt; existing: boolean } {
    const requestId = hardwareInput(() => hardwareId(input.requestId, "Request ID"));
    hardwareInput(() => validateHardwareJson(input));
    const digest = createHash("sha256").update(canonical({ action, input })).digest("hex");
    const existing = next.receipts.find(record => sameOwner(record.owner, owner) && record.receipt.requestId === requestId);
    if (existing) { requireHardware(existing.action === action && existing.digest === digest, "REQUEST_ID_REUSED", "This owner already used that request ID with a different action or payload."); this.replayedRequests.add(next); return { record: existing, existing: true }; }
    this.capacity.assertNewRequest(next, action);
    const record: StoredHardwareReceipt = { owner: clone(owner), action, digest, receipt: { requestId, runId: `run-${randomUUID()}`, state: "running", startedAt: now() } };
    next.receipts.push(record);
    return { record, existing: false };
  }

  private mutationResult(next: HardwareStoredState, receipt: OperationReceipt): HardwareMutationResult {
    const claim = receipt.reservation && next.reservations.find(claim => sameRef(claim, receipt.reservation!));
    return { receipt, ...(claim ? { reservation: publicClaim(claim) } : {}) };
  }

  private requireRevision(actual: number, expected: unknown): void {
    const revision = hardwareInput(() => hardwareInteger(expected, "Expected revision"));
    requireHardware(actual === revision, "REVISION_CONFLICT", "The record changed. Read the current revision before editing.", { expected: revision, actual });
  }
  private requireItem(next: HardwareStoredState, id: string): HardwareItem {
    const item = next.items.find(item => item.id === id);
    requireHardware(item, "NOT_FOUND", "The hardware item no longer exists.");
    return item;
  }
  private requireClaim(next: HardwareStoredState, input: Record<string, unknown>, owner: HardwareOwner): HardwareReservationRecord {
    const id = hardwareInput(() => hardwareId(input.reservationId, "Reservation ID"));
    const generation = hardwareInput(() => hardwareInteger(input.generation, "Reservation generation"));
    const claim = next.reservations.find(claim => claim.reservationId === id);
    requireHardware(claim && claim.generation === generation, "STALE_RESERVATION", "This reservation generation is no longer current.");
    requireHardware(sameOwner(claim.owner, owner), "OWNER_CHANGED", "Only the exact owner of this execution can use its reservation.");
    return claim;
  }
  private currentClaim(ref: ReservationRef, phases: HardwareReservation["state"][]): HardwareReservationRecord {
    this.store.assertHeld();
    const claim = this.state.reservations.find(claim => sameRef(claim, ref));
    requireHardware(claim, "STALE_RESERVATION", "The admitted reservation generation has been revoked.");
    requireHardware(phases.includes(claim.state), "INVALID_PHASE", "The reservation phase no longer permits this operation.");
    return clone(claim);
  }
  private requireNoHold(next: HardwareStoredState, keys: string[]): void {
    const conflicts = (held: { resourceKeys: string[] }) => held.resourceKeys.some(key => keys.includes(key));
    const check = next.checkHolds.find(conflicts);
    requireHardware(!check, check?.state === "checking" ? "CHECK_IN_PROGRESS" : "RECOVERY_REQUIRED", check?.state === "checking" ? "A system check holds this physical resource." : "A prior system check requires operator reconciliation.");
    requireHardware(!next.reservations.some(conflicts), "RESERVATION_CONFLICT", "Another live reservation holds this physical resource.");
  }
  private recover(claim: HardwareReservationRecord, reason: string, cause: HardwareReservationRecord["recoveryCause"] = "effects"): void {
    claim.state = "recovery_required"; claim.revision++; claim.updatedAt = now(); claim.recoveryReason = reason;
    if (claim.recoveryCause !== "effects" && claim.recoveryCause !== "cleanup" && claim.recoveryCause !== "hook" && claim.recoveryCause !== "restart") claim.recoveryCause = cause;
  }
  private provider(item: HardwareItem): HardwareTypeProvider<unknown> {
    let provider: HardwareTypeProvider<unknown>;
    try { provider = this.options.registry.get(item.typeId); }
    catch { throw new HardwareError("PROVIDER_UNAVAILABLE", "The hardware type provider is not installed or enabled."); }
    requireHardware(provider.descriptor.configVersion === item.configVersion, "CONFIG_VERSION_UNSUPPORTED", "The provider does not support this saved configuration version.");
    validateSchema(provider.descriptor.configSchema, item.config);
    hardwareInput(() => provider.parseConfig(item.config));
    return provider;
  }
  private validateItemReferences(next: HardwareStoredState, item: HardwareItem): void {
    requireHardware(next.groups.some(group => group.id === item.physicalResourceId), "INVALID_INPUT", "Choose an existing physical resource group.");
    requireHardware(item.tagIds.every(id => next.tags.some(tag => tag.id === id)), "INVALID_INPUT", "Every item tag must exist.");
    for (const binding of item.statuses) {
      const definition = next.statusDefinitions.find(definition => definition.id === binding.definitionId);
      requireHardware(definition, "INVALID_INPUT", "Every bound status definition must exist.");
      if (binding.source === "manual") hardwareInput(() => validateHardwareStatusValue(binding.value, definition));
      if (binding.requiredForReserve) hardwareInput(() => validateHardwareStatusValue(binding.requiredForReserve!.equals, definition));
    }
  }
  private uniqueLabel<T extends { id: string }>(records: T[], value: string, ignore: string | undefined, read: (record: T) => string): void {
    requireHardware(!records.some(record => record.id !== ignore && read(record).normalize("NFKC").toLocaleLowerCase() === value.normalize("NFKC").toLocaleLowerCase()), "DUPLICATE_LABEL", "A catalog record already uses this label.");
  }
  private manualObservations(next: HardwareStoredState, item: HardwareItem): void {
    const previous = next.observations[item.id] ?? [];
    next.observations[item.id] = item.statuses.flatMap(binding => {
      if (binding.source === "manual") {
        const existing = previous.find(observation => observation.definitionId === binding.definitionId && observation.bindingRevision === binding.revision && observation.state === "known" && observation.value === binding.value);
        return [existing ?? { definitionId: binding.definitionId, bindingRevision: binding.revision, state: "known" as const, value: binding.value, observedAt: now() }];
      }
      return previous.filter(observation => observation.definitionId === binding.definitionId && observation.bindingRevision === binding.revision);
    });
  }
  private async validateItemScripts(item: HardwareItem): Promise<void> {
    const scripts = [...item.statuses.flatMap(binding => binding.source === "command" ? [binding.script] : []), ...Object.values(item.hooks)];
    for (const script of scripts) await this.scripts.validateWorkingDirectory(script.cwd);
  }
  private addHistory(next: HardwareStoredState, kind: string, detail: string, owner?: HardwareOwner, claim?: HardwareReservationRecord, hardwareIdValue?: string, runId?: string): void {
    next.history.push({ id: `event-${randomUUID()}`, at: now(), kind, detail, ...(owner ? { owner: clone(owner) } : {}), ...(claim ? { reservationId: claim.reservationId } : {}), ...(claim || hardwareIdValue ? { hardwareId: claim?.hardwareId ?? hardwareIdValue } : {}), ...(runId ? { runId } : {}) });
  }

  private pruneDetails(next: HardwareStoredState): void {
    const cutoff = Date.now() - this.retention.completedMaxAgeMs;
    const completed = next.receipts.filter(record => ["succeeded", "failed"].includes(record.receipt.state)).sort((a, b) => Date.parse(a.receipt.finishedAt!) - Date.parse(b.receipt.finishedAt!));
    const retained = new Set(completed.slice(-this.retention.completedMaxEntries));
    let bytes = 0;
    for (const record of [...completed].reverse()) {
      const { receipt } = record;
      if (receipt.outputPruned || receipt.result === undefined) continue;
      const size = Buffer.byteLength(JSON.stringify(receipt.result));
      const reason = Date.parse(receipt.finishedAt!) < cutoff ? "age" : !retained.has(record) ? "count" : bytes + size > this.retention.outputMaxBytes ? "budget" : undefined;
      if (reason) { delete receipt.result; receipt.outputPruned = { at: now(), reason }; }
      else bytes += size;
    }
    const unresolvedRuns = new Set(next.receipts.filter(record => ["running", "unknown"].includes(record.receipt.state)).map(record => record.receipt.runId));
    const held = new Set(next.reservations.map(claim => claim.reservationId));
    const protectedHistory = (event: HardwareStoredState["history"][number]) => Boolean(event.reservationId && held.has(event.reservationId) || event.runId && unresolvedRuns.has(event.runId));
    const detailed = next.history.filter(event => !protectedHistory(event) && Date.parse(event.at) >= cutoff).slice(-this.retention.completedMaxEntries);
    const keep = new Set(detailed);
    next.history = next.history.filter(event => keep.has(event) || protectedHistory(event));
  }

  private async inspectInventory(state: HardwareStoredState): Promise<Inventory> {
    const endpoints = new Map<string, Endpoint>();
    const groupKeys = new Map(state.groups.map(group => [group.id, [`physical:${group.id}`]]));
    for (const item of state.items) {
      let endpoint: Endpoint;
      try {
        const provider = this.provider(item), config = provider.parseConfig(item.config);
        const inspection = await provider.inspectEndpoint(config);
        requireHardware(Array.isArray(inspection.resourceKeys) && inspection.resourceKeys.length <= 64 && inspection.resourceKeys.every(key => typeof key === "string" && key.length > 0 && key.length <= 4096) && typeof inspection.ready === "boolean" && Array.isArray(inspection.blockers) && inspection.blockers.every(blocker => typeof blocker === "string" && blocker.length <= 4096), "INVALID_PROVIDER_OUTPUT", "Endpoint inspection returned an invalid readiness or identity.");
        const keys = [...new Set(inspection.resourceKeys)].sort();
        state.endpointKeys[item.id] = keys;
        endpoint = { provider, config, inspection: { ...inspection, resourceKeys: keys } };
      } catch (error) {
        endpoint = { inspection: { resourceKeys: state.endpointKeys[item.id] ?? [], ready: false, blockers: [error instanceof HardwareError && error.code === "PROVIDER_UNAVAILABLE" ? "Provider unavailable" : "Endpoint inspection unavailable"] } };
      }
      endpoints.set(item.id, endpoint);
      const keys = groupKeys.get(item.physicalResourceId)!;
      keys.push(...endpoint.inspection.resourceKeys);
    }
    for (const [group, keys] of groupKeys) groupKeys.set(group, [...new Set(keys)].sort());
    const keyGroups = new Map<string, Set<string>>();
    for (const [group, keys] of groupKeys) for (const key of keys) { const groups = keyGroups.get(key) ?? new Set<string>(); groups.add(group); keyGroups.set(key, groups); }
    const conflictingGroups = new Set<string>();
    for (const groups of keyGroups.values()) if (groups.size > 1) for (const group of groups) conflictingGroups.add(group);
    return { endpoints, groupKeys, conflictingGroups };
  }

  private summary(state: HardwareStoredState, item: HardwareItem, inventory: Inventory): HardwareSummary {
    const keys = inventory.groupKeys.get(item.physicalResourceId)!;
    const reservation = state.reservations.find(claim => claim.resourceKeys.some(key => keys.includes(key)));
    const checkHold = state.checkHolds.find(hold => hold.resourceKeys.some(key => keys.includes(key)));
    const observations = state.observations[item.id] ?? [];
    const blockers: string[] = [];
    if (!item.enabled) blockers.push("Item disabled");
    blockers.push(...inventory.endpoints.get(item.id)!.inspection.blockers);
    if (!inventory.endpoints.get(item.id)!.inspection.ready && !blockers.length) blockers.push("Endpoint not ready");
    if (inventory.conflictingGroups.has(item.physicalResourceId)) blockers.push("Endpoint aliases conflict across physical groups");
    for (const binding of item.statuses) if (binding.requiredForReserve) {
      const observation = observations.find(observation => observation.definitionId === binding.definitionId && observation.bindingRevision === binding.revision);
      if (!observation || observation.state !== "known") blockers.push(`Required status ${binding.definitionId} is unknown or failed`);
      else if (binding.source === "command" && (!observation.expiresAt || Date.parse(observation.expiresAt) <= Date.now())) blockers.push(`Required status ${binding.definitionId} is stale`);
      else if (observation.value !== binding.requiredForReserve.equals) blockers.push(`Required status ${binding.definitionId} does not equal the configured value`);
    }
    if (reservation) blockers.push(`Physical resource held: ${reservation.state}`);
    if (checkHold) blockers.push(`Physical resource held: ${checkHold.state}`);
    return { item, observations, reservation: reservation ? publicClaim(reservation) : null, availability: reservation || checkHold ? "held" : blockers.length ? "ineligible" : "available", blockers, ...(checkHold ? { checkHold } : {}) };
  }

  private async list(action: string, input: Record<string, unknown>, owner: HardwareOwner): Promise<unknown> {
    const state = clone(this.state);
    let records: unknown[], key: string;
    if (action === "hardware.items.list") {
      this.validateFilter(state, input);
      const filter = input as HardwareFilter, inventory = await this.inspectInventory(state);
      records = state.items.map(item => this.summary(state, item, inventory)).filter(summary => this.matches(summary, filter, owner));
      records.sort((a, b) => orderName((a as HardwareSummary).item, (b as HardwareSummary).item));
      key = "items";
    } else if (action === "hardware.reservations.list") {
      fields(input, ["state", "ownedByMe", "cursor", "limit"]);
      requireHardware(input.state === undefined || ["preparing", "active", "releasing", "recovery_required", "checking"].includes(String(input.state)), "INVALID_FILTER", "Unknown reservation state filter.");
      requireHardware(input.ownedByMe === undefined || typeof input.ownedByMe === "boolean", "INVALID_FILTER", "ownedByMe must be boolean.");
      const reservations = state.reservations.filter(claim => (!input.state || claim.state === input.state) && (!input.ownedByMe || sameOwner(claim.owner, owner))).map(publicClaim);
      const checks = input.ownedByMe ? [] : state.checkHolds.filter(hold => !input.state || hold.state === input.state);
      const page = this.page([...reservations, ...checks], input, state.revision, `${action}:${ownerKey(owner)}`);
      return { reservations: page.values.filter(value => !("kind" in value)), checkHolds: page.values.filter(value => "kind" in value), nextCursor: page.nextCursor, revision: state.revision };
    } else {
      fields(input, ["cursor", "limit"]);
      if (action === "hardware.tags.list") { key = "tags"; records = state.tags.map(tag => ({ ...tag, usageCount: state.items.filter(item => item.tagIds.includes(tag.id)).length })); records.sort((a, b) => orderName({ id: (a as { id: string }).id, name: (a as { label: string }).label }, { id: (b as { id: string }).id, name: (b as { label: string }).label })); }
      else if (action === "hardware.groups.list") { key = "groups"; records = [...state.groups].sort(orderName); }
      else if (action === "hardware.statuses.list") { key = "statuses"; records = [...state.statusDefinitions].sort((a, b) => orderName({ ...a, name: a.label }, { ...b, name: b.label })); }
      else if (action === "hardware.types.list") { key = "types"; records = this.options.registry.values().map(provider => provider.descriptor).sort((a, b) => orderName({ ...a, name: a.displayName }, { ...b, name: b.displayName })); }
      else throw new HardwareError("INVALID_INPUT", "Unknown hardware list action.");
    }
    const page = this.page(records, input, state.revision, `${action}:${ownerKey(owner)}`);
    return { [key]: page.values, nextCursor: page.nextCursor, revision: state.revision };
  }
  private page<T>(records: T[], input: Record<string, unknown>, revision: number, scope: string): { values: T[]; nextCursor: string | null } {
    const limit = hardwareInput(() => hardwareInteger(input.limit ?? 50, "Page limit", 1, 200));
    const { cursor, ...filter } = input;
    const digest = createHash("sha256").update(canonical({ scope, filter: { ...filter, limit } })).digest("hex");
    let offset = 0;
    if (cursor !== undefined) {
      const text = hardwareInput(() => hardwareText(cursor, "Page cursor", 2048));
      let parsed: Record<string, unknown>;
      try { parsed = hardwareRecord(JSON.parse(Buffer.from(text, "base64url").toString())); } catch { throw new HardwareError("INVALID_FILTER", "Invalid page cursor."); }
      requireHardware(parsed.revision === revision, "CURSOR_STALE", "Hardware changed since this page cursor. Start an explicit fresh query.");
      requireHardware(parsed.digest === digest && Number.isSafeInteger(parsed.offset) && Number(parsed.offset) >= 0 && Number(parsed.offset) <= records.length, "INVALID_FILTER", "Page cursor does not match this filter.");
      offset = Number(parsed.offset);
    }
    const end = Math.min(offset + limit, records.length);
    return { values: records.slice(offset, end), nextCursor: end < records.length ? Buffer.from(JSON.stringify({ revision, digest, offset: end })).toString("base64url") : null };
  }
  private validateFilter(state: HardwareStoredState, input: Record<string, unknown>): void {
    fields(input, ["text", "typeIds", "tags", "statuses", "availability", "ownedByMe", "enabled", "limit", "cursor"], "INVALID_FILTER");
    requireHardware(input.text === undefined || typeof input.text === "string" && input.text.length <= 4096, "INVALID_FILTER", "Text filter must be bounded text.");
    const ids = (value: unknown, exists: (id: string) => boolean) => requireHardware(value === undefined || Array.isArray(value) && value.length <= 256 && value.every(id => typeof id === "string" && exists(id)), "INVALID_FILTER", "A hardware filter contains unknown IDs.");
    ids(input.typeIds, id => this.options.registry.values().some(provider => provider.descriptor.id === id));
    if (input.tags !== undefined) { const tags = hardwareInput(() => hardwareRecord(input.tags)); fields(tags, ["all", "any", "none"], "INVALID_FILTER"); for (const value of Object.values(tags)) ids(value, id => state.tags.some(tag => tag.id === id)); }
    if (input.statuses !== undefined) {
      requireHardware(Array.isArray(input.statuses) && input.statuses.length <= 128, "INVALID_FILTER", "Status filters must be a bounded list.");
      for (const value of input.statuses) {
        const status = hardwareInput(() => hardwareRecord(value)); fields(status, ["definitionId", "equals", "requireFresh"], "INVALID_FILTER");
        const definition = state.statusDefinitions.find(definition => definition.id === status.definitionId);
        requireHardware(definition && typeof status.requireFresh === "boolean", "INVALID_FILTER", "Status filter requires an existing definition and freshness choice.");
        try { validateHardwareStatusValue(status.equals, definition); } catch { throw new HardwareError("INVALID_FILTER", "Status filter value must match the definition's exact value type."); }
      }
    }
    requireHardware(input.availability === undefined || ["available", "held", "ineligible"].includes(String(input.availability)), "INVALID_FILTER", "Unknown availability filter.");
    for (const field of ["enabled", "ownedByMe"]) requireHardware(input[field] === undefined || typeof input[field] === "boolean", "INVALID_FILTER", `${field} must be boolean.`);
  }
  private matches(summary: HardwareSummary, filter: HardwareFilter, owner: HardwareOwner): boolean {
    const item = summary.item;
    if (filter.text && !`${item.name}\n${item.description}\n${item.notes}`.toLocaleLowerCase().includes(filter.text.toLocaleLowerCase())) return false;
    if (filter.typeIds?.length && !filter.typeIds.includes(item.typeId)) return false;
    if (filter.tags?.all?.some(id => !item.tagIds.includes(id)) || filter.tags?.any?.length && !filter.tags.any.some(id => item.tagIds.includes(id)) || filter.tags?.none?.some(id => item.tagIds.includes(id))) return false;
    if (filter.enabled !== undefined && item.enabled !== filter.enabled || filter.availability && summary.availability !== filter.availability || filter.ownedByMe && (!summary.reservation || !sameOwner(summary.reservation.owner, owner))) return false;
    return !filter.statuses?.some(status => {
      const binding = item.statuses.find(binding => binding.definitionId === status.definitionId);
      const observation = summary.observations.find(observation => observation.definitionId === status.definitionId && observation.bindingRevision === binding?.revision);
      return !observation || observation.state !== "known" || observation.value !== status.equals || status.requireFresh && binding?.source === "command" && (!observation.expiresAt || Date.parse(observation.expiresAt) <= Date.now());
    });
  }

  private cancelTasks(ref: ReservationRef): void {
    for (const task of this.tasks.values()) if (task.ref && sameRef(task.ref, ref)) task.controller.abort(new Error("The reservation no longer permits this operation."));
  }
  private launch(hardwareIdValue: string, runId: string, ref: ReservationRef | undefined, run: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    const claim = ref && this.state.reservations.find(claim => sameRef(claim, ref));
    const group = claim?.acquiredItem.physicalResourceId ?? this.state.items.find(item => item.id === hardwareIdValue)?.physicalResourceId ?? hardwareIdValue;
    const previous = this.lanes.get(group) ?? Promise.resolve();
    let started = false;
    const promise = previous.catch(() => undefined).then(async () => {
      controller.signal.throwIfAborted(); this.store.assertHeld();
      started = true;
      await run(controller.signal);
    }).catch(async error => {
      const knownNoDispatch = !started || error instanceof HardwareError && ["INVALID_PHASE", "STALE_RESERVATION", "OWNER_CHANGED", "INVALID_INPUT", "CREDENTIAL_UNAVAILABLE", "PROVIDER_UNAVAILABLE"].includes(error.code);
      const outcome: ProviderOutcome<JsonObject> = knownNoDispatch ? failure(error instanceof HardwareError ? error.code : "CANCELLED", "The operation was cancelled or rejected before dispatch.") : { state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "The admitted operation ended without a confirmed result. Inspect this held resource." } };
      try { await this.finish(runId, ref, outcome, (next, held) => {
        if (held?.state === "preparing") this.recover(held, "Preparation did not produce a confirmed successful outcome.", "hook");
        const check = next.checkHolds.find(check => check.runId === runId);
        if (check) { if (knownNoDispatch) next.checkHolds = next.checkHolds.filter(hold => hold !== check); else { check.state = "recovery_required"; check.revision++; check.recoveryReason = "The checking process has an uncertain outcome."; } }
      }); } catch { /* A failed durable writer closes admission and startup reconciles the saved receipt. */ }
    }).finally(() => { this.tasks.delete(runId); if (this.lanes.get(group) === promise) this.lanes.delete(group); });
    this.tasks.set(runId, { ref, hardwareId: hardwareIdValue, controller, promise });
    this.lanes.set(group, promise);
  }

  private async finish(runId: string, ref: ReservationRef | undefined, outcome: ProviderOutcome<JsonObject>, update?: (next: HardwareStoredState, claim: HardwareReservationRecord | undefined, receipt: OperationReceipt) => void): Promise<void> {
    await this.change(next => {
      const records = next.receipts.filter(record => record.receipt.runId === runId && record.receipt.state === "running");
      if (!records.length) return;
      const claim = ref ? next.reservations.find(claim => sameRef(claim, ref)) : undefined;
      for (const record of records) {
        const receipt = record.receipt;
        receipt.state = outcome.state === "completed" ? "succeeded" : outcome.state; receipt.finishedAt = now();
        if (outcome.state === "completed") receipt.result = clone(outcome.value); else receipt.error = clone(outcome.error);
      }
      if (claim) {
        claim.activeOperationIds = claim.activeOperationIds.filter(id => id !== runId); claim.revision++; claim.updatedAt = now();
        if (outcome.state === "unknown") this.recover(claim, outcome.error.message, "effects");
      } else if (ref) for (const held of next.reservations) if (held.reservationId === ref.reservationId && held.activeOperationIds.includes(runId)) { held.activeOperationIds = held.activeOperationIds.filter(id => id !== runId); held.revision++; }
      update?.(next, claim, records[0].receipt);
      for (const record of records.slice(1)) { const requestId = record.receipt.requestId; record.receipt = { ...clone(records[0].receipt), requestId }; }
      this.addHistory(next, `operation_${outcome.state}`, outcome.state === "completed" ? "Hardware operation completed." : outcome.error.message, records[0].owner, claim, this.tasks.get(runId)?.hardwareId, runId);
    }, true);
  }

  private async runScript(script: BashScript, claim: HardwareReservationRecord, purpose: string, signal: AbortSignal) {
    return this.scripts.run(script, { purpose, hardwareId: claim.hardwareId, physicalResourceId: claim.acquiredItem.physicalResourceId, reservationId: claim.reservationId, generation: claim.generation, owner: json(claim.owner), connection: clone(claim.acquiredItem.config) }, signal);
  }
  private async closeAccess(ref: ReservationRef, signal: AbortSignal): Promise<ProviderOutcome<null>> {
    const access = this.access.get(ref.reservationId);
    const claim = this.state.reservations.find(claim => claim.reservationId === ref.reservationId);
    if (!access || access.generation !== ref.generation && (!claim || !sameRef(claim, ref))) {
      return !claim || claim.accessState === "closed" ? { state: "completed", value: null } : { state: "unknown", error: { code: "CLEANUP_UNCONFIRMED", message: "No live managed handle can confirm that the previous connection ended." } };
    }
    const closers = access.connection ? [access.connection.close.bind(access.connection)] : access.cleanup;
    if (!closers.length) return { state: "unknown", error: { code: "CLEANUP_UNCONFIRMED", message: "The provider did not register managed cleanup before connection dispatch." } };
    for (const close of closers) {
      const outcome = await bounded(signal, 10_000, close);
      if (outcome.state !== "completed") return outcome;
    }
    this.access.delete(ref.reservationId);
    return { state: "completed", value: null };
  }

  private scheduling = false;
  private lastRetentionSweep = Date.now();
  private async checkScheduledStatuses(): Promise<void> {
    if (this.scheduling || this.stopping || !this.ready || this.unavailableReason) return;
    this.scheduling = true;
    try {
      if (Date.now() - this.lastRetentionSweep >= 60_000) {
        this.lastRetentionSweep = Date.now();
        const cutoff = Date.now() - this.retention.completedMaxAgeMs;
        const held = new Set(this.state.reservations.map(claim => claim.reservationId));
        const unresolved = new Set(this.state.receipts.filter(record => ["running", "unknown"].includes(record.receipt.state)).map(record => record.receipt.runId));
        const expired = this.state.receipts.some(({ receipt }) => ["succeeded", "failed"].includes(receipt.state) && receipt.result !== undefined && Date.parse(receipt.finishedAt!) < cutoff) || this.state.history.some(event => Date.parse(event.at) < cutoff && !(event.reservationId && held.has(event.reservationId) || event.runId && unresolved.has(event.runId)));
        if (expired) await this.change(() => undefined);
      }
      if (!this.capacity.canSchedule(this.state)) return;
      const state = clone(this.state), inventory = await this.inspectInventory(state);
      for (const item of state.items) {
        const keys = inventory.groupKeys.get(item.physicalResourceId)!;
        if (!item.enabled || !inventory.endpoints.get(item.id)?.inspection.ready || inventory.conflictingGroups.has(item.physicalResourceId) || [...state.reservations, ...state.checkHolds].some(hold => hold.resourceKeys.some(key => keys.includes(key)))) continue;
        const due = item.statuses.filter(binding => binding.source === "command" && binding.intervalMs !== null && (!state.observations[item.id]?.some(observation => observation.definitionId === binding.definitionId && observation.bindingRevision === binding.revision && Date.parse(observation.observedAt) + binding.intervalMs! > Date.now()))).map(binding => binding.definitionId);
        if (!due.length) continue;
        try { await this.refresh({ requestId: `scheduled-${randomUUID()}`, hardwareId: item.id, statusIds: due }, { kind: "user", userId: "local" }); }
        catch (error) { if (!(error instanceof HardwareError) || !["RESERVATION_CONFLICT", "CHECK_IN_PROGRESS", "RECOVERY_REQUIRED", "CAPACITY_EXCEEDED"].includes(error.code)) throw error; }
      }
    } finally { this.scheduling = false; }
  }
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
}
function fields(input: Record<string, unknown>, allowed: string[], code = "INVALID_INPUT"): void {
  requireHardware(Object.keys(input).every(key => allowed.includes(key)), code, "Hardware input contains unknown fields.");
}
function orderName(a: { id: string; name: string }, b: { id: string; name: string }): number {
  return a.name.normalize("NFKC").toLocaleLowerCase().localeCompare(b.name.normalize("NFKC").toLocaleLowerCase()) || a.id.localeCompare(b.id);
}
const schemas = new Ajv2020({ strict: false, allErrors: true });
function validateSchema(schema: JsonObject, value: unknown): void {
  hardwareInput(() => validateHardwareJson(value));
  requireHardware(schemas.compile(schema)(value), "INVALID_INPUT", "Operation input or output does not match the provider's declared schema.");
}
function scriptDiagnostics(result: HardwareScriptResult, limit = 64 * 1024): JsonObject {
  const stdout = Buffer.from(result.stdout).subarray(0, limit).toString("utf8");
  const stderr = Buffer.from(result.stderr).subarray(0, Math.max(0, limit - Buffer.byteLength(stdout))).toString("utf8");
  return json({ ...result, stdout, stderr, diagnosticsTruncated: stdout !== result.stdout || stderr !== result.stderr });
}
async function bounded<T>(parent: AbortSignal, timeoutMs: number, work: (signal: AbortSignal) => Promise<ProviderOutcome<T>>): Promise<ProviderOutcome<T>> {
  if (parent.aborted) return { state: "failed", effects: "none", error: { code: "CANCELLED", message: "Operation cancelled before dispatch." } };
  const controller = new AbortController();
  let stop!: (value: ProviderOutcome<T>) => void;
  const interrupted = new Promise<ProviderOutcome<T>>(resolve => { stop = resolve; });
  const abort = () => { controller.abort(parent.reason); stop({ state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "The dispatched operation was cancelled or exceeded its deadline." } }); };
  const timer = setTimeout(abort, timeoutMs); timer.unref();
  parent.addEventListener("abort", abort, { once: true });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); }), interrupted]);
    requireHardware(result && ["completed", "failed", "unknown"].includes(result.state), "INVALID_PROVIDER_OUTPUT", "Provider returned an invalid execution envelope.");
    if (result.state === "failed") requireHardware(["none", "settled"].includes(result.effects), "INVALID_PROVIDER_OUTPUT", "Provider omitted its effect disposition.");
    if (result.state !== "completed") requireHardware(result.error && typeof result.error.code === "string" && result.error.code.length > 0 && result.error.code.length <= 128 && !result.error.code.includes("\0") && typeof result.error.message === "string" && result.error.message.length > 0 && result.error.message.length <= 4096 && !result.error.message.includes("\0"), "INVALID_PROVIDER_OUTPUT", "Provider returned an invalid error envelope.");
    return result;
  } catch { return { state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "The provider stopped without confirming its dispatched operation outcome." } }; }
  finally { clearTimeout(timer); parent.removeEventListener("abort", abort); }
}

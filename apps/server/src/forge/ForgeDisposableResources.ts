import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { ForgeWorker, WorkspaceCleanupCandidate } from "@cloudx/shared";
import { JsonStateFile } from "../jsonStateFile.js";

const execute = promisify(execFile);
const resourceLabel = "cloudx.forge.resource";
const ownerLabel = "cloudx.forge.worker";
const attemptLabel = "cloudx.forge.attempt";
interface Consumer { workerId: string; attemptId: string }
export interface DisposableContainerInput {
  image: string;
  name: string;
  command: string[];
  consumers?: Consumer[];
  retentionReason?: string;
}
export interface DisposableResource {
  id: string;
  kind: "container";
  engineId: string;
  containerId?: string;
  created?: string;
  creationRejected?: true;
  name: string;
  owner: Consumer;
  consumers: Consumer[];
  retentionReason?: string;
  state: "creating" | "owned" | "deleting" | "deleted" | "blocked" | "failed";
  reason: string;
  allocatedBytes?: number;
  reclaimedBytes: number;
  updatedAt: string;
}
export interface ContainerIdentity {
  id: string;
  created: string;
  labels: Record<string, string>;
  running: boolean;
  writableBytes: number;
}
export interface DisposableContainerHost {
  engineId(): Promise<string>;
  create(input: DisposableContainerInput, labels: Record<string, string>): Promise<string>;
  find(resourceId: string): Promise<string[]>;
  inspect(id: string): Promise<ContainerIdentity | undefined>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
interface ResourceJournal {
  resources: DisposableResource[];
  terminalWorkers: Consumer[];
}

export class ContainerCreationRejectedError extends Error {}

/** Only creation receipts grant authority; names and discovered labels alone never do. */
export class ForgeDisposableResources {
  private readonly journal: JsonStateFile;
  private tail = Promise.resolve();
  constructor(dataDir: string, private readonly workers: () => Promise<ForgeWorker[]>, private readonly host: DisposableContainerHost = new DockerDisposableContainerHost()) {
    this.journal = new JsonStateFile(dataDir, "forge-disposable-resources.json", "Forge disposable resources", 0o600);
  }

  create(worker: ForgeWorker, input: DisposableContainerInput): Promise<DisposableResource> {
    return this.serial(async () => {
      validateContainerInput(input);
      if (!worker.attemptId || !["running", "starting"].includes(worker.status)) throw new Error("A current running worker attempt must own resource creation.");
      const owner = { workerId: worker.id, attemptId: worker.attemptId };
      const consumers = [owner, ...(input.consumers ?? []).filter(item => !sameConsumer(item, owner))];
      const workers = await this.workers();
      if (consumers.some(consumer => !workers.some(current => current.id === consumer.workerId && current.attemptId === consumer.attemptId && ["running", "starting", "paused", "stopped", "failed", "awaiting_publication", "awaiting_review", "awaiting_merge"].includes(current.status))))
        throw new Error("Every shared consumer must identify a known unfinished worker attempt.");
      const state = await this.read();
      const resource: DisposableResource = {
        id: randomUUID(), kind: "container", engineId: await this.host.engineId(), name: input.name,
        owner, consumers, retentionReason: input.retentionReason, state: "creating", reason: "Creation intent recorded before Docker creation.", reclaimedBytes: 0, updatedAt: now(),
      };
      state.resources.push(resource);
      await this.journal.write(state);
      try {
        resource.containerId = await this.host.create(input, labelsFor(resource));
        const identity = await this.host.inspect(resource.containerId);
        if (!identity) throw new Error("Created container identity is unavailable.");
        assertIdentity(resource, identity);
        resource.created = identity.created;
        resource.allocatedBytes = identity.writableBytes;
        resource.state = "owned";
        resource.reason = "Disposable container and shared consumers recorded.";
      } catch (error) {
        if (!resource.containerId && error instanceof ContainerCreationRejectedError) {
          resource.creationRejected = true;
          resource.reason = `Creation rejected: ${message(error)}. Reconciliation will confirm absence on the recorded engine.`;
        } else resource.reason = `Creation interrupted: ${message(error)}. Reconciliation will inspect the recorded creation intent.`;
        resource.updatedAt = now();
        await this.journal.write(state);
        throw error;
      }
      resource.updatedAt = now();
      await this.journal.write(state);
      return structuredClone(resource);
    });
  }

  async records(): Promise<DisposableResource[]> { return structuredClone((await this.read()).resources); }

  preview(): Promise<WorkspaceCleanupCandidate[]> {
    return this.serial(async () => {
      const state = await this.read();
      const candidates: WorkspaceCleanupCandidate[] = [];
      for (const resource of state.resources.filter(item => item.state !== "deleted")) {
        let reason: string | undefined;
        try {
          if (await this.recoverCreation(resource) === "deleted") continue;
          const identity = await this.currentIdentity(resource);
          if (identity) resource.allocatedBytes = identity.writableBytes;
          else resource.allocatedBytes = 0;
          reason = await this.protection(resource, state);
        } catch (error) { reason = message(error); resource.allocatedBytes = undefined; }
        candidates.push({ id: resource.id, resourceId: resource.id, path: `docker:${resource.containerId ?? resource.name}`, repository: resource.name,
          kind: "resource", workerId: resource.owner.workerId, state: resource.state, lastActivity: resource.updatedAt,
          allocatedBytes: resource.allocatedBytes ?? 0, ...(resource.allocatedBytes === undefined ? { sizeUnavailable: true as const } : {}),
          eligible: !reason, reason: reason ?? "All recorded consumers are terminal. Exact owned container can be reclaimed; volumes stay preserved.",
          sourceChanges: [], unpublishedCommits: 0, requiresDiscard: false });
      }
      await this.journal.write(state);
      return candidates;
    });
  }

  /** The lifecycle owner calls this only after authoritative completion and quiescence. */
  retire(worker: ForgeWorker): Promise<void> {
    return this.serial(async () => {
      if (worker.status !== "completed") throw new Error("Disposable cleanup requires a quiescent completed worker.");
      const state = await this.read();
      // All earlier attempts belonging to this worker end with its authoritative lifecycle.
      const consumers = state.resources.flatMap(item => item.consumers).filter(item => item.workerId === worker.id);
      for (const consumer of consumers) if (!state.terminalWorkers.some(item => sameConsumer(item, consumer))) state.terminalWorkers.push(consumer);
      await this.journal.write(state);
      const failures: string[] = [];
      for (const resource of state.resources.filter(item => item.state !== "deleted" && item.consumers.some(consumer => consumer.workerId === worker.id))) {
        await this.removeRecorded(resource, state);
        if (resource.state !== "deleted") failures.push(`${resource.name}: ${resource.reason}`);
      }
      if (failures.length) throw new Error(failures.join("; "));
    });
  }

  async consumerIds(resourceId: string): Promise<string[]> {
    const resource = (await this.read()).resources.find(item => item.id === resourceId);
    if (!resource) throw new Error("Unknown disposable resource.");
    return [...new Set(resource.consumers.map(item => item.workerId))];
  }

  remove(resourceId: string): Promise<DisposableResource> {
    return this.serial(async () => {
      const state = await this.read();
      const resource = state.resources.find(item => item.id === resourceId);
      if (!resource) throw new Error("Unknown disposable resource.");
      await this.removeRecorded(resource, state);
      return structuredClone(resource);
    });
  }

  private async removeRecorded(resource: DisposableResource, state: ResourceJournal): Promise<void> {
    if (resource.state === "deleted") return;
    try {
      if (await this.recoverCreation(resource) === "deleted") return;
      const protection = await this.protection(resource, state);
      if (protection) { resource.state = "blocked"; resource.reason = protection; return; }
      let identity = await this.currentIdentity(resource);
      if (!identity) { resource.state = "deleted"; resource.reason = "Recorded container is already absent; cleanup reconciled."; return; }
      resource.allocatedBytes = identity.writableBytes;
      resource.state = "deleting";
      resource.reason = "Deletion intent saved; revalidating identity and consumers.";
      await this.journal.write(state);
      if (identity.running) {
        await this.assertRemovable(resource, state);
        await this.host.stop(identity.id);
      }
      identity = await this.assertRemovable(resource, state);
      if (identity?.running) throw new Error("The owned container became active during cleanup; it was preserved.");
      if (identity) await this.host.remove(identity.id);
      if (await this.currentIdentity(resource)) throw new Error("Docker still reports the recorded container after removal.");
      resource.reclaimedBytes = resource.allocatedBytes ?? 0;
      resource.state = "deleted";
      resource.reason = "Exact owned container removed; writable-layer bytes reclaimed. Shared volumes and images preserved.";
    } catch (error) {
      resource.state = "failed";
      resource.reason = message(error);
    } finally {
      resource.updatedAt = now();
      await this.journal.write(state);
    }
  }

  private async assertRemovable(resource: DisposableResource, state: ResourceJournal): Promise<ContainerIdentity | undefined> {
    const identity = await this.currentIdentity(resource);
    const reason = await this.protection(resource, state);
    if (reason) throw new Error(reason);
    return identity;
  }
  private async protection(resource: DisposableResource, state: ResourceJournal): Promise<string | undefined> {
    if (resource.retentionReason) return `Explicit evidence retention: ${resource.retentionReason}`;
    const workers = await this.workers();
    for (const consumer of resource.consumers) {
      const worker = workers.find(item => item.id === consumer.workerId);
      const terminal = state.terminalWorkers.some(item => sameConsumer(item, consumer));
      const quiescentSourceBlocker = worker?.status === "cleanup_failed" && !worker.tabId && terminal;
      if (worker && (worker.status !== "completed" && !quiescentSourceBlocker || worker.tabId || worker.kind === "issue" && worker.batch?.issues.some(issue => issue.state === "open"))) return `Active or unfinished shared consumer ${consumer.workerId} protects this environment.`;
      if (!terminal) return `Consumer ${consumer.workerId} has no authoritative closure/merge receipt. A finished unmerged review remains protected.`;
    }
    return undefined;
  }
  private async currentIdentity(resource: DisposableResource): Promise<ContainerIdentity | undefined> {
    if (await this.host.engineId() !== resource.engineId) throw new Error("Docker engine identity changed. An explicit ownership review is required.");
    if (!resource.containerId) throw new Error("Container creation identity is unresolved. An explicit ownership review is required.");
    const identity = await this.host.inspect(resource.containerId);
    if (identity) assertIdentity(resource, identity);
    return identity;
  }
  private async recoverCreation(resource: DisposableResource): Promise<DisposableResource["state"]> {
    if (resource.containerId && resource.created) return resource.state;
    if (await this.host.engineId() !== resource.engineId) throw new Error("Docker engine identity changed; creation receipt cannot be reconciled.");
    const ids = resource.containerId ? [resource.containerId] : await this.host.find(resource.id);
    if (!ids.length && !resource.containerId && resource.creationRejected) {
      if (await this.host.engineId() !== resource.engineId) throw new Error("Docker engine identity changed during the absence scan; creation receipt cannot be reconciled.");
      resource.state = "deleted";
      resource.allocatedBytes = resource.reclaimedBytes = 0;
      resource.reason = "Docker rejected creation; the recorded resource is confirmed absent on its original engine.";
      resource.updatedAt = now();
      return resource.state;
    }
    if (ids.length !== 1) throw new Error(`Recorded creation has ${ids.length} matching resources; explicit ownership review is required.`);
    const identity = await this.host.inspect(ids[0]!);
    if (!identity) throw new Error("Recorded creation container is unavailable; explicit ownership review is required.");
    assertIdentity(resource, identity);
    resource.containerId = identity.id;
    resource.created = identity.created;
    resource.allocatedBytes = identity.writableBytes;
    return resource.state;
  }
  private async read(): Promise<ResourceJournal> {
    const value = await this.journal.read<ResourceJournal>();
    if (!value) return { resources: [], terminalWorkers: [] };
    if (!Array.isArray(value.resources) || !Array.isArray(value.terminalWorkers) || !value.terminalWorkers.every(validConsumer) ||
      !value.resources.every(validResource) || new Set(value.resources.map(item => item.id)).size !== value.resources.length)
      throw new Error("Disposable resource ownership journal is invalid. Resources were preserved.");
    return value;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class DockerDisposableContainerHost implements DisposableContainerHost {
  async engineId(): Promise<string> {
    const id = (await docker(["info", "--format", "{{.ID}}"])).trim();
    if (!id || id === "<no value>") throw new Error("Docker engine identity is unavailable.");
    return id;
  }
  async create(input: DisposableContainerInput, labels: Record<string, string>): Promise<string> {
    const args = ["create", "--name", input.name, ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), input.image, ...input.command];
    let id: string;
    try { id = (await docker(args)).trim(); }
    catch (error) {
      const failure = error as { code?: unknown; killed?: boolean; signal?: string; stderr?: string };
      if (!failure.killed && !failure.signal && typeof failure.code === "number" && /^Error response from daemon:/mu.test(failure.stderr ?? ""))
        throw new ContainerCreationRejectedError(message(error), { cause: error });
      throw error;
    }
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Docker returned an invalid container identity.");
    return id;
  }
  async find(id: string): Promise<string[]> {
    return (await docker(["container", "ls", "--all", "--no-trunc", "--quiet", "--filter", `label=${resourceLabel}=${id}`])).trim().split("\n").filter(Boolean);
  }
  async inspect(id: string): Promise<ContainerIdentity | undefined> {
    let output: string;
    try { output = await docker(["container", "inspect", "--size", id]); }
    catch (error) {
      // Only a confirmed missing ID is absence. Daemon/permission/scan failures propagate.
      if (/No such (container|object):/u.test(String((error as { stderr?: string }).stderr))) return undefined;
      throw error;
    }
    const values = JSON.parse(output) as Array<{ Id: string; Created: string; Config: { Labels: Record<string, string> | null }; State: { Running: boolean }; SizeRw: number }>;
    const item = values[0];
    if (values.length !== 1 || !item || !/^[a-f0-9]{64}$/u.test(item.Id) || !Number.isFinite(Date.parse(item.Created)) ||
      typeof item.State?.Running !== "boolean" || !Number.isSafeInteger(item.SizeRw) || item.SizeRw < 0) throw new Error("Docker container identity or writable size is invalid.");
    return { id: item.Id, created: item.Created, labels: item.Config.Labels ?? {}, running: item.State.Running, writableBytes: item.SizeRw };
  }
  async stop(id: string): Promise<void> { await docker(["container", "stop", "--time", "10", id]); }
  async remove(id: string): Promise<void> { await docker(["container", "rm", id]); }
}

export function validateContainerInput(value: unknown): asserts value is DisposableContainerInput {
  const input = value as DisposableContainerInput;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["image", "name", "command", "consumers", "retentionReason"].includes(key)) ||
    typeof input.image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/u.test(input.image) ||
    typeof input.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(input.name) ||
    !Array.isArray(input.command) || input.command.length > 128 || !input.command.every(item => typeof item === "string" && item.length <= 16_384 && !item.includes("\0")) ||
    (input.consumers !== undefined && (!Array.isArray(input.consumers) || input.consumers.length > 50 || !input.consumers.every(validConsumer))) ||
    (input.retentionReason !== undefined && (typeof input.retentionReason !== "string" || !input.retentionReason.trim() || input.retentionReason.length > 2000)))
    throw new Error("A disposable environment requires image, name, command and verified consumers; arbitrary Docker options are not accepted.");
}
function validConsumer(value: unknown): value is Consumer {
  const consumer = value as Consumer;
  return Boolean(consumer && typeof consumer === "object" && [consumer.workerId, consumer.attemptId].every(item => typeof item === "string" && /^[a-f0-9-]{36}$/u.test(item)));
}
function validResource(item: DisposableResource): boolean {
  return Boolean(item && /^[a-f0-9-]{36}$/u.test(item.id) && item.kind === "container" && typeof item.engineId === "string" && item.engineId &&
    (item.containerId === undefined || /^[a-f0-9]{64}$/u.test(item.containerId)) && (item.created === undefined || Number.isFinite(Date.parse(item.created))) &&
    (item.creationRejected === undefined || item.creationRejected === true) &&
    typeof item.name === "string" && validConsumer(item.owner) && Array.isArray(item.consumers) && item.consumers.length > 0 && item.consumers.every(validConsumer) && item.consumers.some(consumer => sameConsumer(consumer, item.owner)) &&
    ["creating", "owned", "deleting", "deleted", "blocked", "failed"].includes(item.state) && typeof item.reason === "string" &&
    Number.isSafeInteger(item.reclaimedBytes) && item.reclaimedBytes >= 0 && (item.allocatedBytes === undefined || Number.isSafeInteger(item.allocatedBytes) && item.allocatedBytes >= 0) &&
    (item.retentionReason === undefined || typeof item.retentionReason === "string" && item.retentionReason.trim()) && Number.isFinite(Date.parse(item.updatedAt)));
}
function labelsFor(resource: DisposableResource): Record<string, string> { return { [resourceLabel]: resource.id, [ownerLabel]: resource.owner.workerId, [attemptLabel]: resource.owner.attemptId }; }
function assertIdentity(resource: DisposableResource, identity: ContainerIdentity): void {
  if ((resource.containerId && identity.id !== resource.containerId) || (resource.created && identity.created !== resource.created) || Object.entries(labelsFor(resource)).some(([key, value]) => identity.labels[key] !== value))
    throw new Error("Disposable container identity or ownership changed. Explicit ownership review required; replacement preserved.");
}
function sameConsumer(left: Consumer, right: Consumer): boolean { return left.workerId === right.workerId && left.attemptId === right.attemptId; }
function now(): string { return new Date().toISOString(); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function docker(args: string[]): Promise<string> { return (await execute("docker", args, { timeout: 60_000, maxBuffer: 2_000_000 })).stdout; }

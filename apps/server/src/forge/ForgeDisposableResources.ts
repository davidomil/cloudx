import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { ForgeWorker, WorkspaceCleanupCandidate, DisposableContainerInput, DisposableResource, ForgeResourceConsumer as Consumer, EvidenceDecision, ForgeEvidenceManifest } from "@cloudx/shared";
import { JsonStateFile } from "../jsonStateFile.js";
import { ForgeContainerEvidence, readContainerEvidenceTar, validEvidencePaths, type EvidenceSink } from "./ForgeContainerEvidence.js";
import { writeEvidenceReceipt } from "./ForgeEvidenceFiles.js";

export type { DisposableContainerInput, DisposableResource, EvidenceDecision } from "@cloudx/shared";

const execute = promisify(execFile);
const resourceLabel = "cloudx.forge.resource";
const ownerLabel = "cloudx.forge.worker";
const attemptLabel = "cloudx.forge.attempt";
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
  readEvidence?(id: string, paths: string[], write: EvidenceSink): Promise<void>;
}
interface ResourceJournal {
  resources: DisposableResource[];
  terminalWorkers: Consumer[];
}

export class ContainerCreationRejectedError extends Error {}
export class ForgeDisposableCleanupError extends Error {
  constructor(reason: string, readonly blockerIdentity: string) { super(reason); }
}

/** Only creation receipts grant authority; names and discovered labels alone never do. */
export class ForgeDisposableResources {
  private readonly journal: JsonStateFile;
  private readonly evidenceArchive: ForgeContainerEvidence;
  private tail = Promise.resolve();
  constructor(dataDir: string, private readonly workers: () => Promise<ForgeWorker[]>, private readonly host: DisposableContainerHost = new DockerDisposableContainerHost()) {
    this.journal = new JsonStateFile(dataDir, "forge-disposable-resources.json", "Forge disposable resources", 0o600);
    this.evidenceArchive = new ForgeContainerEvidence(dataDir);
  }

  create(worker: ForgeWorker, input: DisposableContainerInput): Promise<DisposableResource> {
    return this.serial(async () => {
      validateContainerInput(input);
      if (!worker.attemptId || !["running", "starting"].includes(worker.status)) throw new Error("A current running worker attempt must own resource creation.");
      if (worker.headSha && !validCommit(worker.headSha)) throw new Error("Worker commit provenance must be a full Git object identity.");
      const owner = { workerId: worker.id, attemptId: worker.attemptId };
      const consumers = [owner, ...(input.consumers ?? []).filter(item => !sameConsumer(item, owner))];
      const workers = await this.workers();
      if (consumers.some(consumer => !workers.some(current => current.id === consumer.workerId && current.attemptId === consumer.attemptId && ["running", "starting", "paused", "stopped", "failed", "awaiting_publication", "awaiting_review", "awaiting_merge"].includes(current.status))))
        throw new Error("Every shared consumer must identify a known unfinished worker attempt.");
      const state = await this.read();
      const resource: DisposableResource = {
        id: randomUUID(), kind: "container", engineId: await this.host.engineId(), name: input.name,
        owner, consumers, retentionReason: input.retentionReason,
        ...((input.retentionReason || input.evidencePaths) ? { evidence: { state: "pending" as const, paths: input.evidencePaths ?? [],
          ...(input.commitSha ? { commitSha: input.commitSha, commitSource: "declared" as const } : worker.headSha ? { commitSha: worker.headSha, commitSource: "worker" as const } : {}) } } : {}),
        state: "creating", reason: "Creation intent recorded before Docker creation.", reclaimedBytes: 0, updatedAt: now(),
      };
      state.resources.push(resource);
      await this.write(state);
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
        await this.write(state);
        throw error;
      }
      resource.updatedAt = now();
      await this.write(state);
      return structuredClone(resource);
    });
  }

  async records(): Promise<DisposableResource[]> { return structuredClone((await this.read()).resources); }

  decideEvidence(resourceId: string, decision: EvidenceDecision): Promise<DisposableResource> {
    return this.serial(async () => {
      validateEvidenceDecision(decision);
      const state = await this.read();
      const resource = state.resources.find(item => item.id === resourceId);
      if (!resource) throw new Error("Unknown disposable resource.");
      const blocker = await this.consumerProtection(resource, state);
      if (blocker) throw new Error(blocker);
      if (resource.state === "deleted") throw new Error("The disposable environment has already been removed.");
      if (!resource.retentionReason && !resource.evidence) throw new Error("This disposable environment has no evidence hold to review.");
      if (resource.evidence?.state === "verified") {
        if (decision.action !== "export" || decision.evidencePaths !== undefined || decision.commitSha !== undefined) throw new Error("Verified evidence is immutable; retry export without changing its provenance to complete cleanup.");
        await this.removeRecorded(resource, state);
        if (resource.state === "failed") throw new Error(resource.reason);
        return structuredClone(resource);
      }
      resource.evidence ??= { state: "pending", paths: [] };
      if (decision.action === "discard") resource.evidence.state = "discarded";
      else {
        if (decision.evidencePaths) resource.evidence.paths = decision.evidencePaths;
        if (decision.commitSha) { resource.evidence.commitSha = decision.commitSha; resource.evidence.commitSource = "declared"; }
        if (decision.action === "export" && !validEvidencePaths(resource.evidence.paths)) throw new Error("Select specific absolute evidence paths before releasing this hold.");
        resource.evidence.state = decision.action === "keep" ? "kept" : "pending";
      }
      if (decision.action === "export") await this.recordEvidenceCommit(resource);
      resource.reason = `Evidence decision recorded: ${decision.action}.`;
      resource.updatedAt = now();
      await this.write(state);
      await this.removeRecorded(resource, state);
      if (decision.action === "export" && resource.state === "failed") throw new Error(resource.reason);
      return structuredClone(resource);
    });
  }

  async readEvidence(resourceId: string): Promise<ForgeEvidenceManifest> {
    const resource = (await this.read()).resources.find(item => item.id === resourceId);
    if (!resource) throw new Error("Unknown disposable resource.");
    return structuredClone((await this.evidenceArchive.read(resource)).manifest);
  }

  async evidenceFile(resourceId: string, filePath: string) {
    const resource = (await this.read()).resources.find(item => item.id === resourceId);
    if (!resource) throw new Error("Unknown disposable resource.");
    return this.evidenceArchive.fileStream(resource, filePath);
  }

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
      await this.write(state);
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
      await this.write(state);
      const failures: DisposableResource[] = [];
      for (const resource of state.resources.filter(item => item.state !== "deleted" && item.consumers.some(consumer => consumer.workerId === worker.id))) {
        await this.removeRecorded(resource, state);
        if (resource.state !== "deleted") failures.push(resource);
      }
      if (failures.length) throw new ForgeDisposableCleanupError(failures.map(resource => `${resource.name}: ${resource.reason}`).join("; "),
        this.cleanupBlockerIdentity(failures));
    });
  }

  private cleanupBlockerIdentity(resources: DisposableResource[]): string {
    return JSON.stringify(resources.sort((a, b) => a.id.localeCompare(b.id)).map(resource => ({ id: resource.id, name: resource.name,
      blocker: resource.reason === this.evidenceProtection(resource)
        ? { retentionReason: resource.retentionReason, paths: [...(resource.evidence?.paths ?? [])].sort(), commitSha: resource.evidence?.commitSha }
        : resource.reason })));
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
      const protection = await this.consumerProtection(resource, state);
      if (protection) { resource.state = "blocked"; resource.reason = protection; return; }
      let identity = await this.currentIdentity(resource);
      if (!identity) {
        if (resource.evidence?.state === "exporting") resource.evidence = await this.evidenceArchive.recover(resource) ?? { ...resource.evidence, state: "missing" };
        if (resource.evidence?.state === "verified") await this.evidenceArchive.read(resource);
        else if ((resource.retentionReason || resource.evidence) && resource.evidence?.state !== "discarded") resource.evidence = { ...resource.evidence, paths: resource.evidence?.paths ?? [], state: "missing" };
        if (resource.removalStartedAt) resource.reclaimedBytes = resource.allocatedBytes ?? 0;
        resource.state = "deleted"; resource.allocatedBytes = 0;
        resource.reason = resource.evidence?.state === "missing" ? "Recorded container is already absent; unexported evidence is unavailable. Cleanup reconciled without claiming an export." : "Recorded container is already absent; cleanup reconciled."; return;
      }
      resource.allocatedBytes = identity.writableBytes;
      resource.reason = "Quiescence intent saved; revalidating identity and consumers.";
      await this.write(state);
      if (identity.running) {
        await this.assertQuiescentConsumers(resource, state);
        await this.host.stop(identity.id);
      }
      identity = await this.assertQuiescentConsumers(resource, state);
      if (identity?.running) throw new Error("The owned container became active during cleanup; it was preserved.");
      await this.preserveEvidence(resource, state, Boolean(identity));
      const evidenceProtection = this.evidenceProtection(resource);
      if (evidenceProtection) { resource.state = "blocked"; resource.reason = evidenceProtection; return; }
      resource.state = "deleting";
      resource.removalStartedAt ??= now();
      resource.reason = "Evidence release and deletion intent saved; revalidating identity and consumers.";
      await this.write(state);
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
      await this.write(state);
    }
  }

  private async assertRemovable(resource: DisposableResource, state: ResourceJournal): Promise<ContainerIdentity | undefined> {
    const identity = await this.currentIdentity(resource);
    const reason = await this.protection(resource, state);
    if (reason) throw new Error(reason);
    return identity;
  }
  private async protection(resource: DisposableResource, state: ResourceJournal): Promise<string | undefined> {
    const blocker = await this.consumerProtection(resource, state);
    if (blocker) return blocker;
    if (resource.evidence?.state === "verified") await this.evidenceArchive.read(resource);
    return this.evidenceProtection(resource);
  }
  private evidenceProtection(resource: DisposableResource): string | undefined {
    if (!resource.retentionReason && !resource.evidence) return undefined;
    if (resource.evidence?.state === "verified" || resource.evidence?.state === "discarded" || resource.evidence?.state === "missing") return undefined;
    if (resource.evidence?.state === "kept") return `Evidence hold explicitly kept for review: ${resource.retentionReason ?? resource.evidence.paths.join(", ")}. Idle container is stopped; export or confirm discard to release it.`;
    if (!resource.evidence?.paths.length) return `Explicit evidence retention requires review: ${resource.retentionReason}. Select specific paths to export, keep the hold or confirm discard. Idle container is stopped after all consumers close.`;
    return `Specific evidence export pending: ${resource.evidence.paths.join(", ")}. ${resource.retentionReason ?? ""}`;
  }
  private async assertQuiescentConsumers(resource: DisposableResource, state: ResourceJournal): Promise<ContainerIdentity | undefined> {
    const identity = await this.currentIdentity(resource);
    const blocker = await this.consumerProtection(resource, state);
    if (blocker) throw new Error(blocker);
    return identity;
  }
  private async preserveEvidence(resource: DisposableResource, state: ResourceJournal, present: boolean): Promise<void> {
    if (!resource.evidence || ["kept", "discarded", "missing"].includes(resource.evidence.state)) return;
    if (resource.evidence.state === "verified") { await this.evidenceArchive.read(resource); return; }
    if (!validEvidencePaths(resource.evidence.paths)) return;
    await this.recordEvidenceCommit(resource);
    const recovered = await this.evidenceArchive.recover(resource);
    if (recovered) { resource.evidence = recovered; await this.write(state); return; }
    if (!present) throw new Error("The container disappeared before evidence export; required evidence is unavailable.");
    if (!this.host.readEvidence) throw new Error("The container host does not support evidence export.");
    const identity = await this.assertQuiescentConsumers(resource, state);
    if (!identity || identity.running) throw new Error("Evidence export requires the exact stopped owned container.");
    resource.evidence = await this.evidenceArchive.export(resource, async write => {
      await this.host.readEvidence!(identity.id, resource.evidence!.paths, write);
      const afterExport = await this.assertQuiescentConsumers(resource, state);
      if (afterExport?.running) throw new Error("The container became active during evidence export; it was preserved.");
    }, async receipt => { resource.evidence = receipt; await this.write(state); });
    await this.write(state);
  }
  private async recordEvidenceCommit(resource: DisposableResource): Promise<void> {
    if (!resource.evidence || resource.evidence.commitSha || resource.evidence.manifestSha256) return;
    const owner = (await this.workers()).find(worker => worker.id === resource.owner.workerId);
    if (validCommit(owner?.headSha)) { resource.evidence.commitSha = owner.headSha; resource.evidence.commitSource = "worker"; }
  }
  private async consumerProtection(resource: DisposableResource, state: ResourceJournal): Promise<string | undefined> {
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
    if (await this.host.engineId() !== resource.engineId) throw new Error("Docker engine identity changed during inspection. The resource was preserved.");
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
  private async write(state: ResourceJournal): Promise<void> {
    if (state.resources.some(resource => resource.evidence?.manifestSha256)) await writeEvidenceReceipt(this.journal, state);
    else await this.journal.write(state);
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
      const stderr = (failure.stderr ?? "").trim();
      const localReferenceRejection = ["invalid reference format", "repository name must not be more than 255 characters", "invalid checksum digest format", "invalid checksum digest length", "unsupported digest algorithm"].includes(stderr) ||
        /^invalid reference format: repository name \([^()\r\n]+\) must be lowercase$/u.test(stderr);
      if (!failure.killed && !failure.signal && typeof failure.code === "number" && (localReferenceRejection || /^Error response from daemon:/mu.test(stderr)))
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
  async readEvidence(id: string, paths: string[], write: EvidenceSink): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(id) || !validEvidencePaths(paths)) throw new Error("Evidence export requires an exact container identity and specific absolute paths.");
    for (const source of paths) await streamDockerEvidence(id, source, write);
  }

}

export function validateContainerInput(value: unknown): asserts value is DisposableContainerInput {
  const input = value as DisposableContainerInput;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["image", "name", "command", "consumers", "retentionReason", "evidencePaths", "commitSha"].includes(key)) ||
    typeof input.image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/u.test(input.image) ||
    typeof input.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(input.name) ||
    !Array.isArray(input.command) || input.command.length > 128 || !input.command.every(item => typeof item === "string" && item.length <= 16_384 && !item.includes("\0")) ||
    (input.consumers !== undefined && (!Array.isArray(input.consumers) || input.consumers.length > 50 || !input.consumers.every(validConsumer))) ||
    (input.retentionReason !== undefined && (typeof input.retentionReason !== "string" || !input.retentionReason.trim() || input.retentionReason.length > 2000)) ||
    (input.retentionReason !== undefined && input.evidencePaths === undefined) ||
    (input.evidencePaths !== undefined && !validEvidencePaths(input.evidencePaths)) ||
    (input.commitSha !== undefined && !validCommit(input.commitSha)))
    throw new Error("A disposable environment requires image, name, command and verified consumers; arbitrary Docker options are not accepted. Evidence retention requires specific evidencePaths.");
}
export function validateEvidenceDecision(value: unknown): asserts value is EvidenceDecision {
  const decision = value as EvidenceDecision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision) || Object.keys(decision).some(key => !["action", "evidencePaths", "commitSha", "confirmation"].includes(key)) ||
    !["keep", "export", "discard"].includes(decision.action) ||
    (decision.evidencePaths !== undefined && !validEvidencePaths(decision.evidencePaths)) ||
    (decision.commitSha !== undefined && !validCommit(decision.commitSha)) ||
    (decision.action === "discard" ? decision.confirmation !== "Discard evidence" || decision.evidencePaths !== undefined || decision.commitSha !== undefined : decision.confirmation !== undefined))
    throw new Error("Evidence requires an explicit keep/export decision or confirmed discard; use specific absolute paths and a full commit SHA.");
}
function validCommit(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value); }
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
    (item.retentionReason === undefined || typeof item.retentionReason === "string" && item.retentionReason.trim()) &&
    (item.evidence === undefined || validEvidence(item.evidence)) &&
    (item.removalStartedAt === undefined || Number.isFinite(Date.parse(item.removalStartedAt))) && Number.isFinite(Date.parse(item.updatedAt)));
}
function validEvidence(value: DisposableResource["evidence"]): boolean {
  return Boolean(value && ["pending", "exporting", "verified", "kept", "discarded", "missing"].includes(value.state) && validEvidencePaths(value.paths, true) &&
    (value.commitSha === undefined || validCommit(value.commitSha)) &&
    (value.commitSource === undefined || ["worker", "declared"].includes(value.commitSource)) &&
    (value.archivePath === undefined || typeof value.archivePath === "string" && /^forge-evidence\/[a-f0-9-]{36}(?:\.json|\/manifest\.json)$/u.test(value.archivePath)) &&
    (value.manifestSha256 === undefined || typeof value.manifestSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.manifestSha256)) &&
    (value.bytes === undefined || Number.isSafeInteger(value.bytes) && value.bytes >= 0) &&
    (value.exportedAt === undefined || Number.isFinite(Date.parse(value.exportedAt))) &&
    (value.files === undefined || Array.isArray(value.files) && value.files.every(file => typeof file.path === "string" && validEvidencePaths([`/${file.path}`]) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/u.test(file.sha256))) &&
    (value.state !== "verified" || value.archivePath && value.manifestSha256 && value.files?.length && value.bytes !== undefined && value.exportedAt));
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

async function streamDockerEvidence(id: string, source: string, write: EvidenceSink): Promise<void> {
  const child = spawn("docker", ["container", "cp", `${id}:${source}`, "-"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let failure: Error | undefined;
  const fail = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr) + chunk.length > 64 * 1024) fail(new Error("Docker evidence export exceeded the diagnostic output limit."));
    else stderr += chunk.toString();
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.on("error", error => { failure ??= error; });
    child.on("close", (code, signal) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Docker evidence export failed (${signal ?? code}): ${stderr.trim()}`));
      else resolve();
    });
  });
  completion.catch(() => undefined);
  const timeout = setTimeout(() => fail(new Error("Docker evidence export timed out after 60 seconds.")), 60_000);
  try { await readContainerEvidenceTar(source, child.stdout, write); await completion; }
  catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    await completion.catch(() => undefined);
    if (stderr.trim()) throw new Error(`${message(error)} Docker evidence export: ${stderr.trim()}`, { cause: error });
    throw error;
  }
  finally { clearTimeout(timeout); }
}

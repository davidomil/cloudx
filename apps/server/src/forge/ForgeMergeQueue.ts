import type { ForgeChangeRequest, ForgeWorker } from "@cloudx/shared";

/** Queue state lives in the workflow snapshot, so admission and worker transitions commit together. */
export class ForgeMergeQueue {
  constructor(private readonly workers: () => ForgeWorker[]) {}

  reserve(worker: ForgeWorker, change: ForgeChangeRequest): boolean {
    if (worker.mergeQueue?.outcome === "merged") throw new Error("This merge was already confirmed and cannot re-enter the queue.");
    const unresolved = this.workers().find(other => other.id !== worker.id && other.mergeAttempted &&
      queueKey(other) === queueKey(worker) && !other.mergeQueue?.active);
    if (unresolved) throw new Error(`Reconcile worker ${unresolved.id}'s previous merge before advancing this queue.`);
    const members = this.members(worker);
    const duplicate = members.find(other => other.id !== worker.id && other.changeNumber === worker.changeNumber);
    if (duplicate) throw new Error(`This request already belongs to merge queue worker ${duplicate.id}.`);
    if (!worker.mergeQueue || worker.mergeQueue.phase === "blocked") {
      worker.mergeQueue = {
        sequence: Math.max(0, ...members.map(member => member.mergeQueue!.sequence)) + 1,
        enteredAt: new Date().toISOString(), phase: "queued", active: false, position: 0,
      };
    }
    this.refresh();
    const owner = this.members(worker).find(member => member.mergeQueue!.active);
    if (owner && owner !== worker) return false;
    const first = this.members(worker).find(member => member.mergeQueue!.phase !== "blocked");
    if (!owner && first !== worker) return false;
    const entry = worker.mergeQueue;
    entry.active = true;
    if (entry.candidate?.headSha !== change.headSha || entry.candidate.targetHeadSha !== change.targetHeadSha) {
      entry.candidate = { headSha: change.headSha, targetHeadSha: change.targetHeadSha };
      entry.phase = "updating";
    }
    entry.reason = undefined;
    this.refresh();
    return true;
  }

  phase(worker: ForgeWorker, phase: NonNullable<ForgeWorker["mergeQueue"]>["phase"], reason?: string): void {
    if (!worker.mergeQueue) return;
    worker.mergeQueue.phase = phase;
    worker.mergeQueue.reason = reason;
  }

  block(worker: ForgeWorker, reason: string): void {
    if (!worker.mergeQueue) return;
    // A lost response reserves the turn until the original request is reconciled.
    if (worker.mergeAttempted) {
      worker.mergeQueue.active = true;
      this.phase(worker, "merging", reason);
      worker.mergeQueue.outcome = "uncertain";
      return;
    }
    worker.mergeQueue.active = false;
    worker.mergeQueue.outcome = undefined;
    this.phase(worker, "blocked", reason);
    this.refresh();
  }

  complete(worker: ForgeWorker): void {
    if (!worker.mergeQueue) return;
    worker.mergeQueue.outcome = "merged";
    worker.mergeQueue.active = false;
    worker.mergeQueue.phase = "blocked";
    worker.mergeQueue.reason = "Merge confirmed; waiting for issue closure and cleanup.";
    this.refresh();
  }

  refresh(): void {
    const requests = new Set<string>();
    for (const worker of this.workers()) {
      if (!worker.mergeQueue) continue;
      const request = JSON.stringify([queueKey(worker), worker.changeNumber]);
      if (requests.has(request)) throw new Error("A saved request has duplicate merge queue owners.");
      requests.add(request);
    }
    for (const worker of this.workers()) {
      if (!worker.mergeQueue) continue;
      const members = this.members(worker);
      const owners = members.filter(member => member.mergeQueue!.active);
      if (owners.length > 1) throw new Error("Conflicting saved merge queue owners. No queue item may advance.");
      worker.mergeQueue.activeWorkerId = owners[0]?.id;
      worker.mergeQueue.position = worker.mergeQueue.phase === "blocked" ? 0 :
        members.filter(member => member.mergeQueue!.phase !== "blocked").findIndex(member => member.id === worker.id) + 1;
    }
  }

  private members(worker: ForgeWorker): ForgeWorker[] {
    return this.workers().filter(other => other.mergeQueue && queueKey(other) === queueKey(worker))
      .sort((a, b) => a.mergeQueue!.sequence - b.mergeQueue!.sequence || a.id.localeCompare(b.id));
  }
}

export function queueKey(worker: ForgeWorker): string {
  return JSON.stringify([worker.repository.provider, worker.repository.apiUrl, worker.repository.projectPath, worker.baseBranch]);
}

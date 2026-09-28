import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ForgeChangeRequest, ForgeWorker } from "@cloudx/shared";
import { ForgeMergeQueue } from "./ForgeMergeQueue.js";
import { ForgeWorkflowStore } from "./ForgeWorkflowStore.js";
import { PluginDataStore } from "../plugins/PluginDataStore.js";
import { parseWorkers } from "./ForgeWorkflowValidation.js";

function worker(number: number, overrides: Partial<ForgeWorker> = {}): ForgeWorker {
  return { id: randomUUID(), kind: "issue", number, title: `Issue ${number}`,
    repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "a/b" },
    baseBranch: "main", templateId: "worker", status: "paused", autoPost: false,
    changeNumber: number, headSha: "a".repeat(40), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}
const change = { headSha: "a".repeat(40), targetHeadSha: "b".repeat(40) } as ForgeChangeRequest;

describe("Forge final merge turns", () => {
  it("admits once in FIFO order and preserves the active CI reservation across snapshots", () => {
    let workers = [worker(1), worker(2), worker(3)];
    let queue = new ForgeMergeQueue(() => workers);
    expect(queue.reserve(workers[0], change)).toBe(true);
    queue.phase(workers[0], "waiting_ci");
    expect(queue.reserve(workers[1], change)).toBe(false);
    expect(queue.reserve(workers[2], change)).toBe(false);
    for (let poll = 0; poll < 3; poll++) expect(queue.reserve(workers[1], change)).toBe(false);
    expect(workers.map(worker => worker.mergeQueue!.position)).toEqual([1, 2, 3]);
    workers = parseWorkers(structuredClone(workers));
    queue = new ForgeMergeQueue(() => workers);
    expect(queue.reserve(workers[2], change)).toBe(false);
    queue.complete(workers[0]);
    expect(queue.reserve(workers[1], { ...change, targetHeadSha: "c".repeat(40) })).toBe(true);
    expect(workers[1].mergeQueue?.candidate?.targetHeadSha).toBe("c".repeat(40));
    expect(workers[2].mergeQueue?.position).toBe(2);
  });

  it.each(["provider", "instance", "repository", "target"])("keeps %s queues independent", boundary => {
    const first = worker(1);
    const second = worker(2);
    if (boundary === "provider") second.repository.provider = "gitlab";
    if (boundary === "instance") second.repository.apiUrl = "https://enterprise.test/api";
    if (boundary === "repository") second.repository.projectPath = "c/d";
    if (boundary === "target") second.baseBranch = "release";
    const queue = new ForgeMergeQueue(() => [first, second]);
    expect(queue.reserve(first, change)).toBe(true);
    expect(queue.reserve(second, change)).toBe(true);
  });

  it("releases blocked work and re-enters behind waiting work, while uncertain merges retain ownership", () => {
    const workers = [worker(1), worker(2)];
    const queue = new ForgeMergeQueue(() => workers);
    queue.reserve(workers[0], change);
    queue.reserve(workers[1], change);
    workers[0].mergeAttempted = true;
    queue.block(workers[0], "Response lost");
    expect(queue.reserve(workers[1], change)).toBe(false);
    expect(workers[0].mergeQueue).toMatchObject({ active: true, outcome: "uncertain" });
    workers[0].mergeAttempted = undefined;
    queue.block(workers[0], "Required CI failed");
    expect(queue.reserve(workers[1], change)).toBe(true);
    expect(queue.reserve(workers[0], change)).toBe(false);
    expect(workers[0].mergeQueue!.sequence).toBeGreaterThan(workers[1].mergeQueue!.sequence);
  });

  it.each([false, true])("blocks admission behind an unresolved merge without active ownership (saved queue: %s)", savedQueue => {
    const first = worker(1, { mergeAttempted: true });
    const second = worker(2);
    if (savedQueue) first.mergeQueue = { sequence: 1, enteredAt: new Date().toISOString(), active: false,
      phase: "merging", position: 1, outcome: "uncertain" };
    const queue = new ForgeMergeQueue(() => [first, second]);
    expect(() => queue.reserve(second, change)).toThrow("previous merge");
    expect(parseWorkers([first])[0].mergeAttempted).toBe(true);
    expect(second.mergeQueue).toBeUndefined();
  });

  it("invalidates prepared candidate, review and check identities when either head changes", () => {
    const current = worker(1);
    const queue = new ForgeMergeQueue(() => [current]);
    queue.reserve(current, change);
    current.mergeQueue!.candidate = { ...change, prepared: true, reviewId: randomUUID(), checksUrl: "https://ci.test/1" };
    queue.reserve(current, { ...change, targetHeadSha: "c".repeat(40) });
    expect(current.mergeQueue!.candidate).toEqual({ headSha: change.headSha, targetHeadSha: "c".repeat(40) });
    queue.reserve(current, { ...change, headSha: "d".repeat(40) });
    expect(current.mergeQueue!.candidate).toEqual({ headSha: "d".repeat(40), targetHeadSha: change.targetHeadSha });
  });

  it("rejects duplicate request ownership and invalid saved candidates", () => {
    const workers = [worker(1), worker(1)];
    const queue = new ForgeMergeQueue(() => workers);
    queue.reserve(workers[0], change);
    expect(() => queue.reserve(workers[1], change)).toThrow("already belongs");
    expect(() => parseWorkers([{ ...workers[0], mergeQueue: { ...workers[0].mergeQueue, candidate: { headSha: "not-sha" } } }])).toThrow();
    expect(() => parseWorkers([{ ...workers[0], mergeQueue: { ...workers[0].mergeQueue, active: true, phase: "blocked" } }])).toThrow();
  });

  it("rejects competing persisted writers, then transfers ownership without deleting a lock file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-queue-writer-"));
    const first = new ForgeWorkflowStore(new PluginDataStore(root));
    const second = new ForgeWorkflowStore(new PluginDataStore(root));
    try {
      await first.claimWriter();
      await expect(second.claimWriter()).rejects.toThrow("Another CloudX service");
      await expect(second.write([])).rejects.toThrow("Another CloudX service");
      await first.write([worker(1)]);
      await first.releaseWriter();
      await second.claimWriter();
      expect(await second.read()).toHaveLength(1);
      await second.write([]);
      expect(await first.read()).toEqual([]);
    } finally {
      await first.releaseWriter(); await second.releaseWriter();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

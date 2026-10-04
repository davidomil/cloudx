import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import type { ForgeWorker } from "@cloudx/shared";
import { DockerDisposableContainerHost, ForgeDisposableResources } from "./ForgeDisposableResources.js";
import { ForgeWorkflowService, type ForgeWorkflowDependencies } from "./ForgeWorkflowService.js";

const execute = promisify(execFile);
it.skipIf(process.env.CLOUDX_RESOURCE_DOCKER_TEST !== "1")("reclaims the two owned feedback fixtures with measured Docker writable-layer reduction", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-resources-docker-"));
  const worker: ForgeWorker = { id: randomUUID(), attemptId: randomUUID(), kind: "issue", number: 128, title: "feedback fixture", repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "fixture/project" }, baseBranch: "main", templateId: "fixture", status: "running", autoPost: false, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const host = new DockerDisposableContainerHost();
  let workflow: ForgeWorkflowService | undefined;
  const service = new ForgeDisposableResources(directory, async () => workflow ? (await workflow.dashboard()).workers : [worker], host);
  const created: string[] = [];
  try {
    for (const [index, name] of ["cloudx-128-feedback", "cloudx-128-feedback-upgrade"].entries()) {
      const resource = await service.create(worker, { image: "ubuntu:24.04", name: `${name}-fixture-${worker.id}`, command: ["dd", "if=/dev/zero", "of=/disposable-fixture.bin", "bs=1M", `count=${index ? 8 : 16}`] });
      created.push(resource.containerId!);
      await execute("docker", ["start", "--attach", resource.containerId!], { timeout: 30_000 });
    }
    const before = (await service.preview()).reduce((sum, item) => sum + item.allocatedBytes, 0);
    expect(before).toBeGreaterThanOrEqual(24 * 1024 * 1024);
    const storage = (await execute("docker", ["info", "--format", "{{.DockerRootDir}}"])).stdout.trim();
    const capacityBefore = await fs.statfs(storage);
    let stored = [structuredClone(worker)];
    const close = vi.fn(async () => {});
    const getIssue = vi.fn(async () => ({ number: worker.number, state: "closed" }));
    workflow = new ForgeWorkflowService({
      settings: () => ({ repository: worker.repository, baseBranch: "main" }),
      provider: () => ({ getIssue }),
      runtime: { recover: async () => ({ tabIds: [] }), isActive: () => false, close },
      store: { read: async () => structuredClone(stored), write: async (workers: ForgeWorker[]) => { stored = structuredClone(workers); } },
      reports: { remove: async () => {} },
      notify: () => {},
      cleanupDisposableResources: (completed: ForgeWorker) => service.retire(completed),
    } as unknown as ForgeWorkflowDependencies);
    await workflow.poll();
    expect(getIssue).toHaveBeenCalledWith(128);
    expect((await workflow.dashboard()).workers).toEqual([]);
    const after = (await service.preview()).reduce((sum, item) => sum + item.allocatedBytes, 0);
    expect(after).toBe(0);
    expect((await service.records()).reduce((sum, item) => sum + item.reclaimedBytes, 0)).toBe(before);
    for (const id of created) expect(await host.inspect(id)).toBeUndefined();
    const capacityAfter = await fs.statfs(storage);
    console.info(`Owned feedback fixtures: Docker writable bytes before=${before}, after=${after}, removed=${before - after}; filesystem available before=${capacityBefore.bavail * capacityBefore.bsize}, after=${capacityAfter.bavail * capacityAfter.bsize}.`);
  } finally {
    await workflow?.dispose();
    for (const resource of await service.records()) if (resource.containerId && await host.inspect(resource.containerId)) {
      const identity = await host.inspect(resource.containerId);
      if (identity?.labels["cloudx.forge.resource"] === resource.id) { if (identity.running) await host.stop(resource.containerId); await host.remove(resource.containerId); }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);

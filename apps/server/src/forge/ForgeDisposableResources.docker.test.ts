import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import type { ForgeWorker } from "@cloudx/shared";
import { ContainerCreationRejectedError, DockerDisposableContainerHost, ForgeDisposableResources } from "./ForgeDisposableResources.js";
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

it.skipIf(process.env.CLOUDX_RESOURCE_DOCKER_TEST !== "1")("reconciles a real Docker name conflict as absent after restart while preserving the conflicting container", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-resources-rejected-"));
  const worker: ForgeWorker = { id: randomUUID(), attemptId: randomUUID(), kind: "issue", number: 173, title: "rejected creation fixture", repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "fixture/project" }, baseBranch: "main", templateId: "fixture", status: "running", autoPost: false, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const host = new DockerDisposableContainerHost();
  const input = { image: "ubuntu:24.04", name: `cloudx-rejected-fixture-${worker.id}`, command: ["true"] };
  const fixtureLabels = { "cloudx.test.fixture": worker.id };
  let conflicting: string | undefined;
  try {
    conflicting = await host.create(input, fixtureLabels);
    const identity = await host.inspect(conflicting);
    const service = new ForgeDisposableResources(directory, async () => [worker], host);
    await expect(service.create(worker, input)).rejects.toBeInstanceOf(ContainerCreationRejectedError);
    expect((await service.records())[0]).toMatchObject({ state: "creating", creationRejected: true });
    const reopened = new ForgeDisposableResources(directory, async () => [worker], host);
    expect(await reopened.preview()).toEqual([]);
    expect((await reopened.records())[0]).toMatchObject({ state: "deleted", allocatedBytes: 0, reclaimedBytes: 0, reason: expect.stringContaining("confirmed absent") });
    worker.status = "completed";
    await reopened.retire(worker);
    await new ForgeDisposableResources(directory, async () => [worker], host).retire(worker);
    expect(await host.inspect(conflicting)).toEqual(identity);
    console.info("Rejected name-conflict intent reconciled as absent after restart; exact conflicting fixture identity remained unchanged through repeated retirement.");
  } finally {
    if (conflicting) {
      const identity = await host.inspect(conflicting);
      if (identity?.labels["cloudx.test.fixture"] === worker.id) await host.remove(conflicting);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.env.CLOUDX_RESOURCE_DOCKER_TEST !== "1").each([
  ["uppercase repository", "UPPERCASE:latest", "invalid reference format: repository name (library/UPPERCASE) must be lowercase"],
  ["invalid tag syntax", "ubuntu:.", "invalid reference format"],
  ["repository name length", "a".repeat(256), "repository name must not be more than 255 characters"],
  ["invalid digest format", `ubuntu@sha256:${"A".repeat(64)}`, "invalid checksum digest format"],
  ["invalid digest length", `ubuntu@sha256:${"a".repeat(32)}`, "invalid checksum digest length"],
  ["unsupported digest algorithm", `ubuntu@unknown:${"a".repeat(64)}`, "unsupported digest algorithm"],
])("reconciles actual Docker local reference rejection (%s) across restart without sending a container-create request", async (scenario, image, rejection) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-resources-local-rejected-"));
  const worker: ForgeWorker = { id: randomUUID(), attemptId: randomUUID(), kind: "issue", number: 173, title: "local rejected creation fixture", repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "fixture/project" }, baseBranch: "main", templateId: "fixture", status: "running", autoPost: false, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/_ping") {
      response.setHeader("API-Version", "1.54"); response.setHeader("OSType", "linux");
      response.end("OK");
    } else if (/^\/v[\d.]+\/info$/u.test(request.url ?? "")) response.end(JSON.stringify({ ID: "controlled-local-rejection-engine" }));
    else if (/^\/v[\d.]+\/containers\/json\?/u.test(request.url ?? "")) response.end("[]");
    else { response.statusCode = 500; response.end(JSON.stringify({ message: "Unexpected Docker operation" })); }
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Controlled Docker endpoint is unavailable.");
    vi.stubEnv("DOCKER_HOST", `tcp://127.0.0.1:${address.port}`);
    vi.stubEnv("DOCKER_CONTEXT", ""); vi.stubEnv("DOCKER_TLS_VERIFY", ""); vi.stubEnv("DOCKER_CERT_PATH", ""); vi.stubEnv("DOCKER_API_VERSION", ""); vi.stubEnv("DOCKER_CONFIG", directory);
    const version = (await execute("docker", ["--version"])).stdout.trim();
    const host = new DockerDisposableContainerHost();
    const input = { image, name: `local-rejected-${worker.id}`, command: ["true"] };
    await expect(host.create(input, {})).rejects.toThrow(rejection);
    expect(requests.length).toBeGreaterThan(0);
    expect([...new Set(requests)]).toEqual(["HEAD /_ping"]);
    const reopen = () => new ForgeDisposableResources(directory, async () => [worker], host);
    await expect(reopen().create(worker, input)).rejects.toThrow(rejection);
    const initial = (await reopen().records())[0];
    worker.status = "completed";
    const failures: string[] = [];
    const previews = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await reopen().retire(worker); } catch (error) { failures.push(String(error)); }
      previews.push(await reopen().preview());
    }
    expect(requests.some(request => request.startsWith("POST "))).toBe(false);
    expect(failures).toEqual([]);
    expect(previews).toEqual([[], []]);
    expect(initial).toMatchObject({ creationRejected: true, state: "creating" });
    expect((await reopen().records())[0]).toMatchObject({ state: "deleted", allocatedBytes: 0, reclaimedBytes: 0, reason: expect.stringContaining("confirmed absent") });
    console.info(`${version}: ${scenario} sent only HEAD /_ping before local rejection; recorded same-engine empty scan and two restart/retire cycles persisted zero owned/reclaimed bytes. No container-create or mutation request was sent.`);
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);

import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisposableResource, ForgeWorker } from "@cloudx/shared";
import { ContainerCreationRejectedError, DockerDisposableContainerHost, ForgeDisposableCleanupError, ForgeDisposableResources } from "./ForgeDisposableResources.js";
import { Header } from "tar";

const execute = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());
function evidenceTar(entries: { path: string; data: string }[]): Buffer {
  return Buffer.concat([...entries.flatMap(entry => {
    const data = Buffer.from(entry.data);
    const header = new Header({ path: entry.path, type: "File", size: data.length, mode: 0o600 });
    header.encode();
    return [header.block!, data, Buffer.alloc((512 - data.length % 512) % 512)];
  }), Buffer.alloc(1024)]);
}
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: execute });
  return { ...original, execFile, spawn };
});

describe("Docker creation rejection receipts", () => {
  let directory: string;
  let worker: ForgeWorker;
  const host = new DockerDisposableContainerHost();
  const reopen = () => new ForgeDisposableResources(directory, async () => [worker], host);
  const input = { image: "UPPERCASE:latest", name: "rejected-fixture", command: ["true"] };
  const localRejection = "invalid reference format: repository name (library/UPPERCASE) must be lowercase\n";

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-docker-rejection-"));
    worker = { id: randomUUID(), attemptId: randomUUID(), kind: "issue", number: 173, title: "local rejection", repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "fixture/project" }, baseBranch: "main", templateId: "fixture", status: "running", autoPost: false, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    execute.mockReset(); spawn.mockReset();
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  function rejectCreate(failure: Error): void {
    execute.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "info") return { stdout: "same-engine\n" };
      if (args[0] === "create") throw failure;
      if (args[0] === "container" && args[1] === "ls") return { stdout: "" };
      throw new Error(`Unexpected Docker mutation: ${args.join(" ")}`);
    });
  }

  function ownedDockerContainer(): void {
    const id = "a".repeat(64);
    const created = new Date().toISOString();
    let labels: Record<string, string> = {};
    let running = true;
    execute.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "info") return { stdout: "same-engine\n" };
      if (args[0] === "create") {
        labels = Object.fromEntries(args.flatMap((arg, index) => arg === "--label" ? [args[index + 1]!.split("=")] : []));
        return { stdout: `${id}\n` };
      }
      if (args[1] === "inspect") return { stdout: JSON.stringify([{ Id: id, Created: created, Config: { Labels: labels }, State: { Running: running }, SizeRw: 2048 }]) };
      if (args[1] === "stop") { running = false; return { stdout: id }; }
      throw new Error(`Unexpected Docker operation: ${args.join(" ")}`);
    });
  }

  async function cleanupBlocker(resources: ForgeDisposableResources, completed = worker): Promise<string> {
    const failure = await resources.retire(completed).catch(error => error);
    expect(failure).toBeInstanceOf(ForgeDisposableCleanupError);
    return (failure as ForgeDisposableCleanupError).blockerIdentity;
  }

  it.each([
    ["local lowercase validation", localRejection],
    ["local reference syntax validation", "invalid reference format\n"],
    ["local repository length validation", "repository name must not be more than 255 characters\n"],
    ["local digest syntax validation", "invalid checksum digest format\n"],
    ["local digest length validation", "invalid checksum digest length\n"],
    ["local digest algorithm validation", "unsupported digest algorithm\n"],
    ["daemon rejection", "Error response from daemon: Conflict. The container name is already in use.\n"],
  ])("reconciles %s only after same-engine absence and persists it across retirement restarts", async (_scenario, stderr) => {
    rejectCreate(Object.assign(new Error(stderr), { code: 1, killed: false, signal: null, stderr }));
    await expect(reopen().create(worker, input)).rejects.toBeInstanceOf(ContainerCreationRejectedError);
    expect((await reopen().records())[0]).toMatchObject({ creationRejected: true, state: "creating" });
    worker.status = "completed";
    for (let attempt = 0; attempt < 2; attempt++) {
      await reopen().retire(worker);
      expect(await reopen().preview()).toEqual([]);
      expect((await reopen().records())[0]).toMatchObject({ state: "deleted", allocatedBytes: 0, reclaimedBytes: 0, reason: expect.stringContaining("confirmed absent") });
    }
    expect(execute.mock.calls.filter(([, args]) => args[0] === "container").map(([, args]) => args[1])).toEqual(["ls"]);
  });

  it.each([
    ["connection failure", { code: 1, stderr: "error during connect: connection refused\n" }],
    ["generic nonzero exit", { code: 1, stderr: "Docker command failed\n" }],
    ["transport error containing parser text", { code: 1, stderr: `error during connect: ${localRejection}` }],
    ["timeout with parser text", { code: 1, killed: true, stderr: localRejection }],
    ["signal with parser text", { code: 1, signal: "SIGINT", stderr: localRejection }],
    ["executable failure with parser text", { code: "ENOENT", stderr: localRejection }],
  ])("keeps %s uncertain and blocked after successful empty scans and restarts", async (_scenario, details) => {
    const failure = Object.assign(new Error("Creation response uncertain"), details);
    rejectCreate(failure);
    await expect(reopen().create(worker, input)).rejects.toBe(failure);
    expect((await reopen().records())[0]).not.toHaveProperty("creationRejected");
    worker.status = "completed";
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(reopen().retire(worker)).rejects.toThrow("0 matching resources");
      expect((await reopen().preview())[0]).toMatchObject({ eligible: false, sizeUnavailable: true });
    }
    expect(execute.mock.calls.filter(([, args]) => args[0] === "container").every(([, args]) => args[1] === "ls")).toBe(true);
  });

  it("uses the production Docker adapter to stop, safely export, verify and remove an exact completed environment", async () => {
    const id = "a".repeat(64);
    let labels: Record<string, string> = {};
    let running = true;
    let removed = false;
    const created = new Date().toISOString();
    execute.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "info") return { stdout: "same-engine\n" };
      if (args[0] === "create") {
        labels = Object.fromEntries(args.flatMap((arg, index) => arg === "--label" ? [args[index + 1]!.split("=")] : []));
        return { stdout: `${id}\n` };
      }
      if (args[1] === "inspect") {
        if (removed) throw Object.assign(new Error("absent"), { stderr: `Error: No such container: ${id}` });
        return { stdout: JSON.stringify([{ Id: id, Created: created, Config: { Labels: labels }, State: { Running: running }, SizeRw: 2_048 }]) };
      }
      if (args[1] === "stop") { running = false; return { stdout: id }; }
      if (args[1] === "rm") { expect(running).toBe(false); expect(args).toEqual(["container", "rm", id]); removed = true; return { stdout: id }; }
      throw new Error(`Unexpected Docker operation: ${args.join(" ")}`);
    });
    spawn.mockImplementation((_command: string, args: string[], options: unknown) => {
      expect(args).toEqual(["container", "cp", `${id}:/work/evidence`, "-"]);
      expect(options).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
      return dockerChild(Readable.from([evidenceTar([{ path: "evidence/result.log", data: "test passed" }, { path: "evidence/node_modules/disposable", data: "dependency" }])]));
    });
    worker.headSha = "b".repeat(40);
    const resource = await reopen().create(worker, { ...input, image: "node:22", retentionReason: "Specific test log", evidencePaths: ["/work/evidence"] });
    worker.status = "completed";
    await reopen().retire(worker);
    expect((await reopen().records())[0]).toMatchObject({ state: "deleted", reclaimedBytes: 2048, evidence: { state: "verified", bytes: 11 } });
    const manifest = await reopen().readEvidence(resource.id);
    expect(manifest).toMatchObject({ owner: resource.owner, commitSha: worker.headSha, commitSource: "worker", files: [{ path: "work/evidence/result.log", bytes: 11 }] });
    expect(await text(await reopen().evidenceFile(resource.id, "work/evidence/result.log"))).toBe("test passed");
    expect(execute.mock.calls.some(([, args]) => args.includes("prune") || args.includes("--volumes") || args.includes("-v"))).toBe(false);
  });
  it("rejects nonzero Docker export after streaming its stdout without accepting a durable archive", async () => {
    const child = dockerChild(Readable.from([evidenceTar([{ path: "evidence/report.log", data: "partial result" }])]), 1);
    spawn.mockReturnValue(child);
    queueMicrotask(() => child.stderr.end("Error response from daemon: evidence copy denied"));
    const files: string[] = [];
    await expect(host.readEvidence("a".repeat(64), ["/work/evidence"], async (filePath, stream) => {
      await text(Readable.from(stream)); files.push(filePath);
    })).rejects.toThrow("evidence copy denied");
    expect(files).toEqual(["work/evidence/report.log"]);
  });

  it("preserves Docker's missing-source diagnostic when its tar output is empty", async () => {
    const child = dockerChild(Readable.from([]), 1);
    spawn.mockReturnValue(child);
    queueMicrotask(() => child.stderr.end("Could not find the file /work/evidence in container"));
    await expect(host.readEvidence("a".repeat(64), ["/work/evidence"], async () => {})).rejects.toThrow("Could not find the file");
  });

  it("persists one primary blocker across Docker cancellation diagnostics and restart, then distinguishes a changed rejection", async () => {
    ownedDockerContainer();
    const resource = await reopen().create(worker, { ...input, image: "node:22", retentionReason: "Keep reproduction evidence", evidencePaths: ["/work/evidence"] });
    worker.status = "completed";
    let previous: string | undefined;
    for (const [diagnostic, delayed] of [["", false], ["write /dev/stdout: connection reset by peer", false], ["copy stream closed at a different time", true]] as const) {
      spawn.mockImplementation(() => {
        const child = dockerChild(Readable.from([evidenceTar([{ path: "outside/log", data: "unsafe" }])]));
        if (delayed) child.kill.mockImplementation(() => { child.stderr.end(diagnostic); child.stdout.destroy(new Error("process killed")); return true; });
        else if (diagnostic) child.stderr.end(diagnostic);
        return child;
      });
      const blocker = await cleanupBlocker(reopen());
      if (previous) expect(blocker).toBe(previous);
      previous = blocker;
      const [saved] = await reopen().records();
      expect(saved).toMatchObject({ id: resource.id, state: "failed", cleanupFailure: "Container evidence archive contains an unsafe or unexpected path.", evidence: { state: "pending" } });
      if (diagnostic) expect(saved!.reason).toContain(diagnostic);
      expect(await fs.readdir(path.join(directory, "forge-evidence"))).toEqual([]);
    }
    spawn.mockImplementation(() => dockerChild(Readable.from([evidenceTar([
      { path: "evidence/log", data: "first" }, { path: "evidence/log", data: "duplicate" },
    ])])));
    expect(await cleanupBlocker(reopen())).not.toBe(previous);
    expect((await reopen().records())[0]?.cleanupFailure).toContain("duplicate paths");
    expect(execute.mock.calls.some(([, args]) => args[1] === "rm")).toBe(false);
  });

  it("canonicalizes selections and consumers while reporting changed selection, commit provenance and consumer membership", async () => {
    ownedDockerContainer();
    const shared = { ...worker, id: randomUUID(), attemptId: randomUUID() };
    const resources = () => new ForgeDisposableResources(directory, async () => [worker, shared], host);
    worker.headSha = "b".repeat(40);
    await resources().create(worker, { ...input, image: "node:22", retentionReason: "Keep fixture evidence", evidencePaths: ["/work/evidence", "/work/repro"], consumers: [{ workerId: shared.id, attemptId: shared.attemptId }] });
    worker.status = shared.status = "completed";
    await cleanupBlocker(resources());
    spawn.mockImplementation(() => dockerChild(Readable.from([evidenceTar([{ path: "outside/log", data: "unsafe" }])])));
    const initial = await cleanupBlocker(resources(), shared);
    const journalPath = path.join(directory, "forge-disposable-resources.json");
    const changeJournal = async (change: (resource: DisposableResource) => void) => {
      const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
      change(journal.resources[0]);
      await fs.writeFile(journalPath, JSON.stringify(journal));
    };
    await changeJournal(resource => { resource.evidence!.paths.reverse(); resource.consumers.reverse(); });
    expect(await cleanupBlocker(resources())).toBe(initial);
    let previous = initial;
    for (const change of [
      (resource: DisposableResource) => { resource.evidence!.paths.push("/work/third"); },
      (resource: DisposableResource) => { resource.evidence!.commitSource = "declared"; },
      (resource: DisposableResource) => { resource.evidence!.commitSha = "c".repeat(40); },
      (resource: DisposableResource) => { resource.consumers = resource.consumers.filter(consumer => consumer.workerId === worker.id); },
    ]) {
      await changeJournal(change);
      const blocker = await cleanupBlocker(resources());
      expect(blocker).not.toBe(previous);
      previous = blocker;
    }
  });

});

function dockerChild(stdout: Readable, exitCode = 0) {
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), kill: vi.fn(() => { stdout.destroy(new Error("process killed")); return true; }) });
  stdout.on("end", () => { setImmediate(() => child.emit("close", exitCode, null)); });
  stdout.on("error", () => { setImmediate(() => child.emit("close", 1, "SIGKILL")); });
  return child;
}

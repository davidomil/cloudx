import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { Header } from "tar";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { DisposableResource, ForgeWorker } from "@cloudx/shared";
import { ForgeContainerEvidence, readContainerEvidenceTar, type EvidenceSink } from "./ForgeContainerEvidence.js";
import { ForgeDisposableResources, type ContainerIdentity, type DisposableContainerHost, type DisposableContainerInput } from "./ForgeDisposableResources.js";

interface HistoricalExport {
  baseCommit: string;
  worker: ForgeWorker;
  variants: { layout: string; selection: string; resourceId: string }[];
  files: { path: string; data: string }[];
}
// Original bytes exported, verified and retired by 4f970518; the upgrade never regenerates these receipts.
const historical: HistoricalExport = JSON.parse(await fs.readFile(new URL("./fixtures/container-evidence-base-4f970518.json", import.meta.url), "utf8"));
const historicalJournal = JSON.parse(Buffer.from(historical.files.find(file => file.path === "forge-disposable-resources.json")!.data, "base64").toString()) as { resources: DisposableResource[] };

async function reopenHistoricalArchives() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-archive-upgrade-"));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  for (const file of historical.files) {
    const destination = path.join(directory, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, Buffer.from(file.data, "base64"));
  }
  const host = new EvidenceHost();
  const worker: ForgeWorker = { ...historical.worker, id: randomUUID(), attemptId: randomUUID(), status: "running" };
  const resources = () => new ForgeDisposableResources(directory, async () => [historical.worker, worker], host);
  return { directory, host, worker, resources };
}

async function expectHistoricalBytes(directory: string, includeJournal = false) {
  for (const file of historical.files.filter(file => includeJournal || file.path !== "forge-disposable-resources.json"))
    expect(await fs.readFile(path.join(directory, file.path)), file.path).toEqual(Buffer.from(file.data, "base64"));
}

describe("Forge evidence archives across plugin-cache policy upgrades", () => {
  it("reopens unchanged base receipts and verified deleted archives without host calls", async () => {
    const fixture = await reopenHistoricalArchives();
    expect(await fixture.resources().records()).toEqual(historicalJournal.resources);
    for (const variant of historical.variants) {
      const resource = historicalJournal.resources.find(resource => resource.id === variant.resourceId)!;
      expect(resource).toMatchObject({ state: "deleted", evidence: { state: "verified", commitSha: historical.baseCommit } });
      const archive = await new ForgeContainerEvidence(fixture.directory).read(resource);
      expect(archive.manifest.files).toHaveLength(2);
      expect(await fixture.resources().readEvidence(resource.id)).toEqual(archive.manifest);
      expect(await text(await fixture.resources().evidenceFile(resource.id, "work/evidence/validation.log"))).toBe("historical validation passed\n");
      const cache = archive.manifest.files.find(file => file.path.includes("/.tmp/"))!;
      expect(await text(await fixture.resources().evidenceFile(resource.id, cache.path))).toBe('{"generated":"historical plugin clone"}\n');
    }
    await fixture.resources().retire(historical.worker);
    expect(fixture.host.engineId).not.toHaveBeenCalled();
    expect(fixture.host.create).not.toHaveBeenCalled();
    expect(fixture.host.inspect).not.toHaveBeenCalled();
    expect(fixture.host.readEvidence).not.toHaveBeenCalled();
    expect(fixture.host.remove).not.toHaveBeenCalled();
    await expectHistoricalBytes(fixture.directory, true);
  });

  it.each(["plugins", "plugins-clone-QkqfBY"])("creates and retires unrelated resources while new exports exclude %s cache files", async layout => {
    const fixture = await reopenHistoricalArchives();
    fixture.host.entries = [
      { path: "evidence/new-validation.log", data: "current validation passed\n" },
      { path: `evidence/profile/data/codex-launches/model/.tmp/${layout}/plugins/example/cache.json`, data: "new generated cache" },
    ];
    await expect(fixture.resources().create(fixture.worker, { image: "ubuntu:24.04", name: "new-cache-selection", command: ["true"], retentionReason: "Generated cache", evidencePaths: [`/work/${fixture.host.entries[1]!.path}`] }))
      .rejects.toThrow("Evidence retention requires specific evidencePaths");
    expect(fixture.host.create).not.toHaveBeenCalled();
    const created = await fixture.resources().create(fixture.worker, { image: "ubuntu:24.04", name: "current-validation", command: ["true"], retentionReason: "Current validation log", evidencePaths: ["/work/evidence"] });
    fixture.host.beforeRemove = async () => {
      const manifest = await fixture.resources().readEvidence(created.id);
      expect(manifest.files.map(file => file.path)).toEqual(["work/evidence/new-validation.log"]);
      expect(await text(await fixture.resources().evidenceFile(created.id, manifest.files[0]!.path))).toBe("current validation passed\n");
      await expectHistoricalBytes(fixture.directory);
    };
    fixture.worker.status = "completed";
    await fixture.resources().retire(fixture.worker);
    expect(fixture.host.remove).toHaveBeenCalledExactlyOnceWith(created.containerId);
    const records = await fixture.resources().records();
    expect(records.find(resource => resource.id === created.id)).toMatchObject({ state: "deleted", evidence: { state: "verified" } });
    expect(records.filter(resource => resource.id !== created.id)).toEqual(historicalJournal.resources);
    await fixture.resources().retire(historical.worker);
    expect(fixture.host.remove).toHaveBeenCalledTimes(1);
    await expectHistoricalBytes(fixture.directory);
  });

  it.each(["plugins", "plugins-clone-QkqfBY"])("recovers an already durable %s export checkpoint before checking new-export policy", async layout => {
    const fixture = await reopenHistoricalArchives();
    const checkpoint = await restoreExportCheckpoint(fixture, layout);
    fixture.host.beforeRemove = async () => {
      expect((await fixture.resources().readEvidence(checkpoint.id)).files).toHaveLength(2);
      await expectHistoricalBytes(fixture.directory);
    };
    await fixture.resources().retire(historical.worker);
    expect(fixture.host.remove).toHaveBeenCalledExactlyOnceWith(checkpoint.containerId);
    expect(fixture.host.readEvidence).not.toHaveBeenCalled();
    expect((await fixture.resources().records()).find(resource => resource.id === checkpoint.id))
      .toMatchObject({ state: "deleted", evidence: { state: "verified", manifestSha256: checkpoint.evidence!.manifestSha256 } });
    await expectHistoricalBytes(fixture.directory);
  });

  it("preserves the environment when the historical export intent no longer matches its archive", async () => {
    const fixture = await reopenHistoricalArchives();
    const checkpoint = await restoreExportCheckpoint(fixture, "plugins");
    const manifestPath = path.join(fixture.directory, checkpoint.evidence!.archivePath!);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.reason = "changed after durable intent";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(fixture.resources().retire(historical.worker)).rejects.toThrow("Evidence archive does not match its durable export intent");
    expect((await fixture.resources().records()).find(resource => resource.id === checkpoint.id)).toMatchObject({ state: "failed", evidence: { state: "exporting" } });
    expect(fixture.host.remove).not.toHaveBeenCalled();
    expect(fixture.host.readEvidence).not.toHaveBeenCalled();
  });

  it("keeps a pending newly excluded selection without an archive subject to the current export policy", async () => {
    const fixture = await reopenHistoricalArchives();
    const checkpoint = await restoreExportCheckpoint(fixture, "plugins");
    await fs.rm(path.join(fixture.directory, "forge-evidence", checkpoint.id), { recursive: true });
    const journalPath = path.join(fixture.directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    journal.resources.find((resource: DisposableResource) => resource.id === checkpoint.id).evidence = { state: "pending", paths: checkpoint.evidence!.paths };
    await fs.writeFile(journalPath, JSON.stringify(journal));
    await expect(fixture.resources().retire(historical.worker)).rejects.toThrow("Specific evidence export pending");
    expect((await fixture.resources().records()).find(resource => resource.id === checkpoint.id)).toMatchObject({ state: "blocked", evidence: { state: "pending" } });
    expect(fixture.host.remove).not.toHaveBeenCalled();
    expect(fixture.host.readEvidence).not.toHaveBeenCalled();
  });

  it.each(["work/evidence/../private", "work/evidence/.git/config", "work/evidence/node_modules/pkg/private", "work/evidence/back\\slash", "work/evidence/control\u0000"])("rejects saved unsafe or previously excluded file %s before host calls", async filePath => {
    const fixture = await reopenHistoricalArchives();
    const location = path.join(fixture.directory, "forge-disposable-resources.json");
    const journal = JSON.parse(await fs.readFile(location, "utf8"));
    journal.resources[0].evidence.files[0].path = filePath;
    await fs.writeFile(location, JSON.stringify(journal));
    await expect(fixture.resources().records()).rejects.toThrow("Disposable resource ownership journal is invalid");
    expect(fixture.host.engineId).not.toHaveBeenCalled();
    expect(fixture.host.remove).not.toHaveBeenCalled();
  });
});

async function restoreExportCheckpoint(fixture: Awaited<ReturnType<typeof reopenHistoricalArchives>>, layout: string) {
  const resourceId = historical.variants.find(variant => variant.layout === layout && variant.selection === "files")!.resourceId;
  const location = path.join(fixture.directory, "forge-disposable-resources.json");
  const journal = JSON.parse(await fs.readFile(location, "utf8")) as { resources: DisposableResource[] };
  const checkpoint = journal.resources.find(resource => resource.id === resourceId)!;
  checkpoint.state = "owned";
  checkpoint.evidence!.state = "exporting";
  delete checkpoint.removalStartedAt;
  await fs.writeFile(location, JSON.stringify(journal));
  fixture.host.restore(checkpoint);
  return checkpoint;
}

class EvidenceHost implements DisposableContainerHost {
  private readonly containers = new Map<string, ContainerIdentity>();
  entries: { path: string; data: string }[] = [];
  beforeRemove?: () => Promise<void>;
  restore(resource: DisposableResource) {
    const id = resource.containerId!;
    this.containers.set(id, { id, created: resource.created!, running: false, writableBytes: 2048,
      labels: { "cloudx.forge.resource": resource.id, "cloudx.forge.worker": resource.owner.workerId, "cloudx.forge.attempt": resource.owner.attemptId } });
  }
  engineId = vi.fn(async () => "historical-test-engine");
  create = vi.fn(async (_input: DisposableContainerInput, labels: Record<string, string>) => {
    const id = randomUUID().replaceAll("-", "").repeat(2);
    this.containers.set(id, { id, labels, created: new Date().toISOString(), running: false, writableBytes: 2048 });
    return id;
  });
  find = async (resourceId: string) => [...this.containers.values()].filter(container => container.labels["cloudx.forge.resource"] === resourceId).map(container => container.id);
  inspect = vi.fn(async (id: string) => structuredClone(this.containers.get(id)));
  stop = async (id: string) => { this.containers.get(id)!.running = false; };
  remove = vi.fn(async (id: string) => { await this.beforeRemove?.(); this.containers.delete(id); });
  readEvidence = vi.fn(async (_id: string, paths: string[], write: EvidenceSink) => {
    expect(paths).toEqual(["/work/evidence"]);
    const tar = Buffer.concat([...this.entries.flatMap(entry => {
      const data = Buffer.from(entry.data);
      const header = new Header({ path: entry.path, type: "File", size: data.length, mode: 0o600 }); header.encode();
      return [header.block!, data, Buffer.alloc((512 - data.length % 512) % 512)];
    }), Buffer.alloc(1024)]);
    await readContainerEvidenceTar(paths[0]!, Readable.from([tar]), write);
  });
}

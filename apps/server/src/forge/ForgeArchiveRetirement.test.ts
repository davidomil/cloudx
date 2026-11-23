import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it, onTestFinished } from "vitest";
import type { DisposableResource, ForgeCheckoutEvidenceReceipt, ForgeWorker } from "@cloudx/shared";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile } from "../jsonStateFile.js";
import { ForgeArchiveRetirement } from "./ForgeArchiveRetirement.js";
import { retainForgeArchive } from "./ForgeArchiveAccess.js";
import { ForgeCheckoutEvidence } from "./ForgeCheckoutEvidence.js";
import { ForgeContainerEvidence } from "./ForgeContainerEvidence.js";
import { captureForgeRemovalContents } from "./ForgeCheckoutRemoval.js";
import { ForgeDiagnosticSnapshotRecovery } from "./ForgeDiagnosticSnapshotRecovery.js";
import { ForgeDiagnosticSnapshotInventory } from "./ForgeDiagnosticSnapshotInventory.js";
import type { OwnedDiagnosticSnapshot } from "./ForgeDiagnosticSnapshots.js";
import { ForgeDisposableResources } from "./ForgeDisposableResources.js";
import { ForgeWorkerReports } from "./ForgeWorkflowStore.js";
import { ForgeEvidenceFiles } from "./ForgeEvidenceFiles.js";
import { ForgeGitHistory } from "./ForgeGitHistory.js";

const repository = { provider: "github" as const, apiUrl: "https://api.github.com", projectPath: "fixture/cloudx" };
const commitSha = "a".repeat(40);

describe("Forge archive retirement", () => {
  it("reclaims completed ordinary archives and all owned report attempts, retaining only audit metadata", async () => {
    const fixture = await setup();
    fixture.worker.batch = { issues: [294, 293].map(number => ({ number, title: `Issue ${number}`,
      url: `https://github.com/fixture/cloudx/issues/${number}`, state: "closed" })) };
    await fixture.checkoutEvidence();
    const reports = new ForgeWorkerReports(fixture.root);
    const oldAttempt = randomUUID();
    for (const attemptId of [oldAttempt, fixture.worker.attemptId!]) {
      const report = await reports.prepare(attemptId, { item: { number: 294 } });
      await reports.recordOwner(attemptId, fixture.worker.id);
      await fs.writeFile(report.reportPath, JSON.stringify({ title: "Completed", body: "Validated" }));
    }
    const before = await allocated(path.join(fixture.root, "forge-checkout-evidence")) + await allocated(path.join(fixture.root, "forge-reports"));
    const result = await fixture.retirement.retire(fixture.worker, [fixture.worker], []);
    expect(result.eligible).toBe(true);
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(16_384);
    expect(await allocated(path.join(fixture.root, "forge-checkout-evidence")) + await allocated(path.join(fixture.root, "forge-reports"))).toBeLessThan(before);
    expect(await reports.read(oldAttempt)).toBeUndefined();
    const audit = await fixture.retirement.audit();
    expect(audit.owners[0]!.batchNumbers).toEqual([294, 293]);
    expect(audit.payloads.every(payload => payload.state === "retired" && !payload.inventory && !payload.identity)).toBe(true);
    expect(audit.payloads).toHaveLength(7);
    expect(audit.payloads.every(payload => payload.workerId === fixture.worker.id && payload.reason)).toBe(true);
    const restart = new ForgeArchiveRetirement(fixture.root);
    expect(await restart.reconcile([], [])).toEqual(result);
    expect(await new ForgeCheckoutEvidence(fixture.root).list()).toEqual([]);
  });

  it("preserves deliberate evidence and published references after work completion", async () => {
    const fixture = await setup();
    const receipt = await fixture.checkoutEvidence(["validation.log"]);
    const result = await fixture.retirement.retire(fixture.worker, [], []);
    expect(result).toMatchObject({ eligible: false, reclaimedBytes: 0, heldPaths: [`forge-checkout-evidence/${receipt.archiveId}`] });
    expect((await new ForgeCheckoutEvidence(fixture.root).read(receipt.archiveId)).files).toHaveLength(1);
    const referenced = await setup();
    const archive = await referenced.checkoutEvidence();
    referenced.worker.completion = { attemptId: referenced.worker.attemptId!, deadlineAt: new Date().toISOString(),
      report: { kind: "issue", title: "Done", body: `/api/forge/checkout-evidence/${archive.archiveId}`, discussionReplies: [], resolvedDiscussionIds: [] } };
    expect((await referenced.retirement.retire(referenced.worker, [], [])).eligible).toBe(false);
    expect((await referenced.retirement.audit()).payloads[0]!.hold).toMatch(/published completion/);
  });

  it.each(["[validation output](validation.log)", "[validation output](<validation.log>)", "`validation.log`"])("preserves published source reference %s before an archive identifier exists", async reference => {
    const fixture = await setup();
    await fixture.checkoutEvidence();
    fixture.worker.completion = { attemptId: fixture.worker.attemptId!, deadlineAt: new Date().toISOString(), report: {
      kind: "issue", title: "Done", body: `See ${reference}.`, discussionReplies: [], resolvedDiscussionIds: [],
    } };
    expect((await fixture.retirement.retire(fixture.worker, [], [])).eligible).toBe(false);
    expect((await fixture.retirement.audit()).payloads[0]!.hold).toMatch(/published/);
  });

  it("holds active downloads and resumes automatic retirement when the stream closes", async () => {
    const fixture = await setup();
    const receipt = await fixture.checkoutEvidence();
    const archive = new ForgeCheckoutEvidence(fixture.root);
    const stream = await archive.fileStream(receipt.archiveId, "validation.log");
    expect((await fixture.retirement.retire(fixture.worker, [], [])).heldPaths).toEqual([`forge-checkout-evidence/${receipt.archiveId}`]);
    expect((await buffer(stream)).toString()).toBe("passed\n".repeat(2000));
    if (!stream.closed) await once(stream, "close");
    expect((await fixture.retirement.reconcile([], [])).eligible).toBe(true);
  });

  it("holds active reviewers and shared consumers until each has terminal authority", async () => {
    const fixture = await setup();
    const consumer = { ...fixture.worker, id: randomUUID(), attemptId: randomUUID(), status: "running" as const, tabId: randomUUID() };
    const resource = await fixture.containerEvidence(consumer);
    const result = await fixture.retirement.retire(fixture.worker, [consumer], [resource]);
    expect(result.eligible).toBe(false);
    expect((await fixture.retirement.audit()).payloads[0]!.hold).toMatch(/active|recoverable/);
    expect((await fixture.retirement.reconcile([], [resource])).eligible).toBe(false);
    const ended = { ...consumer, status: "completed" as const, tabId: undefined };
    expect((await fixture.retirement.retire(ended, [], [resource])).eligible).toBe(true);
    expect((await fixture.retirement.reconcile([], [resource])).eligible).toBe(true);
    await expect(fs.stat(path.join(fixture.root, "forge-evidence", resource.id))).rejects.toMatchObject({ code: "ENOENT" });
    const file = new JsonStateFile(fixture.root, "forge-disposable-resources.json", "Fixture resources");
    await file.write({ resources: [resource], terminalWorkers: [resource.owner] });
    const resources = new ForgeDisposableResources(fixture.root, async () => []);
    expect((await resources.records())[0]!.evidence).toMatchObject({ state: "retired", files: undefined });
    await resources.compactRetiredArchives();
    const compacted = (await file.read<{ resources: DisposableResource[] }>())!.resources[0]!.evidence!;
    expect(compacted.state).toBe("retired");
    expect(compacted.files).toBeUndefined();
    expect((await resources.records())[0]!.evidence?.state).toBe("retired");
  });

  it("preserves references in other current workers", async () => {
    const fixture = await setup();
    const receipt = await fixture.checkoutEvidence();
    const reviewer = { ...fixture.worker, id: randomUUID(), status: "running" as const,
      error: `Review forge-checkout-evidence/${receipt.archiveId}` };
    expect((await fixture.retirement.retire(fixture.worker, [reviewer], [])).eligible).toBe(false);
    expect((await fixture.retirement.reconcile([], [])).eligible).toBe(true);
  });

  it("keeps published references through interrupted owner discovery", async () => {
    const fixture = await setup();
    const receipt = await fixture.checkoutEvidence();
    fixture.worker.completion = { attemptId: fixture.worker.attemptId!, deadlineAt: new Date().toISOString(), report: {
      kind: "issue", title: "Done", body: `/api/forge/checkout-evidence/${receipt.archiveId}`, discussionReplies: [], resolvedDiscussionIds: [],
    } };
    const tab = new JsonStateFile(fixture.root, `forge-workers/tabs/${randomUUID()}.json`, "Fixture terminal");
    await tab.write({ workerId: fixture.worker.id, attemptId: fixture.worker.attemptId, closed: false, quiescent: false });
    await expect(fixture.retirement.retire(fixture.worker, [], [])).rejects.toThrow(/terminal still needs/);
    await tab.write({ workerId: fixture.worker.id, attemptId: fixture.worker.attemptId, closed: true, quiescent: true });
    expect((await new ForgeArchiveRetirement(fixture.root).reconcile([], [])).eligible).toBe(false);
    expect((await fixture.retirement.audit()).payloads[0]!.hold).toMatch(/published/);
  });

  it.each(["earlier report", "task context", "draft", "review history"])("preserves archive references from %s before removing report payloads", async source => {
    const fixture = await setup();
    const receipt = await fixture.checkoutEvidence();
    const body = `/api/forge/checkout-evidence/${receipt.archiveId}`;
    const attemptId = randomUUID();
    if (source === "earlier report" || source === "task context") {
      const reports = new ForgeWorkerReports(fixture.root);
      const prepared = await reports.prepare(attemptId, source === "task context" ? { item: { body } } : {});
      await reports.recordOwner(attemptId, fixture.worker.id);
      if (source === "earlier report") await fs.writeFile(prepared.reportPath, JSON.stringify({ kind: "issue", title: "Earlier attempt", body }));
    } else {
      const draft = { id: attemptId, startedAt: new Date().toISOString(), headSha: commitSha,
        event: "comment" as const, body, comments: [], status: "post_failed" as const };
      if (source === "draft") fixture.worker.draft = draft;
      else fixture.worker.reviewHistory = [draft];
    }
    expect((await fixture.retirement.retire(fixture.worker, [], [])).eligible).toBe(false);
    expect((await fixture.retirement.audit()).payloads.find(payload => payload.path === `forge-checkout-evidence/${receipt.archiveId}`)?.retained).toBe(true);
    expect((await new ForgeArchiveRetirement(fixture.root).reconcile([], [])).eligible).toBe(false);
    expect((await new ForgeCheckoutEvidence(fixture.root).read(receipt.archiveId)).files).toHaveLength(1);
  });

  it("preserves cross-worker published references after both worker cards disappear", async () => {
    const fixture = await setup();
    const receipt = await fixture.checkoutEvidence();
    const release = retainForgeArchive(path.join(fixture.root, "forge-checkout-evidence", receipt.archiveId));
    await fixture.retirement.retire(fixture.worker, [], []);
    release();
    const publisher: ForgeWorker = { ...fixture.worker, id: randomUUID(), attemptId: randomUUID(), completion: {
      attemptId: randomUUID(), deadlineAt: new Date().toISOString(), report: { kind: "issue", title: "Reference", body: `/api/forge/checkout-evidence/${receipt.archiveId}`,
        discussionReplies: [], resolvedDiscussionIds: [] },
    } };
    await fixture.retirement.retire(publisher, [], []);
    expect((await new ForgeArchiveRetirement(fixture.root).reconcile([], [])).eligible).toBe(false);
    expect((await new ForgeCheckoutEvidence(fixture.root).read(receipt.archiveId)).files).toHaveLength(1);
  });

  it("preserves unknown legacy archives and reports without guessing ownership", async () => {
    const fixture = await setup();
    const unknownId = randomUUID();
    const unknown = path.join(fixture.root, "forge-checkout-evidence", unknownId);
    await fs.mkdir(unknown, { recursive: true });
    await fs.writeFile(path.join(unknown, "manifest.json"), "{}");
    await fs.mkdir(path.join(fixture.root, "forge-reports"));
    const report = path.join(fixture.root, "forge-reports", `${randomUUID()}.context.json`);
    await fs.writeFile(report, JSON.stringify({ item: { number: fixture.worker.number } }));
    await fixture.retirement.retire(fixture.worker, [], []);
    await fixture.retirement.reconcile([], []);
    expect(await fs.readFile(path.join(unknown, "manifest.json"), "utf8")).toBe("{}");
    expect(await fs.stat(report)).toBeTruthy();
  });

  it.each(["checkout", "Git history"])("holds a misbound %s receipt and preserves both workers' payloads", async kind => {
    const fixture = await setup();
    const otherSource = path.join(fixture.root, "other-source");
    await fs.mkdir(otherSource);
    const otherWorker: ForgeWorker = { ...fixture.worker, id: randomUUID(), attemptId: randomUUID(), status: "running", worktreePath: otherSource };
    const namespace = kind === "checkout" ? "forge-checkout-evidence" : "forge-git-history";
    const archives = [];
    for (const worker of [fixture.worker, otherWorker]) {
      const worktree = worker === fixture.worker ? fixture.workspace.worktree : await readDirectoryIdentity(otherSource);
      const archiveId = randomUUID();
      const writer = await new ForgeEvidenceFiles(fixture.root).begin(namespace, archiveId);
      const file = kind === "checkout" ? "validation.log" : "history.bundle";
      await writer.add(file, [Buffer.from(`Evidence owned by ${worker.id}`)]);
      const selection = kind === "checkout" ? { paths: [file] } : { refs: [{ name: `refs/cloudx/before-rebase/${commitSha}`, commitSha }] };
      const manifest = { archiveId, workerId: worker.id, attemptId: worker.attemptId!, commitSha,
        checkoutIdentity: { dev: worktree.dev, ino: worktree.ino }, ...selection,
        exportedAt: new Date().toISOString(), files: writer.files, bytes: writer.bytes };
      const receipt = { archiveId, attemptId: worker.attemptId!, commitSha, ...selection,
        manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), publication: "complete" };
      const owned = { ...fixture.workspace, id: worker.id, worktree,
        ...(kind === "checkout" ? { checkoutEvidence: receipt } : { gitHistory: receipt }) };
      const ownership = new JsonStateFile(fixture.root, `forge-workers/workspaces/${worker.id}.json`, "Fixture ownership");
      await writer.commit(manifest, () => ownership.write(owned));
      await writer.abort();
      archives.push({ manifest, receipt, owned, ownership });
    }
    const [completed, active] = archives;
    await completed!.ownership.write({ ...completed!.owned,
      ...(kind === "checkout" ? { checkoutEvidence: active!.receipt } : { gitHistory: active!.receipt }) });
    const read = (archiveId: string) => kind === "checkout" ? new ForgeCheckoutEvidence(fixture.root).read(archiveId) : new ForgeGitHistory(fixture.root).read(archiveId);
    expect((await read(active!.receipt.archiveId)).workerId).toBe(otherWorker.id);
    expect((await fixture.retirement.retire(fixture.worker, [otherWorker], [])).eligible).toBe(false);
    expect((await fixture.retirement.audit()).payloads[0]!.hold).toMatch(/candidate owner/);
    for (const archive of archives) {
      const location = path.join(fixture.root, namespace, archive.receipt.archiveId);
      expect(JSON.parse(await fs.readFile(path.join(location, "manifest.json"), "utf8"))).toEqual(archive.manifest);
      expect((await buffer(await new ForgeEvidenceFiles(fixture.root).fileStream(namespace, archive.receipt.archiveId, archive.manifest.files[0]!.path))).toString())
        .toBe(`Evidence owned by ${archive.manifest.workerId}`);
    }
    expect((await new ForgeArchiveRetirement(fixture.root).reconcile([otherWorker], [])).eligible).toBe(false);
    expect((await read(active!.receipt.archiveId)).workerId).toBe(otherWorker.id);
  });

  it("resumes an interrupted unlink inventory after restart without retaining another payload copy", async () => {
    const fixture = await setup();
    const receipt = await fixture.checkoutEvidence();
    const location = path.join(fixture.root, "forge-checkout-evidence", receipt.archiveId);
    const release = retainForgeArchive(location);
    await fixture.retirement.retire(fixture.worker, [], []);
    release();
    const journal = await fixture.retirement.audit();
    journal.payloads[0]!.state = "retiring";
    await new JsonStateFile(fixture.root, "forge-archive-retirement.json", "Interrupted fixture").write(journal);
    const blob = (await fs.readdir(location)).find(name => name !== "manifest.json")!;
    await fs.unlink(path.join(location, blob));
    const result = await new ForgeArchiveRetirement(fixture.root).reconcile([], []);
    expect(result.eligible).toBe(true);
    expect(await fs.readdir(path.dirname(location))).toEqual([]);
  });

  it.each(["file", "symlink", "unknown"])("preserves a %s replacement after the deletion inventory was recorded", async mode => {
    const fixture = await setup();
    const receipt = await fixture.checkoutEvidence();
    const location = path.join(fixture.root, "forge-checkout-evidence", receipt.archiveId);
    const release = retainForgeArchive(location);
    await fixture.retirement.retire(fixture.worker, [], []);
    release();
    const blob = (await fs.readdir(location)).find(name => name !== "manifest.json")!;
    const outside = path.join(fixture.root, "user-artifact");
    await fs.writeFile(outside, "user content");
    if (mode === "unknown") await fs.writeFile(path.join(location, "new-file"), "user content");
    else {
      await fs.unlink(path.join(location, blob));
      if (mode === "symlink") await fs.symlink(outside, path.join(location, blob));
      else await fs.writeFile(path.join(location, blob), "replacement");
    }
    expect((await new ForgeArchiveRetirement(fixture.root).reconcile([], [])).eligible).toBe(false);
    expect(await fs.readFile(outside, "utf8")).toBe("user content");
    expect(await fs.stat(location)).toBeTruthy();
  });

  it("never follows a substituted archive parent", async () => {
    const fixture = await setup();
    const receipt = await fixture.checkoutEvidence();
    const parent = path.join(fixture.root, "forge-checkout-evidence");
    const location = path.join(parent, receipt.archiveId);
    const release = retainForgeArchive(location);
    await fixture.retirement.retire(fixture.worker, [], []);
    release();
    const original = path.join(fixture.root, "original-archives");
    await fs.rename(parent, original);
    await fs.symlink(original, parent);
    expect((await fixture.retirement.reconcile([], [])).eligible).toBe(false);
    expect(await fs.stat(path.join(original, receipt.archiveId, "manifest.json"))).toBeTruthy();
  });

  it("retires routine recovery copies and preserves explicitly recovered diagnostics", async () => {
    for (const retained of [false, true]) {
      const fixture = await setup();
      const snapshot = await fixture.recoveryEvidence(retained);
      const result = await fixture.retirement.retire(fixture.worker, [], []);
      expect(result.eligible).toBe(!retained);
      expect((await new ForgeDiagnosticSnapshotInventory(fixture.root).list()).snapshots).toHaveLength(retained ? 1 : 0);
      if (retained) await new ForgeDiagnosticSnapshotRecovery(fixture.root).verify(snapshot);
      else await expect(fs.stat(snapshot.recovery!.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects unconfirmed completion and preserves unresolved workspace recovery", async () => {
    const fixture = await setup();
    await expect(fixture.retirement.retire({ ...fixture.worker, status: "awaiting_merge" }, [], [])).rejects.toThrow(/authoritative/);
    await fixture.checkoutEvidence();
    fixture.workspace.cleaned = false;
    await fixture.saveWorkspace();
    await expect(fixture.retirement.retire(fixture.worker, [], [])).rejects.toThrow(/recoverable/);
  });

  it("holds legacy recovery copies whose deliberate-retention history is unknown", async () => {
    const fixture = await setup();
    const snapshot = await fixture.recoveryEvidence(false);
    delete snapshot.recovery!.lifecycle;
    await fixture.saveWorkspace();
    expect((await fixture.retirement.retire(fixture.worker, [], [])).eligible).toBe(false);
    expect((await fixture.retirement.audit()).payloads[0]!.hold).toMatch(/Legacy recovery ownership/);
    expect(await fs.stat(snapshot.recovery!.archivePath)).toBeTruthy();
  });
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-retirement-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const worker: ForgeWorker = { id: randomUUID(), attemptId: randomUUID(), kind: "issue", number: 294, title: "Retire archives", repository,
    status: "completed", baseBranch: "main", templateId: "fixture", headSha: commitSha, autoPost: false, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const checkout = path.join(root, "source");
  await fs.mkdir(checkout);
  const worktree = await readDirectoryIdentity(checkout);
  const workspace = { id: worker.id, worktree, cleaned: true, gitPending: false, launchPending: false,
    evidenceRetirement: { attemptId: worker.attemptId!, commitSha, paths: [] as string[] },
    checkoutEvidence: undefined as ForgeCheckoutEvidenceReceipt | undefined, diagnosticSnapshots: [] as OwnedDiagnosticSnapshot[] };
  const saveWorkspace = () => new JsonStateFile(root, `forge-workers/workspaces/${worker.id}.json`, "Fixture ownership").write(workspace);
  return { root, worker, workspace, saveWorkspace, retirement: new ForgeArchiveRetirement(root),
    async checkoutEvidence(retained: string[] = []) {
      await fs.writeFile(path.join(checkout, "validation.log"), "passed\n".repeat(2000));
      const receipt = { archiveId: randomUUID(), attemptId: worker.attemptId!, commitSha, paths: ["validation.log"] };
      workspace.checkoutEvidence = receipt;
      workspace.evidenceRetirement.paths = retained;
      await saveWorkspace();
      await new ForgeCheckoutEvidence(root).export(worker.id, worktree, receipt, async intent => { workspace.checkoutEvidence = intent; await saveWorkspace(); });
      return workspace.checkoutEvidence!;
    },
    async containerEvidence(consumer: ForgeWorker) {
      const resource: DisposableResource = { id: randomUUID(), kind: "container", engineId: "engine", containerId: "b".repeat(64), created: new Date().toISOString(),
        name: "validation", owner: { workerId: worker.id, attemptId: worker.attemptId! },
        consumers: [{ workerId: worker.id, attemptId: worker.attemptId! }, { workerId: consumer.id, attemptId: consumer.attemptId! }],
        state: "deleted", reason: "Completed", reclaimedBytes: 1, updatedAt: new Date().toISOString(),
        evidence: { state: "pending", paths: ["/work/validation.log"], commitSha, commitSource: "declared" } };
      resource.evidence = await new ForgeContainerEvidence(root).export(resource, async write => {
        await write("work/validation.log", Readable.from([Buffer.from("passed")]), 6);
      }, async receipt => { resource.evidence = receipt; });
      return resource;
    },
    async recoveryEvidence(retained: boolean) {
      const relative = `.cloudx/forge-snapshots/${randomUUID()}/source`;
      const source = path.join(checkout, relative);
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "diagnostic.log"), "verified diagnostic\n");
      const snapshot: OwnedDiagnosticSnapshot = { workerId: worker.id, attemptId: worker.attemptId!, path: relative,
        kind: "repository", retentionPolicy: "recover", state: "ready", identity: await readDirectoryIdentity(source),
        parentIdentity: await readDirectoryIdentity(path.dirname(source)), origin: { checkout: worktree,
          gitDirectory: { ...worktree, path: path.join(checkout, ".git") }, commitSha, url: "https://github.com/fixture/cloudx" },
        removalContents: await captureForgeRemovalContents(await readDirectoryIdentity(source)),
        ...(retained ? { recoveryRetention: { reason: "Explicitly recovered diagnostic", heldAt: new Date().toISOString() } } : {}) };
      workspace.diagnosticSnapshots.push(snapshot);
      await saveWorkspace();
      await new ForgeDiagnosticSnapshotRecovery(root).preserve(snapshot, snapshot.identity, saveWorkspace);
      snapshot.state = "removed";
      await saveWorkspace();
      return snapshot;
    },
  };
}
async function allocated(target: string): Promise<number> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return stat.blocks * 512;
  return stat.blocks * 512 + (await Promise.all((await fs.readdir(target)).map(name => allocated(path.join(target, name))))).reduce((a, b) => a + b, 0);
}
